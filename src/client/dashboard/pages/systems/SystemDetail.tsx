import type { ContainerPoint, PveSnapshot, StatsPoint, StatsRange, SystemInstall, SystemRecord, SystemStats } from "@shared/types";
import {
	ArrowLeft,
	Bell,
	Box,
	Clock,
	Cpu,
	Gpu,
	HardDrive,
	Network,
	Package,
	SquareTerminal,
	Fingerprint,
	KeyRound,
	Layers,
	MemoryStick,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	Search,
	Server,
	Settings2,
	Terminal,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { admin } from "@/api";
import { ChartCard, type Row, type Series, TimeChart } from "@/components/charts";
import { Badge, StatusBadge, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/components/ui/toast";
import { formatBytes, formatDay, formatDuration, formatNumber, formatPercent, formatRate, formatTime, osName, timeAgo } from "@/lib/format";
import { useApi, useDocumentTitle, useLatest, useLocalStorage } from "@/lib/hooks";
import { CHART_COLORS } from "@/lib/status";
import { splitList } from "@/lib/utils";
import { AlertsDialog } from "./AlertsDialog";
import { InstallInfo } from "./InstallInfo";
import { ProxmoxGuests } from "./ProxmoxGuests";
import { Packages, Services, scrollTo, UpdateChips } from "./SystemUpdates";
import { useCanEdit } from "@/dashboard/role";

const RANGES: { value: StatsRange; label: string }[] = [
	{ value: "1h", label: "1 hour" },
	{ value: "12h", label: "12 hours" },
	{ value: "24h", label: "24 hours" },
	{ value: "1w", label: "1 week" },
	{ value: "30d", label: "30 days" },
];

/** Beszel's system page layouts: everything on one page, or grouped into tabs. */
type DisplayMode = "default" | "tabs";
type SystemTab = "core" | "network" | "disk" | "gpu" | "containers" | "guests" | "services" | "updates";
const TAB_META: Record<SystemTab, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
	core: { label: "Core", Icon: Cpu },
	network: { label: "Network", Icon: Network },
	disk: { label: "Disk", Icon: HardDrive },
	gpu: { label: "GPU", Icon: Gpu },
	containers: { label: "Containers", Icon: Box },
	guests: { label: "Guests", Icon: Layers },
	services: { label: "Services", Icon: SquareTerminal },
	updates: { label: "Updates", Icon: Package },
};

const CPUB = ["User", "System", "IOWait", "Steal", "Idle", "IRQ", "SoftIRQ", "Nice"];
const SYNC = "system-stats";
const pct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;

/** Union of keys across a per-point record field (sensors, fans, gpus, fs). */
function keysOf<T>(stats: StatsPoint[], pick: (s: SystemStats) => Record<string, T> | undefined): string[] {
	const set = new Set<string>();
	for (const p of stats) for (const k of Object.keys(pick(p.stats) ?? {})) set.add(k);
	return [...set].sort();
}

const series = (keys: string[], name: (k: string) => string = (k) => k, prefix = ""): Series[] =>
	keys.map((k, i) => ({ key: prefix + k, name: name(k), color: CHART_COLORS[i % CHART_COLORS.length] }));

export function SystemDetail({ id }: { id: string }) {
	const [, navigate] = useLocation();
	const confirm = useConfirm();
	const canEdit = useCanEdit();
	const { run, busy } = useAction();
	const [range, setRange] = useLocalStorage<StatsRange>("richter-range", "1h");
	const sys = useApi<SystemRecord>(`/api/admin/systems/${id}`, { refreshMs: 15_000 });
	const refresh = range === "1h" ? 60_000 : 300_000;
	const stats = useApi<StatsPoint[]>(`/api/admin/systems/${id}/stats?range=${range}`, { refreshMs: refresh });
	const containers = useApi<ContainerPoint[]>(`/api/admin/systems/${id}/containers?range=${range}`, { refreshMs: refresh });
	const pve = useApi<PveSnapshot | null>(`/api/admin/systems/${id}/pve`, { refreshMs: 60_000 });
	const [alertsOpen, setAlertsOpen] = useState(false);
	const [install, setInstall] = useState<SystemInstall>();
	const [editing, setEditing] = useState(false);
	const [cpuMode, setCpuMode] = useState<"total" | "breakdown">("total");
	const [displayMode, setDisplayMode] = useLocalStorage<DisplayMode>("richter-displayMode", "default");
	const [activeTab, setActiveTab] = useState<SystemTab>("core");
	const tabsRef = useRef<{ tabs: SystemTab[]; tab: SystemTab }>({ tabs: ["core"], tab: "core" });
	useDocumentTitle(sys.data ? `${sys.data.name} · Richter` : undefined);
	// Back to Core when switching systems, like Beszel.
	useEffect(() => setActiveTab("core"), [id]);
	// Tabs mode: ← / → (or h / l) switch tabs, as in Beszel. Ignored while typing or when the tab list has focus.
	useEffect(() => {
		if (displayMode !== "tabs") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
			const t = e.target as HTMLElement | null;
			if (t?.closest('input, textarea, select, [contenteditable="true"], [role="tablist"], [role="dialog"], [role="menu"]')) return;
			const left = e.key === "ArrowLeft" || e.key === "h";
			const right = e.key === "ArrowRight" || e.key === "l";
			if (!left && !right) return;
			const { tabs, tab } = tabsRef.current;
			const i = tabs.indexOf(tab);
			setActiveTab(tabs[(i + (left ? -1 : 1) + tabs.length) % tabs.length]);
		};
		document.addEventListener("keyup", onKey);
		return () => document.removeEventListener("keyup", onKey);
	}, [displayMode]);

	const s = sys.data;
	const xFormat = range === "1w" || range === "30d" ? formatDay : formatTime;
	const pts = stats.data ?? [];

	const charts = useMemo(() => buildRows(pts), [pts]);

	if (sys.error && !s) return <ErrorState error={sys.error} onRetry={sys.reload} />;

	const act = async (key: string, path: string, msg: string) => {
		const r = await run(key, () => admin.post<SystemRecord>(`/systems/${id}/${path}`), msg);
		if (r) sys.setData(r);
	};

	const actions = s && canEdit && (
		<div className="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" onClick={() => setAlertsOpen(true)}>
				<Bell /> Alerts
			</Button>
			<Button
				variant="outline"
				size="sm"
				loading={busy === "install"}
				onClick={async () => {
					const r = await run("install", () => admin.get<SystemInstall>(`/systems/${id}/install`));
					if (r) setInstall(r);
				}}
			>
				<Terminal /> Install
			</Button>
			{s.status === "paused" ? (
				<Button variant="outline" size="sm" loading={busy === "resume"} onClick={() => act("resume", "resume", "System resumed")}>
					<Play /> Resume
				</Button>
			) : (
				<Button variant="outline" size="sm" loading={busy === "pause"} onClick={() => act("pause", "pause", "System paused")}>
					<Pause /> Pause
				</Button>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="icon-sm" aria-label="More actions">
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem onSelect={() => setEditing(true)}>
						<Pencil /> Edit system
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={async () => {
							const ok = await confirm({
								title: "Rotate token?",
								description: "The current agent will be disconnected until you update its TOKEN with the new value.",
								confirmLabel: "Rotate token",
								destructive: true,
							});
							if (!ok) return;
							const r = await run("rotate", () => admin.post<SystemInstall>(`/systems/${id}/rotate-token`), "Token rotated");
							if (r) setInstall(r);
						}}
					>
						<KeyRound /> Rotate token
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={async () => {
							const ok = await confirm({
								title: "Reset fingerprint?",
								description: "The next agent that connects with this token will be bound to the system. Use this after reinstalling the server.",
								confirmLabel: "Reset",
							});
							if (ok) act("fp", "reset-fingerprint", "Fingerprint reset");
						}}
					>
						<Fingerprint /> Reset fingerprint
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						destructive
						onSelect={async () => {
							const ok = await confirm({
								title: `Delete ${s.name}?`,
								description: "All stored metrics, alerts and status page references for this system are removed. This cannot be undone.",
								confirmLabel: "Delete system",
								destructive: true,
							});
							if (!ok) return;
							const r = await run("delete", () => admin.del(`/systems/${id}`), "System deleted");
							if (r) navigate("/systems");
						}}
					>
						<Trash2 /> Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);

	const d = s?.details;
	const info = s?.info;
	const facts: [React.ComponentType<{ className?: string }>, string, string | undefined][] = s
		? [
				[Server, "Host", info?.h ?? d?.hostname],
				[Box, "OS", d?.osName ?? (info?.os != null ? osName(info.os) : undefined)],
				[Terminal, "Kernel", info?.k ?? d?.kernel],
				[Cpu, "CPU", info?.m ?? d?.cpuModel],
				[Cpu, "Cores", (info?.c ?? d?.cores) ? `${info?.c ?? d?.cores}c / ${info?.t ?? d?.threads ?? "?"}t` : undefined],
				[MemoryStick, "Memory", d?.memTotal ? formatBytes(d.memTotal) : undefined],
				[Clock, "Uptime", s.status === "up" && info?.u ? formatDuration(info.u) : undefined],
			]
		: [];


	/** Loading / error / empty states shared by every chart group; charts render in the same 2-column grid. */
	const chartArea = (children: React.ReactNode) =>
		stats.loading && !stats.data ? (
			<div className="grid gap-4 lg:grid-cols-2">
				{Array.from({ length: 6 }, (_, i) => (
					<Skeleton key={i} className="h-64 rounded-lg" />
				))}
			</div>
		) : stats.error && !stats.data ? (
			<ErrorState error={stats.error} onRetry={stats.reload} />
		) : pts.length === 0 ? (
			<Card>
				<EmptyState icon={Clock} title="No metrics for this range yet">
					{s?.status === "pending"
						? "The agent has not connected yet. Use “Install” above to get the docker-compose or binary snippet."
						: "Data appears once the agent reports. Longer ranges fill in as rollups run (every 10 minutes and up)."}
				</EmptyState>
			</Card>
		) : (
			<div className="grid gap-4 lg:grid-cols-2">{children}</div>
		);

	// Beszel's tab set and order: Core, Network, Disk, then GPU / Containers / Services / Updates when present.
	const hasGpu = charts.gpus.length > 0;
	const hasContainers = (containers.data?.length ?? 0) > 0;
	const hasServices = !!s?.info?.sv?.length;
	const hasUpdates = !!s?.info?.pu?.length;
	const tabs: SystemTab[] = ["core", "network", "disk"];
	if (hasGpu) tabs.push("gpu");
	if (hasContainers) tabs.push("containers");
	const hasGuests = !!pve.data;
	if (hasGuests) tabs.push("guests");
	if (hasServices) tabs.push("services");
	if (hasUpdates) tabs.push("updates");
	const tab: SystemTab = tabs.includes(activeTab) ? activeTab : "core";
	tabsRef.current = { tabs, tab };
	const onChip = (section: "packages" | "services") => {
		if (displayMode === "tabs") setActiveTab(section === "packages" ? "updates" : "services");
		else scrollTo(section);
	};

	const cpuC = (
		<>
			<ChartCard
						title="CPU usage"
						description={cpuMode === "total" ? "Average system-wide utilization" : "Time spent per CPU state"}
						actions={
							charts.hasCpub && (
								<Segmented
									value={cpuMode}
									onChange={setCpuMode}
									options={[
										{ value: "total", label: "Total" },
										{ value: "breakdown", label: "Breakdown" },
									]}
								/>
							)
						}
					>
						{cpuMode === "breakdown" && charts.hasCpub ? (
							<TimeChart
								data={charts.rows}
								syncId={SYNC}
								xFormat={xFormat}
								format={pct}
								stacked
								legend
								domain={[0, 100]}
								series={CPUB.map((n, i) => ({ key: `cpub${i}`, name: n, color: CHART_COLORS[i] })).filter((x) => x.name !== "Idle")}
							/>
						) : (
							<TimeChart
								data={charts.rows}
								syncId={SYNC}
								xFormat={xFormat}
								format={pct}
								domain={[0, 100]}
								series={[{ key: "cpu", name: "CPU", color: CHART_COLORS[0] }, ...(charts.hasCpuMax && range !== "1h" ? [{ key: "cpum", name: "Peak", color: "#a1a1aa" }] : [])]}
							/>
						)}
					</ChartCard>
		</>
	);
	const memoryC = (
		<>
			<ChartCard title="Memory usage" description={charts.memTotal ? `Total ${formatBytes(charts.memTotal)}` : "Used, buffers/cache and ZFS ARC"}>
						<TimeChart
							data={charts.rows}
							syncId={SYNC}
							xFormat={xFormat}
							format={(v) => formatBytes(v)}
							stacked
							legend
							domain={[0, charts.memTotal || "auto"]}
							series={[
								{ key: "mu", name: "Used", color: CHART_COLORS[0] },
								...(charts.hasZfs ? [{ key: "mz", name: "ZFS ARC", color: CHART_COLORS[3] }] : []),
								...(charts.hasBuff ? [{ key: "mb", name: "Cache / buffers", color: CHART_COLORS[1] }] : []),
							]}
						/>
					</ChartCard>
		</>
	);
	const diskC = (
		<>
			<ChartCard title="Disk usage" description={charts.diskTotal ? `Root filesystem · ${formatBytes(charts.diskTotal)}` : "Root filesystem"}>
						<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => formatBytes(v)} domain={[0, charts.diskTotal || "auto"]} series={[{ key: "du", name: "Used", color: CHART_COLORS[2] }]} />
					</ChartCard>
		</>
	);
	const diskioC = (
		<>
			<ChartCard title="Disk I/O" description="Root filesystem throughput">
						<TimeChart
							data={charts.rows}
							syncId={SYNC}
							xFormat={xFormat}
							format={(v) => formatRate(v)}
							legend
							series={[
								{ key: "dr", name: "Read", color: CHART_COLORS[1] },
								{ key: "dw", name: "Write", color: CHART_COLORS[3] },
							]}
						/>
					</ChartCard>
		</>
	);
	const bandwidthC = (
		<>
			<ChartCard title="Bandwidth" description="Network traffic of public interfaces">
						<TimeChart
							data={charts.rows}
							syncId={SYNC}
							xFormat={xFormat}
							format={(v) => formatRate(v)}
							legend
							series={[
								{ key: "ns", name: "Sent", color: CHART_COLORS[0] },
								{ key: "nr", name: "Received", color: CHART_COLORS[2] },
							]}
						/>
					</ChartCard>
		</>
	);
	const loadC = (
		<>
			{charts.hasLoad && (
						<ChartCard title="Load average" description="1, 5 and 15 minute averages">
							<TimeChart
								data={charts.rows}
								syncId={SYNC}
								xFormat={xFormat}
								format={(v) => formatNumber(v)}
								lines
								legend
								series={[
									{ key: "la0", name: "1 min", color: CHART_COLORS[0] },
									{ key: "la1", name: "5 min", color: CHART_COLORS[1] },
									{ key: "la2", name: "15 min", color: CHART_COLORS[2] },
								]}
							/>
						</ChartCard>
					)}
		</>
	);
	const swapC = (
		<>
			{charts.hasSwap && (
						<ChartCard title="Swap usage" description={`Total ${formatBytes(charts.swapTotal)}`}>
							<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => formatBytes(v)} domain={[0, charts.swapTotal || "auto"]} series={[{ key: "swu", name: "Used", color: CHART_COLORS[5] }]} />
						</ChartCard>
					)}
		</>
	);
	const tempsC = (
		<>
			{charts.temps.length > 0 && (
						<ChartCard title="Temperatures" description="Click a sensor to hide or show it">
							<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => `${v.toFixed(0)} °C`} domain={["auto", "auto"]} lines legend series={series(charts.temps, (k) => k, "t:")} />
						</ChartCard>
					)}
		</>
	);
	const gpusC = (
		<>
			{charts.gpus.length > 0 && (
						<>
							<ChartCard title="GPU usage">
								<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={pct} domain={[0, 100]} legend series={series(charts.gpus, (k) => charts.gpuNames[k] ?? `GPU ${k}`, "gu:")} />
							</ChartCard>
							{charts.hasGpuMem && (
								<ChartCard title="GPU VRAM">
									<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => formatBytes(v)} legend series={series(charts.gpus, (k) => charts.gpuNames[k] ?? `GPU ${k}`, "gm:")} />
								</ChartCard>
							)}
							{charts.hasGpuPower && (
								<ChartCard title="GPU power draw">
									<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => `${v.toFixed(0)} W`} lines legend series={series(charts.gpus, (k) => charts.gpuNames[k] ?? `GPU ${k}`, "gp:")} />
								</ChartCard>
							)}
						</>
					)}
		</>
	);
	const efsC = (
		<>
			{charts.efs.map((fs) => (
						<ChartCard key={fs} title={`Disk usage · ${fs}`} description={charts.efsTotal[fs] ? `Total ${formatBytes(charts.efsTotal[fs])}` : undefined}>
							<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => formatBytes(v)} domain={[0, charts.efsTotal[fs] || "auto"]} series={[{ key: `efs:${fs}:du`, name: "Used", color: CHART_COLORS[2] }]} />
						</ChartCard>
					))}
		</>
	);
	const efsioC = (
		<>
			{charts.efs
						.filter((fs) => charts.efsIo[fs])
						.map((fs) => (
							<ChartCard key={`${fs}-io`} title={`Disk I/O · ${fs}`}>
								<TimeChart
									data={charts.rows}
									syncId={SYNC}
									xFormat={xFormat}
									format={(v) => formatRate(v)}
									legend
									series={[
										{ key: `efs:${fs}:r`, name: "Read", color: CHART_COLORS[1] },
										{ key: `efs:${fs}:w`, name: "Write", color: CHART_COLORS[3] },
									]}
								/>
							</ChartCard>
						))}
		</>
	);
	const fansC = (
		<>
			{charts.fans.length > 0 && (
						<ChartCard title="Fans">
							<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={(v) => `${v.toFixed(0)} rpm`} domain={["auto", "auto"]} lines legend series={series(charts.fans, (k) => k, "f:")} />
						</ChartCard>
					)}
		</>
	);
	const batteryC = (
		<>
			{charts.hasBattery && (
						<ChartCard title="Battery">
							<TimeChart data={charts.rows} syncId={SYNC} xFormat={xFormat} format={pct} domain={[0, 100]} series={[{ key: "bat", name: "Charge", color: CHART_COLORS[2] }]} />
						</ChartCard>
					)}
		</>
	);
	const coresC = (
		<>
			{charts.cores > 0 && (
						<ChartCard title="Per-core CPU" description={`${charts.cores} logical cores over time`} className="lg:col-span-2">
							<CoreHeatmap points={pts} xFormat={xFormat} />
						</ChartCard>
					)}
		</>
	);

	return (
		<>
			<Link href="/systems" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
				<ArrowLeft className="size-4" /> Systems
			</Link>

			{!s ? (
				<Skeleton className="mb-4 h-28 rounded-lg" />
			) : (
				<Card className="mb-4 p-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2.5">
								<h1 className="text-xl font-semibold tracking-tight">{s.name}</h1>
								<StatusBadge status={s.status} />
								{s.agent_version && <Badge>agent {s.agent_version}</Badge>}
								{!s.fingerprint_bound && <Badge className="border-amber-500/40 text-amber-600 dark:text-amber-400">unbound</Badge>}
								<UpdateChips info={s.info} onSelect={onChip} />
								{s.tags.map((t) => (
									<TagChip key={t} tag={t} />
								))}
							</div>
							<div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
								{facts
									.filter(([, , v]) => v)
									.map(([Icon, label, value]) => (
										<span key={label} className="flex items-center gap-1.5" title={label}>
											<Icon className="size-4 opacity-70" />
											{value}
										</span>
									))}
								<span className="flex items-center gap-1.5">Last seen {timeAgo(s.last_seen)}</span>
							</div>
						</div>
						{actions}
					</div>
				</Card>
			)}
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<Segmented value={range} onChange={setRange} options={RANGES} />
				<div className="flex items-center gap-3">
					{pts.length > 0 && (
						<span className="text-xs text-muted-foreground">
							{pts.length} samples · latest {timeAgo(pts[pts.length - 1].created_at)}
						</span>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button aria-label="View" title="Display" variant="outline" size="icon-sm">
								<Settings2 className="opacity-80" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent className="min-w-44">
							<DropdownMenuLabel className="px-3.5">Display</DropdownMenuLabel>
							<DropdownMenuSeparator />
							<DropdownMenuRadioGroup className="px-1 pb-1" value={displayMode} onValueChange={(v) => setDisplayMode(v as DisplayMode)}>
								<DropdownMenuRadioItem value="default" onSelect={(e) => e.preventDefault()}>
									Default
								</DropdownMenuRadioItem>
								<DropdownMenuRadioItem value="tabs" onSelect={(e) => e.preventDefault()}>
									Tabs
								</DropdownMenuRadioItem>
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{displayMode === "tabs" ? (
				<Tabs value={tab} onValueChange={(v) => setActiveTab(v as SystemTab)} className="contents">
					<TabsList className="mb-4 flex h-11 w-full justify-start overflow-auto p-1.5 shadow-xs">
						{tabs.map((t) => {
							const { label, Icon } = TAB_META[t];
							return (
								<TabsTrigger key={t} value={t} className="h-8 w-full">
									<Icon className="size-3.5" />
									{label}
								</TabsTrigger>
							);
						})}
					</TabsList>
					<TabsContent value="core">
						{chartArea(
							<>
								{cpuC}
								{loadC}
								{memoryC}
								{swapC}
								{tempsC}
								{fansC}
								{batteryC}
								{coresC}
							</>,
						)}
					</TabsContent>
					<TabsContent value="network">{chartArea(bandwidthC)}</TabsContent>
					<TabsContent value="disk">
						{chartArea(
							<>
								{diskC}
								{diskioC}
								{efsC}
								{efsioC}
							</>,
						)}
					</TabsContent>
					{hasGpu && <TabsContent value="gpu">{chartArea(gpusC)}</TabsContent>}
					{hasContainers && (
						<TabsContent value="containers" className="[&>section]:mt-0">
							<Containers data={containers.data ?? []} xFormat={xFormat} />
						</TabsContent>
					)}
					{hasGuests && (
						<TabsContent value="guests" className="[&>section]:mt-0">
							<ProxmoxGuests snap={pve.data} />
						</TabsContent>
					)}
					{hasServices && s && (
						<TabsContent value="services" className="[&>section]:mt-0">
							<Services systemId={s.id} info={s.info} />
						</TabsContent>
					)}
					{hasUpdates && s && (
						<TabsContent value="updates" className="[&>section]:mt-0">
							<Packages systemId={s.id} info={s.info} />
						</TabsContent>
					)}
				</Tabs>
			) : (
				<>
					{chartArea(
						<>
							{cpuC}
							{memoryC}
							{diskC}
							{diskioC}
							{bandwidthC}
							{loadC}
							{swapC}
							{tempsC}
							{gpusC}
							{efsC}
							{efsioC}
							{fansC}
							{batteryC}
							{coresC}
						</>,
					)}

					<Containers data={containers.data ?? []} xFormat={xFormat} />

					<ProxmoxGuests snap={pve.data} />

					{s && <Packages systemId={s.id} info={s.info} />}
					{s && <Services systemId={s.id} info={s.info} />}
				</>
			)}

			{s && <AlertsDialog systemId={s.id} systemName={s.name} open={alertsOpen} onOpenChange={setAlertsOpen} />}

			<Dialog open={install != null} onOpenChange={(o) => !o && setInstall(undefined)}>
				<DialogContent wide>
					<DialogHeader title="Agent install snippet" description={s ? `Run on ${s.name} to (re)connect the agent.` : undefined} />
					<DialogBody>{install && <InstallInfo install={install} />}</DialogBody>
				</DialogContent>
			</Dialog>

			{s && <EditSystemDialog system={s} open={editing} onOpenChange={setEditing} onSaved={sys.setData} />}
		</>
	);
}

function buildRows(pts: StatsPoint[]) {
	const temps = keysOf(pts, (s) => s.t);
	const fans = keysOf(pts, (s) => s.f);
	const gpus = keysOf(pts, (s) => s.g);
	const efs = keysOf(pts, (s) => s.efs);
	const gpuNames: Record<string, string> = {};
	const efsTotal: Record<string, number> = {};
	const efsIo: Record<string, boolean> = {};
	let memTotal = 0;
	let diskTotal = 0;
	let swapTotal = 0;
	let cores = 0;
	const flags = { hasCpub: false, hasCpuMax: false, hasZfs: false, hasBuff: false, hasLoad: false, hasSwap: false, hasGpuMem: false, hasGpuPower: false, hasBattery: false };

	const rows: Row[] = pts.map(({ created_at, stats: s }) => {
		const r: Row = { t: created_at, cpu: s.cpu, cpum: s.cpum, mu: s.mu, mb: s.mb, mz: s.mz, du: s.du, dr: s.dr, dw: s.dw, ns: s.ns, nr: s.nr, swu: s.swu };
		memTotal = Math.max(memTotal, s.mt ?? (s.mp > 0 ? s.mu / (s.mp / 100) : 0));
		diskTotal = Math.max(diskTotal, s.d ?? 0);
		swapTotal = Math.max(swapTotal, s.sw ?? 0);
		if (s.cpum != null) flags.hasCpuMax = true;
		if (s.mz) flags.hasZfs = true;
		if (s.mb) flags.hasBuff = true;
		if (s.sw) flags.hasSwap = true;
		if (s.cpub?.length) {
			flags.hasCpub = true;
			s.cpub.forEach((v, i) => (r[`cpub${i}`] = v));
		}
		if (s.la) {
			flags.hasLoad = true;
			s.la.forEach((v, i) => (r[`la${i}`] = v));
		}
		for (const [k, v] of Object.entries(s.t ?? {})) r[`t:${k}`] = v;
		for (const [k, v] of Object.entries(s.f ?? {})) r[`f:${k}`] = v;
		for (const [k, g] of Object.entries(s.g ?? {})) {
			gpuNames[k] = g.n || gpuNames[k];
			r[`gu:${k}`] = g.u;
			if (g.mu != null) {
				flags.hasGpuMem = true;
				r[`gm:${k}`] = g.mu * 1024 * 1024; // MB → bytes
			}
			if (g.p != null) {
				flags.hasGpuPower = true;
				r[`gp:${k}`] = g.p;
			}
		}
		for (const [k, f] of Object.entries(s.efs ?? {})) {
			efsTotal[k] = Math.max(efsTotal[k] ?? 0, f.d);
			r[`efs:${k}:du`] = f.du;
			if (f.r != null || f.w != null) {
				efsIo[k] = true;
				r[`efs:${k}:r`] = f.r;
				r[`efs:${k}:w`] = f.w;
			}
		}
		if (s.bat) {
			flags.hasBattery = true;
			r.bat = s.bat[0];
		}
		cores = Math.max(cores, s.cpus?.length ?? 0);
		return r;
	});
	return { rows, temps, fans, gpus, gpuNames, efs, efsTotal, efsIo, memTotal, diskTotal, swapTotal, cores, ...flags };
}

/** Heat strip: one row per core, one column per sample. */
function CoreHeatmap({ points, xFormat }: { points: StatsPoint[]; xFormat: (t: number) => string }) {
	const pts = points.filter((p) => p.stats.cpus?.length);
	const cores = Math.max(0, ...pts.map((p) => p.stats.cpus!.length));
	if (!pts.length) return null;
	const color = (v: number) => {
		const x = Math.max(0, Math.min(100, v)) / 100;
		return `hsl(${150 - 150 * x} 75% 48% / ${0.18 + 0.82 * x})`;
	};
	const latest = pts[pts.length - 1].stats.cpus!;
	const ticks = [0, Math.floor(pts.length / 2), pts.length - 1];
	return (
		<div className="flex gap-3">
			<div className="min-w-0 flex-1">
				<svg viewBox={`0 0 ${pts.length} ${cores}`} preserveAspectRatio="none" className="w-full rounded-sm" style={{ height: Math.min(260, Math.max(64, cores * 10)) }}>
					{pts.map((p, x) =>
						p.stats.cpus!.map((v, y) => (
							<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={0.92} fill={color(v)}>
								<title>{`Core ${y} · ${xFormat(p.created_at)} · ${v.toFixed(0)}%`}</title>
							</rect>
						)),
					)}
				</svg>
				<div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
					{ticks.map((i) => (
						<span key={i}>{xFormat(pts[i].created_at)}</span>
					))}
				</div>
			</div>
			<div className="hidden w-40 shrink-0 sm:block">
				<p className="mb-1.5 text-xs text-muted-foreground">Now</p>
				<div className="grid grid-cols-4 gap-1">
					{latest.map((v, i) => (
						<div key={i} className="rounded px-1 py-0.5 text-center text-[10px] tabular-nums" style={{ background: color(v) }} title={`Core ${i}`}>
							{v.toFixed(0)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

const HEALTH: Record<number, { label: string; cls: string }> = {
	0: { label: "–", cls: "text-muted-foreground" },
	1: { label: "starting", cls: "text-sky-600 dark:text-sky-400" },
	2: { label: "healthy", cls: "text-emerald-600 dark:text-emerald-400" },
	3: { label: "unhealthy", cls: "text-red-600 dark:text-red-400" },
};

function Containers({ data, xFormat }: { data: ContainerPoint[]; xFormat: (t: number) => string }) {
	const [filter, setFilter] = useState("");
	const model = useMemo(() => {
		if (!data.length) return null;
		const latest = data[data.length - 1].stats;
		const names = [...new Set(data.flatMap((p) => p.stats.map((c) => c.n)))];
		const latestCpu = new Map(latest.map((c) => [c.n, c.c]));
		names.sort((a, b) => (latestCpu.get(b) ?? 0) - (latestCpu.get(a) ?? 0));
		const cpu: Row[] = [];
		const mem: Row[] = [];
		const net: Row[] = [];
		for (const p of data) {
			const c: Row = { t: p.created_at };
			const m: Row = { t: p.created_at };
			const n: Row = { t: p.created_at };
			for (const x of p.stats) {
				c[x.n] = x.c;
				m[x.n] = x.m * 1024 * 1024; // MB → bytes
				n[x.n] = x.ns + x.nr;
			}
			cpu.push(c);
			mem.push(m);
			net.push(n);
		}
		return { latest, cpu, mem, net, series: series(names) };
	}, [data]);

	if (!model) return null;
	const q = filter.trim().toLowerCase();
	const visible = model.series.filter((s) => !q || s.name.toLowerCase().includes(q));
	const rows = model.latest.filter((c) => !q || c.n.toLowerCase().includes(q) || c.i?.toLowerCase().includes(q)).sort((a, b) => b.c - a.c);

	return (
		<section className="mt-8">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<Box className="size-5 text-muted-foreground" /> Containers
					<Badge>{model.latest.length}</Badge>
				</h2>
				<div className="relative w-full sm:w-64">
					<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter containers…" className="pl-8" />
				</div>
			</div>
			<div className="grid gap-4 lg:grid-cols-3">
				<ChartCard title="Docker CPU usage">
					<TimeChart data={model.cpu} series={visible} syncId="containers" stacked xFormat={xFormat} format={pct} />
				</ChartCard>
				<ChartCard title="Docker memory usage">
					<TimeChart data={model.mem} series={visible} syncId="containers" stacked xFormat={xFormat} format={(v) => formatBytes(v)} />
				</ChartCard>
				<ChartCard title="Docker network I/O" description="Sent + received">
					<TimeChart data={model.net} series={visible} syncId="containers" stacked xFormat={xFormat} format={(v) => formatRate(v)} />
				</ChartCard>
			</div>
			<Card className="mt-4 overflow-hidden">
				<Table>
					<thead className="border-b bg-muted/30">
						<tr>
							<Th className="pl-4">Name</Th>
							<Th>Image</Th>
							<Th>Status</Th>
							<Th>Health</Th>
							<Th className="text-right">CPU</Th>
							<Th className="text-right">Memory</Th>
							<Th className="pr-4 text-right">Net ↑ / ↓</Th>
						</tr>
					</thead>
					<tbody>
						{rows.map((c, i) => (
							<Tr key={c.id ?? c.n}>
								<Td className="pl-4">
									<span className="flex items-center gap-2 font-medium">
										<span className="size-2 rounded-[2px]" style={{ background: model.series.find((s) => s.key === c.n)?.color ?? CHART_COLORS[i % CHART_COLORS.length] }} />
										{c.n}
									</span>
								</Td>
								<Td className="max-w-64 truncate font-mono text-xs text-muted-foreground">{c.i ?? "–"}</Td>
								<Td className="whitespace-nowrap text-xs">{c.s ?? "–"}</Td>
								<Td className={`text-xs ${HEALTH[c.h ?? 0]?.cls}`}>{HEALTH[c.h ?? 0]?.label}</Td>
								<Td className="text-right tabular-nums">{formatPercent(c.c)}</Td>
								<Td className="text-right tabular-nums">{formatBytes(c.m * 1024 * 1024)}</Td>
								<Td className="whitespace-nowrap pr-4 text-right text-xs tabular-nums">
									{formatRate(c.ns)} / {formatRate(c.nr)}
								</Td>
							</Tr>
						))}
						{rows.length === 0 && (
							<tr>
								<Td colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
									No containers match “{filter}”.
								</Td>
							</tr>
						)}
					</tbody>
				</Table>
			</Card>
		</section>
	);
}

/** Status pages' "Consider down after" choices, in seconds (1 minute is the default and the minimum). */
const DOWN_AFTER = [
	[60, "1 minute (default)"],
	[120, "2 minutes"],
	[300, "5 minutes"],
	[600, "10 minutes"],
	[900, "15 minutes"],
	[1800, "30 minutes"],
] as const;

function downAfterLabel(sec: number): string {
	return DOWN_AFTER.find(([v]) => v === sec)?.[1] ?? (sec % 60 === 0 ? `${sec / 60} minutes` : `${sec} seconds`);
}

function EditSystemDialog({
	system,
	open,
	onOpenChange,
	onSaved,
}: {
	system: SystemRecord;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onSaved: (s: SystemRecord) => void;
}) {
	const { run, busy } = useAction();
	const [name, setName] = useState(system.name);
	const [tags, setTags] = useState(system.tags.join(", "));
	const [downAfter, setDownAfter] = useState(Math.max(60, system.down_after ?? 60));
	const choices = DOWN_AFTER.some(([v]) => v === downAfter) ? DOWN_AFTER : [...DOWN_AFTER, [downAfter, downAfterLabel(downAfter)] as const];
	// Fill the form from the system each time the dialog opens, and only then: `system` is refetched every
	// 15 s while the page is open, and must not overwrite what is being typed (or bring back a cancelled edit).
	const systemRef = useLatest(system);
	useEffect(() => {
		if (!open) return;
		const s = systemRef.current;
		setName(s.name);
		setTags(s.tags.join(", "));
		setDownAfter(Math.max(60, s.down_after ?? 60));
	}, [open, systemRef]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						const r = await run("save", () => admin.patch<SystemRecord>(`/systems/${system.id}`, { name: name.trim(), tags: splitList(tags), down_after: downAfter }), "System updated");
						if (r) {
							onSaved(r);
							onOpenChange(false);
						}
					}}
				>
					<DialogHeader title="Edit system" />
					<DialogBody className="space-y-4">
						<Field label="Name">
							<Input value={name} onChange={(e) => setName(e.target.value)} required />
						</Field>
						<Field label="Tags" hint="Comma separated">
							<Input value={tags} onChange={(e) => setTags(e.target.value)} />
						</Field>
						<Field
							label="Status pages: consider down after"
							hint="Affects status pages only: an outage shorter than this still shows as Up there and isn't counted in their uptime bars or outages. The dashboard always shows the real status, and alerts use their own delay (Alerts)."
						>
							<Select value={downAfter} onChange={(e) => setDownAfter(Number(e.target.value))}>
								{choices.map(([v, l]) => (
									<option key={v} value={v}>
										{l}
									</option>
								))}
							</Select>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" loading={busy === "save"}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
