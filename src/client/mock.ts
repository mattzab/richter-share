// In-memory fake backend for UI development. Only loaded when VITE_MOCK=1.
// Covers every endpoint in docs/API.md; mutations persist until reload.
import type {
	AccessSettings,
	DashboardUser,
	Me,
	Role,
	NotificationLogEntry,
	PackageSnapshot,
	PveSnapshot,
	ServicesSnapshot,
	SystemdService,
	Announcement,
	CheckNowResult,
	CheckPoint,
	ContainerPoint,
	ContainerStat,
	DayBar,
	EventRecord,
	HostInfo,
	Incident,
	Maintenance,
	Monitor,
	MonitorInput,
	MonitorListItem,
	NotificationChannel,
	Overview,
	PublicItem,
	PublicPage,
	Settings,
	StatsPoint,
	StatsRange,
	StatusPage,
	SystemAlert,
	SystemInstall,
	SystemRecord,
	SystemStats,
	UptimeSummary,
} from "@shared/types";
import { ApiError } from "./api";
import { buildInstall } from "@shared/install";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = () => Date.now();
const T0 = now();

let seed = 42;
const rand = () => {
	seed = (seed * 16807) % 2147483647;
	return (seed - 1) / 2147483646;
};
const id15 = () => Array.from({ length: 15 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const GB = 1024 ** 3;
const MB = 1024 ** 2;

// ---- Systems -------------------------------------------------------------------

interface SysProfile {
	cpuBase: number;
	memTotal: number;
	memBase: number;
	disk: number;
	diskUsed: number;
	cores: number;
	gpu?: boolean;
	containers?: string[];
	temps: string[];
	fans?: boolean;
	efs?: boolean;
}

const systems: SystemRecord[] = [
	mkSystem("web-01", "up", ["prod", "web"], { h: "web-01", k: "6.8.0-45-generic", c: 4, t: 8, m: "AMD EPYC 7763 64-Core", u: 1_843_200, os: 0 }),
	mkSystem("db-primary", "up", ["prod", "db"], { h: "db-primary", k: "6.1.0-25-amd64", c: 8, t: 16, m: "Intel Xeon E-2388G", u: 5_402_000, os: 0 }),
	mkSystem("gpu-box", "up", ["lab"], { h: "gpu-box", k: "6.10.11-arch1-1", c: 16, t: 32, m: "AMD Ryzen 9 7950X", u: 302_400, os: 0 }),
	mkSystem("mac-mini", "down", ["lab"], { h: "mac-mini.local", k: "24.1.0", c: 8, t: 8, m: "Apple M2", u: 0, os: 1 }),
	mkSystem("pve02", "up", ["proxmox"], { h: "pve02", k: "6.8.12-9-pve", c: 16, t: 32, m: "AMD EPYC 7302P 16-Core", u: 3_100_000, os: 0 }),
	mkSystem("backup-nas", "paused", ["storage"], { h: "nas", k: "14.1-RELEASE", c: 4, t: 4, m: "Intel Celeron N5105", u: 9_000_000, os: 3 }),
];

const profiles: Record<string, SysProfile> = {
	[systems[0].id]: { cpuBase: 28, memTotal: 8 * GB, memBase: 0.55, disk: 160 * GB, diskUsed: 0.62, cores: 8, containers: ["caddy", "app", "worker", "redis"], temps: ["cpu_thermal", "nvme0"] },
	[systems[1].id]: { cpuBase: 55, memTotal: 64 * GB, memBase: 0.78, disk: 2000 * GB, diskUsed: 0.91, cores: 16, containers: ["postgres", "pgbouncer"], temps: ["coretemp_package", "coretemp_core0", "coretemp_core1", "nvme0"], efs: true },
	[systems[2].id]: { cpuBase: 72, memTotal: 128 * GB, memBase: 0.4, disk: 4000 * GB, diskUsed: 0.35, cores: 32, gpu: true, temps: ["k10temp_tctl", "amdgpu_edge", "nvme0", "nvme1"], fans: true, containers: ["ollama", "jupyter"] },
	[systems[3].id]: { cpuBase: 12, memTotal: 16 * GB, memBase: 0.6, disk: 512 * GB, diskUsed: 0.5, cores: 8, temps: [] },
	[systems[4].id]: { cpuBase: 18, memTotal: 128 * GB, memBase: 0.45, disk: 94 * GB, diskUsed: 0.2, cores: 32, temps: ["k10temp_tctl", "nvme0"] },
	[systems[5].id]: { cpuBase: 6, memTotal: 16 * GB, memBase: 0.3, disk: 16000 * GB, diskUsed: 0.7, cores: 4, temps: ["cpu"] },
};

function mkSystem(name: string, status: SystemRecord["status"], tags: string[], info: SystemRecord["info"]): SystemRecord {
	const ver = name === "mac-mini" ? "0.12.12" : "0.13.2";
	return {
		id: id15(),
		name,
		status,
		info: { ...info, v: ver },
		details: { hostname: info?.h, kernel: info?.k, cores: info?.c, threads: info?.t, cpuModel: info?.m, os: info?.os, osName: ["Ubuntu 24.04.1 LTS", "macOS 15.1", "Windows", "FreeBSD 14.1"][info?.os ?? 0], arch: info?.os === 1 ? "arm64" : "amd64" },
		agent_version: ver,
		last_seen: status === "up" ? now() - 20_000 : now() - 3 * HOUR,
		connected_at: status === "up" ? now() - 2 * DAY : null,
		fingerprint_bound: true,
		tags,
		created_at: now() - 40 * DAY,
		down_after: 60,
	};
}

function wave(t: number, period: number, phase = 0) {
	return Math.sin((t / period) * Math.PI * 2 + phase);
}

function genStats(sysId: string, t: number): SystemStats {
	const p = profiles[sysId];
	const noise = () => (rand() - 0.5) * 2;
	const cpu = clamp(p.cpuBase + wave(t, 3 * HOUR) * 15 + noise() * 6, 1, 100);
	const memUsed = p.memTotal * clamp(p.memBase + wave(t, 6 * HOUR, 1) * 0.06 + noise() * 0.01, 0.05, 0.98);
	const buff = p.memTotal * 0.15;
	const s: SystemStats = {
		cpu,
		cpum: clamp(cpu + 10 + rand() * 10, 0, 100),
		mp: (memUsed / p.memTotal) * 100,
		mt: p.memTotal,
		mu: memUsed,
		mb: buff,
		mz: p.efs ? p.memTotal * 0.08 : undefined,
		sw: 4 * GB,
		swu: 0.6 * GB + wave(t, 5 * HOUR) * 0.2 * GB,
		d: p.disk,
		du: p.disk * p.diskUsed + wave(t, 24 * HOUR) * GB,
		dp: p.diskUsed * 100,
		dr: Math.max(0, 4 * MB + wave(t, HOUR) * 3 * MB + noise() * MB),
		dw: Math.max(0, 2 * MB + wave(t, 2 * HOUR, 2) * 1.5 * MB + noise() * MB),
		ns: Math.max(0, 1.2 * MB + wave(t, 2 * HOUR) * MB + noise() * 0.3 * MB),
		nr: Math.max(0, 3 * MB + wave(t, 90 * MIN, 1) * 2 * MB + noise() * 0.5 * MB),
		la: [cpu / 25, cpu / 27, cpu / 30].map((x) => +(x * (p.cores / 8)).toFixed(2)) as [number, number, number],
		t: Object.fromEntries(p.temps.map((k, i) => [k, +(42 + i * 4 + cpu / 4 + noise() * 2).toFixed(1)])),
		cpub: [cpu * 0.62, cpu * 0.24, cpu * 0.08, cpu * 0.01, 100 - cpu, cpu * 0.02, cpu * 0.02, cpu * 0.01],
		cpus: Array.from({ length: p.cores }, (_, i) => clamp(cpu + wave(t, 40 * MIN, i) * 25 + noise() * 8, 0, 100)),
	};
	if (p.gpu) s.g = { "0": { n: "NVIDIA RTX 4090", u: clamp(60 + wave(t, HOUR) * 35, 0, 100), mu: 14_000 + wave(t, 2 * HOUR) * 6000, mt: 24_564, p: 280 + wave(t, HOUR) * 120 } };
	if (p.fans) s.f = { cpu_fan: 1100 + cpu * 8, case_fan1: 850 + wave(t, HOUR) * 80 };
	if (p.efs) s.efs = { "/mnt/backup": { d: 8000 * GB, du: 5200 * GB, r: 12 * MB + wave(t, HOUR) * 8 * MB, w: 4 * MB + noise() * MB } };
	return s;
}

const RANGE: Record<StatsRange, { span: number; step: number }> = {
	"1h": { span: HOUR, step: MIN },
	"12h": { span: 12 * HOUR, step: 10 * MIN },
	"24h": { span: DAY, step: 20 * MIN },
	"1w": { span: 7 * DAY, step: 120 * MIN },
	"30d": { span: 30 * DAY, step: 480 * MIN },
};

function statsFor(sysId: string, range: StatsRange): StatsPoint[] {
	const sys = systems.find((s) => s.id === sysId);
	if (!sys || sys.status === "pending") return [];
	const { span, step } = RANGE[range];
	const end = sys.status === "up" ? Math.floor(now() / step) * step : (sys.last_seen ?? now());
	const out: StatsPoint[] = [];
	for (let t = end - span; t <= end; t += step) out.push({ created_at: t, stats: genStats(sysId, t) });
	return out;
}

function containersFor(sysId: string, range: StatsRange): ContainerPoint[] {
	const p = profiles[sysId];
	if (!p?.containers) return [];
	return statsFor(sysId, range).map(({ created_at: t }) => ({
		created_at: t,
		stats: p.containers!.map(
			(n, i): ContainerStat => ({
				n,
				c: clamp(3 + i * 4 + wave(t, HOUR, i) * 3 + rand() * 2, 0, 100),
				m: 120 + i * 180 + wave(t, 3 * HOUR, i) * 30,
				ns: Math.max(0, 200_000 + i * 50_000 + wave(t, HOUR, i) * 100_000),
				nr: Math.max(0, 400_000 + i * 80_000 + wave(t, HOUR, i + 1) * 150_000),
				h: n === "worker" ? 3 : i % 2 === 0 ? 2 : 0,
				s: n === "worker" ? "Up 2 hours (unhealthy)" : `Up ${3 + i} days`,
				id: id15().slice(0, 12),
				i: { caddy: "caddy:2.8", app: "ghcr.io/acme/app:1.42.0", worker: "ghcr.io/acme/app:1.42.0", redis: "redis:7-alpine", postgres: "postgres:16", pgbouncer: "edoburu/pgbouncer:1.23", ollama: "ollama/ollama:0.4.1", jupyter: "jupyter/scipy-notebook" }[n],
			}),
		),
	}));
}

function refreshSystemInfo() {
	for (const s of systems) {
		if (s.status !== "up") continue;
		const st = genStats(s.id, now());
		s.info = { ...s.info, pu: s.id === systems[0].id ? [8, 2] : [0, 0], sv: s.id === systems[0].id ? [6, 1] : [4, 0], cpu: st.cpu, mp: st.mp, dp: st.dp, la: st.la, bb: st.ns + st.nr, dt: st.t ? Math.max(...Object.values(st.t)) : undefined, g: st.g ? Object.values(st.g)[0].u : undefined, efs: st.efs ? { "/mnt/backup": 65 } : undefined };
		s.last_seen = now() - Math.floor(rand() * 30_000);
	}
}

const alerts: Record<string, { alerts: SystemAlert[]; notification_ids: string[] }> = {};

function install(sys: SystemRecord): SystemInstall {
	const token = `tok_${sys.id}${id15()}`;
	const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMock";
	return buildInstall(location.origin, token, key);
}

// ---- Notifications -------------------------------------------------------------

const notifications: NotificationChannel[] = [
	{ id: id15(), name: "Ops Discord", type: "discord", config: { webhook_url: "https://discord.com/api/webhooks/123/abc" }, enabled: true, apply_default: true, created_at: T0 - 30 * DAY },
	{ id: id15(), name: "Phone (ntfy)", type: "ntfy", config: { server: "https://ntfy.sh", topic: "richter-demo", priority: "4" }, enabled: false, apply_default: false, created_at: T0 - 20 * DAY },
];

// ---- Monitors ------------------------------------------------------------------

const baseMonitor = (over: Partial<Monitor> & Pick<Monitor, "name" | "type" | "config">): Monitor => ({
	id: id15(),
	parent_id: null,
	interval_s: 60,
	retries: 1,
	retry_interval_s: 60,
	timeout_ms: 10_000,
	max_latency_ms: null,
	upside_down: false,
	resend_every: 0,
	paused: false,
	description: null,
	tags: [],
	status: "up",
	last_check_at: now() - 25_000,
	next_check_at: now() + 35_000,
	last_latency_ms: 120,
	last_message: "200 OK",
	push_token: null,
	ping_url: null,
	last_ping_at: null,
	domain_expires_at: null,
	notification_ids: [notifications[0].id],
	created_at: T0 - 25 * DAY,
	...over,
});

const grpWeb = baseMonitor({ name: "Websites", type: "group", config: {}, last_latency_ms: null, last_message: null });
const grpInfra = baseMonitor({ name: "Infrastructure", type: "group", config: {}, status: "degraded", last_latency_ms: null, last_message: null });
const monitors: Monitor[] = [
	grpWeb,
	baseMonitor({ name: "Marketing site", type: "http", config: { url: "https://example.com", method: "GET", accepted_codes: ["200-299"] }, parent_id: grpWeb.id, tags: ["prod"], description: "Public homepage" }),
	baseMonitor({ name: "Cloudflare", type: "http", config: { url: "https://cloudflare.com", keyword: "Cloudflare" }, parent_id: grpWeb.id, last_latency_ms: 48, tags: ["external"] }),
	baseMonitor({ name: "API health", type: "http", config: { url: "https://api.example.com/health", json_path: "status", json_expected: "ok" }, parent_id: grpWeb.id, status: "down", last_message: "HTTP 503 Service Unavailable", last_latency_ms: 812, tags: ["prod", "api"] }),
	grpInfra,
	baseMonitor({ name: "DNS 1.1.1.1", type: "tcp", config: { host: "1.1.1.1", port: 53 }, parent_id: grpInfra.id, last_latency_ms: 9 }),
	baseMonitor({ name: "example.com A", type: "dns", config: { name: "example.com", record_type: "A", expected: ["93.184.215.14"] }, parent_id: grpInfra.id, last_latency_ms: 22, status: "degraded", max_latency_ms: 20, last_message: "slow response" }),
	baseMonitor({ name: "web-01 server", type: "system", config: { system_id: systems[0].id }, parent_id: grpInfra.id, last_latency_ms: null, last_message: "agent connected" }),
	baseMonitor({ name: "app container", type: "container", config: { system_id: systems[0].id, container_name: "app" }, last_latency_ms: null }),
	baseMonitor({ name: "smtp-probe (LXC 212)", type: "guest", config: { system_id: systems[4].id, vmid: 212, guest_type: "lxc" }, tags: ["proxmox", "lxc", "pve02"], last_latency_ms: null, last_message: "running · up 12 d 4 h · mem 38% · disk 14%" }),
	baseMonitor({ name: "web (VM 101)", type: "guest", config: { system_id: systems[4].id, vmid: 101, guest_type: "qemu" }, tags: ["proxmox", "vm", "pve02"], last_latency_ms: null, status: "down", last_message: "Stopped (set to start on boot)" }),
	baseMonitor({
		name: "Nightly backup",
		type: "heartbeat",
		config: { period_s: 86400, grace_s: 3600 },
		push_token: "hb_8a7sd6f87as6df87as6df87a6sdf8a7s",
		ping_url: `${location.origin}/ping/hb_8a7sd6f87as6df87as6df87a6sdf8a7s`,
		last_ping_at: now() - 7 * HOUR,
		last_latency_ms: null,
		last_message: "ping received",
		interval_s: 86400,
		tags: ["cron"],
	}),
	baseMonitor({ name: "example.com domain", type: "domain", config: { domain: "example.com", warn_days: 30 }, interval_s: 86400, domain_expires_at: now() + 212 * DAY, last_latency_ms: 340, last_message: "expires in 212 days" }),
	baseMonitor({ name: "Staging", type: "http", config: { url: "https://staging.example.com" }, paused: true, status: "paused", tags: ["staging"] }),
];

const checksCache: Record<string, CheckPoint[]> = {};
function checksFor(m: Monitor): CheckPoint[] {
	if (checksCache[m.id]) return checksCache[m.id];
	const out: CheckPoint[] = [];
	const step = Math.max(60, Math.min(m.interval_s, 3600)) * 1000;
	const start = now() - 7 * DAY;
	const base = m.last_latency_ms ?? 0;
	for (let t = start; t <= now(); t += step) {
		const r = rand();
		let status: CheckPoint["status"] = 1;
		if (m.status === "down" && t > now() - 20 * MIN) status = 0;
		else if (r < 0.004) status = 0;
		else if (r < 0.012) status = 2;
		else if (t > now() - 3 * DAY - 2 * HOUR && t < now() - 3 * DAY) status = 3;
		const lat = base ? Math.round(base * (0.7 + rand() * 0.6) + wave(t, 6 * HOUR) * base * 0.2) : null;
		out.push({ ts: t, status, latency_ms: m.type === "group" ? null : lat, message: status === 0 ? "timeout after 10000 ms" : status === 2 ? "slow response" : status === 3 ? "in maintenance" : "200 OK" });
	}
	checksCache[m.id] = out;
	return out;
}

function uptimeOf(checks: CheckPoint[], since: number): number | null {
	const c = checks.filter((x) => x.ts >= since && x.status !== 3);
	if (!c.length) return null;
	return (c.filter((x) => x.status !== 0).length / c.length) * 100;
}

function listItem(m: Monitor): MonitorListItem {
	const c = m.type === "group" ? [] : checksFor(m);
	return { ...m, uptime_24h: m.type === "group" ? null : uptimeOf(c, now() - DAY), recent: m.paused ? [] : c.slice(-30) };
}

const incidents: Incident[] = [
	{ id: id15(), monitor_id: monitors[3].id, monitor_name: monitors[3].name, started_at: now() - 18 * MIN, resolved_at: null, cause: "HTTP 503 Service Unavailable" },
	{ id: id15(), monitor_id: monitors[1].id, monitor_name: monitors[1].name, started_at: now() - 2 * DAY - 3 * HOUR, resolved_at: now() - 2 * DAY - 2 * HOUR - 40 * MIN, cause: "timeout after 10000 ms" },
	{ id: id15(), monitor_id: monitors[5].id, monitor_name: monitors[5].name, started_at: now() - 6 * DAY, resolved_at: now() - 6 * DAY + 4 * MIN, cause: "connection refused" },
];

// ---- Status pages, maintenance, announcements ----------------------------------

const pages: StatusPage[] = [
	{
		id: id15(),
		slug: "main",
		title: "Acme Status",
		description: "Live status of Acme services and infrastructure.",
		logo_url: null,
		custom_domain: "status.acme.dev",
		footer_text: "Questions? Email ops@acme.dev",
		layout: [
			{ name: "Websites", items: [{ kind: "monitor", id: monitors[1].id }, { kind: "monitor", id: monitors[2].id, link: false }, { kind: "monitor", id: monitors[3].id }] },
			{ name: "Infrastructure", items: [{ kind: "monitor", id: monitors[5].id }, { kind: "monitor", id: monitors[6].id }, { kind: "system", id: systems[0].id }, { kind: "system", id: systems[1].id }] },
		],
		show_uptime_bars: true,
		show_latency: true,
		show_tags: false,
		show_system_uptime: true,
		show_system_cpu: true,
		published: true,
		is_default: true,
		accent_color: "#7c3aed",
		custom_css: null,
		created_at: T0 - 20 * DAY,
		url: "",
	},
	{
		id: id15(),
		slug: "internal",
		title: "Internal tools",
		description: null,
		logo_url: null,
		custom_domain: null,
		footer_text: null,
		layout: [{ name: "Jobs", items: [{ kind: "monitor", id: monitors[9].id }] }],
		show_uptime_bars: true,
		show_latency: false,
		show_tags: true,
		show_system_uptime: false,
		published: false,
		is_default: false,
		accent_color: null,
		custom_css: null,
		created_at: T0 - 5 * DAY,
		url: "",
	},
];
const pageUrl = (p: StatusPage) => `${location.origin}/s/${p.slug}`;

const maintenances: Maintenance[] = [
	{ id: id15(), title: "Database upgrade", description: "PostgreSQL 16 → 17. Short write pauses expected.", starts_at: now() + 2 * DAY, ends_at: now() + 2 * DAY + 2 * HOUR, repeat: null, monitor_ids: [monitors[3].id], system_ids: [systems[1].id], active: false, next_start: now() + 2 * DAY, created_at: T0 - DAY },
	{ id: id15(), title: "Weekly patch window", description: null, starts_at: now() - 30 * MIN, ends_at: now() + 30 * MIN, repeat: { every: "week", until: null }, monitor_ids: [monitors[5].id], system_ids: [], active: true, next_start: now() + 7 * DAY - 30 * MIN, created_at: T0 - 10 * DAY },
];

const announcements: Announcement[] = [
	{ id: id15(), status_page_id: null, title: "Investigating API errors", body: "We are seeing elevated **503 errors** on the public API.\n\n- Dashboard is unaffected\n- Updates every 30 minutes on [our blog](https://example.com)", severity: "warning", pinned: true, starts_at: now() - 20 * MIN, ends_at: null, created_at: now() - 20 * MIN, updated_at: now() - 10 * MIN },
];

const events: EventRecord[] = [
	{ id: 6, ts: now() - 18 * MIN, kind: "monitor.down", ref_id: monitors[3].id, message: "API health is DOWN: HTTP 503 Service Unavailable" },
	{ id: 5, ts: now() - 3 * HOUR, kind: "system.down", ref_id: systems[3].id, message: "mac-mini disconnected" },
	{ id: 4, ts: now() - 2 * DAY, kind: "monitor.up", ref_id: monitors[1].id, message: "Marketing site is UP (down for 20m)" },
	{ id: 3, ts: now() - 2 * DAY - HOUR, kind: "alert.triggered", ref_id: systems[1].id, message: "db-primary Disk above 90% (91.2%)" },
	{ id: 2, ts: now() - 2 * DAY - 3 * HOUR, kind: "monitor.down", ref_id: monitors[1].id, message: "Marketing site is DOWN: timeout" },
	{ id: 1, ts: now() - 5 * DAY, kind: "system.connect", ref_id: systems[2].id, message: "gpu-box agent connected (0.13.2)" },
];

const settings: Settings = {
	site_title: "Richter",
	timezone: "Europe/Berlin",
	hub_public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockMockMockMockMockMockMockMockMockMockMock",
	public_url: `${location.origin}`,
	dashboard_url: `${location.origin}`,
};

// ---- Public page model ---------------------------------------------------------

function bars(seedUp: number): DayBar[] {
	const out: DayBar[] = [];
	const today = new Date();
	for (let i = 89; i >= 0; i--) {
		const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
		const r = rand();
		const has = i < 75 || seedUp > 99.95;
		const uptime = !has ? null : r < 0.03 ? 93 + rand() * 4 : r < 0.08 ? 99 + rand() * 0.8 : r < 0.12 ? 96 + rand() * 3 : 100;
		out.push({ day: d.toISOString().slice(0, 10), uptime, incidents: uptime != null && uptime < 99.9 ? 1 : 0 });
	}
	return out;
}

function publicPage(p: StatusPage): PublicPage {
	const groups = p.layout.map((g) => ({
		name: g.name,
		items: g.items
			.map((ref): PublicItem | null => {
				if (ref.kind === "system") {
					const s = systems.find((x) => x.id === ref.id);
					if (!s) return null;
					const b = bars(99);
					const on = p.show_system_uptime;
					const base = profiles[s.id]?.cpuBase ?? 20;
					const cpu =
						p.show_system_cpu !== false && s.status === "up"
							? Array.from({ length: 96 }, (_, i) => ({ ts: now() - (96 - i) * 900_000, pct: Math.round(clamp(base + 12 * Math.sin(i / 9) + (rand() - 0.5) * 10, 1, 99) * 10) / 10 }))
							: undefined;
					return {
						kind: "system",
						id: s.id,
						name: s.name,
						status: s.status,
						url: null,
						type: "system",
						uptime_90d: on ? 99.97 : null,
						bars: on && p.show_uptime_bars ? b : [],
						cpu,
						cpu_now: cpu ? cpu[cpu.length - 1].pct : undefined,
						tags: s.tags,
					};
				}
				const m = monitors.find((x) => x.id === ref.id);
				if (!m) return null;
				const c = checksFor(m);
				const b = bars(99.9);
				return {
					kind: "monitor",
					id: m.id,
					name: m.name,
					status: m.status,
					url: m.type === "http" && ref.link !== false ? (m.config as { url: string }).url : null,
					type: m.type,
					uptime_90d: uptimeOf(c, 0),
					bars: b,
					latency: p.show_latency ? c.filter((x) => x.ts > now() - DAY && x.latency_ms != null).filter((_, i) => i % 15 === 0).map((x) => ({ ts: x.ts, ms: x.latency_ms! })) : undefined,
					tags: m.tags,
				};
			})
			.filter((x): x is PublicItem => x != null),
	}));
	const items = groups.flatMap((g) => g.items);
	const down = items.filter((i) => i.status === "down").length;
	const overall: PublicPage["overall"] = maintenances.some((m) => m.active) && !down
		? "maintenance"
		: down > items.length / 2
			? "major"
			: down > 0
				? "partial"
				: items.some((i) => i.status === "degraded")
					? "degraded"
					: "operational";
	const ids = new Set(items.map((i) => i.id));
	return {
		page: p,
		overall,
		groups,
		announcements: announcements.filter((a) => a.status_page_id == null || a.status_page_id === p.id),
		maintenances: maintenances.filter((m) => m.monitor_ids.some((x) => ids.has(x)) || m.system_ids.some((x) => ids.has(x))),
		incidents: incidents.filter((i) => ids.has(i.monitor_id) && i.started_at > now() - 14 * DAY).map((i) => ({ id: i.id, name: i.monitor_name ?? "", started_at: i.started_at, resolved_at: i.resolved_at, cause: i.cause })),
		generated_at: now(),
	};
}

// ---- Router --------------------------------------------------------------------

type Handler = (m: RegExpMatchArray, body: any, q: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) =>
	routes.push([method, new RegExp(`^${pattern.replace(/:(\w+)/g, "([^/]+)")}$`), h]);

const find = <T extends { id: string }>(xs: T[], id: string): T => {
	const x = xs.find((i) => i.id === id);
	if (!x) throw new ApiError("Not found", 404);
	return x;
};
const remove = <T extends { id: string }>(xs: T[], id: string) => {
	const i = xs.findIndex((x) => x.id === id);
	if (i < 0) throw new ApiError("Not found", 404);
	xs.splice(i, 1);
	return { ok: true };
};

on("GET", "/api/whoami-host", (): HostInfo => {
	const pub = location.pathname.startsWith("/s/") || new URLSearchParams(location.search).get("mode") === "public";
	return { mode: pub ? "public" : "dashboard", pageSlug: null, publicUrl: location.origin, dashboardUrl: location.origin };
});
on("GET", "/api/public/page", () => publicPage(pages.find((p) => p.is_default) ?? pages[0]));
on("GET", "/api/public/pages/:slug", (m) => {
	const p = pages.find((x) => x.slug === m[1]);
	if (!p) throw new ApiError("Status page not found", 404);
	return publicPage(p);
});

const A = "/api/admin";
// ?role=read previews the dashboard as a read-only user.
const mockRole: Role = new URLSearchParams(location.search).get("role") === "read" ? "read" : "full";
const OWNER = "owner@example.com";
const meEmail = mockRole === "read" ? "alex@example.com" : OWNER;
const users: DashboardUser[] = [
	{ email: OWNER, role: "full", owner: true, added_by: null, created_at: 0 },
	{ email: "sam@example.com", role: "full", owner: false, added_by: OWNER, created_at: now() - 12 * 86_400_000 },
	{ email: "alex@example.com", role: "read", owner: false, added_by: OWNER, created_at: now() - 3 * 86_400_000 },
];
const guard = () => {
	if (mockRole === "read") throw new ApiError("Read-only access: ask the owner for Full access to do this.", 403);
};
on("GET", `${A}/me`, (): Me => ({ email: meEmail, role: mockRole, owner: meEmail === OWNER }));
on("GET", `${A}/access`, (): AccessSettings => ({ users, configured: true, ...(mockRole === "full" ? { policy: { emails: users.map((u) => u.email) } } : {}) }));
on("POST", `${A}/access`, (_, b) => {
	guard();
	const email = String(b.email).trim().toLowerCase();
	if (users.some((u) => u.email === email)) throw new ApiError(`${email} is already on the list`, 409, "email");
	users.push({ email, role: b.role, owner: false, added_by: meEmail, created_at: now() });
	return { users };
});
on("PATCH", `${A}/access/:id`, (m, b) => {
	guard();
	const u = users.find((x) => x.email === decodeURIComponent(m[1]) && !x.owner);
	if (!u) throw new ApiError("User not found", 404);
	u.role = b.role;
	return { users };
});
on("DELETE", `${A}/access/:id`, (m) => {
	guard();
	const i = users.findIndex((x) => x.email === decodeURIComponent(m[1]) && !x.owner);
	if (i < 0) throw new ApiError("User not found", 404);
	users.splice(i, 1);
	return { users };
});
on("POST", `${A}/access/sync`, () => ({ ok: true }));
on("GET", `${A}/overview`, (): Overview => {
	refreshSystemInfo();
	const ms = monitors.filter((m) => m.type !== "group");
	return {
		systems: { total: systems.length, up: systems.filter((s) => s.status === "up").length, down: systems.filter((s) => s.status === "down").length, pending: systems.filter((s) => s.status === "pending").length, paused: systems.filter((s) => s.status === "paused").length },
		monitors: { total: ms.length, up: ms.filter((m) => m.status === "up").length, down: ms.filter((m) => m.status === "down").length, degraded: ms.filter((m) => m.status === "degraded").length, other: ms.filter((m) => !["up", "down", "degraded"].includes(m.status)).length },
		open_incidents: incidents.filter((i) => !i.resolved_at).length,
		events,
	};
});
on("GET", `${A}/settings`, () => settings);
on("PUT", `${A}/settings`, (_, b) => Object.assign(settings, b));

on("GET", `${A}/systems`, () => {
	refreshSystemInfo();
	return systems;
});
on("POST", `${A}/systems`, (_, b) => {
	if (!b?.name) throw new ApiError("name is required", 400, "name");
	const s: SystemRecord = { id: id15(), name: b.name, status: "pending", info: null, details: null, agent_version: null, last_seen: null, connected_at: null, fingerprint_bound: false, tags: b.tags ?? [], created_at: now(), down_after: 60 };
	systems.push(s);
	profiles[s.id] = { cpuBase: 20, memTotal: 4 * GB, memBase: 0.4, disk: 80 * GB, diskUsed: 0.3, cores: 2, temps: ["cpu"] };
	// Simulate the agent connecting after ~8 seconds.
	setTimeout(() => {
		s.status = "up";
		s.agent_version = "0.13.2";
		s.connected_at = now();
		s.fingerprint_bound = true;
		s.info = { h: b.name, k: "6.8.0", c: 2, t: 2, m: "Virtual CPU", u: 120, os: 0, v: "0.13.2" };
		s.details = { hostname: b.name, kernel: "6.8.0", cores: 2, threads: 2, cpuModel: "Virtual CPU", os: 0, osName: "Debian 12", arch: "amd64" };
	}, 8000);
	return { system: s, install: install(s) };
});
on("GET", `${A}/systems/:id`, (m) => {
	refreshSystemInfo();
	return find(systems, m[1]);
});
on("PATCH", `${A}/systems/:id`, (m, b) => Object.assign(find(systems, m[1]), b));
on("DELETE", `${A}/systems/:id`, (m) => remove(systems, m[1]));
on("GET", `${A}/systems/:id/install`, (m) => install(find(systems, m[1])));
on("POST", `${A}/systems/:id/pause`, (m) => Object.assign(find(systems, m[1]), { status: "paused" }));
on("POST", `${A}/systems/:id/resume`, (m) => Object.assign(find(systems, m[1]), { status: "up" }));
on("POST", `${A}/systems/:id/reset-fingerprint`, (m) => Object.assign(find(systems, m[1]), { fingerprint_bound: false }));
on("POST", `${A}/systems/:id/rotate-token`, (m) => install(find(systems, m[1])));
on("GET", `${A}/systems/:id/stats`, (m, _, q) => statsFor(find(systems, m[1]).id, (q.get("range") ?? "1h") as StatsRange));
on("GET", `${A}/systems/:id/containers`, (m, _, q) => containersFor(find(systems, m[1]).id, (q.get("range") ?? "1h") as StatsRange));
const alertsOf = (id: string) => (alerts[id] ??= { alerts: [{ metric: "Status", threshold: null, minutes: 1 }], notification_ids: [notifications[0].id] });
on("GET", `${A}/systems/:id/alerts`, (m) => alertsOf(m[1]));
on("PUT", `${A}/systems/:id/alerts`, (m, b) => (alerts[m[1]] = b));
on("POST", `${A}/alerts/bulk`, (_, b) => {
	const { metric, threshold, minutes, overwrite, system_ids } = b as SystemAlert & { overwrite?: boolean; system_ids?: string[] };
	const ids = systems.map((s) => s.id).filter((id) => (system_ids ? system_ids.includes(id) : overwrite || !alertsOf(id).alerts.some((a) => a.metric === metric)));
	for (const id of ids) {
		const list = alertsOf(id).alerts.filter((a) => a.metric !== metric);
		alerts[id].alerts = [...list, { metric, threshold, minutes }];
	}
	return { system_ids: ids };
});
on("DELETE", `${A}/alerts/bulk`, (_, b) => {
	const { metric, system_ids } = b as { metric: string; system_ids?: string[] };
	for (const s of systems) if (!system_ids || system_ids.includes(s.id)) alertsOf(s.id).alerts = alertsOf(s.id).alerts.filter((a) => a.metric !== metric);
	return { ok: true };
});
on("GET", `${A}/systems/:id/packages`, (m): PackageSnapshot => {
	const first = find(systems, m[1]).id === systems[0].id;
	return {
		manager: "apt",
		checked_at: now() - 25 * MIN,
		security_known: true,
		updated_at: now() - 3 * HOUR,
		packages: first
			? [
					{ n: "libssl3t64", c: "3.0.13-0ubuntu3.5", a: "3.0.13-0ubuntu3.6", s: true },
					{ n: "openssl", c: "3.0.13-0ubuntu3.5", a: "3.0.13-0ubuntu3.6", s: true },
					{ n: "curl", c: "8.5.0-2ubuntu10.6", a: "8.5.0-2ubuntu10.7" },
					{ n: "docker-ce", c: "5:28.1.1-1~ubuntu.24.04~noble", a: "5:28.2.0-1~ubuntu.24.04~noble" },
					{ n: "tzdata", c: "2025b-0ubuntu0.24.04", a: "2025b-0ubuntu0.24.04.1" },
					{ n: "nodejs", c: "20.19.2-1nodesource1", a: "22.16.0-1nodesource1" },
					{ n: "tailscale", c: "1.102.2", a: "1.104.4" },
					{ n: "sosreport", c: "4.10.2-0ubuntu0~24.04.1", a: "4.10.3-0ubuntu0~24.04.1" },
				]
			: [],
	};
});
on("GET", `${A}/systems/:id/pve`, (m): PveSnapshot | null => {
	if (find(systems, m[1]).id !== systems[4].id) return null;
	const G = 1024 ** 3;
	return {
		at: now() - 25_000,
		node: "pve02",
		pve_version: "8.4.1",
		guests: [
			{ vmid: 101, type: "qemu", name: "web", node: "pve02", status: "stopped", onboot: true, template: false, maxmem: 4 * G, maxdisk: 32 * G },
			{ vmid: 102, type: "qemu", name: "win11-lab", node: "pve02", status: "stopped", onboot: false, template: false, maxmem: 8 * G, maxdisk: 64 * G },
			{ vmid: 105, type: "qemu", name: "homeassistant", node: "pve02", status: "running", onboot: true, template: false, cpu: 0.04, maxcpu: 2, mem: 2.6 * G, maxmem: 4 * G, disk: 9 * G, maxdisk: 32 * G, uptime: 1_050_000 },
			{ vmid: 212, type: "lxc", name: "smtp-probe", node: "pve02", status: "running", onboot: true, template: false, cpu: 0.002, maxcpu: 1, mem: 0.19 * G, maxmem: 0.5 * G, disk: 1.1 * G, maxdisk: 8 * G, uptime: 1_051_200 },
			{ vmid: 213, type: "lxc", name: "unifi", node: "pve02", status: "running", onboot: true, template: false, lock: "backup", cpu: 0.11, maxcpu: 2, mem: 1.9 * G, maxmem: 2 * G, disk: 7.4 * G, maxdisk: 16 * G, uptime: 86_000 },
			{ vmid: 9000, type: "qemu", name: "debian-12-tpl", node: "pve02", status: "stopped", onboot: false, template: true },
		],
		storages: [
			{ storage: "local", node: "pve02", type: "dir", status: "available", disk: 18 * G, maxdisk: 94 * G },
			{ storage: "local-zfs", node: "pve02", type: "zfspool", status: "available", disk: 410 * G, maxdisk: 860 * G },
		],
	};
});
on("GET", `${A}/systems/:id/services`, (m): ServicesSnapshot => {
	const first = find(systems, m[1]).id === systems[0].id;
	const list: SystemdService[] = [
		{ n: "caddy.service", s: 0, ss: 1 },
		{ n: "docker.service", s: 0, ss: 1 },
		{ n: "ssh.service", s: 0, ss: 1 },
		{ n: "systemd-journald.service", s: 0, ss: 1 },
	];
	if (first) list.push({ n: "backup.service", s: 2, ss: 3 }, { n: "apt-daily.service", s: 1, ss: 0 });
	return { services: list, updated_at: now() - 40 * MIN };
});

on("GET", `${A}/monitors`, () => monitors.map(listItem));
on("POST", `${A}/monitors/test`, (_, b: MonitorInput): CheckNowResult => {
	const ok = !String(JSON.stringify(b.config)).includes("fail");
	return { ok, status: ok ? "up" : "down", latency_ms: Math.round(40 + rand() * 200), message: ok ? "200 OK" : "connection refused" };
});
on("POST", `${A}/monitors`, (_, b: MonitorInput) => {
	if (!b?.name) throw new ApiError("name is required", 400, "name");
	const m = baseMonitor({ ...b, status: "pending", last_check_at: null, last_latency_ms: null, last_message: null, created_at: now(), notification_ids: b.notification_ids ?? [] } as Monitor);
	if (m.type === "heartbeat") {
		m.push_token = `hb_${id15()}${id15()}`;
		m.ping_url = `${location.origin}/ping/${m.push_token}`;
	}
	monitors.push(m);
	checksCache[m.id] = [];
	return m;
});
on("GET", `${A}/monitors/:id`, (m) => find(monitors, m[1]));
on("PATCH", `${A}/monitors/:id`, (m, b) => Object.assign(find(monitors, m[1]), b));
on("DELETE", `${A}/monitors/:id`, (m) => remove(monitors, m[1]));
on("POST", `${A}/monitors/:id/pause`, (m) => Object.assign(find(monitors, m[1]), { paused: true, status: "paused" }));
on("POST", `${A}/monitors/:id/resume`, (m) => Object.assign(find(monitors, m[1]), { paused: false, status: "pending" }));
on("POST", `${A}/monitors/:id/clone`, (m) => {
	const src = find(monitors, m[1]);
	const c = { ...structuredClone(src), id: id15(), name: `${src.name} (copy)`, status: "pending" as const, created_at: now() };
	monitors.push(c);
	checksCache[c.id] = [];
	return c;
});
on("POST", `${A}/monitors/:id/check-now`, (m): CheckNowResult => {
	const mon = find(monitors, m[1]);
	return { ok: mon.status !== "down", status: mon.status === "down" ? "down" : "up", latency_ms: Math.round(40 + rand() * 200), message: mon.status === "down" ? "HTTP 503" : "200 OK" };
});
on("GET", `${A}/monitors/:id/checks`, (m, _, q) => {
	const hours = Number(q.get("hours") ?? 24);
	return checksFor(find(monitors, m[1])).filter((c) => c.ts >= now() - hours * HOUR);
});
on("GET", `${A}/monitors/:id/uptime`, (m): UptimeSummary => {
	const mon = find(monitors, m[1]);
	const c = checksFor(mon);
	const day = c.filter((x) => x.ts > now() - DAY && x.latency_ms != null);
	return {
		h24: uptimeOf(c, now() - DAY),
		d7: uptimeOf(c, now() - 7 * DAY),
		d30: uptimeOf(c, 0),
		d90: uptimeOf(c, 0),
		d365: uptimeOf(c, 0),
		avg_latency_24h: day.length ? day.reduce((a, x) => a + x.latency_ms!, 0) / day.length : null,
		domain_days: mon.domain_expires_at ? Math.floor((mon.domain_expires_at - now()) / DAY) : null,
	};
});
on("GET", `${A}/monitors/:id/incidents`, (m) => incidents.filter((i) => i.monitor_id === m[1]));
on("GET", `${A}/incidents`, (_, __, q) => (q.get("open") ? incidents.filter((i) => !i.resolved_at) : incidents));

on("GET", `${A}/notifications`, () => notifications);
on("POST", `${A}/notifications`, (_, b) => {
	const n: NotificationChannel = { id: id15(), enabled: true, apply_default: false, created_at: now(), ...b };
	notifications.push(n);
	return n;
});
on("PATCH", `${A}/notifications/:id`, (m, b) => Object.assign(find(notifications, m[1]), b));
on("DELETE", `${A}/notifications/:id`, (m) => remove(notifications, m[1]));
on("POST", `${A}/notifications/:id/test`, (m) => {
	const n = find(notifications, m[1]);
	const r = n.type === "webhook" ? { ok: false, error: "webhook returned HTTP 404" } : { ok: true };
	const log = notifLog();
	log.unshift({ ...logEntry(now(), n, { kind: "test", id: null, name: "Richter" }, "🔔 Richter test notification", `If you can read this, the "${n.name}" channel works.`, "info"), id: (log[0]?.id ?? 0) + 1, ok: r.ok, error: r.error ?? null });
	return r;
});
let notifLogCache: NotificationLogEntry[] | undefined;
let logSeq = 1000;
function logEntry(ts: number, ch: NotificationChannel, t: { kind: NotificationLogEntry["target_kind"]; id: string | null; name: string }, title: string, body: string, status: NotificationLogEntry["status"]): NotificationLogEntry {
	return { id: logSeq--, ts, channel_id: ch.id, channel_name: ch.name, channel_type: ch.type, title, body, status, target_kind: t.kind, target_id: t.id, target_name: t.name, ok: true, error: null };
}
function notifLog(): NotificationLogEntry[] {
	if (notifLogCache) return notifLogCache;
	const [discord, ntfy] = notifications;
	const mon = monitors.find((x) => x.name === "API health") ?? monitors[0];
	const sys = systems[0];
	const M = 60_000;
	const out: NotificationLogEntry[] = [
		logEntry(now() - 18 * M, discord, { kind: "monitor", id: mon.id, name: mon.name }, `🔴 ${mon.name} is DOWN`, "HTTP 503 Service Unavailable", "down"),
		{ ...logEntry(now() - 18 * M, { ...ntfy, name: "Pushover (phone)", type: "pushover" }, { kind: "monitor", id: mon.id, name: mon.name }, `🔴 ${mon.name} is DOWN`, "HTTP 503 Service Unavailable", "down"), ok: false, error: 'HTTP 400: {"user":"invalid","errors":["user identifier is not a valid user, group, or subscribed user key"],"status":0}' },
		logEntry(now() - 95 * M, discord, { kind: "system", id: sys.id, name: sys.name }, `⚠️ ${sys.name}: CPU high`, "CPU averaged 92% over the last 5 min (threshold 90%)", "warning"),
		logEntry(now() - 80 * M, discord, { kind: "system", id: sys.id, name: sys.name }, `✅ ${sys.name}: CPU resolved`, "CPU averaged 41% over the last 5 min", "up"),
		logEntry(now() - 5 * 60 * M, discord, { kind: "system", id: sys.id, name: sys.name }, `📦 ${sys.name}: 3 security updates`, "openssl 3.0.13-0ubuntu3.4, libssl3t64, openssh-server", "warning"),
		logEntry(now() - 26 * 60 * M, discord, { kind: "test", id: null, name: "Richter" }, "🔔 Richter test notification", 'If you can read this, the "Ops Discord" channel works.', "info"),
	];
	for (let i = 0; i < 60; i++) out.push(logEntry(now() - (2 + i) * 24 * 60 * M, discord, { kind: "monitor", id: mon.id, name: mon.name }, i % 2 ? `🟢 ${mon.name} is UP` : `🔴 ${mon.name} is DOWN`, i % 2 ? "Recovered after 4m. 200 OK" : "timeout after 10000 ms", i % 2 ? "up" : "down"));
	out.sort((a, b) => b.ts - a.ts).forEach((e, i) => (e.id = 1000 - i));
	return (notifLogCache = out);
}
on("GET", `${A}/notification-log`, (_, __, q) => {
	const before = Number(q.get("before")) || Infinity;
	const limit = Number(q.get("limit")) || 50;
	const rows = notifLog().filter((e) => e.id < before);
	return { entries: rows.slice(0, limit), more: rows.length > limit };
});

on("GET", `${A}/status-pages`, () => pages.map((p) => ({ ...p, url: pageUrl(p) })));
on("POST", `${A}/status-pages`, (_, b) => {
	if (pages.some((p) => p.slug === b.slug)) throw new ApiError("slug already in use", 409, "slug");
	const p: StatusPage = { id: id15(), description: null, logo_url: null, custom_domain: null, footer_text: null, layout: [], show_uptime_bars: true, show_latency: true, show_tags: false, show_system_uptime: false, show_system_cpu: true, show_mobile_sparklines: true, published: true, is_default: false, accent_color: null, custom_css: null, created_at: now(), url: "", ...b };
	pages.push(p);
	return { ...p, url: pageUrl(p) };
});
on("GET", `${A}/status-pages/:id`, (m) => {
	const p = find(pages, m[1]);
	return { ...p, url: pageUrl(p) };
});
on("PATCH", `${A}/status-pages/:id`, (m, b) => {
	const p = Object.assign(find(pages, m[1]), b);
	if (b.is_default) for (const o of pages) if (o !== p) o.is_default = false;
	return { ...p, url: pageUrl(p) };
});
on("DELETE", `${A}/status-pages/:id`, (m) => remove(pages, m[1]));

const withComputed = (m: Maintenance): Maintenance => ({ ...m, active: m.starts_at <= now() && m.ends_at > now(), next_start: m.starts_at > now() ? m.starts_at : null });
on("GET", `${A}/maintenances`, () => maintenances);
on("POST", `${A}/maintenances`, (_, b) => {
	const m = withComputed({ id: id15(), created_at: now(), active: false, next_start: null, ...b });
	maintenances.push(m);
	return m;
});
on("PATCH", `${A}/maintenances/:id`, (m, b) => {
	const x = find(maintenances, m[1]);
	Object.assign(x, withComputed({ ...x, ...b }));
	return x;
});
on("DELETE", `${A}/maintenances/:id`, (m) => remove(maintenances, m[1]));

on("GET", `${A}/announcements`, () => announcements);
on("POST", `${A}/announcements`, (_, b) => {
	const a: Announcement = { id: id15(), created_at: now(), updated_at: now(), ...b };
	announcements.push(a);
	return a;
});
on("PATCH", `${A}/announcements/:id`, (m, b) => Object.assign(find(announcements, m[1]), b, { updated_at: now() }));
on("DELETE", `${A}/announcements/:id`, (m) => remove(announcements, m[1]));

on("GET", `${A}/events`, () => events);
on("GET", `${A}/export`, () => ({ version: 1, exported_at: now(), monitors, status_pages: pages, notifications, systems: systems.map(({ id, name, tags }) => ({ id, name, tags })), maintenances, announcements }));
on("POST", `${A}/import`, (_, b) => ({ ok: true, counts: { monitors: b?.monitors?.length ?? 0, status_pages: b?.status_pages?.length ?? 0, notifications: b?.notifications?.length ?? 0 } }));

export async function mockRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
	await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
	const url = new URL(path, location.origin);
	for (const [m, re, h] of routes) {
		if (m !== method) continue;
		const match = url.pathname.match(re);
		if (match) return structuredClone(h(match, body, url.searchParams)) as T;
	}
	throw new ApiError(`Mock: no route for ${method} ${url.pathname}`, 404);
}
