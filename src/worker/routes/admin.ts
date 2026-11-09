import { Hono } from "hono";
import { z } from "zod";
import type { AccessSettings, Me, Role, CheckPoint, Incident, MonitorListItem, NotificationLogEntry, Overview, PackageSnapshot, PackageUpdate, ServicesSnapshot, StatsRange, SystemAlert, SystemdService, UptimeSummary } from "../../shared/types";
import { authenticate, type AccessIdentity } from "../access";
import { getHubKey } from "../beszel/keys";
import { EVENT_METRICS } from "../beszel/update-alerts";
import { addEvent, getSetting, newId, newToken, parseJson, setSetting } from "../db";
import type { Env } from "../env";
import { installFor, toAnnouncement, toChannel, toMonitor, toPage, toSystem, type PageRow, type SystemRow } from "../mappers";
import { liveSystems } from "../beszel/live";
import { overlay, type HubView } from "../hub";
import { hub, hubReload, hubView } from "../hub-client";
import { latestPve, runCheck, utcDay, type MonitorRow } from "../monitors/engine";
import { uptime24h, type DailyCounts } from "../monitors/uptime";
import { toMaintenance, type MaintenanceRow } from "../monitors/maintenance";
import { nextState } from "../monitors/state";
import { logNotifications, sendToChannel, type NotifyMessage } from "../notify";
import { READ_BLOCKED_GET, READ_REDACTED_GET, redactForReadOnly } from "../redact";
import { AccessApiError, accessConfigured, invalidateRoles, listUsers, managedPolicyEmails, normEmail, ownerEmail, roleOf, syncAccessPolicy } from "../users";

type Ctx = { Bindings: Env; Variables: { identity: AccessIdentity; role: Role } };
export const admin = new Hono<Ctx>();

class HttpError extends Error {
	constructor(public status: 400 | 404 | 409 | 502, message: string, public field?: string) {
		super(message);
	}
}

admin.onError((err, c) => {
	if (err instanceof HttpError) return c.json({ error: err.message, field: err.field }, err.status);
	if (err instanceof z.ZodError) {
		const issue = err.issues[0];
		return c.json({ error: `${issue.path.join(".")}: ${issue.message}`, field: String(issue.path[0] ?? "") }, 400);
	}
	if (/UNIQUE constraint failed: (\w+)\.(\w+)/.test(err.message)) {
		const field = err.message.match(/UNIQUE constraint failed: \w+\.(\w+)/)?.[1];
		return c.json({ error: `${field} is already in use`, field }, 409);
	}
	console.error(err.stack);
	return c.json({ error: err.message }, 500);
});

admin.use("*", async (c, next) => {
	const identity = await authenticate(c.req.raw, c.env);
	if (!identity) return c.json({ error: "Unauthorized: Cloudflare Access login required" }, 401);
	const role = await roleOf(c.env, identity.email);
	if (!role) return c.json({ error: `${identity.email} isn't on this dashboard's user list. Ask the owner to add you.` }, 403);
	c.set("identity", identity);
	c.set("role", role);
	c.header("cache-control", "no-store");
	const path = c.req.path.replace(/^\/api\/admin/, "") || "/";
	const read = c.req.method === "GET" || c.req.method === "HEAD";
	if (role === "read") {
		if (!read || READ_BLOCKED_GET.some((r) => r.test(path))) return c.json({ error: "Read-only access: ask the owner for Full access to do this.", readonly: true }, 403);
		await next();
		if (READ_REDACTED_GET.test(path) && c.res.status === 200 && (c.res.headers.get("content-type") ?? "").includes("application/json")) {
			const data = redactForReadOnly(await c.res.json());
			c.res = new Response(JSON.stringify(data), { status: 200, headers: c.res.headers });
		}
		return;
	}
	await next();
	if (path.startsWith("/access")) return;
	// Any successful change may touch monitors, maintenances or a public page: let the Hub re-read
	// its config and drop its page snapshots. An import replaces monitors wholesale, so reseed.
	if (c.req.method !== "GET" && c.res.status < 400 && !/\/monitors\/(test|[^/]+\/check-now)$/.test(c.req.path)) {
		await hubReload(c.env, c.req.path.endsWith("/import") ? { reseed: true } : {});
	}
});

const bool = z.union([z.boolean(), z.number()]).transform((v) => (v ? 1 : 0));
const tags = z.array(z.string().max(40)).max(20);

async function must<T>(p: Promise<T | null>, what = "Not found"): Promise<T> {
	const v = await p;
	if (v == null) throw new HttpError(404, what);
	return v;
}

// ---------------------------------------------------------------- misc

admin.get("/me", (c) => {
	const email = c.get("identity").email;
	return c.json({ email, role: c.get("role"), owner: normEmail(email) === ownerEmail(c.env) } satisfies Me);
});

// ---------------------------------------------------------------- access (dashboard users)

admin.get("/access", async (c) => {
	const out: AccessSettings = { users: await listUsers(c.env), configured: accessConfigured(c.env) };
	// Only Full users get the live policy check (one Access API read when Settings opens).
	if (c.get("role") === "full" && out.configured && c.req.query("check") === "1") {
		try {
			out.policy = { emails: await managedPolicyEmails(c.env) };
		} catch (e) {
			out.policy = { emails: null, error: (e as Error).message };
		}
	}
	return c.json(out);
});

const accessError = (e: unknown) => {
	if (e instanceof AccessApiError) return new HttpError(e.code === "not_configured" ? 409 : 502, e.message);
	return e;
};
async function otherEmails(env: Env): Promise<string[]> {
	return (await env.DB.prepare("SELECT email FROM users").all<{ email: string }>()).results.map((r) => r.email);
}
const roleSchema = z.enum(["full", "read"]);

admin.post("/access", async (c) => {
	const body = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: roleSchema }).parse(await c.req.json());
	if (body.email === ownerEmail(c.env)) throw new HttpError(400, "The owner is always allowed with Full access", "email");
	const db = c.env.DB;
	const exists = await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(body.email).first();
	if (exists) throw new HttpError(409, `${body.email} is already on the list`, "email");
	// Access first: a user only lands in D1 once Access will let them in.
	await syncAccessPolicy(c.env, [...(await otherEmails(c.env)), body.email]).catch((e) => Promise.reject(accessError(e)));
	await db.prepare("INSERT INTO users(email, role, added_by, created_at) VALUES (?, ?, ?, ?)").bind(body.email, body.role, normEmail(c.get("identity").email), Date.now()).run();
	invalidateRoles();
	await addEvent(db, "access", body.email, `${c.get("identity").email} added ${body.email} (${body.role === "full" ? "Full" : "Read-only"})`);
	return c.json({ users: await listUsers(c.env) }, 201);
});

admin.patch("/access/:email", async (c) => {
	const email = normEmail(decodeURIComponent(c.req.param("email")));
	const { role } = z.object({ role: roleSchema }).parse(await c.req.json());
	if (email === ownerEmail(c.env)) throw new HttpError(400, "The owner is always Full");
	const r = await c.env.DB.prepare("UPDATE users SET role = ? WHERE email = ?").bind(role, email).run();
	if (!r.meta.changes) throw new HttpError(404, "User not found");
	invalidateRoles();
	await addEvent(c.env.DB, "access", email, `${c.get("identity").email} set ${email} to ${role === "full" ? "Full" : "Read-only"}`);
	return c.json({ users: await listUsers(c.env) });
});

