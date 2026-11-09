import { connect } from "cloudflare:sockets";
import type { DnsConfig, DomainConfig, HttpConfig, TcpConfig } from "../../shared/types";

/** Raw result of one active check, before upside-down / retries / maintenance are applied. */
export interface CheckResult {
	ok: boolean;
	latency_ms: number | null;
	message: string | null;
	degraded?: boolean; // e.g. domain expiring soon
	domain_expires_at?: number;
}

const MAX_BODY = 1024 * 1024;

/**
 * Like AbortSignal.timeout, but the timer is cleared once the check settles. A pending
 * AbortSignal.timeout timer keeps the Hub Durable Object's invocation open (billed wall time)
 * for the full timeout even after the fetch has finished.
 */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(new DOMException(`Timeout after ${ms} ms`, "TimeoutError")), ms);
	return { signal: ac.signal, clear: () => clearTimeout(t) };
}

/** "200-299", "301" → predicate. */
export function parseAcceptedCodes(codes: string[] | undefined): (status: number) => boolean {
	const list = codes?.length ? codes : ["200-299"];
	const ranges = list.map((c) => {
		const [a, b] = c.split("-").map((x) => Number(x.trim()));
		return [a, Number.isFinite(b) ? b : a] as const;
	});
	return (s) => ranges.some(([a, b]) => s >= a && s <= b);
}

/** "$.a.b[0].c" or "a.b[0].c" → value or undefined. */
export function jsonPath(obj: unknown, path: string): unknown {
	const parts = path
		.replace(/^\$\.?/, "")
		.split(/\.|\[(\d+)\]/)
		.filter((p) => p !== undefined && p !== "");
	let cur: unknown = obj;
	for (const p of parts) {
		if (cur == null) return undefined;
		cur = /^\d+$/.test(p) && Array.isArray(cur) ? cur[Number(p)] : (cur as Record<string, unknown>)[p];
	}
	return cur;
}

async function readCapped(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BODY) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	reader.cancel().catch(() => {});
	const buf = new Uint8Array(Math.min(size, MAX_BODY));
	let o = 0;
	for (const c of chunks) {
		const take = Math.min(c.length, buf.length - o);
		buf.set(c.subarray(0, take), o);
		o += take;
		if (o >= buf.length) break;
	}
	return new TextDecoder().decode(buf);
}

export async function checkHttp(cfg: HttpConfig, timeoutMs: number): Promise<CheckResult> {
	const start = Date.now();
	const dl = deadline(timeoutMs);
	try {
		const res = await fetch(cfg.url, {
			method: cfg.method || "GET",
			headers: { "user-agent": "Richter-Monitor/1.0 (+https://github.com/)", ...(cfg.headers ?? {}) },
			body: cfg.body && !["GET", "HEAD"].includes((cfg.method || "GET").toUpperCase()) ? cfg.body : undefined,
			redirect: cfg.follow_redirects === false ? "manual" : "follow",
			signal: dl.signal,
		});
		const needBody = !!(cfg.keyword || cfg.json_path);
		const body = needBody ? await readCapped(res) : (res.body?.cancel().catch(() => {}), "");
		const latency = Date.now() - start;
		if (!parseAcceptedCodes(cfg.accepted_codes)(res.status)) {
			return { ok: false, latency_ms: latency, message: `HTTP ${res.status} ${res.statusText}`.trim() };
		}
		if (cfg.keyword) {
			const found = body.includes(cfg.keyword);
			if (found === !!cfg.invert_keyword) {
				return { ok: false, latency_ms: latency, message: cfg.invert_keyword ? `Keyword "${cfg.keyword}" found` : `Keyword "${cfg.keyword}" not found` };
			}
		}
		if (cfg.json_path) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(body);
			} catch {
				return { ok: false, latency_ms: latency, message: "Response is not JSON" };
			}
			const v = jsonPath(parsed, cfg.json_path);
			if (v === undefined) return { ok: false, latency_ms: latency, message: `Nothing at ${cfg.json_path}` };
			if (cfg.json_expected !== undefined && cfg.json_expected !== "" && String(v) !== cfg.json_expected) {
				return { ok: false, latency_ms: latency, message: `${cfg.json_path} = ${JSON.stringify(v).slice(0, 80)}, expected ${cfg.json_expected}` };
			}
		}
		return { ok: true, latency_ms: latency, message: `HTTP ${res.status}` };
	} catch (e) {
		const err = e as Error;
		const msg = err.name === "TimeoutError" ? `Timeout after ${timeoutMs} ms` : err.message;
		return { ok: false, latency_ms: null, message: msg };
	} finally {
		dl.clear();
	}
}

