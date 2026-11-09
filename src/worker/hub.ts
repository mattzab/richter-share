import { DurableObject } from "cloudflare:workers";
import type { CheckPoint, HeartbeatConfig, HttpConfig, MonitorStatus } from "../shared/types";
import { getHubKey } from "./beszel/keys";
import { addEvent, ensureSchema, newId, parseJson } from "./db";
import type { Env } from "./env";
import { notify } from "./notify";
import { buildPublicPage, pageFor, pageGraceMs, pageSystemStatus, type PageSource } from "./public-page";
import { seedOnce } from "./seed";
import type { CheckResult } from "./monitors/checks";
import { ACTIVE_COST, formatDuration, latestContainers, latestPve, RANK, runCheck, systemOf, utcDay, type MonitorRow } from "./monitors/engine";
import { addLatency, DAY, decodeBucket, encodeBucket, HOUR, hourOf, LAT_SLOT_MS, type LatSlot } from "./monitors/history";
import { toMaintenance, type MaintenanceRow } from "./monitors/maintenance";
import { nextState } from "./monitors/state";
import { HB_FLUSH_MS, minutesByDay } from "./monitors/uptime";

/**
 * Hub: one SQLite-backed Durable Object ("hub") that owns live monitor state.
 *
 * D1 stays the system of record for configuration, history and incidents, but the hot per-check
 * state (status, streaks, next_check_at, last ping, the in-progress hour of check history and
 * today's counters) lives here and is only written to D1 when a monitor's status changes or once
 * an hour. The cron tick, heartbeat pings and dashboard reads all go through this object.
 */

export interface Live {
	status: MonitorStatus;
	fail_streak: number;
	down_checks: number;
	last_check_at: number | null;
	next_check_at: number | null;
	last_latency_ms: number | null;
	last_message: string | null;
	last_ping_at: number | null;
	run_started_at: number | null;
	domain_expires_at: number | null;
	warned_expiry: number | null;
	/** Heartbeats: time up to which minutes were attributed to monitor_daily, and the status they run on with. */
	acct_at: number | null;
	acct_status: number | null;
}

export interface DayCounts {
	up: number;
	down: number;
	degraded: number;
	maint: number;
	latency_sum: number;
	latency_n: number;
}

interface SysDay {
	up: number;
	down: number;
	maint: number;
	/** Transitions into down seen today (optional: state persisted before it existed). */
	outages?: number;
}

interface Stmt {
	sql: string;
	params: (string | number | null)[];
}

/**
 * Per-system status-page accounting: the real status at the last sample, when the current outage
 * started (`since`, absent = unknown/long ago) and the system's status-page grace (`g`, ms).
 */
interface SysAcct {
	status: string | null;
	at: number | null;
	since?: number;
	g?: number;
}

interface HubState {
	v: 1;
	day: string;
	hour: number;
	live: Record<string, Live>;
	bucket: Record<string, CheckPoint[]>;
	recent: Record<string, CheckPoint[]>;
	daily: Record<string, DayCounts>;
	lat: Record<string, LatSlot[]>;
	sys: Record<string, SysAcct>;
	sysDaily: Record<string, SysDay>;
	/**
	 * Public CPU sparkline: 15-minute [slot, sum %, n] averages over 24 h plus the newest sample, per
	 * system. Fed by the cron's agent polls; rides in the snapshot (no writes of its own).
	 */
	cpu?: Record<string, LatSlot[]>;
	cpuNow?: Record<string, [number, number]>;
	/** Idempotent absolute upserts waiting for D1, keyed so a newer value replaces an older one. */
	outbox: Record<string, Stmt>;
	retention: string | null;
	/** When this snapshot was written (kept in the snapshot: the object hibernates after ~10 s idle and restarts from it). */
	saved_at?: number;
}

interface Cfg {
	at: number;
	monitors: MonitorRow[];
	maint: MaintenanceRow[];
}

interface Hist {
	day: string;
	rows: { monitor_id: string; day: string; up: number; down: number; degraded: number; maint: number; latency_sum: number; latency_n: number }[];
	/** system_daily for the same 90 days (absent in hist cached before it existed: re-read). */
	sys?: (SysDay & { system_id: string; day: string })[];
}

export interface HubView {
	now: number;
	live: Record<string, Live>;
	recent: Record<string, CheckPoint[]>;
	/** Today's counts per monitor, heartbeat time not yet attributed included. */
	today: Record<string, DayCounts>;
	yesterday: Record<string, DayCounts>;
}

export interface PingReply {
	status: 200 | 404;
	body: { ok: boolean; error?: string; paused?: boolean };
}

const CFG_TTL_MS = 10 * 60_000;
/**
 * The state snapshot is one storage row per put, so it is written at most this often; status
 * changes, notifications, hour/day rolls and failed D1 flushes force a write. An eviction loses
 * at most this much of the in-progress hour's counters and check samples.
 */
export const SNAPSHOT_MS = 5 * 60_000;
/** Slack for tick timing and ping jitter when deciding whether a heartbeat ping must be persisted. */
const PING_SLACK_MS = 60_000;
const RECENT_N = 30;
const PAGE_TTL_MS = 60_000;
const PAGE_MIN_MS = 10_000;
const COLS = ["down", "up", "degraded", "maint"] as const;
const LIVE_KEYS = ["status", "fail_streak", "down_checks", "last_check_at", "next_check_at", "last_latency_ms", "last_message", "last_ping_at", "run_started_at", "domain_expires_at", "warned_expiry"] as const;