admin.delete("/access/:email", async (c) => {
	const email = normEmail(decodeURIComponent(c.req.param("email")));
	if (email === ownerEmail(c.env)) throw new HttpError(400, "The owner can't be removed");
	const others = await otherEmails(c.env);
	if (!others.includes(email)) throw new HttpError(404, "User not found");
	// D1 first: the dashboard refuses them right away even if Access still has a session for them.
	await c.env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email).run();
	invalidateRoles();
	await addEvent(c.env.DB, "access", email, `${c.get("identity").email} removed ${email}`);
	let warning: string | undefined;
	try {
		await syncAccessPolicy(c.env, others.filter((e) => e !== email));
	} catch (e) {
		warning = `Removed from the dashboard, but the Access policy wasn't updated: ${(e as Error).message}`;
	}
	return c.json({ users: await listUsers(c.env), warning });
});

admin.post("/access/sync", async (c) => {
	await syncAccessPolicy(c.env, await otherEmails(c.env)).catch((e) => Promise.reject(accessError(e)));
	return c.json({ ok: true, emails: await managedPolicyEmails(c.env).catch(() => null) });
});

admin.get("/overview", async (c) => {
	const db = c.env.DB;
	const sys = await db.prepare("SELECT status, COUNT(*) n FROM systems GROUP BY status").all<{ status: string; n: number }>();
	const mon = await db.prepare("SELECT CASE WHEN paused = 1 THEN 'paused' ELSE status END s, COUNT(*) n FROM monitors WHERE type != 'group' GROUP BY s").all<{ s: string; n: number }>();
	const open = await db.prepare("SELECT COUNT(*) n FROM incidents WHERE resolved_at IS NULL").first<{ n: number }>();
	// id order == ts order (append-only), and uses the primary key instead of an index on ts.
	const events = await db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 20").all();
	const count = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);
	const sget = (s: string) => sys.results.find((r) => r.status === s)?.n ?? 0;
	const mget = (s: string) => mon.results.find((r) => r.s === s)?.n ?? 0;
	const overview: Overview = {
		systems: { total: count(sys.results), up: sget("up"), down: sget("down"), pending: sget("pending"), paused: sget("paused") },
		monitors: {
			total: count(mon.results),
			up: mget("up"),
			down: mget("down"),
			degraded: mget("degraded"),
			other: count(mon.results) - mget("up") - mget("down") - mget("degraded"),
		},
		open_incidents: open?.n ?? 0,
		events: events.results as unknown as Overview["events"],
	};
	return c.json(overview);
});

async function settingsOf(env: Env) {
	const { publicSsh } = await getHubKey(env.DB);
	return {
		site_title: (await getSetting(env.DB, "site_title")) ?? "Richter",
		timezone: (await getSetting(env.DB, "timezone")) ?? "UTC",
		hub_public_key: publicSsh,
		public_url: `https://${env.PUBLIC_HOST}`,
		dashboard_url: `https://${env.DASHBOARD_HOST}`,
	};
}
admin.get("/settings", async (c) => c.json(await settingsOf(c.env)));
admin.put("/settings", async (c) => {
	const body = z.object({ site_title: z.string().min(1).max(80).optional(), timezone: z.string().max(64).optional() }).parse(await c.req.json());
	if (body.site_title) await setSetting(c.env.DB, "site_title", body.site_title);
	if (body.timezone) await setSetting(c.env.DB, "timezone", body.timezone);
	return c.json(await settingsOf(c.env));
});

admin.get("/events", async (c) => {
	const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
	const rows = await c.env.DB.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").bind(limit).all();
	return c.json(rows.results);
});

// ---------------------------------------------------------------- systems

const getSystemRow = async (env: Env, id: string) => {
	const r = await env.DB.prepare("SELECT * FROM systems WHERE id = ?").bind(id).first<SystemRow>();
	return r ? (await liveSystems(env, [r]))[0] : null;
};
const agentStub = (env: Env, id: string) => env.AGENT.get(env.AGENT.idFromName(id));
async function closeAgent(env: Env, id: string, reason: string) {
	await agentStub(env, id).fetch("https://agent/close", { headers: { "x-reason": reason } });
}

admin.get("/systems", async (c) => {
	const rows = await c.env.DB.prepare("SELECT * FROM systems ORDER BY name COLLATE NOCASE").all<SystemRow>();
	return c.json((await liveSystems(c.env, rows.results)).map(({ infoObj: _, ...r }) => toSystem(r as SystemRow)));
});

admin.post("/systems", async (c) => {
	const body = z.object({ name: z.string().min(1).max(80), tags: tags.optional() }).parse(await c.req.json());
	const id = newId();
	const token = newToken(32);
	await c.env.DB.prepare("INSERT INTO systems(id, name, token, tags, created_at) VALUES (?, ?, ?, ?, ?)")
		.bind(id, body.name, token, JSON.stringify(body.tags ?? []), Date.now())
		.run();
	// New systems get all apply_default channels for Status alerts.
	await c.env.DB.prepare("INSERT INTO system_notifications(system_id, notification_id) SELECT ?, id FROM notifications WHERE apply_default = 1").bind(id).run();
	await c.env.DB.prepare("INSERT INTO system_alerts(id, system_id, metric, threshold, minutes) VALUES (?, ?, 'Status', NULL, 1)").bind(newId(), id).run();
	await addEvent(c.env.DB, "system_added", id, `System ${body.name} added`);
	const { publicSsh } = await getHubKey(c.env.DB);
	return c.json({ system: toSystem((await getSystemRow(c.env, id))!), install: installFor(c.env, token, publicSsh) }, 201);
});

admin.get("/systems/:id", async (c) => c.json(toSystem(await must(getSystemRow(c.env, c.req.param("id")), "System not found"))));

admin.patch("/systems/:id", async (c) => {
	const id = c.req.param("id");
	await must(getSystemRow(c.env, id), "System not found");
	const body = z
		.object({ name: z.string().min(1).max(80).optional(), tags: tags.optional(), down_after: z.number().int().min(60).max(86_400).optional() })
		.parse(await c.req.json());
	if (body.name) await c.env.DB.prepare("UPDATE systems SET name = ? WHERE id = ?").bind(body.name, id).run();
	if (body.tags) await c.env.DB.prepare("UPDATE systems SET tags = ? WHERE id = ?").bind(JSON.stringify(body.tags), id).run();
	if (body.down_after != null) await c.env.DB.prepare("UPDATE systems SET down_after = ? WHERE id = ?").bind(body.down_after, id).run();
	return c.json(toSystem((await getSystemRow(c.env, id))!));
});