export async function checkTcp(cfg: TcpConfig, timeoutMs: number): Promise<CheckResult> {
	const start = Date.now();
	let socket: ReturnType<typeof connect> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		socket = connect({ hostname: cfg.host, port: cfg.port });
		await Promise.race([
			socket.opened,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
		return { ok: true, latency_ms: Date.now() - start, message: `Connected to ${cfg.host}:${cfg.port}` };
	} catch (e) {
		return { ok: false, latency_ms: null, message: (e as Error).message };
	} finally {
		clearTimeout(timer);
		socket?.close().catch(() => {});
	}
}

/**
 * TCP check run by the external probe (probe/server.mjs). Workers can't open port 25 or reach private
 * networks, so the probe connects for us and reports back over HTTPS.
 */
export async function checkTcpViaProbe(cfg: TcpConfig, timeoutMs: number, probeUrl: string | undefined, token: string | undefined): Promise<CheckResult> {
	if (!probeUrl) return { ok: false, latency_ms: null, message: "No probe configured (set probeUrl and redeploy)" };
	const url = new URL("/tcp", probeUrl);
	url.searchParams.set("host", cfg.host);
	url.searchParams.set("port", String(cfg.port));
	url.searchParams.set("timeout_ms", String(timeoutMs));
	if (cfg.expect_banner) url.searchParams.set("expect", cfg.expect_banner);
	// Give the probe its own timeout plus a little for the round trip.
	const dl = deadline(timeoutMs + 5000);
	try {
		const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: dl.signal });
		if (!res.ok) return { ok: false, latency_ms: null, message: `Probe HTTP ${res.status}` };
		const j = (await res.json()) as { ok?: boolean; latency_ms?: number | null; message?: string };
		return { ok: j.ok === true, latency_ms: j.ok ? (j.latency_ms ?? null) : null, message: `${j.message ?? ""} (via probe)`.trim() };
	} catch (e) {
		const err = e as Error;
		return { ok: false, latency_ms: null, message: `Probe unreachable: ${err.name === "TimeoutError" ? "timeout" : err.message}` };
	} finally {
		dl.clear();
	}
}

const DNS_STATUS: Record<number, string> = { 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED" };
const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };

export async function checkDns(cfg: DnsConfig, timeoutMs: number): Promise<CheckResult> {
	const start = Date.now();
	const type = (cfg.record_type || "A").toUpperCase();
	const dl = deadline(timeoutMs);
	try {
		const url = new URL(cfg.resolver || "https://cloudflare-dns.com/dns-query");
		url.searchParams.set("name", cfg.name);
		url.searchParams.set("type", type);
		const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: dl.signal });
		const latency = Date.now() - start;
		if (!res.ok) return { ok: false, latency_ms: latency, message: `Resolver HTTP ${res.status}` };
		const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
		if (j.Status !== 0) return { ok: false, latency_ms: latency, message: DNS_STATUS[j.Status] ?? `DNS status ${j.Status}` };
		const answers = (j.Answer ?? []).filter((a) => a.type === DNS_TYPES[type]).map((a) => a.data);
		if (!answers.length) return { ok: false, latency_ms: latency, message: `No ${type} records` };
		const missing = (cfg.expected ?? []).filter((e) => !answers.includes(e));
		if (missing.length) return { ok: false, latency_ms: latency, message: `Missing ${missing.join(", ")}; got ${answers.join(", ")}` };
		return { ok: true, latency_ms: latency, message: answers.slice(0, 4).join(", ") };
	} catch (e) {
		return { ok: false, latency_ms: null, message: (e as Error).message };
	} finally {
		dl.clear();
	}
}

let rdapBootstrap: { at: number; services: [string[], string[]][] } | null = null;

export async function checkDomain(cfg: DomainConfig, timeoutMs: number): Promise<CheckResult> {
	const start = Date.now();
	const dl = deadline(timeoutMs);
	try {
		if (!rdapBootstrap || Date.now() - rdapBootstrap.at > 86_400_000) {
			const r = await fetch("https://data.iana.org/rdap/dns.json", { signal: dl.signal });
			rdapBootstrap = { at: Date.now(), services: ((await r.json()) as { services: [string[], string[]][] }).services };
		}
		const domain = cfg.domain.toLowerCase().replace(/\.$/, "");
		const tld = domain.split(".").pop()!;
		const service = rdapBootstrap.services.find(([tlds]) => tlds.includes(tld));
		const base = service?.[1].find((u) => u.startsWith("https://"));
		if (!base) return { ok: false, latency_ms: null, message: `No RDAP service for .${tld}` };
		const res = await fetch(`${base.replace(/\/$/, "")}/domain/${domain}`, {
			headers: { accept: "application/rdap+json" },
			signal: dl.signal,
		});
		const latency = Date.now() - start;
		if (!res.ok) return { ok: false, latency_ms: latency, message: `RDAP HTTP ${res.status}` };
		const j = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
		const exp = j.events?.find((e) => e.eventAction === "expiration");
		if (!exp) return { ok: false, latency_ms: latency, message: "No expiration date in RDAP reply" };
		const at = Date.parse(exp.eventDate);
		const days = Math.floor((at - Date.now()) / 86_400_000);
		if (days < 0) return { ok: false, latency_ms: latency, message: `Expired on ${exp.eventDate.slice(0, 10)}`, domain_expires_at: at };
		const warn = cfg.warn_days ?? 30;
		return {
			ok: true,
			degraded: days <= warn,
			latency_ms: latency,
			message: `Expires ${exp.eventDate.slice(0, 10)} (${days} days)`,
			domain_expires_at: at,
		};
	} catch (e) {
		return { ok: false, latency_ms: null, message: (e as Error).message };
	} finally {
		dl.clear();
	}
}
