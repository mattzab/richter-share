import { DurableObject } from "cloudflare:workers";
import { ensureSchema, addEvent, parseJson } from "../db";
import type { Env } from "../env";
import { evaluateSystemAlerts, type PendingStatusAlert, sendPendingStatusAlert, systemStatusChanged } from "./alerts";
import { getHubKey, signToken } from "./keys";
import { RETENTION_1M, rollupContainers, rollupStats, TIERS } from "./rollup";
import type { ContainerStat, PackageUpdate, PveSnapshot, SystemdService, SystemInfo, SystemStats } from "../../shared/types";
import { discoverGuests, guestKey } from "./pve";
import { dashboardTemp, decodeResponse, fingerprintRequest, getDataRequest, type NormalizedPackages, normalizeCombinedData, normalizePackageUpdates, packageUpdatesRequest } from "./protocol";
import { type AlertRow, evaluatePackageAlerts, evaluateSystemdAlerts, hash, UPDATE_METRICS } from "./update-alerts";

/**
 * One Durable Object per Beszel system. Holds the agent's outbound WebSocket using the
 * hibernation API. The Worker's cron calls poll() every minute; a sparse watchdog alarm falls
 * back to self-polling if the cron stops.
 *
 * Storage is billed per row written (each KV key put, each setAlarm), so samples are buffered
 * in the socket attachment (survives hibernation, not billed) and persisted together about
 * every 10 minutes, at the rollup boundary, as one packed "hot" key (live info, the last hour
 * of 1m records, the 10m tier). The 20m/120m/480m tiers are one packed key each, written only
 * when a period closes. Up to ~10 minutes of 1m chart data can be lost if the object is reset
 * without a close (e.g. a deploy).
 *
 * Mirrors internal/hub/agent_connect.go + internal/hub/ws in henrygd/beszel.
 */

const POLL_MS = 60_000;
const SILENCE_CLOSE_MS = 100_000; // matches beszel hub ws deadline
const DOWN_GRACE_MS = 10_000; // reconnect grace before marking down
const VERIFY_TIMEOUT_MS = 30_000;
const PKG_REPLY_MS = 45_000; // give up waiting for a GetPackageUpdates reply after this
const PKG_REFRESH_MS = 6 * 3_600_000; // re-fetch the package list at least this often
const D1_SEEN_MS = 12 * 60_000; // refresh systems.info/last_seen in D1 at most this often
const ROLLUP_LAG_MS = 35_000; // a period's last 1m record lands up to ~30 s after its end
export const WATCHDOG_MS = 30 * 60_000; // sparse alarm that notices a stopped cron
export const CRON_STALE_MS = 150_000; // no cron poll for this long: poll from alarms instead
export const BUF_MAX = 10_000; // flush early once the gzipped buffer gets this big (attachments max 16 KiB)
const FLUSH_PERIOD_MS = 10 * 60_000; // = the 10m tier

/** One stored record of a rolled-up tier: [period end, system stats, containers]. */
type Rec = [number, SystemStats | null, ContainerStat[] | null];
/** A buffered 1m sample, not yet (or just) persisted. */
type Sample = [number, SystemStats, ContainerStat[] | null];

/** v2 live state, one storage key. */
interface Hot {
	v: 2;
	info: SystemInfo | null;
	last_seen: number | null;
	s1: [number, SystemStats][];
	c1: [number, ContainerStat[]][];
	t10: Rec[];
	rolled: Record<string, number>;
}

/** v1 layout ("hot" + "c1" keys, tiers in a SQLite table). */
interface HotV1 {
	info: SystemInfo | null;
	last_seen: number | null;
	s1: [number, SystemStats][];
	rolled: Record<string, number>;
}

type Kind = "s" | "c";
const TIER_KEYS = ["t:20m", "t:120m", "t:480m"] as const;

interface PendingPackages {
	id: number;
	at: number;
}

interface Attachment {
	systemId: string;
	agentVersion: string;
	verified: boolean;
	fpRequestId: number;
	openedAt: number;
	// Live fields; older attachments lack them.
	info?: SystemInfo | null;
	last_seen?: number | null;
	d1_seen?: number | null;
	polledAt?: number;
	/** gzip(JSON Sample[]): samples newer than `flushed`, plus the last persisted one. */
	buf?: Uint8Array | null;
	flushed?: number;
	/** Flush at or after this time (next 10m rollup boundary). */
	due?: number;
	/** When info.dt was last really observed (agent or sensors), for dashboardTemp's carry-over. */
	dtAt?: number;
}

interface SystemRow {
	id: string;
	name: string;
	token: string;
	fingerprint: string | null;
	status: string;
	details: string | null;
}

/** DO storage key of the Status alert DOWN waiting for its minutes (see alerts.ts). */
export const PENDING_ALERT_KEY = "statusAlert";

