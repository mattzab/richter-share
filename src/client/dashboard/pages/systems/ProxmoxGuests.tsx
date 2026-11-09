import type { PveGuest, PveSnapshot } from "@shared/types";
import { Layers, Search } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/page";
import { formatBytes, formatDuration, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const RED = "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
const STALE_MS = 180_000;

const pct = (used?: number, max?: number) => (used != null && max ? (used / max) * 100 : null);

function Usage({ used, max, unknown }: { used?: number; max?: number; unknown?: string }) {
	const p = pct(used, max);
	if (p == null) return <span className="text-muted-foreground">{unknown ?? "–"}</span>;
	return (
		<span className={cn(p >= 90 && "font-medium text-amber-600 dark:text-amber-400")} title={`${formatBytes(used)} of ${formatBytes(max)}`}>
			{p.toFixed(0)}% <span className="text-muted-foreground">of {formatBytes(max, 0)}</span>
		</span>
	);
}

function statusCls(g: PveGuest): string {
	if (g.status === "running") return "text-emerald-600 dark:text-emerald-400";
	if (g.onboot) return "text-red-600 dark:text-red-400";
	return "text-muted-foreground";
}

/** LXC containers and VMs on a Proxmox host, from the richter-pve companion. */
export function ProxmoxGuests({ snap }: { snap: PveSnapshot | null | undefined }) {
	const [filter, setFilter] = useState("");
	if (!snap) return null;
	const guests = snap.guests.filter((g) => !g.template);
	const q = filter.trim().toLowerCase();
	const rows = guests.filter((g) => !q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q) || g.status.includes(q));
	const down = guests.filter((g) => g.onboot && g.status !== "running").length;
	const stale = Date.now() - snap.at > STALE_MS;
	return (
		<section id="guests" className="mt-8 scroll-mt-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<Layers className="size-5 text-muted-foreground" /> Proxmox guests
					<Badge>{guests.length}</Badge>
					{down > 0 && <Badge className={RED}>{down} not running</Badge>}
				</h2>
				<div className="flex flex-wrap items-center gap-3">
					<span className={cn("text-xs", stale ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
						{snap.node}
						{snap.pve_version && ` · PVE ${snap.pve_version}`} · pushed {timeAgo(snap.at)}
					</span>
					<div className="relative w-full sm:w-56">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter guests…" className="pl-8" />
					</div>
				</div>
			</div>
			<Card className="overflow-hidden">
				<div className="max-h-[28rem] overflow-auto">
					<Table>
						<thead className="sticky top-0 border-b bg-card">
							<tr>
								<Th className="pl-4">Guest</Th>
								<Th>Kind</Th>
								<Th>Status</Th>
								<Th>CPU</Th>
								<Th>Memory</Th>
								<Th>Disk</Th>
								<Th className="pr-4">Uptime</Th>
							</tr>
						</thead>
						<tbody>
							{rows.map((g) => (
								<Tr key={g.vmid} className={cn(g.onboot && g.status !== "running" && "bg-red-500/5")}>
									<Td className="pl-4">
										<span className="font-medium">{g.name}</span> <span className="text-xs text-muted-foreground">{g.vmid}</span>
									</Td>
									<Td className="text-xs">{g.type === "lxc" ? "LXC" : "VM"}</Td>
									<Td className={cn("text-xs", statusCls(g))}>
										{g.status}
										{g.lock && ` · ${g.lock}`}
										{!g.onboot && <span className="text-muted-foreground"> · no autostart</span>}
									</Td>
									<Td className="text-xs">{g.status === "running" && g.cpu != null ? `${(g.cpu * 100).toFixed(0)}% of ${g.maxcpu ?? "?"}` : "–"}</Td>
									<Td className="text-xs">{g.status === "running" ? <Usage used={g.mem} max={g.maxmem} /> : "–"}</Td>
									<Td className="text-xs">
										{g.type === "qemu" && !g.disk ? <span className="text-muted-foreground" title="Proxmox only knows a VM's disk usage through the QEMU guest agent">{g.maxdisk ? `${formatBytes(g.maxdisk, 0)} (no agent)` : "–"}</span> : <Usage used={g.disk} max={g.maxdisk} />}
									</Td>
									<Td className="pr-4 text-xs">{g.status === "running" && g.uptime ? formatDuration(g.uptime) : "–"}</Td>
								</Tr>
							))}
							{rows.length === 0 && (
								<tr>
									<Td colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
										{guests.length ? `No guests match “${filter}”.` : "No guests on this node."}
									</Td>
								</tr>
							)}
						</tbody>
					</Table>
				</div>
			</Card>
			{snap.storages.length > 0 && (
				<Card className="mt-4 overflow-hidden">
					<Table>
						<thead className="border-b">
							<tr>
								<Th className="pl-4">Storage</Th>
								<Th>Type</Th>
								<Th>Status</Th>
								<Th className="pr-4">Used</Th>
							</tr>
						</thead>
						<tbody>
							{snap.storages.map((st) => (
								<Tr key={st.storage}>
									<Td className="pl-4 font-medium">
										{st.storage}
										{st.shared && <span className="text-xs text-muted-foreground"> · shared</span>}
									</Td>
									<Td className="text-xs">{st.type ?? "–"}</Td>
									<Td className={cn("text-xs", st.status !== "available" && "text-red-600 dark:text-red-400")}>{st.status ?? "–"}</Td>
									<Td className="pr-4 text-xs">
										<Usage used={st.disk} max={st.maxdisk} />
									</Td>
								</Tr>
							))}
						</tbody>
					</Table>
				</Card>
			)}
		</section>
	);
}
