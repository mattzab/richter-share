// API contract shared by the Worker and the SPA. All timestamps are unix ms.

export type SystemStatus = "pending" | "up" | "down" | "paused";
export type MonitorStatus = "pending" | "up" | "degraded" | "down" | "maintenance" | "paused" | "running";
export type MonitorType = "http" | "tcp" | "dns" | "heartbeat" | "domain" | "system" | "container" | "group";
export type StatsRange = "1h" | "12h" | "24h" | "1w" | "30d";

/** Normalized Beszel Info (latest snapshot, shown in the systems table). */
export interface SystemInfo {
	h?: string; // hostname
	k?: string; // kernel
	c?: number; // cores
	t?: number; // threads
	m?: string; // cpu model
	u?: number; // uptime seconds
	cpu?: number; // %
	mp?: number; // mem %
	dp?: number; // disk %
	v?: string; // agent version
	os?: number; // 0 linux 1 darwin 2 windows 3 freebsd
	g?: number; // gpu %
	dt?: number; // dashboard temp °C
	la?: [number, number, number];
	bb?: number; // total bandwidth bytes/s
	sv?: number[]; // [services total, failed]
	pu?: number[]; // [package updates, security]
	efs?: Record<string, number>; // extra fs %
}

export interface SystemDetails {
	hostname?: string;
	kernel?: string;
	cores?: number;
	threads?: number;
	cpuModel?: string;
	os?: number;
	osName?: string;
	arch?: string;
	podman?: boolean;
	memTotal?: number; // bytes
}

/** Normalized Beszel Stats record. Units: % / bytes / bytes per second / °C. */
export interface SystemStats {
	cpu: number; // %
	cpum?: number; // max cpu % within rollup
	mp: number; // mem %
	mt?: number; // mem total bytes
	mu: number; // mem used bytes
	mb?: number; // buff/cache bytes
	mz?: number; // zfs arc bytes
	sw?: number; // swap total bytes
	swu?: number; // swap used bytes
	d: number; // disk total bytes
	du: number; // disk used bytes
	dp: number; // disk %
	dr: number; // disk read B/s
	dw: number; // disk write B/s
	drm?: number; // max read within rollup
	dwm?: number;
	ns: number; // net sent B/s
	nr: number; // net recv B/s
	nsm?: number; // max sent within rollup
	nrm?: number;
	la?: [number, number, number];
	t?: Record<string, number>; // temperatures °C
	efs?: Record<string, { d: number; du: number; r?: number; w?: number }>; // extra fs (bytes, B/s)
	g?: Record<string, { n: string; mu?: number; mt?: number; u: number; p?: number }>; // gpu (MB, %, W)
	ni?: Record<string, [number, number]>; // per-interface [up B/s, down B/s]
	cpub?: number[]; // [user, system, iowait, steal, idle, irq, softirq, nice]
	cpus?: number[]; // per-core %
	f?: Record<string, number>; // fans rpm
	bat?: [number, number]; // [percent, state]
}

export interface ContainerStat {
	n: string; // name
	c: number; // cpu %
	m: number; // mem MB
	ns: number; // net sent B/s
	nr: number; // net recv B/s
	h?: number; // health 0 none 1 starting 2 healthy 3 unhealthy
	s?: string; // status text e.g. "Up 3 days"
	id?: string;
	i?: string; // image
}

export interface SystemRecord {
	id: string;
	name: string;
	status: SystemStatus;
	info: SystemInfo | null;
	details: SystemDetails | null;
	agent_version: string | null;
	last_seen: number | null;
	connected_at: number | null;
	fingerprint_bound: boolean;
	tags: string[];
	created_at: number;
	/**
	 * Status pages only: seconds a (real) outage must last before status pages show the system as
	 * Down and count it (60 = 1 min, the default and minimum). Dashboard and alerts ignore it.
	 */
	down_after: number;
}

export interface SystemInstall {
	hub_url: string;
	token: string;
	key: string;
	compose: string;
	docker_run: string;
	/** Linux (systemd) command. */
	binary: string;
	brew: string;
	windows: string;
	freebsd: string;
}