admin.delete("/systems/:id", async (c) => {
	const id = c.req.param("id");
	await must(getSystemRow(c.env, id), "System not found");
	await closeAgent(c.env, id, "system deleted");
	await agentStub(c.env, id).purge();
	await c.env.DB.batch(
		["systems WHERE id", "system_stats WHERE system_id", "container_stats WHERE system_id", "system_alerts WHERE system_id", "system_notifications WHERE system_id", "system_packages WHERE system_id", "system_services WHERE system_id"].map((t) =>
			c.env.DB.prepare(`DELETE FROM ${t} = ?`).bind(id),
		),
	);
	return c.json({ ok: true });
});

admin.get("/systems/:id/install", async (c) => {
	const row = await must(getSystemRow(c.env, c.req.param("id")), "System not found");
	return c.json(installFor(c.env, row.token, (await getHubKey(c.env.DB)).publicSsh));
});

admin.post("/systems/:id/:action{pause|resume|reset-fingerprint|rotate-token}", async (c) => {
	const id = c.req.param("id");
	const action = c.req.param("action");
	const row = await must(getSystemRow(c.env, id), "System not found");
	const db = c.env.DB;
	if (action === "pause") {
		await db.prepare("UPDATE systems SET status = 'paused' WHERE id = ?").bind(id).run();
		await closeAgent(c.env, id, "paused");
	} else if (action === "resume") {
		await db.prepare("UPDATE systems SET status = 'pending' WHERE id = ? AND status = 'paused'").bind(id).run();
	} else if (action === "reset-fingerprint") {
		await db.prepare("UPDATE systems SET fingerprint = NULL WHERE id = ?").bind(id).run();
		await addEvent(db, "fingerprint_reset", id, `${row.name}: fingerprint reset`);
	} else {
		const token = newToken(32);
		await db.prepare("UPDATE systems SET token = ?, fingerprint = NULL WHERE id = ?").bind(token, id).run();
		await closeAgent(c.env, id, "token rotated");
		return c.json(installFor(c.env, token, (await getHubKey(db)).publicSsh));
	}
	return c.json(toSystem((await getSystemRow(c.env, id))!));
});

const RANGE: Record<StatsRange, [string, number]> = {
	"1h": ["1m", 3600_000],
	"12h": ["10m", 12 * 3600_000],
	"24h": ["20m", 24 * 3600_000],
	"1w": ["120m", 7 * 86_400_000],
	"30d": ["480m", 30 * 86_400_000],
};

admin.get("/systems/:id/:table{stats|containers}", async (c) => {
	const [type, span] = RANGE[(c.req.query("range") as StatsRange) ?? "1h"] ?? RANGE["1h"];
	// Stats live in the system's AgentConnection Durable Object (SQLite), not D1.
	const kind = c.req.param("table") === "stats" ? "s" : "c";
	return c.json(await agentStub(c.env, c.req.param("id")).stats(kind, type, Date.now() - span));
});

// Latest richter-pve snapshot (Proxmox hosts only; null when the companion never pushed).
admin.get("/systems/:id/pve", async (c) => {
	await must(getSystemRow(c.env, c.req.param("id")), "System not found");
	return c.json(await latestPve(c.env, c.req.param("id")));
});

admin.get("/systems/:id/packages", async (c) => {
	const r = await c.env.DB.prepare("SELECT manager, checked_at, security_known, packages, updated_at FROM system_packages WHERE system_id = ?")
		.bind(c.req.param("id"))
		.first<{ manager: string | null; checked_at: number | null; security_known: number; packages: string; updated_at: number }>();
	const out: PackageSnapshot = r
		? { manager: r.manager, checked_at: r.checked_at, security_known: !!r.security_known, packages: parseJson<PackageUpdate[]>(r.packages, []), updated_at: r.updated_at }
		: { manager: null, checked_at: null, security_known: false, packages: [], updated_at: null };
	return c.json(out);
});

admin.get("/systems/:id/services", async (c) => {
	const r = await c.env.DB.prepare("SELECT services, updated_at FROM system_services WHERE system_id = ?")
		.bind(c.req.param("id"))
		.first<{ services: string; updated_at: number }>();
	const out: ServicesSnapshot = { services: r ? parseJson<SystemdService[]>(r.services, []) : [], updated_at: r?.updated_at ?? null };
	return c.json(out);
});

async function alertsOf(env: Env, id: string) {
	const alerts = await env.DB.prepare("SELECT * FROM system_alerts WHERE system_id = ? ORDER BY metric").bind(id).all<{
		id: string;
		metric: SystemAlert["metric"];
		threshold: number | null;
		minutes: number;
		triggered: number;
		last_value: number | null;
	}>();
	const n = await env.DB.prepare("SELECT notification_id FROM system_notifications WHERE system_id = ?").bind(id).all<{ notification_id: string }>();
	return {
		alerts: alerts.results.map((a) => ({ ...a, triggered: !!a.triggered })) as SystemAlert[],
		notification_ids: n.results.map((r) => r.notification_id),
	};
}
const alertMetric = z.enum(["Status", "CPU", "Memory", "Disk", "Temperature", "LoadAvg5", "Bandwidth", "GPU", "SecurityUpdates", "PackageUpdates", "SystemdFailed"]);
const alertInput = z.object({ metric: alertMetric, threshold: z.number().nullable(), minutes: z.number().int().min(1).max(60) });

admin.get("/systems/:id/alerts", async (c) => c.json(await alertsOf(c.env, c.req.param("id"))));

/**
 * "All systems" alerts tab (like Beszel's): add/update one alert across systems, leaving every
 * other alert, its state and each system's channels alone. Without `system_ids` it goes to the
 * systems lacking that alert, or to all with `overwrite`; with them (re-saving a value the tab
 * already applied), to exactly those. Returns which systems it touched so the tab can undo it.
 */
admin.post("/alerts/bulk", async (c) => {
	const body = alertInput.extend({ overwrite: bool.optional(), system_ids: z.array(z.string()).optional() }).parse(await c.req.json());
	const db = c.env.DB;
	const systems = (await db.prepare("SELECT id FROM systems").all<{ id: string }>()).results.map((r) => r.id);
	const have = new Map(
		(await db.prepare("SELECT id, system_id, threshold FROM system_alerts WHERE metric = ?").bind(body.metric).all<{ id: string; system_id: string; threshold: number | null }>()).results.map((r) => [r.system_id, r]),
	);
	const only = body.system_ids ? new Set(body.system_ids) : null;
	const targets = systems.filter((id) => (only ? only.has(id) : body.overwrite || !have.has(id)));
	const threshold = body.metric === "Status" || body.metric === "SystemdFailed" ? null : body.threshold;
	const event = (EVENT_METRICS as readonly string[]).includes(body.metric);
	const now = Date.now();
	const stmts = targets.map((sid) => {
		const prev = have.get(sid);
		if (!prev)
			return db
				.prepare("INSERT INTO system_alerts(id, system_id, metric, threshold, minutes, triggered, last_value) VALUES (?, ?, ?, ?, ?, 0, NULL)")
				.bind(newId(), sid, body.metric, threshold, body.minutes);
		// Same rule as the per-system save: event alerts and unchanged thresholds keep their state.
		const keep = event || prev.threshold === threshold;
		return db
			.prepare(`UPDATE system_alerts SET threshold = ?, minutes = ?, updated_at = ?${keep ? "" : ", triggered = 0, last_value = NULL"} WHERE id = ?`)
			.bind(threshold, body.minutes, now, prev.id);
	});
	if (stmts.length) await db.batch(stmts);
	return c.json({ system_ids: targets });
});