export async function pack(v: unknown): Promise<Uint8Array> {
	const s = new Blob([JSON.stringify(v)]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function unpack<T>(b: Uint8Array | ArrayBuffer): Promise<T> {
	const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
	return JSON.parse(await new Response(s).text()) as T;
}
const nextDue = (now: number) => (Math.floor((now - ROLLUP_LAG_MS) / FLUSH_PERIOD_MS) + 1) * FLUSH_PERIOD_MS + ROLLUP_LAG_MS;
const emptyHot = (): Hot => ({ v: 2, info: null, last_seen: null, s1: [], c1: [], t10: [], rolled: {} });

export class AgentConnection extends DurableObject<Env> {
	private lastId = 0;
	private hotV: Hot | null = null;
	private tiersV = new Map<string, Rec[]>();
	private pveV: PveSnapshot | null = null;

	/** Request ids only need to be unique per connection: time-based, no storage write. */
	private nextId(): number {
		const t = Math.floor(Date.now() / 100) % 0x7fffffff;
		this.lastId = Math.max(t, this.lastId + 1) % 0x7fffffff || 1;
		return this.lastId;
	}

	private async hot(): Promise<Hot> {
		if (this.hotV) return this.hotV;
		const h = await this.ctx.storage.get<Hot | HotV1>("hot");
		this.hotV = h && (h as Hot).v === 2 ? (h as Hot) : await this.migrate(h as HotV1 | undefined);
		return this.hotV;
	}

	/**
	 * v1 -> v2, idempotent: tiers move from the SQLite table into packed keys, "c1" into "hot".
	 * The puts, the delete and the DROP run without an await in between, so they commit together.
	 */
	private async migrate(old: HotV1 | undefined): Promise<Hot> {
		const sql = this.ctx.storage.sql;
		const hasTable = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stats'").toArray().length > 0;
		const c1 = old ? ((await this.ctx.storage.get<[number, ContainerStat[]][]>("c1")) ?? []) : [];
		const h = emptyHot();
		if (!old && !hasTable) return h; // fresh object, nothing to move
		if (old) {
			h.info = old.info ?? null;
			h.last_seen = old.last_seen ?? null;
			h.s1 = old.s1 ?? [];
			for (const [type] of TIERS) if (old.rolled?.[`s${type}`]) h.rolled[type] = old.rolled[`s${type}`];
		}
		h.c1 = c1;
		const tiers = new Map<string, Map<number, Rec>>();
		if (hasTable) {
			for (const r of sql.exec<{ kind: string; type: string; ts: number; data: string }>("SELECT kind, type, ts, data FROM stats ORDER BY ts").toArray()) {
				const m = tiers.get(r.type) ?? new Map<number, Rec>();
				tiers.set(r.type, m);
				const rec = m.get(r.ts) ?? [r.ts, null, null];
				if (r.kind === "s") rec[1] = parseJson<SystemStats | null>(r.data, null);
				else rec[2] = parseJson<ContainerStat[] | null>(r.data, null);
				m.set(r.ts, rec);
			}
		}
		const list = (type: string) => [...(tiers.get(type)?.values() ?? [])].sort((a, b) => a[0] - b[0]);
		h.t10 = list("10m");
		const put: Record<string, unknown> = { hot: h };
		for (const k of TIER_KEYS) {
			const recs = list(k.slice(2));
			this.tiersV.set(k.slice(2), recs);
			if (recs.length) put[k] = recs;
		}
		const p = [this.ctx.storage.put(put), this.ctx.storage.delete(["c1"])];
		if (hasTable) sql.exec("DROP TABLE IF EXISTS stats");
		await Promise.all(p);
		console.log(`agent: migrated storage to v2 (${h.s1.length} 1m, ${h.c1.length} c1, ${h.t10.length} 10m, ${TIER_KEYS.map((k) => `${(put[k] as Rec[] | undefined)?.length ?? 0} ${k}`).join(", ")})`);
		return h;
	}

	private async tier(type: string): Promise<Rec[]> {
		if (type === "10m") return (await this.hot()).t10;
		let t = this.tiersV.get(type);
		if (!t) {
			t = (await this.ctx.storage.get<Rec[]>(`t:${type}`)) ?? [];
			this.tiersV.set(type, t);
		}
		return t;
	}

	private setTier(hot: Hot, type: string, recs: Rec[], put: Record<string, unknown>): void {
		if (type === "10m") hot.t10 = recs;
		else {
			this.tiersV.set(type, recs);
			put[`t:${type}`] = recs;
		}
	}

	/** One-time move of this system's rows out of D1 (pre-v3 storage). */
	private async importFromD1(systemId: string): Promise<void> {
		const db = this.env.DB;
		const now = Date.now();
		try {
			const [ss, cs] = await db.batch([
				db.prepare("SELECT type, created_at, stats FROM system_stats WHERE system_id = ? ORDER BY created_at").bind(systemId),
				db.prepare("SELECT type, created_at, stats FROM container_stats WHERE system_id = ? ORDER BY created_at").bind(systemId),
			]);
			const hot = await this.hot();
			const recs = new Map<string, Map<number, Rec>>();
			for (const [kind, rows] of [["s", ss.results], ["c", cs.results]] as const) {
				for (const r of rows as { type: string; created_at: number; stats: string }[]) {
					if (r.type === "1m") {
						if (r.created_at < now - RETENTION_1M) continue;
						if (kind === "s") hot.s1.push([r.created_at, parseJson<SystemStats>(r.stats, {} as SystemStats)]);
						else hot.c1.push([r.created_at, parseJson<ContainerStat[]>(r.stats, [])]);
					} else {
						const m = recs.get(r.type) ?? new Map<number, Rec>();
						recs.set(r.type, m);
						const rec = m.get(r.created_at) ?? [r.created_at, null, null];
						rec[kind === "s" ? 1 : 2] = parseJson(r.stats, null);
						m.set(r.created_at, rec);
						hot.rolled[r.type] = Math.max(hot.rolled[r.type] ?? 0, r.created_at);
					}
				}
			}
			hot.s1.sort((a, b) => a[0] - b[0]);
			hot.c1.sort((a, b) => a[0] - b[0]);
			const put: Record<string, unknown> = { d1Imported: now };
			for (const [type, , period] of TIERS) {
				hot.rolled[type] ??= Math.floor((now - ROLLUP_LAG_MS) / (period * 60_000)) * period * 60_000;
				const m = recs.get(type);
				if (!m) continue;
				const merged = new Map((await this.tier(type)).map((r) => [r[0], r] as const));
				for (const [ts, r] of m) merged.set(ts, r);
				this.setTier(hot, type, [...merged.values()].sort((a, b) => a[0] - b[0]), put);
			}
			put.hot = hot;
			await this.ctx.storage.put(put);
			await db.batch([
				db.prepare("DELETE FROM system_stats WHERE system_id = ?").bind(systemId),
				db.prepare("DELETE FROM container_stats WHERE system_id = ?").bind(systemId),
			]);
		} catch (e) {
			console.error("agent: D1 stats import failed", (e as Error).message);
		}
	}

	private async system(systemId: string): Promise<SystemRow | null> {
		return this.env.DB.prepare("SELECT id, name, token, fingerprint, status, details FROM systems WHERE id = ?").bind(systemId).first<SystemRow>();
	}

	private openSockets(): WebSocket[] {
		return this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
	}

	/** Buffered samples of the live connection (newest last). */
	private async buffered(att: Attachment | undefined): Promise<Sample[]> {
		if (!att?.buf) return [];
		try {
			return await unpack<Sample[]>(att.buf);
		} catch {
			return [];
		}
	}

	private async liveAtt(): Promise<Attachment | undefined> {
		for (const ws of this.openSockets()) {
			const a = ws.deserializeAttachment() as Attachment | null;
			if (a?.verified) return a;
		}
		return undefined;
	}

	/**
	 * Persist buffered samples into "hot" and run any due rollups: one put with "hot" plus the
	 * tier keys whose period closed. Keeps the newest sample in the buffer for live reads.
	 */
	private async flush(ws: WebSocket | null, att: Attachment, now: number, why: string): Promise<void> {
		const samples = await this.buffered(att);
		const fresh = samples.filter(([t]) => t > (att.flushed ?? 0));
		const hot = await this.hot();
		const put: Record<string, unknown> = { hot };
		const lastTs = hot.s1.length ? hot.s1[hot.s1.length - 1][0] : 0;
		for (const [t, s, c] of fresh) {
			if (t <= lastTs) continue;
			hot.s1.push([t, s]);
			if (c) hot.c1.push([t, c]);
		}
		const keep1m = now - RETENTION_1M - 5 * 60_000;
		while (hot.s1.length && hot.s1[0][0] < keep1m) hot.s1.shift();
		while (hot.c1.length && hot.c1[0][0] < keep1m) hot.c1.shift();
		if (att.info) hot.info = att.info;
		if (att.last_seen && att.last_seen > (hot.last_seen ?? 0)) hot.last_seen = att.last_seen;
		await this.rollups(hot, now, put);
		if (fresh.length || Object.keys(put).length > 1) await this.ctx.storage.put(put);
		const last = samples[samples.length - 1];
		att.flushed = last ? last[0] : (att.flushed ?? 0);
		att.due = nextDue(now);
		att.buf = last ? await pack([last]) : null;
		if (att.buf && att.buf.byteLength > BUF_MAX) att.buf = null;
		if (ws) {
			try {
				ws.serializeAttachment(att);
			} catch {
				/* socket already gone */
			}
		}
		console.log(
			`agent ${att.systemId}: flushed ${fresh.length} samples (${why}; ${(samples.length ? JSON.stringify(samples[samples.length - 1]).length : 0)} B/sample, keys ${Object.keys(put).join("+")})`,
		);
	}

	/** Roll 1m records up into Beszel's tiers once each period has closed; trim each tier to its retention. */
	private async rollups(hot: Hot, now: number, put: Record<string, unknown>): Promise<void> {
		for (const [type, source, period, keep] of TIERS) {
			const ms = period * 60_000;
			const end = Math.floor((now - ROLLUP_LAG_MS) / ms) * ms;
			if ((hot.rolled[type] ?? 0) >= end) continue;
			hot.rolled[type] = end;
			const start = end - ms;
			const inWin = ([t]: [number, ...unknown[]]) => t > start && t <= end + 30_000;
			let s: SystemStats[];
			let c: ContainerStat[][];
			if (source === "1m") {
				s = hot.s1.filter(inWin).map(([, v]) => v);
				c = hot.c1.filter(inWin).map(([, v]) => v);
			} else {
				const src = (await this.tier(source)).filter(inWin);
				s = src.map((r) => r[1]).filter((v): v is SystemStats => !!v);
				c = src.map((r) => r[2]).filter((v): v is ContainerStat[] => !!v);
			}
			if (!s.length && !c.length) continue;
			const recs = (await this.tier(type)).filter(([t]) => t >= now - keep && t !== end);
			recs.push([end, s.length ? rollupStats(s) : null, c.length ? rollupContainers(c) : null]);
			this.setTier(hot, type, recs, put);
		}
	}

	private async flushAndClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const att = ws.deserializeAttachment() as Attachment | null;
		try {
			if (att?.verified && att.buf) await this.flush(ws, att, Date.now(), reason);
		} catch (e) {
			console.error("agent: flush on close failed", (e as Error).message);
		}
		try {
			ws.close(code, reason);
		} catch {
			/* already closed */
		}
	}

	async fetch(request: Request): Promise<Response> {
		await ensureSchema(this.env.DB);
		const url = new URL(request.url);
		const systemId = request.headers.get("x-richter-system") ?? "";

		if (url.pathname === "/close") {
			for (const ws of this.ctx.getWebSockets()) await this.flushAndClose(ws, 1000, request.headers.get("x-reason") ?? "closed by hub");
			return new Response("ok");
		}
		if (url.pathname === "/status") {
			const sockets = this.ctx.getWebSockets();
			const att = sockets[0]?.deserializeAttachment() as Attachment | undefined;
			return Response.json({ connected: sockets.length > 0, verified: att?.verified ?? false });
		}

		const sys = await this.system(systemId);
		if (!sys) return new Response("unknown system", { status: 404 });

		// Only one live agent connection per system: replace older sockets.
		for (const ws of this.ctx.getWebSockets()) await this.flushAndClose(ws, 1000, "replaced by new connection");

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);

		const { privateKey } = await getHubKey(this.env.DB);
		const signature = await signToken(privateKey, sys.token);
		const fpRequestId = this.nextId();
		const att: Attachment = {
			systemId,
			agentVersion: request.headers.get("x-beszel") ?? "",
			verified: false,
			fpRequestId,
			openedAt: Date.now(),
		};
		server.serializeAttachment(att);
		const got = await this.ctx.storage.get(["systemId", "d1Imported"]);
		if (got.get("systemId") !== systemId) await this.ctx.storage.put("systemId", systemId);
		if (!got.get("d1Imported")) await this.importFromD1(systemId);
		server.send(fingerprintRequest(signature, fpRequestId));
		await this.ctx.storage.setAlarm(Date.now() + VERIFY_TIMEOUT_MS);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		if (typeof message === "string") return; // beszel only sends binary frames
		const att = ws.deserializeAttachment() as Attachment;

		let res;
		try {
			// Route the generic payload (key 7) by request id, never by shape.
			res = decodeResponse(new Uint8Array(message), "raw");
		} catch (e) {
			console.error("bad cbor from agent", (e as Error).message);
			return;
		}
		if (res.error) {
			console.warn(`agent ${att.systemId} error: ${res.error}`);
			const pending = await this.ctx.storage.get<PendingPackages>("pkgReq");
			if (pending && res.id === pending.id) await this.ctx.storage.delete("pkgReq");
			return;
		}

		if (!att.verified) {
			if (!res.fingerprint || res.id !== att.fpRequestId) return;
			await this.handleFingerprint(ws, att, res.fingerprint.fingerprint);
			return;
		}

		const pending = await this.ctx.storage.get<PendingPackages>("pkgReq");
		if (pending && res.id === pending.id) {
			await this.handlePackages(att, res.payload);
			return;
		}
		const payload = res.payload;
		const data = res.systemData ?? (payload instanceof Map && payload.has(0) && payload.has(1) ? (payload as Map<unknown, unknown>) : undefined);
		if (data) await this.handleData(ws, att, data);
	}

	private async handleFingerprint(ws: WebSocket, att: Attachment, fingerprint: string): Promise<void> {
		const db = this.env.DB;
		const sys = await this.system(att.systemId);
		if (!sys) {
			ws.close(1008, "system deleted");
			return;
		}
		if (sys.status === "paused") {
			ws.close(1000, "paused");
			return;
		}
		if (sys.fingerprint && sys.fingerprint !== fingerprint) {
			await addEvent(db, "fingerprint_mismatch", sys.id, `${sys.name}: rejected agent with a different fingerprint`);
			ws.close(1008, "fingerprint mismatch");
			return;
		}
		const now = Date.now();
		await db
			.prepare("UPDATE systems SET fingerprint = ?, status = 'up', connected_at = ?, last_seen = ?, agent_version = ? WHERE id = ?")
			.bind(fingerprint, now, now, att.agentVersion, sys.id)
			.run();
		att.verified = true;
		this.request(ws, att, !sys.details);
		if (sys.status !== "up") {
			// Back up: a Status alert still waiting for its minutes is dropped (nothing was sent).
			await this.ctx.storage.delete(PENDING_ALERT_KEY);
			await systemStatusChanged(this.env, sys.id, sys.name, "up");
		}
	}

	/** Ask the agent for data; the reply arrives as a message. No storage write. */
	private request(ws: WebSocket, att: Attachment, includeDetails: boolean): void {
		ws.send(getDataRequest(this.nextId(), includeDetails));
		att.polledAt = Date.now();
		ws.serializeAttachment(att);
	}

	private async handleData(ws: WebSocket, att: Attachment, raw: Map<unknown, unknown>): Promise<void> {
		const db = this.env.DB;
		const n = normalizeCombinedData(raw);
		const now = Date.now();
		const samples = (await this.buffered(att)).filter(([t]) => t >= (att.flushed ?? 0));
		samples.push([now, n.stats, n.containers.length ? n.containers : null]);
		const dt = dashboardTemp(n.info, n.stats, att.info?.dt != null ? { dt: att.info.dt, at: att.dtAt } : undefined, now);
		if (dt.dt != null) n.info.dt = dt.dt;
		att.dtAt = dt.at;
		if (dt.src === "sensors" || dt.src === "carried") console.log("dashboard temp filled", { system: att.systemId, src: dt.src });
		att.info = n.info;
		att.last_seen = now;
		att.buf = await pack(samples);
		if (!att.due || now >= att.due || att.buf.byteLength > BUF_MAX) await this.flush(ws, att, now, att.buf.byteLength > BUF_MAX ? "buffer full" : "period");
		else ws.serializeAttachment(att);

		const stmts: D1PreparedStatement[] = [
			db.prepare("SELECT name, status, agent_version, details IS NOT NULL has_details FROM systems WHERE id = ?").bind(att.systemId),
			db.prepare("SELECT * FROM system_alerts WHERE system_id = ?").bind(att.systemId),
		];
		if (n.services) stmts.push(this.servicesUpsert(att.systemId, n.services, now));
		const results = await db.batch(stmts);
		const row = results[0].results[0] as { name: string; status: string; agent_version: string | null; has_details: number } | undefined;
		if (!row) return;
		const name = row.name;
		const version = n.info.v ?? null;
		// systems.info/last_seen are read through live(); D1 only needs status, version, details and a periodic refresh.
		if ((row.status !== "up" && row.status !== "paused") || n.details || (version && version !== row.agent_version) || !att.d1_seen || now - att.d1_seen >= D1_SEEN_MS) {
			await db
				.prepare(
					`UPDATE systems SET info = ?, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'up' END, last_seen = ?,
					 agent_version = COALESCE(?, agent_version)${n.details ? ", details = ?" : ""} WHERE id = ?`,
				)
				.bind(...[JSON.stringify(n.info), now, version, ...(n.details ? [JSON.stringify(n.details)] : []), att.systemId])
				.run();
			att.d1_seen = now;
			ws.serializeAttachment(att);
		}
		const alerts = results[1].results as AlertRow[];
		await evaluateSystemAlerts(this.env, att.systemId, name, alerts, (since) => this.series1m(att, since));
		if (n.services) await evaluateSystemdAlerts(this.env, att.systemId, name, n.services, alerts);
		if (n.info.pu?.length) await this.packagesTick(ws, att.systemId, name, n.info.pu, alerts);
	}

	/** 1m system stats since `since`: the buffer, plus "hot" only when the buffer doesn't reach back far enough. */
	private async series1m(att: Attachment | undefined, since: number): Promise<{ at: number; s: SystemStats }[]> {
		const buf = await this.buffered(att);
		const out = new Map<number, SystemStats>();
		if (!buf.length || buf[0][0] > since + POLL_MS) for (const [t, s] of (await this.hot()).s1) if (t >= since) out.set(t, s);
		for (const [t, s] of buf) if (t >= since) out.set(t, s);
		return [...out].sort((a, b) => a[0] - b[0]).map(([at, s]) => ({ at, s }));
	}

	// ------------------------------------------------------------------ RPC

	/**
	 * Called by the Worker cron every minute for systems D1 has as "up". Sends the data request,
	 * closes silent agents, and keeps a sparse watchdog alarm so polling survives a stopped cron.
	 */
	/** Ask the agent for fresh data. Returns the newest buffered CPU % (if under 3 min old) for the Hub's public sparkline. */
	async poll(includeDetails: boolean): Promise<number | null> {
		const now = Date.now();
		const st = this.ctx.storage;
		const sockets = this.openSockets();
		if (!sockets.length) {
			// D1 says up but nothing is connected (e.g. sockets dropped by a code update): let the grace alarm decide.
			if ((await st.getAlarm()) == null) await st.setAlarm(now + DOWN_GRACE_MS);
			return null;
		}
		const ws = sockets[0];
		const att = ws.deserializeAttachment() as Attachment;
		if (!att.verified) return null; // the verify alarm handles it
		if (now - Math.max(att.last_seen ?? 0, att.openedAt) > SILENCE_CLOSE_MS) {
			await this.flushAndClose(ws, 1001, "agent silent");
			await st.setAlarm(now + DOWN_GRACE_MS);
			return null;
		}
		// From the socket attachment (in memory, not storage), so this costs no reads.
		const buf = await this.buffered(att);
		const last = buf[buf.length - 1];
		this.request(ws, att, includeDetails);
		if ((await st.getAlarm()) == null) await st.setAlarm(now + WATCHDOG_MS);
		return last && now - last[0] < 3 * 60_000 && Number.isFinite(last[1]?.cpu) ? last[1].cpu : null;
	}

	/** Stats records for the dashboard charts (same shape the D1 tables had). */
	async stats(kind: Kind, type: string, since: number): Promise<{ created_at: number; stats: unknown }[]> {
		if (type === "1m") {
			const att = await this.liveAtt();
			if (kind === "s") return (await this.series1m(att, since)).map(({ at, s }) => ({ created_at: at, stats: s }));
			const out = new Map<number, ContainerStat[]>();
			for (const [t, c] of (await this.hot()).c1) if (t >= since) out.set(t, c);
			for (const [t, , c] of await this.buffered(att)) if (t >= since && c) out.set(t, c);
			return [...out].sort((a, b) => a[0] - b[0]).map(([created_at, stats]) => ({ created_at, stats }));
		}
		if (!TIERS.some(([t]) => t === type)) return [];
		const i = kind === "s" ? 1 : 2;
		return (await this.tier(type)).filter((r) => r[0] >= since && r[i]).map((r) => ({ created_at: r[0], stats: r[i] }));
	}

	/** Newest 1m container snapshot (container monitors). */
	async latestContainers(): Promise<{ created_at: number; stats: string } | null> {
		const buf = await this.buffered(await this.liveAtt());
		for (let i = buf.length - 1; i >= 0; i--) if (buf[i][2]) return { created_at: buf[i][0], stats: JSON.stringify(buf[i][2]) };
		const c1 = (await this.hot()).c1;
		const last = c1[c1.length - 1];
		return last ? { created_at: last[0], stats: JSON.stringify(last[1]) } : null;
	}

	/**
	 * A richter-pve push (Proxmox host): keep the latest snapshot (one storage write per push) and
	 * create monitors for guests seen for the first time. D1 is only touched when the guest set changes.
	 */
	async pveIngest(systemId: string, systemName: string, snap: PveSnapshot): Promise<{ guests: number; created: number }> {
		const st = this.ctx.storage;
		this.pveV = snap;
		const key = guestKey(snap);
		const got = await st.get(["pveKey", "systemId"]);
		if (got.get("pveKey") === key) {
			await st.put("pve", snap);
			return { guests: snap.guests.length, created: 0 };
		}
		await st.put({ pve: snap, ...(got.get("systemId") !== systemId ? { systemId } : {}) });
		// If discovery fails, pveKey stays stale and the next push retries it.
		const created = await discoverGuests(this.env, systemId, systemName, snap);
		await st.put("pveKey", key);
		return { guests: snap.guests.length, created };
	}

	/** Latest richter-pve snapshot, or null if this system never pushed one. */
	async pveSnapshot(): Promise<PveSnapshot | null> {
		this.pveV ??= (await this.ctx.storage.get<PveSnapshot>("pve")) ?? null;
		return this.pveV;
	}

	/** Live info and last_seen, fresher than the D1 systems row. */
	async live(): Promise<{ info: SystemInfo | null; last_seen: number | null }> {
		const att = await this.liveAtt();
		if (att?.last_seen) return { info: att.info ?? null, last_seen: att.last_seen };
		const hot = await this.hot();
		return { info: hot.info, last_seen: hot.last_seen };
	}

	/** System deleted: drop everything this object stores. */
	async purge(): Promise<void> {
		for (const ws of this.ctx.getWebSockets()) {
			const att = ws.deserializeAttachment() as Attachment | null;
			if (att) ws.serializeAttachment({ ...att, buf: null });
			ws.close(1000, "system deleted");
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.hotV = null;
		this.pveV = null;
		this.tiersV.clear();
	}

	/** Latest-only services list; the WHERE clause makes an unchanged list a no-op. */
	private servicesUpsert(systemId: string, services: SystemdService[], now: number): D1PreparedStatement {
		const json = JSON.stringify(services);
		return this.env.DB.prepare(
			`INSERT INTO system_services(system_id, services, hash, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET services = excluded.services, hash = excluded.hash, updated_at = excluded.updated_at
			 WHERE system_services.hash IS NOT excluded.hash`,
		).bind(systemId, json, hash(json), now);
	}

	/**
	 * Info.PackageUpdates ([total, security]) arrives every poll. Fetch the full list when the
	 * counts change (or every 6 h), and evaluate package alerts. When the counts just changed,
	 * alerts wait for the fresh list so the notification can name the packages.
	 */
	private async packagesTick(ws: WebSocket, systemId: string, name: string, pu: number[], alerts: AlertRow[]): Promise<void> {
		const st = this.ctx.storage;
		const now = Date.now();
		const got = await st.get(["lastPu", "pkgFetchedAt", "pkgReq", "pkgDeferred"]);
		const lastPu = got.get("lastPu") as string | undefined;
		const fetchedAt = got.get("pkgFetchedAt") as number | undefined;
		const pending = got.get("pkgReq") as PendingPackages | undefined;
		let deferred = got.get("pkgDeferred") === true;
		const key = pu.join(",");
		const changed = key !== lastPu;
		const pendingLive = !!pending && now - pending.at < PKG_REPLY_MS;
		const hasPkgAlerts = alerts.some((a) => (UPDATE_METRICS as readonly string[]).includes(a.metric));

		if (deferred && !pendingLive) {
			deferred = false; // the reply never came; fall back to the stored list
			await st.delete("pkgDeferred");
		}
		if (changed) await st.put("lastPu", key);
		if (!pendingLive && (changed || !fetchedAt || now - fetchedAt > PKG_REFRESH_MS)) {
			const id = this.nextId();
			await st.put("pkgReq", { id, at: now } satisfies PendingPackages);
			ws.send(packageUpdatesRequest(id));
			console.log(`packages: requested list from ${systemId} (id ${id}, pu ${key})`);
		}
		if (changed && hasPkgAlerts && (pendingLive || !deferred)) {
			const p = await st.get<PendingPackages>("pkgReq");
			if (p && now - p.at < PKG_REPLY_MS) {
				await st.put("pkgDeferred", true);
				return;
			}
		}
		if (!deferred && hasPkgAlerts) await evaluatePackageAlerts(this.env, systemId, name, pu, alerts, () => this.storedPackages(systemId));
	}

	private async storedPackages(systemId: string): Promise<PackageUpdate[] | null> {
		const r = await this.env.DB.prepare("SELECT packages FROM system_packages WHERE system_id = ?").bind(systemId).first<{ packages: string }>();
		if (!r) return null;
		try {
			return JSON.parse(r.packages) as PackageUpdate[];
		} catch {
			return null;
		}
	}

	private async handlePackages(att: Attachment, payload: unknown): Promise<void> {
		const st = this.ctx.storage;
		await st.delete("pkgReq");
		const snap = normalizePackageUpdates(payload);
		console.log(`packages: ${att.systemId} replied (${snap ? `${snap.packages.length} pkgs, checked ${snap.checkedAt ?? "never"}` : "unreadable"})`);
		// checkedAt is 0 until the agent's first check finishes; keep the stored list until then.
		if (snap?.checkedAt) {
			await st.put("pkgFetchedAt", Date.now());
			await this.packagesUpsert(att.systemId, snap);
		}
		if ((await st.get("pkgDeferred")) !== true) return;
		await st.delete("pkgDeferred");
		const db = this.env.DB;
		const [sys, alerts] = await db.batch([
			db.prepare("SELECT name FROM systems WHERE id = ?").bind(att.systemId),
			db.prepare("SELECT * FROM system_alerts WHERE system_id = ?").bind(att.systemId),
		]);
		const row = sys.results[0] as { name: string } | undefined;
		if (!row) return;
		const pu = (att.info ?? (await this.hot()).info)?.pu;
		const fresh = snap?.checkedAt ? snap.packages : null;
		await evaluatePackageAlerts(this.env, att.systemId, row.name, pu, alerts.results as AlertRow[], async () => fresh ?? (await this.storedPackages(att.systemId)));
	}

	/** Latest-only package list. Rewritten when the list changes, or to refresh checked_at every 6 h. */
	private async packagesUpsert(systemId: string, snap: NormalizedPackages): Promise<void> {
		const json = JSON.stringify(snap.packages);
		const h = hash(`${snap.manager}|${snap.securityKnown}|${json}`);
		await this.env.DB.prepare(
			`INSERT INTO system_packages(system_id, manager, checked_at, security_known, packages, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(system_id) DO UPDATE SET manager = excluded.manager, checked_at = excluded.checked_at, security_known = excluded.security_known,
			   packages = excluded.packages, hash = excluded.hash, updated_at = excluded.updated_at
			 WHERE system_packages.hash IS NOT excluded.hash OR excluded.checked_at - COALESCE(system_packages.checked_at, 0) >= ?`,
		)
			.bind(systemId, snap.manager, snap.checkedAt, snap.securityKnown ? 1 : 0, json, h, Date.now(), PKG_REFRESH_MS)
			.run();
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		await this.flushAndClose(ws, code, reason);
		// A replaced socket closing must not disturb the live connection.
		const others = this.ctx.getWebSockets().filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
		if (others.length) return;
		await this.ctx.storage.put("disconnectedAt", Date.now());
		await this.ctx.storage.setAlarm(Date.now() + DOWN_GRACE_MS);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.webSocketClose(ws, 1011, "error");
	}

	/** Verify timeout, down grace, or the cron watchdog. */
	/** Status alert: send the pending DOWN once due if the system is still down; drop it if not. */
	private async firePendingAlert(systemId: string, sys: SystemRow | null, now: number): Promise<void> {
		const p = await this.ctx.storage.get<PendingStatusAlert>(PENDING_ALERT_KEY);
		if (!p) return;
		if (!sys || sys.status !== "down") {
			await this.ctx.storage.delete(PENDING_ALERT_KEY); // up again, paused or deleted
			return;
		}
		if (now < p.due - 1000) {
			await this.ctx.storage.setAlarm(p.due);
			return;
		}
		await this.ctx.storage.delete(PENDING_ALERT_KEY);
		await sendPendingStatusAlert(this.env, systemId, sys.name, p, now);
	}

	async alarm(): Promise<void> {
		await ensureSchema(this.env.DB);
		const now = Date.now();
		const sockets = this.openSockets();
		const systemId = await this.ctx.storage.get<string>("systemId");
		if (!systemId) return;

		if (sockets.length === 0) {
			const sys = await this.system(systemId);
			if (sys && sys.status === "up") {
				await this.env.DB.prepare("UPDATE systems SET status = 'down' WHERE id = ?").bind(systemId).run();
				const pending = await systemStatusChanged(this.env, systemId, sys.name, "down", now);
				if (pending) {
					await this.ctx.storage.put(PENDING_ALERT_KEY, pending);
					await this.ctx.storage.setAlarm(pending.due);
				}
				return;
			}
			await this.firePendingAlert(systemId, sys, now);
			return; // no reschedule otherwise: the next agent connection restarts the loop
		}

		const ws = sockets[0];
		const att = ws.deserializeAttachment() as Attachment;
		if (!att.verified) {
			if (now - att.openedAt >= VERIFY_TIMEOUT_MS - 1000) {
				ws.close(1008, "verification timeout");
				// This socket's verify timer replaced a pending Status alert's alarm: put it back.
				const p = await this.ctx.storage.get<PendingStatusAlert>(PENDING_ALERT_KEY);
				if (p) await this.ctx.storage.setAlarm(Math.max(p.due, now + 1000));
			} else await this.ctx.storage.setAlarm(att.openedAt + VERIFY_TIMEOUT_MS);
			return;
		}
		if (now - Math.max(att.last_seen ?? 0, att.openedAt) > SILENCE_CLOSE_MS) {
			await this.flushAndClose(ws, 1001, "agent silent");
			await this.ctx.storage.setAlarm(now + DOWN_GRACE_MS);
			return;
		}
		if (now - (att.polledAt ?? att.openedAt) < CRON_STALE_MS) return; // cron is polling; its next poll re-arms the watchdog
		// The cron hasn't polled lately: poll from alarms until it does again.
		const sys = await this.system(systemId);
		if (!sys || sys.status === "paused") {
			await this.flushAndClose(ws, 1000, sys ? "paused" : "system deleted");
			return;
		}
		console.warn(`agent ${systemId}: no cron poll for ${Math.round((now - (att.polledAt ?? att.openedAt)) / 1000)} s, polling from alarm`);
		this.request(ws, att, !sys.details);
		await this.ctx.storage.setAlarm(now + POLL_MS);
	}
}