export interface StatsPoint {
	created_at: number;
	stats: SystemStats;
}
export interface ContainerPoint {
	created_at: number;
	stats: ContainerStat[];
}

export type SystemAlertMetric =
	| "Status"
	| "CPU"
	| "Memory"
	| "Disk"
	| "Temperature"
	| "LoadAvg5"
	| "Bandwidth"
	| "GPU"
	| "SecurityUpdates"
	| "PackageUpdates"
	| "SystemdFailed";

/** One pending package update (Beszel GetPackageUpdates). */
export interface PackageUpdate {
	n: string; // name
	c?: string; // installed version, if known
	a?: string; // available version
	s?: boolean; // security update
}

export interface PackageSnapshot {
	manager: string | null;
	checked_at: number | null; // ms, agent's last package check
	security_known: boolean;
	packages: PackageUpdate[];
	updated_at: number | null; // ms, when Richter last stored a changed list
}

/** systemd ActiveState: 0 active 1 inactive 2 failed 3 activating 4 deactivating 5 reloading. */
export type ServiceState = 0 | 1 | 2 | 3 | 4 | 5;
/** systemd SubState: 0 dead 1 running 2 exited 3 failed 4 other. */
export interface SystemdService {
	n: string; // unit name
	s: ServiceState;
	ss: number;
}

export interface ServicesSnapshot {
	services: SystemdService[];
	updated_at: number | null; // ms, when the stored list last changed
}
export interface SystemAlert {
	id?: string;
	metric: SystemAlertMetric;
	threshold: number | null; // null for Status
	minutes: number;
	triggered?: boolean;
	last_value?: number | null;
}

// ---- Monitors -------------------------------------------------------------

export interface HttpConfig {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	accepted_codes?: string[]; // e.g. ["200-299", "301"]
	keyword?: string;
	invert_keyword?: boolean;
	json_path?: string;
	json_expected?: string;
	follow_redirects?: boolean;
}
export interface TcpConfig {
	host: string;
	port: number;
	/** Run the check from the external probe (PROBE_URL) instead of the Worker: for port 25 and hosts Workers can't reach. */
	via_probe?: boolean;
	/** Probe only: the server's first line must start with this, e.g. "220" for SMTP. */
	expect_banner?: string;
}
export interface DnsConfig { name: string; record_type?: string; expected?: string[]; resolver?: string }
export interface HeartbeatConfig { period_s: number; grace_s: number }
export interface DomainConfig { domain: string; warn_days?: number }
export interface SystemMonitorConfig { system_id: string }
export interface ContainerMonitorConfig { system_id: string; container_name: string }
export type MonitorConfig =
	| HttpConfig | TcpConfig | DnsConfig | HeartbeatConfig | DomainConfig
	| SystemMonitorConfig | ContainerMonitorConfig | Record<string, never>;

export interface Monitor {
	id: string;
	name: string;
	type: MonitorType;
	config: MonitorConfig;
	parent_id: string | null;
	interval_s: number;
	retries: number;
	retry_interval_s: number;
	timeout_ms: number;
	max_latency_ms: number | null;
	upside_down: boolean;
	resend_every: number;
	paused: boolean;
	description: string | null;
	tags: string[];
	status: MonitorStatus;
	last_check_at: number | null;
	next_check_at: number | null;
	last_latency_ms: number | null;
	last_message: string | null;
	push_token: string | null; // heartbeat only
	ping_url: string | null; // heartbeat only, full URL
	last_ping_at: number | null;
	domain_expires_at: number | null;
	notification_ids: string[];
	created_at: number;
}

/** List view adds summary fields. */
export interface MonitorListItem extends Monitor {
	uptime_24h: number | null; // 0..100
	recent: CheckPoint[]; // last 30 checks, oldest first
}

export type MonitorInput = Partial<Omit<Monitor, "id" | "status" | "created_at" | "push_token" | "ping_url">> & {
	name: string;
	type: MonitorType;
	config: MonitorConfig;
};