/** Remove one alert from the given systems (what the tab applied), or from every system. */
admin.delete("/alerts/bulk", async (c) => {
	const body = z.object({ metric: alertMetric, system_ids: z.array(z.string()).optional() }).parse(await c.req.json());
	const db = c.env.DB;
	if (!body.system_ids) await db.prepare("DELETE FROM system_alerts WHERE metric = ?").bind(body.metric).run();
	else if (body.system_ids.length)
		await db.batch(body.system_ids.map((sid) => db.prepare("DELETE FROM system_alerts WHERE metric = ? AND system_id = ?").bind(body.metric, sid)));
	return c.json({ ok: true });
});

admin.put("/systems/:id/alerts", async (c) => {
	const id = c.req.param("id");
	await must(getSystemRow(c.env, id), "System not found");
	const body = z
		.object({
			alerts: z.array(alertInput),
			notification_ids: z.array(z.string()),
		})
		.parse(await c.req.json());
	const db = c.env.DB;
	const existing = (await alertsOf(c.env, id)).alerts;
	await db.batch([
		db.prepare("DELETE FROM system_alerts WHERE system_id = ?").bind(id),
		db.prepare("DELETE FROM system_notifications WHERE system_id = ?").bind(id),
		...body.alerts.map((a) => {
			// Event alerts keep their state across edits so changing a threshold does not re-send;
			// the next evaluation resolves or triggers against the new threshold.
			const event = (EVENT_METRICS as readonly string[]).includes(a.metric);
			const prev = existing.find((e) => e.metric === a.metric && (event || e.threshold === a.threshold));
			const threshold = a.metric === "Status" || a.metric === "SystemdFailed" ? null : a.threshold;
			return db
				.prepare("INSERT INTO system_alerts(id, system_id, metric, threshold, minutes, triggered, last_value) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(newId(), id, a.metric, threshold, a.minutes, prev?.triggered ? 1 : 0, event ? (prev?.last_value ?? null) : null);
		}),
		...body.notification_ids.map((nid) => db.prepare("INSERT OR IGNORE INTO system_notifications(system_id, notification_id) VALUES (?, ?)").bind(id, nid)),
	]);
	return c.json(await alertsOf(c.env, id));
});

// ---------------------------------------------------------------- monitors

const monitorSchema = z.object({
	name: z.string().min(1).max(100),
	type: z.enum(["http", "tcp", "dns", "heartbeat", "domain", "system", "container", "guest", "group"]),
	config: z.record(z.string(), z.unknown()).optional(),
	parent_id: z.string().nullable().optional(),
	interval_s: z.number().int().min(60).max(86400).optional(),
	retries: z.number().int().min(0).max(10).optional(),
	retry_interval_s: z.number().int().min(60).max(86400).optional(),
	timeout_ms: z.number().int().min(1000).max(30000).optional(),
	max_latency_ms: z.number().int().min(1).nullable().optional(),
	upside_down: bool.optional(),
	resend_every: z.number().int().min(0).max(10000).optional(),
	paused: bool.optional(),
	description: z.string().max(500).nullable().optional(),
	tags: tags.optional(),
	notification_ids: z.array(z.string()).optional(),
	sort: z.number().int().optional(),
});

function validateConfig(type: string, cfg: Record<string, unknown>): Record<string, unknown> {
	const req = (k: string) => {
		if (cfg[k] === undefined || cfg[k] === "") throw new HttpError(400, `config.${k} is required`, `config.${k}`);
	};
	switch (type) {
		case "http":
			req("url");
			try {
				const u = new URL(String(cfg.url));
				if (!/^https?:$/.test(u.protocol)) throw new Error();
			} catch {
				throw new HttpError(400, "config.url must be an http(s) URL", "config.url");
			}
			break;
		case "tcp":
			req("host");
			req("port");
			cfg.port = Number(cfg.port);
			if (!(Number(cfg.port) > 0 && Number(cfg.port) < 65536)) throw new HttpError(400, "config.port must be 1-65535", "config.port");
			if (cfg.port === 25) throw new HttpError(400, "Cloudflare Workers cannot connect to port 25", "config.port");
			break;
		case "dns":
			req("name");
			break;
		case "heartbeat":
			cfg.period_s = Number(cfg.period_s ?? 3600);
			cfg.grace_s = Number(cfg.grace_s ?? 300);
			break;
		case "domain":
			req("domain");
			break;
		case "system":
			req("system_id");
			break;
		case "container":
			req("system_id");
			req("container_name");
			break;
		case "guest": {
			req("system_id");
			req("vmid");
			cfg.vmid = Number(cfg.vmid);
			if (!(Number.isInteger(cfg.vmid) && (cfg.vmid as number) > 0)) throw new HttpError(400, "config.vmid must be a positive integer", "config.vmid");
			if (cfg.guest_type !== "lxc" && cfg.guest_type !== "qemu") throw new HttpError(400, "config.guest_type must be lxc or qemu", "config.guest_type");
			for (const k of ["mem_warn", "disk_warn"]) {
				if (cfg[k] == null || cfg[k] === "") {
					delete cfg[k];
					continue;
				}
				cfg[k] = Number(cfg[k]);
				if (!((cfg[k] as number) > 0 && (cfg[k] as number) <= 100)) throw new HttpError(400, `config.${k} must be 1-100`, `config.${k}`);
			}
			break;
		}
	}
	return cfg;
}

const getMonitorRow = (env: Env, id: string) => env.DB.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first<MonitorRow>();
async function monitorNotifications(env: Env, id: string) {
	const r = await env.DB.prepare("SELECT notification_id FROM monitor_notifications WHERE monitor_id = ?").bind(id).all<{ notification_id: string }>();
	return r.results.map((x) => x.notification_id);
}
async function loadMonitor(env: Env, id: string) {
	const row = await must(getMonitorRow(env, id), "Monitor not found");
	const st = await hub(env).monitorState(id).catch(() => null);
	return toMonitor(env, overlay(row, st?.live ?? undefined), await monitorNotifications(env, id));
}

const asDaily = (id: string, day: string, d: HubView["today"][string] | undefined): DailyCounts[] =>
	d ? [{ monitor_id: id, day, up: d.up, down: d.down, degraded: d.degraded, latency_sum: d.latency_sum, latency_n: d.latency_n }] : [];

function hashOffset(id: string, mod: number): number {
	let h = 0;
	for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return h % Math.max(mod, 1);
}

admin.get("/monitors", async (c) => {
	const db = c.env.DB;
	const [rows, links, view] = await Promise.all([
		db.prepare("SELECT * FROM monitors ORDER BY sort, name COLLATE NOCASE").all<MonitorRow>(),
		db.prepare("SELECT * FROM monitor_notifications").all<{ monitor_id: string; notification_id: string }>(),
		hubView(c.env),
	]);
	const now = view?.now ?? Date.now();
	const today = utcDay(now);
	const yday = utcDay(now - 86_400_000);
	// Live state, last 30 checks and today's/yesterday's counts all come from the Hub: no history reads.
	const list: MonitorListItem[] = rows.results.map((r) => {
		const daily = [...asDaily(r.id, today, view?.today[r.id]), ...asDaily(r.id, yday, view?.yesterday[r.id])];
		return {
			...toMonitor(c.env, overlay(r, view?.live[r.id]), links.results.filter((l) => l.monitor_id === r.id).map((l) => l.notification_id)),
			uptime_24h: uptime24h(daily, null, now).uptime,
			recent: (view?.recent[r.id] ?? []).map(({ ts, status, latency_ms, message }) => ({ ts, status, latency_ms, message })),
		};
	});
	return c.json(list);
});

async function saveNotifications(env: Env, monitorId: string, ids: string[] | undefined) {
	if (!ids) return;
	await env.DB.batch([
		env.DB.prepare("DELETE FROM monitor_notifications WHERE monitor_id = ?").bind(monitorId),
		...ids.map((nid) => env.DB.prepare("INSERT OR IGNORE INTO monitor_notifications(monitor_id, notification_id) VALUES (?, ?)").bind(monitorId, nid)),
	]);
}

admin.post("/monitors", async (c) => {
	const body = monitorSchema.parse(await c.req.json());
	const cfg = validateConfig(body.type, body.config ?? {});
	const id = newId();
	const now = Date.now();
	const interval = body.interval_s ?? (body.type === "domain" ? 86400 : 60);
	await c.env.DB.prepare(
		`INSERT INTO monitors(id, name, type, config, parent_id, interval_s, retries, retry_interval_s, timeout_ms, max_latency_ms,
		  upside_down, resend_every, paused, description, tags, push_token, next_check_at, sort, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			body.name,
			body.type,
			JSON.stringify(cfg),
			body.parent_id ?? null,
			interval,
			body.retries ?? 0,
			body.retry_interval_s ?? 60,
			body.timeout_ms ?? 10000,
			body.max_latency_ms ?? null,
			body.upside_down ?? 0,
			body.resend_every ?? 0,
			body.paused ?? 0,
			body.description ?? null,
			JSON.stringify(body.tags ?? []),
			body.type === "heartbeat" ? newToken(32) : null,
			now + hashOffset(id, Math.min(interval, 300)) * 1000,
			body.sort ?? 0,
			now,
		)
		.run();
	if (body.notification_ids) await saveNotifications(c.env, id, body.notification_ids);
	else await c.env.DB.prepare("INSERT INTO monitor_notifications(monitor_id, notification_id) SELECT ?, id FROM notifications WHERE apply_default = 1").bind(id).run();
	await addEvent(c.env.DB, "monitor_added", id, `Monitor ${body.name} added`);
	return c.json(await loadMonitor(c.env, id), 201);
});

admin.post("/monitors/test", async (c) => {
	const body = monitorSchema.parse(await c.req.json());
	const cfg = validateConfig(body.type, body.config ?? {});
	const now = Date.now();
	const raw = await runCheck(c.env, { id: "test", type: body.type, config: JSON.stringify(cfg), timeout_ms: body.timeout_ms ?? 10000, last_ping_at: null, run_started_at: null, created_at: now }, now);
	if (!raw) return c.json({ ok: true, status: "pending", latency_ms: null, message: body.type === "group" ? "Groups take the worst status of their members" : "Waiting for data" });
	const s = nextState({ prev: "pending", fail_streak: 0, down_checks: 0, retries: 0, upside_down: !!body.upside_down, max_latency_ms: body.max_latency_ms ?? null, resend_every: 0 }, raw, false);
	return c.json({ ok: s.status !== "down", status: s.status, latency_ms: raw.latency_ms, message: s.message });
});

admin.get("/monitors/:id", async (c) => c.json(await loadMonitor(c.env, c.req.param("id"))));

admin.patch("/monitors/:id", async (c) => {
	const id = c.req.param("id");
	const row = await must(getMonitorRow(c.env, id), "Monitor not found");
	const body = monitorSchema.partial().parse(await c.req.json());
	const sets: string[] = [];
	const vals: unknown[] = [];
	const set = (col: string, v: unknown) => {
		sets.push(`${col} = ?`);
		vals.push(v);
	};
	if (body.config) set("config", JSON.stringify(validateConfig(body.type ?? row.type, body.config)));
	for (const k of ["name", "parent_id", "interval_s", "retries", "retry_interval_s", "timeout_ms", "max_latency_ms", "upside_down", "resend_every", "paused", "description", "sort"] as const) {
		if (body[k] !== undefined) set(k, body[k]);
	}
	if (body.tags) set("tags", JSON.stringify(body.tags));
	if (body.type && body.type !== row.type) {
		set("type", body.type);
		set("status", "pending");
		if (body.type === "heartbeat" && !row.push_token) set("push_token", newToken(32));
	}
	const reset: Record<string, unknown> = {};
	if (body.type && body.type !== row.type) reset.status = "pending";
	if (body.interval_s || body.config) {
		set("next_check_at", Date.now());
		reset.next_check_at = Date.now();
	}
	if (sets.length) await c.env.DB.prepare(`UPDATE monitors SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
	await saveNotifications(c.env, id, body.notification_ids);
	// The Hub owns the live columns: hand it the resets so its next flush does not undo them.
	if (Object.keys(reset).length) await hubReload(c.env, { reset: { [id]: reset } });
	return c.json(await loadMonitor(c.env, id));
});

admin.delete("/monitors/:id", async (c) => {
	const id = c.req.param("id");
	await must(getMonitorRow(c.env, id), "Monitor not found");
	const db = c.env.DB;
	await db.batch([
		db.prepare("DELETE FROM monitors WHERE id = ?").bind(id),
		db.prepare("UPDATE monitors SET parent_id = NULL WHERE parent_id = ?").bind(id),
		db.prepare("DELETE FROM check_buckets WHERE monitor_id = ?").bind(id),
		db.prepare("DELETE FROM monitor_daily WHERE monitor_id = ?").bind(id),
		db.prepare("DELETE FROM incidents WHERE monitor_id = ?").bind(id),
		db.prepare("DELETE FROM monitor_notifications WHERE monitor_id = ?").bind(id),
	]);
	return c.json({ ok: true });
});

admin.post("/monitors/:id/:action{pause|resume|clone|check-now}", async (c) => {
	const id = c.req.param("id");
	const row = await must(getMonitorRow(c.env, id), "Monitor not found");
	const db = c.env.DB;
	switch (c.req.param("action")) {
		case "pause":
			await db.prepare("UPDATE monitors SET paused = 1 WHERE id = ?").bind(id).run();
			return c.json(await loadMonitor(c.env, id));
		case "resume": {
			const now = Date.now();
			await db.prepare("UPDATE monitors SET paused = 0, status = 'pending', fail_streak = 0, next_check_at = ? WHERE id = ?").bind(now, id).run();
			await hubReload(c.env, { reset: { [id]: { status: "pending", fail_streak: 0, next_check_at: now } } });
			return c.json(await loadMonitor(c.env, id));
		}
		case "clone": {
			const nid = newId();
			await db
				.prepare(
					`INSERT INTO monitors(id, name, type, config, parent_id, interval_s, retries, retry_interval_s, timeout_ms, max_latency_ms,
					 upside_down, resend_every, paused, description, tags, push_token, next_check_at, sort, created_at)
					 SELECT ?, name || ' (copy)', type, config, parent_id, interval_s, retries, retry_interval_s, timeout_ms, max_latency_ms,
					 upside_down, resend_every, 1, description, tags, ?, ?, sort, ? FROM monitors WHERE id = ?`,
				)
				.bind(nid, row.type === "heartbeat" ? newToken(32) : null, Date.now(), Date.now(), id)
				.run();
			await db.prepare("INSERT INTO monitor_notifications(monitor_id, notification_id) SELECT ?, notification_id FROM monitor_notifications WHERE monitor_id = ?").bind(nid, id).run();
			return c.json(await loadMonitor(c.env, nid), 201);
		}
		default: {
			const st = await hub(c.env).monitorState(id).catch(() => null);
			const live = overlay(row, st?.live ?? undefined);
			const raw = await runCheck(c.env, live);
			if (!raw) return c.json({ ok: true, status: live.status, latency_ms: null, message: "Nothing to check yet" });
			const s = nextState({ prev: "pending", fail_streak: 0, down_checks: 0, retries: 0, upside_down: !!row.upside_down, max_latency_ms: row.max_latency_ms, resend_every: 0 }, raw, false);
			return c.json({ ok: s.status !== "down", status: s.status, latency_ms: raw.latency_ms, message: s.message });
		}
	}
});

admin.get("/monitors/:id/checks", async (c) => {
	const hours = Math.min(Number(c.req.query("hours") ?? 24), 168);
	// One D1 row per closed hour (packed JSON) plus the in-progress hour from the Hub.
	const rows: CheckPoint[] = await hub(c.env).checks(c.req.param("id"), Date.now() - hours * 3600_000);
	return c.json(rows);
});

admin.get("/monitors/:id/uptime", async (c) => {
	const id = c.req.param("id");
	const row = await must(getMonitorRow(c.env, id), "Monitor not found");
	const db = c.env.DB;
	const [view, hist] = await Promise.all([
		hubView(c.env),
		db.prepare("SELECT day, up, down, degraded, latency_sum, latency_n FROM monitor_daily WHERE monitor_id = ? AND day > ?")
			.bind(id, utcDay(Date.now() - 365 * 86_400_000))
			.all<Omit<DailyCounts, "monitor_id">>(),
	]);
	const now = view?.now ?? Date.now();
	const today = utcDay(now);
	// Today's row is whatever the Hub has (D1 lags up to an hour); earlier days from one D1 query.
	const rowsAll: DailyCounts[] = hist.results.filter((r) => !view || r.day !== today).map((r) => ({ ...r, monitor_id: id }));
	if (view) rowsAll.push(...asDaily(id, today, view.today[id]));
	const h24 = uptime24h(rowsAll.filter((r) => r.day >= utcDay(now - 86_400_000)), null, now);
	const days = (n: number) => {
		const from = utcDay(now - n * 86_400_000);
		let up = 0;
		let down = 0;
		for (const r of rowsAll) if (r.day > from) {
			up += r.up + r.degraded;
			down += r.down;
		}
		return up + down ? (100 * up) / (up + down) : null;
	};
	const live = overlay(row, view?.live[id]);
	const out: UptimeSummary = {
		h24: h24.uptime,
		d7: days(7),
		d30: days(30),
		d90: days(90),
		d365: days(365),
		avg_latency_24h: h24.latency,
		domain_days: live.domain_expires_at ? Math.floor((live.domain_expires_at - Date.now()) / 86_400_000) : null,
	};
	return c.json(out);
});

admin.get("/monitors/:id/incidents", async (c) => {
	const rows = await c.env.DB.prepare("SELECT id, monitor_id, started_at, resolved_at, cause FROM incidents WHERE monitor_id = ? ORDER BY started_at DESC LIMIT 100")
		.bind(c.req.param("id"))
		.all<Incident>();
	return c.json(rows.results);
});

admin.get("/incidents", async (c) => {
	const open = c.req.query("open") === "1";
	const rows = await c.env.DB.prepare(
		`SELECT i.id, i.monitor_id, m.name monitor_name, i.started_at, i.resolved_at, i.cause FROM incidents i
		 LEFT JOIN monitors m ON m.id = i.monitor_id ${open ? "WHERE i.resolved_at IS NULL" : ""} ORDER BY i.started_at DESC LIMIT 200`,
	).all<Incident>();
	return c.json(rows.results);
});

// ---------------------------------------------------------------- notifications

const channelSchema = z.object({
	name: z.string().min(1).max(80),
	type: z.enum(["discord", "slack", "telegram", "ntfy", "gotify", "pushover", "webhook"]),
	config: z.record(z.string(), z.string()),
	enabled: bool.optional(),
	apply_default: bool.optional(),
	apply_existing: z.boolean().optional(),
});
type ChannelRow = Parameters<typeof toChannel>[0];
const getChannel = (env: Env, id: string) => env.DB.prepare("SELECT * FROM notifications WHERE id = ?").bind(id).first<ChannelRow>();

admin.get("/notifications", async (c) => {
	const rows = await c.env.DB.prepare("SELECT * FROM notifications ORDER BY name COLLATE NOCASE").all<ChannelRow>();
	return c.json(rows.results.map(toChannel));
});
async function applyExisting(env: Env, id: string) {
	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO monitor_notifications(monitor_id, notification_id) SELECT id, ? FROM monitors").bind(id),
		env.DB.prepare("INSERT OR IGNORE INTO system_notifications(system_id, notification_id) SELECT id, ? FROM systems").bind(id),
	]);
}
admin.post("/notifications", async (c) => {
	const b = channelSchema.parse(await c.req.json());
	const id = newId();
	await c.env.DB.prepare("INSERT INTO notifications(id, name, type, config, enabled, apply_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(id, b.name, b.type, JSON.stringify(b.config), b.enabled ?? 1, b.apply_default ?? 0, Date.now())
		.run();
	if (b.apply_existing) await applyExisting(c.env, id);
	return c.json(toChannel((await getChannel(c.env, id))!), 201);
});
admin.patch("/notifications/:id", async (c) => {
	const id = c.req.param("id");
	const cur = await must(getChannel(c.env, id), "Channel not found");
	const b = channelSchema.partial().parse(await c.req.json());
	await c.env.DB.prepare("UPDATE notifications SET name = ?, type = ?, config = ?, enabled = ?, apply_default = ? WHERE id = ?")
		.bind(b.name ?? cur.name, b.type ?? cur.type, b.config ? JSON.stringify(b.config) : cur.config, b.enabled ?? cur.enabled, b.apply_default ?? cur.apply_default, id)
		.run();
	if (b.apply_existing) await applyExisting(c.env, id);
	return c.json(toChannel((await getChannel(c.env, id))!));
});
admin.delete("/notifications/:id", async (c) => {
	const id = c.req.param("id");
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM notifications WHERE id = ?").bind(id),
		c.env.DB.prepare("DELETE FROM monitor_notifications WHERE notification_id = ?").bind(id),
		c.env.DB.prepare("DELETE FROM system_notifications WHERE notification_id = ?").bind(id),
	]);
	return c.json({ ok: true });
});
admin.post("/notifications/:id/test", async (c) => {
	const ch = toChannel(await must(getChannel(c.env, c.req.param("id")), "Channel not found"));
	const m: NotifyMessage = {
		title: "🔔 Richter test notification",
		body: `If you can read this, the "${ch.name}" channel works.`,
		status: "info",
		name: "Richter",
		url: `https://${c.env.DASHBOARD_HOST}`,
	};
	let error: string | null = null;
	try {
		await sendToChannel(ch.type, ch.config, m);
	} catch (e) {
		error = (e as Error).message || String(e);
	}
	await logNotifications(c.env, { kind: "test", id: null }, m, [{ ch, error }]);
	return c.json(error ? { ok: false, error } : { ok: true });
});