const zeroDay = (): DayCounts => ({ up: 0, down: 0, degraded: 0, maint: 0, latency_sum: 0, latency_n: 0 });
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** "running" is up for flushing purposes: a heartbeat start ping must not cost a D1 write. */
const norm = (s: MonitorStatus) => (s === "running" ? "up" : s);
const hbCap = (m: MonitorRow) => HB_FLUSH_MS + Math.max(m.interval_s, m.retry_interval_s) * 1000 + 120_000;

function liveFromRow(m: MonitorRow): Live {
	return {
		status: m.status,
		fail_streak: m.fail_streak,
		down_checks: m.down_checks,
		last_check_at: m.last_check_at,
		next_check_at: m.next_check_at,
		last_latency_ms: m.last_latency_ms,
		last_message: m.last_message,
		last_ping_at: m.last_ping_at,
		run_started_at: m.run_started_at,
		domain_expires_at: m.domain_expires_at,
		warned_expiry: m.warned_expiry,
		acct_at: null,
		acct_status: null,
	};
}

/** A D1 monitors row with the Hub's live columns laid over it. */
export function overlay(m: MonitorRow, l: Live | undefined): MonitorRow {
	if (!l) return m;
	const out = { ...m } as Record<string, unknown>;
	for (const k of LIVE_KEYS) out[k] = l[k];
	return out as unknown as MonitorRow;
}