/** status: 0 down, 1 up, 2 degraded, 3 maintenance */
export interface CheckPoint { ts: number; status: 0 | 1 | 2 | 3; latency_ms: number | null; message: string | null }

export interface UptimeSummary {
	h24: number | null;
	d7: number | null;
	d30: number | null;
	d90: number | null;
	d365: number | null;
	avg_latency_24h: number | null;
	domain_days: number | null;
}

export interface Incident {
	id: string;
	monitor_id: string;
	monitor_name?: string;
	started_at: number;
	resolved_at: number | null;
	cause: string | null;
}

export interface CheckNowResult { ok: boolean; status: MonitorStatus; latency_ms: number | null; message: string | null }

// ---- Notifications ----------------------------------------------------------

export type NotificationType = "discord" | "slack" | "telegram" | "ntfy" | "gotify" | "pushover" | "webhook";
export interface NotificationChannel {
	id: string;
	name: string;
	type: NotificationType;
	config: Record<string, string>;
	enabled: boolean;
	apply_default: boolean;
	created_at: number;
}
/** One send to one channel, from the notification log (newest first; kept 90 days). */
export interface NotificationLogEntry {
	id: number;
	ts: number;
	channel_id: string | null;
	channel_name: string;
	channel_type: NotificationType | string;
	title: string;
	body: string;
	status: "down" | "up" | "warning" | "info";
	/** What it was about; "test" for a channel's Send test. */
	target_kind: "monitor" | "system" | "test";
	target_id: string | null;
	target_name: string;
	ok: boolean;
	error: string | null;
}
/** Field definitions per channel type, so the UI can render forms generically. */
export const NOTIFICATION_FIELDS: Record<NotificationType, { key: string; label: string; required?: boolean; secret?: boolean; placeholder?: string }[]> = {
	discord: [{ key: "webhook_url", label: "Webhook URL", required: true, secret: true }],
	slack: [{ key: "webhook_url", label: "Webhook URL", required: true, secret: true }],
	telegram: [
		{ key: "bot_token", label: "Bot token", required: true, secret: true },
		{ key: "chat_id", label: "Chat ID", required: true },
	],
	ntfy: [
		{ key: "server", label: "Server", placeholder: "https://ntfy.sh" },
		{ key: "topic", label: "Topic", required: true },
		{ key: "token", label: "Access token", secret: true },
		{ key: "priority", label: "Priority (1-5)", placeholder: "4" },
	],
	gotify: [
		{ key: "server", label: "Server URL", required: true, placeholder: "https://gotify.example.com" },
		{ key: "app_token", label: "App token", required: true, secret: true },
		{ key: "priority", label: "Priority", placeholder: "8" },
	],
	pushover: [
		{ key: "user_key", label: "User key", required: true, secret: true },
		{ key: "app_token", label: "App token", required: true, secret: true },
	],
	webhook: [
		{ key: "url", label: "URL", required: true },
		{ key: "method", label: "Method", placeholder: "POST" },
		{ key: "body_template", label: "Body template", placeholder: '{"text":"{{name}} is {{status}}: {{message}}"}' },
	],
};

// ---- Status pages ------------------------------------------------------------

export interface StatusPageItemRef {
	kind: "monitor" | "system";
	id: string;
	/** Website monitors: link to the site on public pages (default true). false = no link and the URL/host is never exposed publicly. */
	link?: boolean;
}
export interface StatusPageGroup { name: string; items: StatusPageItemRef[] }
export interface StatusPage {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	logo_url: string | null;
	custom_domain: string | null;
	footer_text: string | null;
	layout: StatusPageGroup[];
	show_uptime_bars: boolean;
	show_latency: boolean;
	show_tags: boolean;
	/** Systems get 90-day uptime bars and % like monitors (from system_daily). */
	show_system_uptime?: boolean;
	/** Systems get a 24 h CPU % sparkline (default on). */
	show_system_cpu?: boolean;
	/** Phones (< 640 px) show sparklines on their own row under the name (default on); off hides them there. */
	show_mobile_sparklines?: boolean;
	published: boolean;
	is_default: boolean;
	accent_color: string | null;
	custom_css: string | null;
	created_at: number;
	url: string; // public URL
}
export type StatusPageInput = Partial<Omit<StatusPage, "id" | "created_at" | "url">> & { slug: string; title: string };