/** Notification log, newest first: `?before=<id>` pages back, `limit` up to 200 (default 50). */
admin.get("/notification-log", async (c) => {
	const before = Number(c.req.query("before")) || Number.MAX_SAFE_INTEGER;
	const limit = Math.min(200, Math.max(1, Number(c.req.query("limit")) || 50));
	const r = await c.env.DB.prepare("SELECT * FROM notification_log WHERE id < ? ORDER BY id DESC LIMIT ?")
		.bind(before, limit + 1)
		.all<Omit<NotificationLogEntry, "ok"> & { ok: number }>();
	const rows = r.results.slice(0, limit).map((x) => ({ ...x, ok: !!x.ok }));
	return c.json({ entries: rows, more: r.results.length > limit });
});

// ---------------------------------------------------------------- status pages

const pageSchema = z.object({
	slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes"),
	title: z.string().min(1).max(120),
	description: z.string().max(1000).nullable().optional(),
	logo_url: z.string().url().nullable().optional().or(z.literal("").transform(() => null)),
	custom_domain: z
		.string()
		.regex(/^[a-z0-9.-]+$/)
		.nullable()
		.optional()
		.or(z.literal("").transform(() => null)),
	footer_text: z.string().max(500).nullable().optional(),
	layout: z
		.array(z.object({ name: z.string().max(80), items: z.array(z.object({ kind: z.enum(["monitor", "system"]), id: z.string(), link: z.boolean().optional() })) }))
		.optional(),
	show_uptime_bars: bool.optional(),
	show_latency: bool.optional(),
	show_tags: bool.optional(),
	show_system_uptime: bool.optional(),
	show_system_cpu: bool.optional(),
	show_mobile_sparklines: bool.optional(),
	published: bool.optional(),
	is_default: bool.optional(),
	accent_color: z.string().max(20).nullable().optional(),
	custom_css: z.string().max(20000).nullable().optional(),
});
/** status_pages.show_system_uptime / show_system_cpu / show_mobile_sparklines (later migrations) are read here rather than in mappers.toPage. */
type PageRowX = PageRow & { show_system_uptime?: number; show_system_cpu?: number; show_mobile_sparklines?: number };
const pageOut = (env: Env, r: PageRow) => ({
	...toPage(env, r),
	show_system_uptime: !!(r as PageRowX).show_system_uptime,
	show_system_cpu: ((r as PageRowX).show_system_cpu ?? 1) !== 0,
	show_mobile_sparklines: ((r as PageRowX).show_mobile_sparklines ?? 1) !== 0,
});
const getPage = (env: Env, id: string) => env.DB.prepare("SELECT * FROM status_pages WHERE id = ?").bind(id).first<PageRow>();