export class Hub extends DurableObject<Env> {
	private s!: HubState | null;
	private cfg: Cfg | null = null;
	private hist: Hist | null = null;
	private readyP: Promise<void> | null = null;
	private busy = 0;
	private version = 0;
	private pages = new Map<string, { at: number; v: number; json: string | null }>();
	private mustSave = false;
	/** last_ping_at per monitor as of the stored snapshot: what a restarted instance would see. */
	private savedPing = new Map<string, number | null>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			const got = await ctx.storage.get(["state", "cfg", "hist"]);
			this.s = (got.get("state") as HubState | undefined) ?? null;
			this.hist = (got.get("hist") as Hist | undefined) ?? null;
			if (this.s) {
				this.noteSaved();
				// How often the runtime evicts the Hub decides how stale a restart's snapshot can be.
				console.log(`hub: woke from storage, snapshot ${Math.round((Date.now() - (this.s.saved_at ?? 0)) / 1000)} s old`);
			}
			// Config is cheap to re-read from D1 and no longer persisted; drop the old copy once.
			if (got.has("cfg")) await ctx.storage.delete("cfg");
		});
	}

	private get db() {
		return this.env.DB;
	}

	private ready(): Promise<void> {
		this.readyP ??= (async () => {
			await ensureSchema(this.db);
			if (!this.s) {
				await seedOnce(this.env);
				await getHubKey(this.db); // make sure the agent KEY exists before anyone opens the dashboard
				await this.seed(Date.now());
				await this.save();
			}
		})().catch((e) => {
			this.readyP = null;
			throw e;
		});
		return this.readyP;
	}

	private get S(): HubState {
		return this.s!;
	}

	private noteSaved(): void {
		this.savedPing.clear();
		for (const [id, l] of Object.entries(this.S.live)) this.savedPing.set(id, l.last_ping_at);
	}

	private async save(): Promise<void> {
		this.S.saved_at = Date.now();
		await this.ctx.storage.put("state", this.S);
		this.noteSaved();
		this.mustSave = false;
	}

	/**
	 * Snapshot the state if something important changed or the stored snapshot is SNAPSHOT_MS old.
	 * The clock lives in the snapshot, not in memory: the Hub hibernates between most requests and
	 * every restart would otherwise reset it (and silently drop everything since the last save).
	 */
	private async persist(now: number): Promise<void> {
		if (this.mustSave || now - (this.S.saved_at ?? 0) >= SNAPSHOT_MS) await this.save();
	}

	/**
	 * A heartbeat ping is only worth a write when a restarted instance would otherwise be wrong:
	 * its stored last_ping_at would turn the monitor late before the next ping can arrive (with a
	 * minute of slack for the tick), or it is older than a snapshot period (dashboards show it).
	 */
	private pingNeedsSave(m: MonitorRow, prev: number | null, now: number): boolean {
		const stored = this.savedPing.get(m.id) ?? null;
		if (stored == null || prev == null) return true;
		if (now - stored >= SNAPSHOT_MS) return true;
		const period = parseJson<HeartbeatConfig>(m.config, { period_s: 3600, grace_s: 300 }).period_s * 1000;
		return now + (now - prev) + PING_SLACK_MS - stored > period;
	}

	/** Build state from D1: hot columns from monitors, today's monitor_daily, and the last 48 h of buckets. */
	private async seed(now: number): Promise<void> {
		await this.loadCfg(now, true, false);
		const day = utcDay(now);
		const hour = hourOf(now);
		const [daily, buckets, sysDaily] = await this.db.batch([
			this.db.prepare("SELECT * FROM monitor_daily WHERE day = ?").bind(day),
			this.db.prepare("SELECT monitor_id, hour, data FROM check_buckets WHERE hour >= ? ORDER BY monitor_id, hour").bind(hour - 48 * HOUR),
			this.db.prepare("SELECT * FROM system_daily WHERE day = ?").bind(day),
		]);
		const st: HubState = { v: 1, day, hour, live: {}, bucket: {}, recent: {}, daily: {}, lat: {}, sys: {}, sysDaily: {}, outbox: {}, retention: null };
		const samples = new Map<string, CheckPoint[]>();
		for (const b of buckets.results as { monitor_id: string; hour: number; data: string }[]) {
			const list = samples.get(b.monitor_id) ?? [];
			list.push(...decodeBucket(b.hour, b.data));
			samples.set(b.monitor_id, list);
		}
		const midnight = Math.floor(now / DAY) * DAY;
		for (const m of this.cfg!.monitors) {
			const l = liveFromRow(m);
			const pts = (samples.get(m.id) ?? []).sort((a, b) => a.ts - b.ts);
			st.recent[m.id] = pts.slice(-RECENT_N);
			const cur = pts.filter((p) => p.ts >= hour);
			if (cur.length) st.bucket[m.id] = cur;
			const lat: LatSlot[] = [];
			for (const p of pts) if (p.latency_ms != null && p.ts >= now - DAY - LAT_SLOT_MS) addLatency(lat, p.ts, p.latency_ms, 0);
			// Seeding from 48 h of buckets is the one-time bridge from the old checks table.
			if (lat.length) st.lat[m.id] = lat;
			const last = pts[pts.length - 1];
			if (m.type === "heartbeat" && last) {
				l.acct_at = Math.max(last.ts, midnight);
				l.acct_status = last.status;
			}
			st.live[m.id] = l;
		}
		for (const d of daily.results as (DayCounts & { monitor_id: string })[]) {
			st.daily[d.monitor_id] = { up: d.up, down: d.down, degraded: d.degraded, maint: d.maint, latency_sum: d.latency_sum, latency_n: d.latency_n };
		}
		for (const d of sysDaily.results as (SysDay & { system_id: string })[]) st.sysDaily[d.system_id] = { up: d.up, down: d.down, maint: d.maint, outages: d.outages ?? 0 };
		this.s = st;
		this.hist = null;
		this.version++;
	}

	/** Monitors and maintenances, cached in memory and re-read from D1 every 10 minutes or on reload(). */
	private async loadCfg(now: number, force = false, sync = true): Promise<void> {
		if (!force && this.cfg && now - this.cfg.at < CFG_TTL_MS) return;
		const [mons, maint] = await this.db.batch([
			this.db.prepare("SELECT * FROM monitors ORDER BY sort, name COLLATE NOCASE"),
			this.db.prepare("SELECT * FROM maintenances"),
		]);
		this.cfg = { at: now, monitors: mons.results as MonitorRow[], maint: maint.results as MaintenanceRow[] };
		if (sync && this.s) {
			const ids = new Set(this.cfg.monitors.map((m) => m.id));
			for (const m of this.cfg.monitors) this.S.live[m.id] ??= liveFromRow(m);
			for (const id of Object.keys(this.S.live)) {
				if (ids.has(id)) continue;
				for (const t of [this.S.live, this.S.bucket, this.S.recent, this.S.daily, this.S.lat]) delete t[id];
				for (const k of Object.keys(this.S.outbox)) if (k.split(":")[1] === id) delete this.S.outbox[k];
			}
		}
	}

	private maintenance(now: number) {
		const monitors = new Set<string>();
		const systems = new Set<string>();
		const list = (this.cfg?.maint ?? []).map((r) => toMaintenance(r, now));
		for (const m of list) {
			if (!m.active) continue;
			m.monitor_ids.forEach((id) => monitors.add(id));
			m.system_ids.forEach((id) => systems.add(id));
		}
		return { monitors, systems, list };
	}

	/** 90 days of monitor_daily before today, re-read from D1 once per UTC day. */
	private async ensureHist(now: number): Promise<Hist> {
		const day = utcDay(now);
		if (this.hist?.day === day && this.hist.sys) return this.hist;
		const from = utcDay(now - 90 * DAY);
		const [r, sys] = await this.db.batch([
			this.db.prepare("SELECT * FROM monitor_daily WHERE day >= ? AND day < ?").bind(from, day),
			this.db.prepare("SELECT * FROM system_daily WHERE day >= ? AND day < ?").bind(from, day),
		]);
		this.hist = { day, rows: r.results as Hist["rows"], sys: sys.results as NonNullable<Hist["sys"]> };
		await this.ctx.storage.put("hist", this.hist);
		return this.hist;
	}

	private live(m: MonitorRow): Live {
		return (this.S.live[m.id] ??= liveFromRow(m));
	}

	private dayOf(id: string): DayCounts {
		return (this.S.daily[id] ??= zeroDay());
	}

	/** Attribute [from, to) (capped) to `status` in today's counters. */
	private addMinutes(id: string, status: number, from: number, to: number, cap: number): void {
		const d = this.dayOf(id);
		for (const [day, mins] of minutesByDay(Math.max(from, to - cap), to)) if (day === this.S.day && mins > 0) d[COLS[status] ?? "up"] += mins;
	}

	private queueMonitor(id: string): void {
		const S = this.S;
		const l = S.live[id];
		if (!l) return;
		S.outbox[`m:${id}`] = {
			sql: `UPDATE monitors SET status = ?, fail_streak = ?, down_checks = ?, last_check_at = ?, next_check_at = ?, last_latency_ms = ?, last_message = ?,
			 last_ping_at = ?, run_started_at = ?, domain_expires_at = ?, warned_expiry = ? WHERE id = ?`,
			params: [...LIVE_KEYS.map((k) => l[k] as string | number | null), id],
		};
		const b = S.bucket[id];
		if (b?.length) {
			S.outbox[`b:${id}:${S.hour}`] = {
				sql: "INSERT INTO check_buckets(monitor_id, hour, data) VALUES (?, ?, ?) ON CONFLICT(monitor_id, hour) DO UPDATE SET data = excluded.data",
				params: [id, S.hour, encodeBucket(S.hour, b)],
			};
		}
		const d = S.daily[id];
		if (d) {
			S.outbox[`d:${id}:${S.day}`] = {
				sql: `INSERT INTO monitor_daily(monitor_id, day, up, down, degraded, maint, latency_sum, latency_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(monitor_id, day) DO UPDATE SET up = excluded.up, down = excluded.down, degraded = excluded.degraded, maint = excluded.maint,
				 latency_sum = excluded.latency_sum, latency_n = excluded.latency_n`,
				params: [id, S.day, r3(d.up), r3(d.down), r3(d.degraded), r3(d.maint), d.latency_sum, d.latency_n],
			};
		}
	}

	private queueSystems(): void {
		const S = this.S;
		for (const [id, d] of Object.entries(S.sysDaily)) {
			S.outbox[`s:${id}:${S.day}`] = {
				sql: `INSERT INTO system_daily(system_id, day, up, down, maint, outages) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(system_id, day) DO UPDATE SET up = excluded.up, down = excluded.down, maint = excluded.maint, outages = excluded.outages`,
				params: [id, S.day, r3(d.up), r3(d.down), r3(d.maint), d.outages ?? 0],
			};
		}
	}

	/** Write everything queued in one D1 batch. Entries stay queued (and persisted) if D1 fails. */
	private async flush(extra: Stmt[] = []): Promise<boolean> {
		const entries = Object.entries(this.S.outbox);
		if (!entries.length && !extra.length) return true;
		try {
			await this.db.batch([...entries.map(([, s]) => s), ...extra].map((s) => this.db.prepare(s.sql).bind(...s.params)));
			for (const [k, s] of entries) if (this.S.outbox[k] === s) delete this.S.outbox[k];
			return true;
		} catch (e) {
			console.error("hub: D1 flush failed", (e as Error).message);
			this.mustSave = true; // keep the outbox across an eviction
			return false;
		}
	}

	/** Hour and day boundaries: queue every bucket, daily row and hot row for D1. */
	private roll(now: number): void {
		const S = this.S;
		const hour = hourOf(now);
		if (hour === S.hour) return;
		const today = utcDay(now);
		const newDay = today !== S.day;
		if (newDay) {
			const midnight = Math.floor(now / DAY) * DAY;
			for (const m of this.cfg?.monitors ?? []) {
				const l = S.live[m.id];
				if (m.type !== "heartbeat" || m.paused || !l || l.acct_at == null || l.acct_status == null || l.acct_at >= midnight) continue;
				this.addMinutes(m.id, l.acct_status, l.acct_at, midnight, hbCap(m));
				l.acct_at = midnight;
			}
			for (const [id, a] of Object.entries(S.sys)) {
				if (a.at != null && a.at < midnight) this.sysMinutes(id, a, midnight, false);
				if (a.at != null) a.at = Math.max(a.at, midnight);
			}
		}
		for (const id of Object.keys(S.live)) this.queueMonitor(id);
		this.queueSystems();
		S.bucket = {};
		if (newDay) {
			S.daily = {};
			S.sysDaily = {};
			S.day = today;
		}
		S.hour = hour;
		this.version++;
		// Never roll the same hour twice from an older snapshot (it would overwrite D1 buckets).
		this.mustSave = true;
	}

	/**
	 * Minutes since the last sample, by the status pages' view: an outage only counts as down after
	 * the system's grace ("Consider down after"); its first minutes (and outages that end sooner) count as up.
	 */
	private sysMinutes(id: string, a: SysAcct, to: number, inMaint: boolean): void {
		if (a.at == null || (a.status !== "up" && a.status !== "down")) return;
		const from = Math.max(a.at, to - 5 * 60_000);
		const segs: [keyof SysDay, number, number][] = [];
		if (inMaint) segs.push(["maint", from, to]);
		else if (a.status === "down" && a.g) {
			const edge = (a.since ?? 0) + a.g;
			if (edge > from) segs.push(["up", from, Math.min(edge, to)]);
			if (edge < to) segs.push(["down", Math.max(edge, from), to]);
		} else segs.push([a.status, from, to]);
		const d = this.sysDay(id);
		for (const [col, f, t] of segs) for (const [day, mins] of minutesByDay(f, t)) if (day === this.S.day && mins > 0) d[col] = (d[col] ?? 0) + mins;
	}

	private sysDay(id: string): SysDay {
		return (this.S.sysDaily[id] ??= { up: 0, down: 0, maint: 0, outages: 0 });
	}

	/** Per-system minutes up/down/in maintenance for today, sampled once per tick (system_daily). */
	private accountSystems(rows: { id: string; status: string; down_after?: number | null }[], maintSystems: Set<string>, now: number): void {
		const seen = new Set<string>();
		for (const r of rows) {
			seen.add(r.id);
			const a = (this.S.sys[r.id] ??= { status: null, at: null });
			const g = pageGraceMs(r.down_after);
			const prev = a.status == null || a.at == null ? null : pageSystemStatus(a.status, a.since, a.g ?? 0, a.at);
			a.g = g;
			this.sysMinutes(r.id, a, now, maintSystems.has(r.id));
			if (a.status != null && a.status !== r.status) this.mustSave = true;
			if (r.status === "down") {
				if (a.status !== "down") a.since = a.status == null ? 0 : now; // first sample after a restart: unknown start
			} else delete a.since;
			// An outage (status pages) is a seen transition into "down" that outlasted the grace, so
			// shorter ones never count; not counted on the first sample after a restart.
			const cur = pageSystemStatus(r.status, a.since, g, now);
			if (cur === "down" && prev != null && prev !== "down" && !maintSystems.has(r.id)) {
				const d = this.sysDay(r.id);
				d.outages = (d.outages ?? 0) + 1;
			}
			a.status = r.status;
			a.at = now;
		}
		for (const id of Object.keys(this.S.sys)) if (!seen.has(id)) delete this.S.sys[id];
	}

	/** Fold this minute's CPU % per system into 15-minute slots (24 h kept); drop deleted systems. */
	private recordCpu(rows: { id: string; status: string }[], cpu: Record<string, number>, now: number): void {
		const S = this.S;
		const all = (S.cpu ??= {});
		const cur = (S.cpuNow ??= {});
		const ids = new Set(rows.map((r) => r.id));
		for (const r of rows) {
			const v = cpu[r.id];
			if (r.status !== "up" || typeof v !== "number" || !Number.isFinite(v)) continue;
			const pct = Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
			all[r.id] = addLatency(all[r.id] ?? [], now, pct, now - DAY - LAT_SLOT_MS);
			const s = all[r.id][all[r.id].length - 1];
			s[1] = Math.round(s[1] * 10) / 10;
			cur[r.id] = [now, pct];
		}
		for (const id of Object.keys(all)) if (!ids.has(id)) delete all[id];
		for (const id of Object.keys(cur)) if (!ids.has(id)) delete cur[id];
	}

	/** State machine + history + incidents + notifications for one outcome (was engine.recordOutcome). */
	private async record(m: MonitorRow, raw: CheckResult, inMaint: boolean, now: number): Promise<void> {
		const S = this.S;
		const l = this.live(m);
		const prev = l.status;
		const prevStreak = l.fail_streak;
		const s = nextState(
			{ prev: l.status, fail_streak: l.fail_streak, down_checks: l.down_checks, retries: m.retries, upside_down: !!m.upside_down, max_latency_ms: m.max_latency_ms, resend_every: m.resend_every },
			raw,
			inMaint,
		);
		// A heartbeat run in progress shows as "running" while it is not overdue.
		let status = s.status;
		if (m.type === "heartbeat" && l.run_started_at && (!l.last_ping_at || l.run_started_at > l.last_ping_at) && s.check_status !== 0 && !inMaint) status = "running";
		const latency = raw.latency_ms;

		const d = this.dayOf(m.id);
		if (m.type === "heartbeat") {
			// Minutes per state, attributed to the previous status when the next outcome arrives.
			if (l.acct_at != null && l.acct_status != null) this.addMinutes(m.id, l.acct_status, l.acct_at, now, hbCap(m));
			else d[COLS[s.check_status]] += 1;
			l.acct_at = now;
			l.acct_status = s.check_status;
		} else d[COLS[s.check_status]] += 1;
		if (latency != null) {
			d.latency_sum += latency;
			d.latency_n += 1;
			S.lat[m.id] = addLatency(S.lat[m.id] ?? [], now, latency, now - DAY - LAT_SLOT_MS);
		}
		const rec = (S.recent[m.id] ??= []);
		const last = rec[rec.length - 1];
		// Heartbeat history stays sparse as before: a sample only on a status change, a new UTC day,
		// latency data, or once per HB_FLUSH_MS.
		const unchanged =
			m.type === "heartbeat" && last && last.status === s.check_status && !s.transition && utcDay(last.ts) === utcDay(now) && now - last.ts < HB_FLUSH_MS && latency == null;
		if (!unchanged) {
			const p: CheckPoint = { ts: now, status: s.check_status, latency_ms: latency, message: s.message };
			(S.bucket[m.id] ??= []).push(p);
			rec.push(p);
			if (rec.length > RECENT_N) rec.splice(0, rec.length - RECENT_N);
		}

		l.status = status;
		l.fail_streak = s.fail_streak;
		l.down_checks = s.down_checks;
		l.last_check_at = now;
		// Heartbeats are re-evaluated on every tick (see tick()); their interval/retry fields are hidden in the UI.
		l.next_check_at = now + (m.type === "heartbeat" ? 60 : s.retrying ? m.retry_interval_s : m.interval_s) * 1000;
		l.last_latency_ms = latency;
		l.last_message = s.message;
		if (raw.domain_expires_at != null) l.domain_expires_at = raw.domain_expires_at;

		const extra: Stmt[] = [];
		if (s.transition === "down") {
			extra.push({ sql: "INSERT INTO incidents(id, monitor_id, started_at, cause, last_notified_at) VALUES (?, ?, ?, ?, ?)", params: [newId(), m.id, now, s.message, now] });
		} else if (s.transition === "up") {
			extra.push({ sql: "UPDATE incidents SET resolved_at = ? WHERE monitor_id = ? AND resolved_at IS NULL", params: [now, m.id] });
		}
		// A retry streak must survive an eviction, or a monitor with retries could keep retrying instead of going down.
		if (norm(status) !== norm(prev) || s.transition || s.reminder || s.fail_streak !== prevStreak) this.mustSave = true;
		if (norm(status) !== norm(prev) || s.transition) {
			this.version++;
			this.queueMonitor(m.id);
			// Incident rows ride in the outbox too so a D1 hiccup cannot lose them.
			extra.forEach((x, i) => (S.outbox[`i:${m.id}:${now}:${i}`] = x));
			await this.flush();
		}

		const db = this.db;
		const url = m.type === "http" ? parseJson<HttpConfig>(m.config, { url: "" }).url : null;
		try {
			if (s.transition === "down") {
				await addEvent(db, "monitor_down", m.id, `${m.name} is down: ${s.message ?? ""}`);
				await notify(this.env, { monitorId: m.id }, { title: `🔴 ${m.name} is DOWN`, body: s.message ?? "Check failed", status: "down", name: m.name, url });
			} else if (s.transition === "up") {
				const inc = await db.prepare("SELECT started_at FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 1").bind(m.id).first<{ started_at: number }>();
				const dur = inc ? formatDuration(now - inc.started_at) : "a while";
				await addEvent(db, "monitor_up", m.id, `${m.name} is back up after ${dur}`);
				await notify(this.env, { monitorId: m.id }, { title: `🟢 ${m.name} is UP`, body: `Recovered after ${dur}. ${s.message ?? ""}`.trim(), status: "up", name: m.name, url });
			} else if (s.reminder) {
				const inc = await db
					.prepare("SELECT id, started_at, reminders FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL")
					.bind(m.id)
					.first<{ id: string; started_at: number; reminders: number }>();
				if (inc) {
					await db.prepare("UPDATE incidents SET reminders = reminders + 1, last_notified_at = ? WHERE id = ?").bind(now, inc.id).run();
					await notify(this.env, { monitorId: m.id }, {
						title: `🔴 ${m.name} is still DOWN (reminder #${inc.reminders + 1})`,
						body: `Down for ${formatDuration(now - inc.started_at)}: ${s.message ?? ""}`,
						status: "down",
						name: m.name,
						url,
					});
				}
			}
			// Domain expiry warning: once per expiry date.
			if (raw.degraded && raw.domain_expires_at && l.warned_expiry !== raw.domain_expires_at && !inMaint) {
				l.warned_expiry = raw.domain_expires_at;
				this.mustSave = true;
				this.queueMonitor(m.id);
				await notify(this.env, { monitorId: m.id }, { title: `⚠️ ${m.name}: domain expiring`, body: raw.message ?? "", status: "warning", name: m.name, url });
			}
		} catch (e) {
			console.error(`monitor ${m.id}: event/notify failed`, (e as Error).message);
		}
	}

	// ------------------------------------------------------------------ RPC

	/** Cron entry: run every due monitor within the subrequest budget, then groups, then flush. */
	async tick(now = Date.now(), cpu: Record<string, number> = {}): Promise<{ ran: number; skipped: number; busy?: boolean }> {
		await this.ready();
		if (this.busy && now - this.busy < 5 * 60_000) return { ran: 0, skipped: 0, busy: true };
		this.busy = now;
		try {
			await this.loadCfg(now);
			this.roll(now);
			const sysRows = (await this.db.prepare("SELECT id, name, status, down_after FROM systems").all<{ id: string; name: string; status: string; down_after: number | null }>()).results;
			const sysMap = new Map(sysRows.map((r) => [r.id, r]));
			const maint = this.maintenance(now);
			this.accountSystems(sysRows, maint.systems, now);
			this.recordCpu(sysRows, cpu, now);

			const due = this.cfg!.monitors
				.filter((m) => !m.paused && m.type !== "group")
				.map((m) => overlay(m, this.live(m)))
				// Heartbeats cost nothing to evaluate (no subrequests), so they run every tick: Late/Down land
				// within a minute of the deadline instead of waiting for a hidden 5-minute check interval.
				.filter((m) => m.type === "heartbeat" || m.next_check_at == null || m.next_check_at <= now + 5000)
				.sort((a, b) => (a.next_check_at ?? 0) - (b.next_check_at ?? 0));
			let budget = Number(this.env.SUBREQUEST_BUDGET || 40);
			let skipped = 0;
			const queue: MonitorRow[] = [];
			for (const m of due) {
				const cost = ACTIVE_COST[m.type] ?? 0;
				if (cost > budget) {
					skipped++;
					continue;
				}
				budget -= cost;
				queue.push(m);
			}
			if (skipped) console.warn(`subrequest budget exhausted: ${skipped} monitors deferred to next minute`);
			const inMaint = (m: MonitorRow) => {
				const sys = systemOf(m);
				return maint.monitors.has(m.id) || (m.parent_id != null && maint.monitors.has(m.parent_id)) || (sys != null && maint.systems.has(sys));
			};
			// One snapshot read per Proxmox host per tick, shared by all of its guest monitors.
			const pveCache = new Map<string, ReturnType<typeof latestPve>>();
			const deps = {
				system: (id: string) => sysMap.get(id) ?? null,
				containers: (id: string) => latestContainers(this.env, id),
				pve: (id: string) => {
					if (!pveCache.has(id)) pveCache.set(id, latestPve(this.env, id));
					return pveCache.get(id)!;
				},
			};
			let ran = 0;
			const worker = async () => {
				for (let m = queue.shift(); m; m = queue.shift()) {
					try {
						const raw = await runCheck(this.env, m, now, deps);
						if (!raw) {
							this.live(m).next_check_at = now + m.interval_s * 1000;
							continue;
						}
						await this.record(m, raw, inMaint(m), Date.now());
						// Heartbeat evaluations are pure functions of stored state: losing one to a restart just
						// repeats it next minute. Anything else (HTTP, containers) is a real sample worth keeping.
						if (m.type !== "heartbeat") this.mustSave = true;
						ran++;
					} catch (e) {
						console.error(`monitor ${m.id} failed`, (e as Error).stack);
					}
				}
			};
			await Promise.all(Array.from({ length: 10 }, worker));
			await this.groups(maint.monitors, now);
			await this.retention(now);
			await this.flush();
			await this.persist(now);
			return { ran, skipped };
		} finally {
			this.busy = 0;
		}
	}

	/** Group monitors take the worst status of their (unpaused) children. */
	private async groups(maintIds: Set<string>, now: number): Promise<void> {
		const mons = this.cfg!.monitors;
		for (const g of mons) {
			if (g.type !== "group" || g.paused) continue;
			const gl = this.live(g);
			if (gl.next_check_at != null && gl.next_check_at > now + 5000) continue;
			const kids = mons.filter((k) => k.parent_id === g.id && !k.paused).map((k) => this.live(k).status);
			if (!kids.length) {
				gl.next_check_at = now + g.interval_s * 1000;
				continue;
			}
			const worst = kids.reduce((a, k) => (RANK[k] > RANK[a] ? k : a), "pending" as string);
			if (worst === "pending") continue;
			const raw: CheckResult =
				worst === "down"
					? { ok: false, latency_ms: null, message: `${kids.filter((k) => k === "down").length} of ${kids.length} down` }
					: { ok: true, degraded: worst === "degraded", latency_ms: null, message: `${kids.length} monitors` };
			await this.record({ ...g, retries: 0, upside_down: 0, max_latency_ms: null }, raw, maintIds.has(g.id), now);
		}
	}

	/** Daily D1 retention, run on the first tick of each UTC day. */
	private async retention(now: number): Promise<void> {
		if (this.S.retention === this.S.day) return;
		try {
			await this.db.batch([
				this.db.prepare("DELETE FROM check_buckets WHERE hour < ?").bind(hourOf(now - 7 * DAY)),
				this.db.prepare("DELETE FROM events WHERE ts < ?").bind(now - 90 * DAY),
				this.db.prepare("DELETE FROM notification_log WHERE ts < ?").bind(now - 90 * DAY),
				this.db.prepare("DELETE FROM monitor_daily WHERE day < ?").bind(utcDay(now - 400 * DAY)),
				this.db.prepare("DELETE FROM system_daily WHERE day < ?").bind(utcDay(now - 400 * DAY)),
				this.db.prepare("DELETE FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?").bind(now - 400 * DAY),
			]);
			this.S.retention = this.S.day;
			this.mustSave = true;
		} catch (e) {
			console.error("hub: retention failed", (e as Error).message);
		}
	}

	/** Heartbeat ping. Only a status change touches D1. */
	async ping(token: string, action: string, ok: boolean, message: string | null, latency: number | null): Promise<PingReply> {
		await this.ready();
		const now = Date.now();
		await this.loadCfg(now);
		const find = () => this.cfg!.monitors.find((x) => x.push_token === token && x.type === "heartbeat");
		let m = find();
		if (!m && now - this.cfg!.at > 30_000) {
			await this.loadCfg(now, true);
			m = find();
		}
		if (!m) return { status: 404, body: { ok: false, error: "unknown token" } };
		if (m.paused) return { status: 200, body: { ok: true, paused: true } };
		this.roll(now);
		const l = this.live(m);
		if (action === "start") {
			l.run_started_at = now;
			if (l.status !== "down") l.status = "running";
			this.mustSave = true;
		} else {
			const prev = l.last_ping_at;
			const hadRun = l.run_started_at != null;
			l.last_ping_at = now;
			l.run_started_at = null;
			await this.record(m, { ok, latency_ms: latency, message }, this.maintenance(now).monitors.has(m.id), now);
			if (hadRun || this.pingNeedsSave(m, prev, now)) this.mustSave = true;
		}
		await this.persist(now);
		return { status: 200, body: { ok: true } };
	}

	private todayCounts(now: number): Record<string, DayCounts> {
		const S = this.S;
		const sameDay = S.day === utcDay(now);
		const midnight = Math.floor(now / DAY) * DAY;
		const out: Record<string, DayCounts> = {};
		for (const m of this.cfg?.monitors ?? []) {
			const d = { ...(sameDay ? (S.daily[m.id] ?? zeroDay()) : zeroDay()) };
			const l = S.live[m.id];
			if (m.type === "heartbeat" && !m.paused && l?.acct_at != null && l.acct_status != null) {
				const from = Math.max(l.acct_at, midnight, now - hbCap(m));
				if (now > from) d[COLS[l.acct_status] ?? "up"] += (now - from) / 60_000;
			}
			out[m.id] = d;
		}
		return out;
	}

	/** Live state for dashboard reads. */
	async view(): Promise<HubView> {
		await this.ready();
		const now = Date.now();
		await this.loadCfg(now);
		const hist = await this.ensureHist(now);
		const yday = utcDay(now - DAY);
		const yesterday: Record<string, DayCounts> = {};
		for (const r of hist.rows) if (r.day === yday) yesterday[r.monitor_id] = { up: r.up, down: r.down, degraded: r.degraded, maint: r.maint, latency_sum: r.latency_sum, latency_n: r.latency_n };
		return { now, live: this.S.live, recent: this.S.recent, today: this.todayCounts(now), yesterday };
	}

	/** One monitor's live columns and today's counts (badges). */
	async monitorState(id: string): Promise<{ live: Live | null; today: DayCounts | null }> {
		await this.ready();
		const now = Date.now();
		return { live: this.S.live[id] ?? null, today: this.todayCounts(now)[id] ?? null };
	}

	/** Check history since `since`: closed hours from D1 (one row each) plus the in-progress hour. */
	async checks(id: string, since: number): Promise<CheckPoint[]> {
		await this.ready();
		const S = this.S;
		const rows = await this.db
			.prepare("SELECT hour, data FROM check_buckets WHERE monitor_id = ? AND hour >= ? AND hour < ? ORDER BY hour")
			.bind(id, hourOf(since), S.hour)
			.all<{ hour: number; data: string }>();
		const pts = rows.results.flatMap((r) => decodeBucket(r.hour, r.data));
		pts.push(...(S.bucket[id] ?? []));
		return pts.filter((p) => p.ts >= since);
	}

	/** Public status page JSON, rebuilt at most every 10 s on change and otherwise once a minute. */
	async publicPage(host: string, slug: string | null): Promise<string | null> {
		await this.ready();
		const now = Date.now();
		const key = slug ? `s:${slug}` : `h:${host}`;
		const hit = this.pages.get(key);
		if (hit && now - hit.at < PAGE_TTL_MS && (hit.v === this.version || now - hit.at < PAGE_MIN_MS)) return hit.json;
		await this.loadCfg(now);
		const row = await pageFor(this.env, host, slug ?? undefined);
		let json: string | null = null;
		if (row) {
			const hist = await this.ensureHist(now);
			const today = this.todayCounts(now);
			const byId = new Map(this.cfg!.monitors.map((m) => [m.id, m]));
			const src: PageSource = {
				monitors: (ids) => ids.map((id) => byId.get(id)).filter((m): m is MonitorRow => !!m).map((m) => overlay(m, this.S.live[m.id])),
				daily: (ids, fromDay, t) => {
					const set = new Set(ids);
					const day = utcDay(t);
					const rows = hist.rows.filter((r) => set.has(r.monitor_id) && r.day >= fromDay && r.day < day);
					for (const id of ids) if (today[id]) rows.push({ monitor_id: id, day, ...today[id] });
					return rows;
				},
				latency: (ids, from) => {
					const out = new Map<string, { ts: number; ms: number }[]>();
					for (const id of ids) out.set(id, (this.S.lat[id] ?? []).filter((x) => x[0] >= from && x[2] > 0).map(([ts, sum, n]) => ({ ts, ms: Math.round(sum / n) })));
					return out;
				},
				maintenance: (t) => this.maintenance(t),
				cpu: (ids, from, t) => {
					const out = new Map<string, { series: { ts: number; pct: number }[]; now: number | null }>();
					for (const id of ids) {
						const series = (this.S.cpu?.[id] ?? []).filter((x) => x[0] >= from && x[2] > 0).map(([ts, sum, n]) => ({ ts, pct: Math.round((sum / n) * 10) / 10 }));
						const last = this.S.cpuNow?.[id];
						out.set(id, { series, now: last && t - last[0] < 5 * 60_000 ? last[1] : null });
					}
					return out;
				},
				systemDownSince: (id, t) => {
					const a = this.S.sys[id];
					if (!a) return 0;
					return a.status === "down" ? (a.since ?? 0) : t; // not sampled yet: it just went down
				},
				systemDaily: (ids, fromDay, t) => {
					const set = new Set(ids);
					const day = utcDay(t);
					const rows = (hist.sys ?? []).filter((r) => set.has(r.system_id) && r.day >= fromDay && r.day < day);
					for (const id of ids) {
						const d = this.S.sysDaily[id];
						if (d) rows.push({ system_id: id, day, ...d });
					}
					return rows;
				},
			};
			json = JSON.stringify(await buildPublicPage(this.env, row, src));
		}
		this.pages.set(key, { at: now, v: this.version, json });
		return json;
	}

	/**
	 * Called after admin changes: re-read monitors/maintenances, apply resets to live state
	 * (e.g. resume → pending), or rebuild everything from D1 after an import.
	 */
	async reload(opts: { reset?: Record<string, Partial<Live>>; reseed?: boolean } = {}): Promise<void> {
		await this.ready();
		const now = Date.now();
		if (opts.reseed) {
			await this.flush();
			await this.seed(now);
		} else {
			await this.loadCfg(now, true);
			for (const [id, patch] of Object.entries(opts.reset ?? {})) {
				const l = this.S.live[id];
				if (!l) continue;
				Object.assign(l, patch);
				this.queueMonitor(id);
			}
			if (opts.reset) await this.flush();
		}
		this.version++;
		this.pages.clear();
		await this.save();
	}
}
