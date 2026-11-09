import type { CheckPoint, ContainerMonitorConfig, GuestMonitorConfig, DnsConfig, DomainConfig, HeartbeatConfig, HttpConfig, Monitor, SystemMonitorConfig, TcpConfig } from "@shared/types";
import { Tooltip } from "@/components/ui/tooltip";
import { formatDateTime, formatDuration, formatMs } from "@/lib/format";
import { CHECK_STATUS } from "@/lib/status";
import { cn } from "@/lib/utils";

/** One-line description of what a monitor checks. */
export function monitorTarget(m: Pick<Monitor, "type" | "config">, systemName?: (id: string) => string | undefined): string {
	switch (m.type) {
		case "http":
			return (m.config as HttpConfig).url;
		case "tcp": {
			const c = m.config as TcpConfig;
			return `${c.host}:${c.port}`;
		}
		case "dns": {
			const c = m.config as DnsConfig;
			return `${c.name} ${c.record_type ?? "A"}`;
		}
		case "heartbeat": {
			const c = m.config as HeartbeatConfig;
			return `every ${formatDuration(c.period_s)} (+${formatDuration(c.grace_s)} grace)`;
		}
		case "domain":
			return (m.config as DomainConfig).domain;
		case "system": {
			const id = (m.config as SystemMonitorConfig).system_id;
			return `system ${systemName?.(id) ?? id}`;
		}
		case "container": {
			const c = m.config as ContainerMonitorConfig;
			return `${c.container_name} on ${systemName?.(c.system_id) ?? c.system_id}`;
		}
		case "guest": {
			const c = m.config as GuestMonitorConfig;
			return `${c.guest_type === "lxc" ? "LXC" : "VM"} ${c.vmid} on ${systemName?.(c.system_id) ?? c.system_id}`;
		}
		case "group":
			return "group";
	}
}

/** Uptime Kuma-style row of check pills (oldest → newest), padded to `count`. */
export function HeartbeatBar({ checks, count = 30, className }: { checks: CheckPoint[]; count?: number; className?: string }) {
	const recent = checks.slice(-count);
	const pad = count - recent.length;
	return (
		<div className={cn("flex h-6 items-center gap-[3px]", className)}>
			{Array.from({ length: pad }, (_, i) => (
				<span key={`p${i}`} className="h-full w-[5px] rounded-full bg-muted" />
			))}
			{recent.map((c) => (
				<Tooltip
					key={c.ts}
					content={
						<div className="space-y-0.5">
							<p className="font-medium">{formatDateTime(c.ts)}</p>
							<p>
								{CHECK_STATUS[c.status].label}
								{c.latency_ms != null && ` · ${formatMs(c.latency_ms)}`}
							</p>
							{c.message && <p className="text-muted-foreground">{c.message}</p>}
						</div>
					}
				>
					<span className={cn("h-full w-[5px] rounded-full transition-transform hover:scale-y-110", CHECK_STATUS[c.status].cls)} />
				</Tooltip>
			))}
		</div>
	);
}

export function uptimeColor(v: number | null | undefined): string {
	if (v == null) return "text-muted-foreground";
	if (v >= 99.9) return "text-emerald-600 dark:text-emerald-400";
	if (v >= 99) return "text-lime-600 dark:text-lime-400";
	if (v >= 95) return "text-amber-600 dark:text-amber-400";
	return "text-red-600 dark:text-red-400";
}