admin.get("/status-pages", async (c) => {
	const rows = await c.env.DB.prepare("SELECT * FROM status_pages ORDER BY is_default DESC, title COLLATE NOCASE").all<PageRow>();
	return c.json(rows.results.map((r) => pageOut(c.env, r)));
});
admin.get("/status-pages/:id", async (c) => c.json(pageOut(c.env, await must(getPage(c.env, c.req.param("id")), "Page not found"))));

async function writePage(env: Env, id: string, b: z.infer<typeof pageSchema>, cur: PageRow | null) {
	const v = <K extends keyof PageRow>(k: K, x: unknown) => (x !== undefined ? x : cur ? cur[k] : null);
	if (b.is_default) await env.DB.prepare("UPDATE status_pages SET is_default = 0 WHERE id != ?").bind(id).run();
	await env.DB.prepare(
		`INSERT INTO status_pages(id, slug, title, description, logo_url, custom_domain, footer_text, layout, show_uptime_bars, show_latency,
		  show_tags, show_system_uptime, show_system_cpu, show_mobile_sparklines, published, is_default, accent_color, custom_css, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, title = excluded.title, description = excluded.description, logo_url = excluded.logo_url,
		  custom_domain = excluded.custom_domain, footer_text = excluded.footer_text, layout = excluded.layout, show_uptime_bars = excluded.show_uptime_bars,
		  show_latency = excluded.show_latency, show_tags = excluded.show_tags, show_system_uptime = excluded.show_system_uptime, show_system_cpu = excluded.show_system_cpu, show_mobile_sparklines = excluded.show_mobile_sparklines, published = excluded.published, is_default = excluded.is_default,
		  accent_color = excluded.accent_color, custom_css = excluded.custom_css`,
	)
		.bind(
			id,
			b.slug,
			b.title,
			v("description", b.description),
			v("logo_url", b.logo_url),
			v("custom_domain", b.custom_domain),
			v("footer_text", b.footer_text),
			b.layout ? JSON.stringify(b.layout) : (cur?.layout ?? "[]"),
			v("show_uptime_bars", b.show_uptime_bars) ?? 1,
			v("show_latency", b.show_latency) ?? 1,
			v("show_tags", b.show_tags) ?? 0,
			b.show_system_uptime !== undefined ? b.show_system_uptime : ((cur as PageRowX | null)?.show_system_uptime ?? 0),
			b.show_system_cpu !== undefined ? b.show_system_cpu : ((cur as PageRowX | null)?.show_system_cpu ?? 1),
			b.show_mobile_sparklines !== undefined ? b.show_mobile_sparklines : ((cur as PageRowX | null)?.show_mobile_sparklines ?? 1),
			v("published", b.published) ?? 1,
			v("is_default", b.is_default) ?? 0,
			v("accent_color", b.accent_color),
			v("custom_css", b.custom_css),
			cur?.created_at ?? Date.now(),
		)
		.run();
	// There must always be a default page if any exist.
	await env.DB.prepare(
		"UPDATE status_pages SET is_default = 1 WHERE id = (SELECT id FROM status_pages ORDER BY created_at LIMIT 1) AND NOT EXISTS (SELECT 1 FROM status_pages WHERE is_default = 1)",
	).run();
}

