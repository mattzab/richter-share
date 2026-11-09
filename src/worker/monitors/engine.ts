import type { ContainerMonitorConfig, DnsConfig, DomainConfig, HeartbeatConfig, HttpConfig, MonitorStatus, MonitorType, SystemMonitorConfig, TcpConfig } from "../../shared/types";
import { parseJson } from "../db";
import type { Env } from "../env";
import { checkDns, checkDomain, checkHttp, checkTcp, checkTcpViaProbe, type CheckResult } from "./checks";

export interface MonitorRow {
	id: string;
	name: string;
	type: MonitorType;
	config: string;
	parent_id: string | null;
	interval_s: number;
	retries: number;
	retry_interval_s: number;
	timeout_ms: number;
	max_latency_ms: number | null;
	upside_down: number;
	resend_every: number;
	paused: number;
	description: string | null;
	tags: string;
	status: MonitorStatus;
	fail_streak: number;
	down_checks: number;
	last_check_at: number | null;
	next_check_at: number | null;
	last_latency_ms: number | null;
	last_message: string | null;
	push_token: string | null;
	last_ping_at: number | null;
	run_started_at: number | null;
	domain_expires_at: number | null;
	warned_expiry: number | null;
	sort: number;
	created_at: number;
}

export const ACTIVE_COST: Partial<Record<MonitorType, number>> = { http: 1, tcp: 1, dns: 1, domain: 2 };

export function utcDay(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

/** Lookups the Hub passes in so a tick does not re-query D1 or the agent per monitor. */
export interface CheckDeps {
	system?: (id: string) => { status: string; name: string } | null | undefined;
	containers?: (systemId: string) => Promise<{ created_at: number; stats: string } | null>;
}

/** Latest 1m container snapshot, kept in the system's AgentConnection Durable Object. */
export async function latestContainers(env: Env, systemId: string): Promise<{ created_at: number; stats: string } | null> {
	if (!systemId) return null;
	try {
		return await env.AGENT.get(env.AGENT.idFromName(systemId)).latestContainers();
	} catch (e) {
		console.error("latestContainers failed", (e as Error).message);
		return null;
	}
}

/** Run the type-specific check. Returns null when there is nothing to record (e.g. waiting for first data). */
export async function runCheck(
	env: Env,
	m: Pick<MonitorRow, "id" | "type" | "config" | "timeout_ms" | "last_ping_at" | "run_started_at" | "created_at">,
	now = Date.now(),
	deps: CheckDeps = {},
): Promise<CheckResult | null> {
	const timeout = Math.min(Math.max(m.timeout_ms || 10_000, 1000), 30_000);
	switch (m.type) {
		case "http":
			return checkHttp(parseJson<HttpConfig>(m.config, { url: "" }), timeout);
		case "tcp":
			{
			const cfg = parseJson<TcpConfig>(m.config, { host: "", port: 0 });
			return cfg.via_probe ? checkTcpViaProbe(cfg, timeout, env.PROBE_URL, env.PROBE_TOKEN) : checkTcp(cfg, timeout);
		}
		case "dns":
			return checkDns(parseJson<DnsConfig>(m.config, { name: "" }), timeout);
		case "domain":
			return checkDomain(parseJson<DomainConfig>(m.config, { domain: "" }), timeout);
		case "heartbeat": {
			const cfg = parseJson<HeartbeatConfig>(m.config, { period_s: 3600, grace_s: 300 });
			const deadline = (cfg.period_s + cfg.grace_s) * 1000;
			if (!m.last_ping_at) {
				// Never pinged: pending until one full period + grace has passed since creation.
				if (now - m.created_at < deadline) return null;
				return { ok: false, latency_ms: null, message: "No ping received yet" };
			}
			const age = now - m.last_ping_at;
			if (age > deadline) return { ok: false, latency_ms: null, message: `No ping for ${Math.round(age / 60000)} min` };
			if (age > cfg.period_s * 1000) return { ok: true, degraded: true, latency_ms: null, message: "Late, within grace period" };
			return { ok: true, latency_ms: null, message: "Last ping on time" };
		}
		case "system": {
			const cfg = parseJson<SystemMonitorConfig>(m.config, { system_id: "" });
			const s = deps.system
				? deps.system(cfg.system_id)
				: await env.DB.prepare("SELECT status, name FROM systems WHERE id = ?").bind(cfg.system_id).first<{ status: string; name: string }>();
			if (!s) return { ok: false, latency_ms: null, message: "System not found" };
			if (s.status === "pending" || s.status === "paused") return null;
			return { ok: s.status === "up", latency_ms: null, message: s.status === "up" ? "Agent connected" : "Agent not responding" };
		}
		case "container": {
			const cfg = parseJson<ContainerMonitorConfig>(m.config, { system_id: "", container_name: "" });
			const row = await (deps.containers ?? ((id: string) => latestContainers(env, id)))(cfg.system_id);
			if (!row || now - row.created_at > 180_000) return { ok: false, latency_ms: null, message: "No recent container data from agent" };
			const c = parseJson<{ n: string; h?: number; s?: string }[]>(row.stats, []).find((x) => x.n === cfg.container_name);
			if (!c) return { ok: false, latency_ms: null, message: `Container ${cfg.container_name} not running` };
			if (c.h === 3) return { ok: false, latency_ms: null, message: `Unhealthy (${c.s ?? ""})` };
			return { ok: true, latency_ms: null, message: c.s ?? "running" };
		}
		case "group":
			return null; // computed from children in evaluateGroups
	}
}

export function formatDuration(ms: number): string {
	const m = Math.round(ms / 60000);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h} h ${m % 60} min`;
	return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function systemOf(m: Pick<MonitorRow, "type" | "config">): string | null {
	if (m.type !== "system" && m.type !== "container") return null;
	return parseJson<{ system_id?: string }>(m.config, {}).system_id ?? null;
}

export const RANK: Record<string, number> = { down: 5, degraded: 4, running: 1, maintenance: 2, up: 0, pending: -1, paused: -2 };