export interface Maintenance {
	id: string;
	title: string;
	description: string | null;
	starts_at: number;
	ends_at: number;
	repeat: { every: "day" | "week" | "month"; until: number | null } | null;
	monitor_ids: string[];
	system_ids: string[];
	active: boolean; // computed
	next_start: number | null; // computed
	created_at: number;
}
export type MaintenanceInput = Omit<Maintenance, "id" | "active" | "next_start" | "created_at">;

export type Severity = "info" | "warning" | "danger" | "success";
export interface Announcement {
	id: string;
	status_page_id: string | null;
	title: string;
	body: string; // markdown
	severity: Severity;
	pinned: boolean;
	starts_at: number | null;
	ends_at: number | null;
	created_at: number;
	updated_at: number;
}
export type AnnouncementInput = Omit<Announcement, "id" | "created_at" | "updated_at">;

export interface EventRecord { id: number; ts: number; kind: string; ref_id: string | null; message: string }

export interface Overview {
	systems: { total: number; up: number; down: number; pending: number; paused: number };
	monitors: { total: number; up: number; down: number; degraded: number; other: number };
	open_incidents: number;
	events: EventRecord[];
}

export interface Settings {
	site_title: string;
	timezone: string;
	hub_public_key: string; // read-only
	public_url: string; // read-only
	dashboard_url: string; // read-only
}

// ---- Public status page render model ---------------------------------------

export interface DayBar { day: string; uptime: number | null; incidents: number }
export interface PublicItem {
	kind: "monitor" | "system";
	id: string;
	name: string;
	status: MonitorStatus | SystemStatus;
	url: string | null; // link for http monitors
	type: MonitorType | "system";
	uptime_90d: number | null;
	bars: DayBar[]; // 90 entries, oldest first
	latency?: { ts: number; ms: number }[]; // last 24h, sampled (only if show_latency)
	cpu?: { ts: number; pct: number }[]; // systems: last 24h CPU %, 15-minute averages (only if show_system_cpu)
	cpu_now?: number | null; // systems: newest CPU % (null when down or stale)
	tags?: string[];
}
export interface PublicPage {
	page: Pick<StatusPage, "slug" | "title" | "description" | "logo_url" | "footer_text" | "show_uptime_bars" | "show_latency" | "show_tags" | "accent_color" | "custom_css"> & { show_mobile_sparklines?: boolean };
	overall: "operational" | "degraded" | "partial" | "major" | "maintenance";
	groups: { name: string; items: PublicItem[] }[];
	announcements: Pick<Announcement, "id" | "title" | "body" | "severity" | "created_at" | "ends_at">[];
	maintenances: Pick<Maintenance, "id" | "title" | "description" | "starts_at" | "ends_at" | "active" | "next_start">[];
	incidents: { id: string; name: string; started_at: number; resolved_at: number | null; cause: string | null }[];
	generated_at: number;
}

export interface HostInfo { mode: "dashboard" | "public"; pageSlug: string | null; publicUrl: string; dashboardUrl: string }

// ---- Dashboard access ---------------------------------------------------------

/** full: same as the owner. read: view everything, change nothing, no secrets. */
export type Role = "full" | "read";
export interface DashboardUser {
	email: string;
	role: Role;
	owner: boolean;
	added_by: string | null;
	created_at: number;
}
export interface Me {
	email: string;
	role: Role;
	owner: boolean;
}
export interface AccessSettings {
	users: DashboardUser[];
	/** The Worker has the CF_ACCESS_API_TOKEN secret (and app/account ids) to edit the Access policy. */
	configured: boolean;
	/** Emails on the Access policy that the Worker manages, when it could be read (owner only). */
	policy?: { emails: string[] | null; error?: string };
}
