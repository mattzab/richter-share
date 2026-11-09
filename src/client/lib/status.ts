import type { CheckPoint, MonitorStatus, MonitorType, PublicPage, SystemStatus } from "@shared/types";

export type AnyStatus = MonitorStatus | SystemStatus;

/** Tailwind background class for a status dot. */
export const STATUS_DOT: Record<AnyStatus, string> = {
	up: "bg-emerald-500",
	down: "bg-red-500",
	degraded: "bg-amber-500",
	maintenance: "bg-sky-500",
	paused: "bg-zinc-400 dark:bg-zinc-500",
	pending: "bg-zinc-400 dark:bg-zinc-500",
	running: "bg-violet-500",
};

/** Badge classes (tinted bg + text). */
export const STATUS_BADGE: Record<AnyStatus, string> = {
	up: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 ring-emerald-500/25",
	down: "bg-red-500/15 text-red-700 dark:text-red-400 ring-red-500/25",
	degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/25",
	maintenance: "bg-sky-500/15 text-sky-700 dark:text-sky-400 ring-sky-500/25",
	paused: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 ring-zinc-500/25",
	pending: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 ring-zinc-500/25",
	running: "bg-violet-500/15 text-violet-700 dark:text-violet-400 ring-violet-500/25",
};

export const STATUS_LABEL: Record<AnyStatus, string> = {
	up: "Up",
	down: "Down",
	degraded: "Degraded",
	maintenance: "Maintenance",
	paused: "Paused",
	pending: "Pending",
	running: "Running",
};

export const CHECK_STATUS: Record<CheckPoint["status"], { label: string; cls: string; color: string }> = {
	0: { label: "Down", cls: "bg-red-500", color: "#ef4444" },
	1: { label: "Up", cls: "bg-emerald-500", color: "#10b981" },
	2: { label: "Degraded", cls: "bg-amber-500", color: "#f59e0b" },
	3: { label: "Maintenance", cls: "bg-sky-500", color: "#0ea5e9" },
};

/** Meter color thresholds (Beszel): green < 65, amber < 90, red ≥ 90. */
export function meterColor(pct: number): string {
	if (pct >= 90) return "bg-red-500";
	if (pct >= 65) return "bg-amber-500";
	return "bg-emerald-500";
}

/** Public day-bar color by daily uptime. */
export function dayBarColor(uptime: number | null): string {
	if (uptime == null) return "bg-zinc-300 dark:bg-zinc-700";
	if (uptime >= 99.9) return "bg-emerald-500";
	if (uptime >= 99) return "bg-lime-500";
	if (uptime >= 95) return "bg-amber-500";
	return "bg-red-500";
}

export const OVERALL: Record<PublicPage["overall"], { label: string; cls: string; dot: string }> = {
	operational: { label: "All systems operational", cls: "bg-emerald-600 text-white", dot: "bg-emerald-500" },
	degraded: { label: "Degraded performance", cls: "bg-amber-500 text-white", dot: "bg-amber-500" },
	partial: { label: "Partial outage", cls: "bg-amber-600 text-white", dot: "bg-amber-500" },
	major: { label: "Major outage", cls: "bg-red-600 text-white", dot: "bg-red-500" },
	maintenance: { label: "Under maintenance", cls: "bg-sky-600 text-white", dot: "bg-sky-500" },
};

export const MONITOR_TYPE_LABEL: Record<MonitorType, string> = {
	http: "HTTP(s)",
	tcp: "TCP port",
	dns: "DNS",
	heartbeat: "Heartbeat",
	domain: "Domain expiry",
	system: "System",
	container: "Container",
	guest: "Proxmox guest",
	group: "Group",
};

export const SEVERITY_CLS: Record<"info" | "warning" | "danger" | "success", string> = {
	info: "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100",
	warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100",
	danger: "border-red-500/40 bg-red-500/10 text-red-900 dark:text-red-100",
	success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100",
};

/** Distinct series colors for charts (works on dark and light). */
export const CHART_COLORS = [
	"#8b5cf6", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899",
	"#14b8a6", "#6366f1", "#84cc16", "#f97316", "#06b6d4", "#a855f7",
];