admin.post("/status-pages", async (c) => {
	const b = pageSchema.parse(await c.req.json());
	const id = newId();
	await writePage(c.env, id, b, null);
	return c.json(pageOut(c.env, (await getPage(c.env, id))!), 201);
});
admin.patch("/status-pages/:id", async (c) => {
	const id = c.req.param("id");
	const cur = await must(getPage(c.env, id), "Page not found");
	const b = pageSchema.partial().parse(await c.req.json());
	await writePage(c.env, id, { ...b, slug: b.slug ?? cur.slug, title: b.title ?? cur.title }, cur);
	return c.json(pageOut(c.env, (await getPage(c.env, id))!));
});
admin.delete("/status-pages/:id", async (c) => {
	await c.env.DB.prepare("DELETE FROM status_pages WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- maintenance & announcements

const maintSchema = z.object({
	title: z.string().min(1).max(200),
	description: z.string().max(2000).nullable().optional(),
	starts_at: z.number().int(),
	ends_at: z.number().int(),
	repeat: z.object({ every: z.enum(["day", "week", "month"]), until: z.number().int().nullable() }).nullable().optional(),
	monitor_ids: z.array(z.string()).default([]),
	system_ids: z.array(z.string()).default([]),
});
const getMaint = (env: Env, id: string) => env.DB.prepare("SELECT * FROM maintenances WHERE id = ?").bind(id).first<MaintenanceRow>();

admin.get("/maintenances", async (c) => {
	const rows = await c.env.DB.prepare("SELECT * FROM maintenances ORDER BY starts_at DESC").all<MaintenanceRow>();
	return c.json(rows.results.map((r) => toMaintenance(r)));
});
async function writeMaint(env: Env, id: string, b: z.infer<typeof maintSchema>, createdAt: number) {
	if (b.ends_at <= b.starts_at) throw new HttpError(400, "End must be after start", "ends_at");
	if (b.repeat && b.ends_at - b.starts_at > 86_400_000) throw new HttpError(400, "A repeating window can last at most 24 hours", "ends_at");
	await env.DB.prepare(
		`INSERT OR REPLACE INTO maintenances(id, title, description, starts_at, ends_at, repeat, monitor_ids, system_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, b.title, b.description ?? null, b.starts_at, b.ends_at, b.repeat ? JSON.stringify(b.repeat) : null, JSON.stringify(b.monitor_ids), JSON.stringify(b.system_ids), createdAt)
		.run();
}
admin.post("/maintenances", async (c) => {
	const id = newId();
	await writeMaint(c.env, id, maintSchema.parse(await c.req.json()), Date.now());
	return c.json(toMaintenance((await getMaint(c.env, id))!), 201);
});
admin.patch("/maintenances/:id", async (c) => {
	const id = c.req.param("id");
	const cur = toMaintenance(await must(getMaint(c.env, id), "Maintenance not found"));
	const b = maintSchema.parse({ ...cur, ...(await c.req.json()) });
	await writeMaint(c.env, id, b, cur.created_at);
	return c.json(toMaintenance((await getMaint(c.env, id))!));
});
admin.delete("/maintenances/:id", async (c) => {
	await c.env.DB.prepare("DELETE FROM maintenances WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

const annSchema = z.object({
	status_page_id: z.string().nullable().optional(),
	title: z.string().min(1).max(200),
	body: z.string().min(1).max(5000),
	severity: z.enum(["info", "warning", "danger", "success"]).default("info"),
	pinned: bool.optional(),
	starts_at: z.number().int().nullable().optional(),
	ends_at: z.number().int().nullable().optional(),
});
type AnnRow = Parameters<typeof toAnnouncement>[0];
const getAnn = (env: Env, id: string) => env.DB.prepare("SELECT * FROM announcements WHERE id = ?").bind(id).first<AnnRow>();

admin.get("/announcements", async (c) => {
	const rows = await c.env.DB.prepare("SELECT * FROM announcements ORDER BY created_at DESC").all<AnnRow>();
	return c.json(rows.results.map(toAnnouncement));
});
admin.post("/announcements", async (c) => {
	const b = annSchema.parse(await c.req.json());
	const id = newId();
	const now = Date.now();
	await c.env.DB.prepare(
		"INSERT INTO announcements(id, status_page_id, title, body, severity, pinned, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(id, b.status_page_id ?? null, b.title, b.body, b.severity, b.pinned ?? 1, b.starts_at ?? null, b.ends_at ?? null, now, now)
		.run();
	return c.json(toAnnouncement((await getAnn(c.env, id))!), 201);
});
admin.patch("/announcements/:id", async (c) => {
	const id = c.req.param("id");
	const cur = toAnnouncement(await must(getAnn(c.env, id), "Announcement not found"));
	const b = annSchema.parse({ ...cur, ...(await c.req.json()) });
	await c.env.DB.prepare("UPDATE announcements SET status_page_id = ?, title = ?, body = ?, severity = ?, pinned = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?")
		.bind(b.status_page_id ?? null, b.title, b.body, b.severity, b.pinned ?? 1, b.starts_at ?? null, b.ends_at ?? null, Date.now(), id)
		.run();
	return c.json(toAnnouncement((await getAnn(c.env, id))!));
});
admin.delete("/announcements/:id", async (c) => {
	await c.env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- export / import

const EXPORT_TABLES = ["monitors", "notifications", "monitor_notifications", "status_pages", "maintenances", "announcements", "systems", "system_alerts", "system_notifications"] as const;

admin.get("/export", async (c) => {
	const out: Record<string, unknown[]> = {};
	for (const t of EXPORT_TABLES) out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
	// Agent credentials never leave the hub: a leaked backup must not let anyone impersonate an agent.
	out.systems = out.systems.map((r) => {
		const { token: _token, fingerprint: _fingerprint, ...rest } = r as Record<string, unknown>;
		return rest;
	});
	c.header("content-disposition", `attachment; filename="richter-backup-${new Date().toISOString().slice(0, 10)}.json"`);
	return c.json({ version: 1, exported_at: Date.now(), ...out });
});

admin.post("/import", async (c) => {
	const body = (await c.req.json()) as Record<string, unknown>;
	if (body.version !== 1) throw new HttpError(400, "Unsupported backup version");
	const counts: Record<string, number> = {};
	for (const t of EXPORT_TABLES) {
		const rows = (body[t] as Record<string, unknown>[] | undefined) ?? [];
		counts[t] = rows.length;
		const stmts = rows.map((r) => {
			const cols = Object.keys(r).filter((k) => /^[a-z_]+$/.test(k) && !(t === "systems" && (k === "token" || k === "fingerprint")));
			const values = cols.map((k) => r[k] as never);
			if (t === "systems") {
				// Backups carry no agent tokens. Existing systems keep theirs; new ones get a fresh token
				// and must be re-installed with the snippet from the dashboard.
				const updates = cols.filter((k) => k !== "id").map((k) => `${k} = excluded.${k}`);
				return c.env.DB.prepare(
					`INSERT INTO systems(${cols.join(", ")}, token) VALUES (${cols.map(() => "?").join(", ")}, ?)
					 ON CONFLICT(id) DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
				).bind(...values, newToken(32));
			}
			return c.env.DB.prepare(`INSERT OR REPLACE INTO ${t}(${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...values);
		});
		for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
	}
	await addEvent(c.env.DB, "import", null, `Imported backup (${Object.values(counts).reduce((a, b) => a + b, 0)} rows)`);
	return c.json({ ok: true, counts });
});
