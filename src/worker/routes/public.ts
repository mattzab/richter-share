import { Hono, type Context } from "hono";
import type { PublicPage, StatusPageGroup } from "../../shared/types";
import { parseJson } from "../db";
import type { Env } from "../env";
import { overlay } from "../hub";
import { hub } from "../hub-client";
import { utcDay, type MonitorRow } from "../monitors/engine";
import { CARD_H, CARD_W, cardPng, OVERALL_TEXT } from "../og/card";
import { MAX_PUSH_BYTES, normalizePvePush } from "../beszel/pve";
import PVE_SCRIPT from "../../../pve/richter-pve.sh?raw";

/** Edge-cache generation for public JSON and OG images. */
const CACHE_V = 2;

type Ctx = { Bindings: Env };
export const pub = new Hono<Ctx>();

const PUBLIC_TTL_S = 60;

/**
 * Serve a public page: edge cache (per host/slug) for PUBLIC_TTL_S seconds, then the Hub's
 * precomputed snapshot, which is rebuilt only when something changed (at most every 10 s) or once a minute.
 */
async function cachedPage(c: Context<Ctx>, host: string, slug: string | null, notFound: string): Promise<Response> {
	const json = await pageJson(c, new URL(c.req.url).hostname, host, slug);
	if (!json) return c.json({ error: notFound }, 404);
	return new Response(json, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${PUBLIC_TTL_S}` } });
}

/** The public page JSON for a host (custom domain / default page) or slug, through the same edge cache entry as its API route. */
async function pageJson(c: Context<Ctx>, reqHost: string, host: string, slug: string | null): Promise<string | null> {
	// CACHE_V: bump to orphan every cached copy at once (e.g. after hiding an item's address); caches.default is per colo.
	const key = new Request(`https://${reqHost}${slug ? `/api/public/pages/${encodeURIComponent(slug)}` : "/api/public/page"}?cv=${CACHE_V}`, { method: "GET" });
	const cache = (caches as unknown as { default: Cache }).default;
	const hit = await cache.match(key);
	if (hit) return hit.text();
	const json = await hub(c.env).publicPage(host, slug);
	if (json) {
		const res = new Response(json, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${PUBLIC_TTL_S}` } });
		c.executionCtx.waitUntil(cache.put(key, res));
	}
	return json;
}

pub.get("/api/public/page", (c) => cachedPage(c, new URL(c.req.url).hostname, null, "No status page published yet"));
pub.get("/api/public/pages/:slug", (c) => cachedPage(c, "", c.req.param("slug"), "Status page not found"));

// ---------------------------------------------------------------- link previews

const OG_TTL_S = 20 * 60;
const isDashboard = (env: Env, host: string) => host === env.DASHBOARD_HOST || host === "localhost" || host === "127.0.0.1";

export function pageDescription(p: PublicPage["page"]): string {
	const d = (p.description ?? "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#>~]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!d) return `Live status and uptime for ${p.title}`;
	return d.length > 200 ? `${d.slice(0, 197).trimEnd()}…` : d;
}

/** Open Graph + Twitter Card tags for a public page, injected server-side (preview bots don't run JS). */
export function metaTags(p: PublicPage, url: string, image: string): string {
	const title = p.page.title;
	const desc = pageDescription(p.page);
	const tags: [string, string, string][] = [
		["name", "description", desc],
		["property", "og:type", "website"],
		["property", "og:site_name", title],
		["property", "og:title", title],
		["property", "og:description", desc],
		["property", "og:url", url],
		["property", "og:image", image],
		["property", "og:image:type", "image/png"],
		["property", "og:image:width", String(CARD_W)],
		["property", "og:image:height", String(CARD_H)],
		["property", "og:image:alt", `${title}: ${OVERALL_TEXT[p.overall]?.label ?? "status"}`],
		["name", "twitter:card", "summary_large_image"],
		["name", "twitter:title", title],
		["name", "twitter:description", desc],
		["name", "twitter:image", image],
		["name", "twitter:image:alt", `${title}: ${OVERALL_TEXT[p.overall]?.label ?? "status"}`],
	];
	return tags.map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}" />`).join("\n\t\t");
}

async function pageHtml(c: Context<Ctx>, slug: string | null): Promise<Response> {
	const url = new URL(c.req.url);
	const spa = await c.env.ASSETS.fetch(c.req.raw);
	if (isDashboard(c.env, url.hostname) || c.req.method !== "GET") return spa;
	let p: PublicPage | null = null;
	try {
		const json = await pageJson(c, url.hostname, slug ? "" : url.hostname, slug);
		p = json ? (JSON.parse(json) as PublicPage) : null;
	} catch (e) {
		console.error("og: page lookup failed", (e as Error).message);
	}
	if (!p || !(spa.headers.get("content-type") ?? "").includes("text/html")) return spa;
	const pageUrl = `https://${url.hostname}${slug ? `/s/${encodeURIComponent(slug)}` : "/"}`;
	// The state is in the image URL so a status change is a new image for crawlers that cache by URL.
	const image = `https://${url.hostname}${slug ? `/og/${encodeURIComponent(slug)}.png` : "/og.png"}?s=${p.overall}`;
	const tags = metaTags(p, pageUrl, image);
	const page = p.page;
	const res = new HTMLRewriter()
		.on("title", { element: (el) => void el.setInnerContent(page.title) })
		.on("head", { element: (el) => void el.append(tags, { html: true }) })
		.on('link[rel="icon"]', {
			element: (el) => {
				if (page.logo_url) (el.setAttribute("href", page.logo_url), el.removeAttribute("type"));
			},
		})
		.transform(spa);
	const h = new Headers(res.headers);
	h.set("cache-control", "no-cache");
	h.delete("etag");
	return new Response(res.body, { status: res.status, headers: h });
}
pub.get("/", (c) => pageHtml(c, null));
pub.get("/s/:slug", (c) => pageHtml(c, c.req.param("slug")));

/** Fetch the page logo for the card as a data: URI (png/jpeg/gif/webp/svg up to 1 MB), or null. */
async function logoData(src: string | null): Promise<string | null> {
	if (!src || !/^https:\/\//.test(src)) return null;
	try {
		const r = await fetch(src, { signal: AbortSignal.timeout(3000), cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
		const type = (r.headers.get("content-type") ?? "").split(";")[0].trim();
		if (!r.ok || !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(type)) return null;
		const buf = new Uint8Array(await r.arrayBuffer());
		if (buf.length > 1_000_000) return null;
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
		return `data:${type};base64,${btoa(bin)}`;
	} catch {
		return null;
	}
}

async function ogImage(c: Context<Ctx>, slug: string | null): Promise<Response> {
	const url = new URL(c.req.url);
	if (isDashboard(c.env, url.hostname)) return c.text("Not found", 404);
	const cache = (caches as unknown as { default: Cache }).default;
	// Canonical key (path + a known state only) so arbitrary query strings can't force fresh renders.
	const st = url.searchParams.get("s");
	const key = new Request(`https://${url.hostname}${url.pathname}?cv=${CACHE_V}${st && st in OVERALL_TEXT ? `&s=${st}` : ""}`, { method: "GET" });
	const hit = await cache.match(key);
	if (hit) return new Response(hit.body, hit);
	const json = await pageJson(c, url.hostname, slug ? "" : url.hostname, slug);
	if (!json) return c.text("Not found", 404);
	const p = JSON.parse(json) as PublicPage;
	const png = await cardPng({ page: p, host: url.hostname, logo: await logoData(p.page.logo_url) });
	const res = new Response(png as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png", "cache-control": `public, max-age=${OG_TTL_S}` } });
	c.executionCtx.waitUntil(cache.put(key, res.clone()));
	return res;
}
pub.get("/og.png", (c) => ogImage(c, null));
pub.get("/og/:file{.+\\.png}", (c) => ogImage(c, c.req.param("file").replace(/\.png$/, "")));

// ---------------------------------------------------------------- feed

const esc = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);

pub.get("/feed.atom", async (c) => {
	const json = await hub(c.env).publicPage(new URL(c.req.url).hostname, c.req.query("page") || null);
	if (!json) return c.text("Not found", 404);
	const p = JSON.parse(json) as PublicPage;
	const base = `https://${c.env.PUBLIC_HOST}`;
	const entries = [
		...p.incidents.map((i) => ({
			id: `incident-${i.id}`,
			at: i.resolved_at ?? i.started_at,
			title: `${i.resolved_at ? "Resolved" : "Outage"}: ${i.name}`,
			body: i.cause ?? "",
		})),
		...p.maintenances.map((m) => ({ id: `maintenance-${m.id}`, at: m.next_start ?? m.starts_at, title: `Maintenance: ${m.title}`, body: m.description ?? "" })),
		...p.announcements.map((a) => ({ id: `announcement-${a.id}`, at: a.created_at, title: a.title, body: a.body })),
	]
		.sort((a, b) => b.at - a.at)
		.slice(0, 50);
	const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(p.page.title)}</title>
  <id>${base}/s/${esc(p.page.slug)}</id>
  <link href="${base}/s/${esc(p.page.slug)}"/>
  <updated>${new Date(p.generated_at).toISOString()}</updated>
${entries
	.map(
		(e) => `  <entry>
    <id>${base}/${e.id}</id>
    <title>${esc(e.title)}</title>
    <updated>${new Date(e.at).toISOString()}</updated>
    <content type="text">${esc(e.body)}</content>
  </entry>`,
	)
	.join("\n")}
</feed>`;
	return c.body(xml, 200, { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=60" });
});

// ---------------------------------------------------------------- badges & embed

/** Only monitors listed on at least one published page are exposed publicly. */
async function publicMonitor(env: Env, id: string): Promise<(MonitorRow & { today: { up: number; down: number; degraded: number } | null }) | null> {
	const pages = await env.DB.prepare("SELECT layout FROM status_pages WHERE published = 1").all<{ layout: string }>();
	const listed = pages.results.some((p) => parseJson<StatusPageGroup[]>(p.layout, []).some((g) => g.items.some((i) => i.kind === "monitor" && i.id === id)));
	if (!listed) return null;
	const m = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?").bind(id).first<MonitorRow>();
	if (!m) return null;
	const st = await hub(env).monitorState(id).catch(() => null);
	return { ...overlay(m, st?.live ?? undefined), today: st?.today ?? null };
}

const COLOR: Record<string, string> = { up: "#22c55e", degraded: "#f59e0b", down: "#ef4444", maintenance: "#3b82f6", running: "#3b82f6" };

function badge(label: string, message: string, color: string): string {
	const w = (s: string) => Math.round(s.length * 6.6 + 12);
	const lw = w(label);
	const mw = w(message);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + mw}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + mw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${mw}" height="20" fill="${esc(color)}"/><rect width="${lw + mw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + mw / 2}" y="14">${esc(message)}</text></g></svg>`;
}

pub.get("/badge/:id/:file", async (c) => {
	const kind = c.req.param("file").match(/^(status|uptime|latency)\.svg$/)?.[1];
	if (!kind) return c.text("Not found", 404);
	const m = await publicMonitor(c.env, c.req.param("id"));
	if (!m) return c.text("Not found", 404);
	const qColor = c.req.query("color");
	let label = c.req.query("label") ?? m.name;
	let message: string;
	let color: string;
	if (kind === "status") {
		message = m.paused ? "paused" : m.status;
		color = COLOR[message] ?? "#9ca3af";
	} else if (kind === "uptime") {
		const days = Math.min(Number(c.req.query("days") ?? 30), 365);
		// Closed days from D1; today (not yet flushed) from the Hub.
		const r = await c.env.DB.prepare("SELECT SUM(up + degraded) up, SUM(down) down FROM monitor_daily WHERE monitor_id = ? AND day > ? AND day < ?")
			.bind(m.id, utcDay(Date.now() - days * 86_400_000), utcDay(Date.now()))
			.first<{ up: number | null; down: number | null }>();
		const up = (r?.up ?? 0) + (m.today ? m.today.up + m.today.degraded : 0);
		const t = up + (r?.down ?? 0) + (m.today?.down ?? 0);
		const pct = t ? (100 * up) / t : null;
		label = c.req.query("label") ?? `uptime ${days}d`;
		message = pct == null ? "n/a" : `${pct >= 99.995 ? "100" : pct.toFixed(2)}%`;
		color = pct == null ? "#9ca3af" : pct >= 99.9 ? "#22c55e" : pct >= 99 ? "#84cc16" : pct >= 95 ? "#f59e0b" : "#ef4444";
	} else {
		label = c.req.query("label") ?? "latency";
		message = m.last_latency_ms != null ? `${m.last_latency_ms} ms` : "n/a";
		color = "#3b82f6";
	}
	if (qColor && /^#?[0-9a-f]{3,6}$/i.test(qColor)) color = qColor.startsWith("#") ? qColor : `#${qColor}`;
	return c.body(badge(label.slice(0, 64), message.slice(0, 64), color), 200, {
		"content-type": "image/svg+xml",
		"cache-control": "public, max-age=60",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
	});
});

pub.get("/embed/:id", async (c) => {
	const m = await publicMonitor(c.env, c.req.param("id"));
	if (!m) return c.text("Not found", 404);
	const dark = c.req.query("theme") !== "light";
	const status = m.paused ? "paused" : m.status;
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:14px system-ui,sans-serif;background:${dark ? "#09090b" : "#fff"};color:${dark ? "#fafafa" : "#18181b"}}
.c{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid ${dark ? "#27272a" : "#e4e4e7"};border-radius:10px}
.d{width:10px;height:10px;border-radius:50%;background:${COLOR[status] ?? "#9ca3af"};box-shadow:0 0 0 3px ${COLOR[status] ?? "#9ca3af"}33}
.n{font-weight:600;flex:1}.s{opacity:.7;text-transform:capitalize}</style></head>
<body><div class="c"><span class="d"></span><span class="n">${esc(m.name)}</span><span class="s">${esc(status)}</span></div></body></html>`;
	return c.html(html, 200, { "cache-control": "public, max-age=60", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
});

// ---------------------------------------------------------------- heartbeat pings

const pingCounts = new Map<string, { minute: number; n: number }>();

pub.all("/ping/:token/:action?", async (c) => {
	const token = c.req.param("token");
	const action = c.req.param("action") ?? "";
	// Best-effort per-isolate rate limit: 30 pings per minute per token.
	const minute = Math.floor(Date.now() / 60_000);
	const rc = pingCounts.get(token);
	if (rc && rc.minute === minute && rc.n >= 30) return c.json({ ok: false, error: "rate limited" }, 429);
	pingCounts.set(token, { minute, n: rc && rc.minute === minute ? rc.n + 1 : 1 });

	if (action === "start") {
		const r = await hub(c.env).ping(token, "start", true, null, null);
		return c.json(r.body, r.status);
	}

	let ok = true;
	let message: string | null = "Ping received";
	const qs = c.req.query("status");
	if (action === "fail") {
		ok = false;
		message = c.req.method === "POST" ? (await c.req.text()).slice(0, 1000) || "Job reported failure" : "Job reported failure";
	} else if (/^\d{1,3}$/.test(action)) {
		const code = Number(action);
		if (code > 255) return c.json({ ok: false, error: "exit code must be 0-255" }, 400);
		ok = code === 0;
		message = ok ? "Exit code 0" : `Exit code ${code}`;
	} else if (action) {
		return c.json({ ok: false, error: "unknown action" }, 404);
	} else if (qs) {
		// Uptime Kuma push compatibility: ?status=up|down&msg=...&ping=ms
		ok = qs !== "down";
		message = c.req.query("msg") || message;
	}
	const latency = Number(c.req.query("ping")) || null;
	// The Hub owns heartbeat state: one RPC, and D1 is only written when the status changes.
	const r = await hub(c.env).ping(token, action, ok, message, latency);
	return c.json(r.body, r.status);
});

// ---------------------------------------------------------------- Proxmox companion (richter-pve)

pub.get("/pve/richter-pve.sh", (c) => c.body(PVE_SCRIPT, 200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "public, max-age=300" }));

/** richter-pve push: the host's guest list, authenticated with the system's agent token. */
pub.post("/api/pve/push", async (c) => {
	const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
	if (!token || token.length > 64) return c.json({ ok: false, error: "missing token" }, 401);
	const sys = await c.env.DB.prepare("SELECT id, name, status FROM systems WHERE token = ?").bind(token).first<{ id: string; name: string; status: string }>();
	if (!sys) return c.json({ ok: false, error: "invalid token" }, 401);
	if (sys.status === "paused") return c.json({ ok: true, paused: true });
	if (Number(c.req.header("content-length") ?? 0) > MAX_PUSH_BYTES) return c.json({ ok: false, error: "payload too large" }, 413);
	const text = await c.req.text();
	if (text.length > MAX_PUSH_BYTES) return c.json({ ok: false, error: "payload too large" }, 413);
	let snap;
	try {
		snap = normalizePvePush(JSON.parse(text));
	} catch (e) {
		return c.json({ ok: false, error: (e as Error).message }, 400);
	}
	const r = await c.env.AGENT.get(c.env.AGENT.idFromName(sys.id)).pveIngest(sys.id, sys.name, snap);
	return c.json({ ok: true, ...r });
});

// ---------------------------------------------------------------- beszel agent

pub.get("/api/beszel/agent-connect", async (c) => {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.text("Expected WebSocket", 426);
	const token = c.req.header("x-token") ?? "";
	const version = c.req.header("x-beszel") ?? "";
	if (!token || !version || token.length > 64) return c.body(null, 400);
	const sys = await c.env.DB.prepare("SELECT id, status FROM systems WHERE token = ?").bind(token).first<{ id: string; status: string }>();
	if (!sys) return c.text("Invalid token", 401);
	const m = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	if (!m) return c.text("Invalid agent version", 401);
	const [maj, min] = [Number(m[1]), Number(m[2])];
	if (maj === 0 && min < 13) return c.text("Agent too old: Richter needs beszel-agent 0.13.0 or newer", 401);
	if (sys.status === "paused") return c.text("System paused", 403);
	const stub = c.env.AGENT.get(c.env.AGENT.idFromName(sys.id));
	const headers = new Headers(c.req.raw.headers);
	headers.set("x-richter-system", sys.id);
	return stub.fetch(new Request("https://agent/connect", { headers }));
});

// ---------------------------------------------------------------- shared

export async function hostInfo(env: Env, host: string) {
	const dashboard = host === env.DASHBOARD_HOST || host === "localhost" || host === "127.0.0.1";
	let pageSlug: string | null = null;
	if (!dashboard) {
		const p = await env.DB.prepare("SELECT slug FROM status_pages WHERE custom_domain = ?").bind(host).first<{ slug: string }>();
		pageSlug = p?.slug ?? null;
	}
	return { mode: dashboard ? "dashboard" : "public", pageSlug, publicUrl: `https://${env.PUBLIC_HOST}`, dashboardUrl: `https://${env.DASHBOARD_HOST}` };
}
