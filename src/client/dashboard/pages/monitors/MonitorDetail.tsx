import type { CheckNowResult, CheckPoint, Incident, Monitor, SystemRecord, UptimeSummary } from "@shared/types";
import { ArrowLeft, Copy, ExternalLink, Pause, Pencil, Play, RefreshCw, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { admin } from "@/api";
import { ChartCard, TimeChart } from "@/components/charts";
import { Badge, StatusBadge, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { ErrorState } from "@/components/ui/empty-state";
import { Table, Td, Th, Tr } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { useAction, useToast } from "@/components/ui/toast";
import { formatDateTime, formatDay, formatDurationMs, formatMs, formatTime, formatUptime, timeAgo } from "@/lib/format";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { CHART_COLORS, CHECK_STATUS, MONITOR_TYPE_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";
import { HeartbeatBar, monitorTarget, uptimeColor } from "./shared";
import { useCanEdit } from "@/dashboard/role";

export function MonitorDetail({ id }: { id: string }) {
	const [, navigate] = useLocation();
	const confirm = useConfirm();
	const canEdit = useCanEdit();
	const toast = useToast();
	const { run, busy } = useAction();
	const [hours, setHours] = useState<"24" | "168">("24");
	const mon = useApi<Monitor>(`/api/admin/monitors/${id}`, { refreshMs: 30_000 });
	const checks = useApi<CheckPoint[]>(`/api/admin/monitors/${id}/checks?hours=${hours}`, { refreshMs: 60_000 });
	const uptime = useApi<UptimeSummary>(`/api/admin/monitors/${id}/uptime`, { refreshMs: 60_000 });
	const incidents = useApi<Incident[]>(`/api/admin/monitors/${id}/incidents`, { refreshMs: 60_000 });
	const systems = useApi<SystemRecord[]>("/api/admin/systems");
	const [result, setResult] = useState<CheckNowResult>();
	useDocumentTitle(mon.data ? `${mon.data.name} · Richter` : undefined);

	const m = mon.data;
	const latency = useMemo(() => (checks.data ?? []).filter((c) => c.latency_ms != null).map((c) => ({ t: c.ts, ms: c.latency_ms })), [checks.data]);
	const last100 = useMemo(() => [...(checks.data ?? [])].reverse().slice(0, 100), [checks.data]);
	const sysName = (sid: string) => systems.data?.find((s) => s.id === sid)?.name;

	if (mon.error && !m) return <ErrorState error={mon.error} onRetry={mon.reload} />;

	const doPost = async (key: string, path: string, msg: string) => {
		const r = await run(key, () => admin.post<Monitor>(`/monitors/${id}/${path}`), msg);
		if (r) mon.setData(r);
		return r;
	};

	const passive = m?.type === "heartbeat" || m?.type === "system" || m?.type === "container" || m?.type === "guest";
	const cards: [string, React.ReactNode, string?][] = [
		...(passive
			? []
			: ([
					["Current latency", formatMs(m?.last_latency_ms)],
					["Avg latency (24h)", formatMs(uptime.data?.avg_latency_24h)],
				] as [string, React.ReactNode][])),
		["Uptime 24h", formatUptime(uptime.data?.h24), uptimeColor(uptime.data?.h24)],
		["Uptime 7d", formatUptime(uptime.data?.d7), uptimeColor(uptime.data?.d7)],
		["Uptime 30d", formatUptime(uptime.data?.d30), uptimeColor(uptime.data?.d30)],
		["Uptime 1y", formatUptime(uptime.data?.d365), uptimeColor(uptime.data?.d365)],
	];
	if (uptime.data?.domain_days != null || m?.domain_expires_at)
		cards.push([
			"Domain expires",
			uptime.data?.domain_days != null ? `${uptime.data.domain_days} days` : formatDateTime(m?.domain_expires_at),
			(uptime.data?.domain_days ?? 999) < 30 ? "text-amber-600 dark:text-amber-400" : undefined,
		]);

	return (
		<>
			<Link href="/monitors" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
				<ArrowLeft className="size-4" /> Monitors
			</Link>

			{!m ? (
				<Skeleton className="mb-4 h-28 rounded-lg" />
			) : (
				<Card className="mb-4 p-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2.5">
								<h1 className="text-xl font-semibold tracking-tight">{m.name}</h1>
								<StatusBadge status={m.status} />
								<Badge>{MONITOR_TYPE_LABEL[m.type]}</Badge>
								{m.upside_down && <Badge>upside down</Badge>}
								{m.tags.map((t) => (
									<TagChip key={t} tag={t} />
								))}
							</div>
							<p className="mt-1.5 flex items-center gap-1.5 break-all text-sm text-muted-foreground">
								{m.type === "http" ? (
									<a href={monitorTarget(m)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
										{monitorTarget(m)} <ExternalLink className="size-3.5" />
									</a>
								) : (
									monitorTarget(m, sysName)
								)}
							</p>
							{m.description && <p className="mt-1 text-sm">{m.description}</p>}
							<p className="mt-2 text-xs text-muted-foreground">
								{m.type !== "group" && m.type !== "heartbeat" && `Every ${m.interval_s}s · `}
								Last check {timeAgo(m.last_check_at)}
								{m.last_message && ` · ${m.last_message}`}
							</p>
						</div>
						{canEdit && <div className="flex flex-wrap gap-2">
							{m.type !== "group" && m.type !== "heartbeat" && (
								<Button
									variant="outline"
									size="sm"
									loading={busy === "check"}
									onClick={async () => {
										const r = await run("check", () => admin.post<CheckNowResult>(`/monitors/${id}/check-now`));
										if (r) setResult(r);
									}}
								>
									<Zap /> Check now
								</Button>
							)}
							{m.paused ? (
								<Button variant="outline" size="sm" loading={busy === "resume"} onClick={() => doPost("resume", "resume", "Monitor resumed")}>
									<Play /> Resume
								</Button>
							) : (
								<Button variant="outline" size="sm" loading={busy === "pause"} onClick={() => doPost("pause", "pause", "Monitor paused")}>
									<Pause /> Pause
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								loading={busy === "clone"}
								onClick={async () => {
									const r = await run("clone", () => admin.post<Monitor>(`/monitors/${id}/clone`), "Monitor cloned");
									if (r) navigate(`/monitors/${r.id}/edit`);
								}}
							>
								<Copy /> Clone
							</Button>
							<Button variant="outline" size="sm" asChild>
								<Link href={`/monitors/${id}/edit`}>
									<Pencil /> Edit
								</Link>
							</Button>
							<Button
								variant="outline"
								size="sm"
								className="text-destructive hover:text-destructive"
								onClick={async () => {
									const ok = await confirm({
										title: `Delete ${m.name}?`,
										description: m.type === "group" ? "Monitors inside the group are kept and become ungrouped." : "Its check history and incidents are deleted too.",
										confirmLabel: "Delete monitor",
										destructive: true,
									});
									if (!ok) return;
									const r = await run("del", () => admin.del(`/monitors/${id}`), "Monitor deleted");
									if (r) navigate("/monitors");
								}}
							>
								<Trash2 /> Delete
							</Button>
						</div>}
					</div>
					{result && (
						<div
							className={cn(
								"mt-3 flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-sm",
								result.ok ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10",
							)}
						>
							<StatusBadge status={result.status} />
							<span>{formatMs(result.latency_ms)}</span>
							{result.message && <span className="text-muted-foreground">· {result.message}</span>}
							<span className="ml-auto text-xs text-muted-foreground">One-off check, not saved</span>
						</div>
					)}
				</Card>
			)}

			{m?.type === "heartbeat" && m.ping_url && <HeartbeatHelp url={m.ping_url} lastPing={m.last_ping_at} />}

			{m?.type !== "group" && (
				<>
					<div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
						{cards.map(([label, value, cls]) => (
							<Card key={label} className="p-3">
								<p className="text-xs text-muted-foreground">{label}</p>
								<div className={cn("mt-1 text-lg font-semibold tabular-nums", cls)}>{uptime.loading && !uptime.data && label !== "Current latency" ? <Skeleton className="h-6 w-16" /> : value}</div>
							</Card>
						))}
					</div>

					<ChartCard
						title={passive ? "Check history" : "Response time"}
						description={checks.data ? <HeartbeatBar checks={checks.data} count={60} className="mt-2 h-5" /> : undefined}
						actions={
							<Segmented
								value={hours}
								onChange={setHours}
								options={[
									{ value: "24", label: "24h" },
									{ value: "168", label: "7d" },
								]}
							/>
						}
						className="mb-4"
					>
						{checks.loading && !checks.data ? (
							<Skeleton className="h-52" />
						) : passive ? null : latency.length === 0 ? (
							<p className="flex h-52 items-center justify-center text-sm text-muted-foreground">No latency data in this range.</p>
						) : (
							<TimeChart
								data={latency}
								series={[{ key: "ms", name: "Latency", color: CHART_COLORS[0] }]}
								format={(v) => formatMs(v)}
								xFormat={hours === "24" ? formatTime : formatDay}
								height={220}
							/>
						)}
					</ChartCard>
				</>
			)}

			<div className="grid gap-4 xl:grid-cols-[1fr_420px]">
				<Card className="overflow-hidden">
					<div className="flex items-center justify-between border-b px-4 py-3">
						<h3 className="text-sm font-semibold">Latest checks</h3>
						<button type="button" onClick={() => checks.reload().then(() => toast.info("Refreshed"))} className="text-muted-foreground hover:text-foreground" title="Refresh">
							<RefreshCw className="size-4" />
						</button>
					</div>
					<div className="max-h-[480px] overflow-y-auto">
						<Table>
							<thead className="sticky top-0 border-b bg-card">
								<tr>
									<Th className="pl-4">Time</Th>
									<Th>Status</Th>
									<Th className="text-right">Latency</Th>
									<Th className="pr-4">Message</Th>
								</tr>
							</thead>
							<tbody>
								{last100.map((c) => (
									<Tr key={c.ts}>
										<Td className="whitespace-nowrap pl-4 text-xs tabular-nums">{formatDateTime(c.ts)}</Td>
										<Td>
											<span className="flex items-center gap-1.5 text-xs">
												<span className={cn("size-2 rounded-full", CHECK_STATUS[c.status].cls)} />
												{CHECK_STATUS[c.status].label}
											</span>
										</Td>
										<Td className="text-right text-xs tabular-nums">{formatMs(c.latency_ms)}</Td>
										<Td className="max-w-sm truncate pr-4 text-xs text-muted-foreground" title={c.message ?? ""}>
											{c.message ?? ""}
										</Td>
									</Tr>
								))}
								{checks.data && last100.length === 0 && (
									<tr>
										<Td colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
											{m?.type === "group" ? "Groups are not checked directly; their status is the worst child status." : "No checks recorded yet."}
										</Td>
									</tr>
								)}
							</tbody>
						</Table>
					</div>
				</Card>

				<Card className="overflow-hidden">
					<div className="border-b px-4 py-3">
						<h3 className="text-sm font-semibold">Incidents</h3>
					</div>
					{incidents.loading && !incidents.data ? (
						<div className="space-y-2 p-4">
							<Skeleton className="h-10" />
							<Skeleton className="h-10" />
						</div>
					) : (incidents.data ?? []).length === 0 ? (
						<p className="px-4 py-8 text-center text-sm text-muted-foreground">No incidents recorded.</p>
					) : (
						<ul className="divide-y">
							{incidents.data!.map((i) => (
								<li key={i.id} className="px-4 py-3">
									<div className="flex items-center justify-between gap-2">
										<span className={cn("text-xs font-semibold", i.resolved_at ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
											{i.resolved_at ? "Resolved" : "Ongoing"}
										</span>
										<span className="text-xs text-muted-foreground">{formatDurationMs((i.resolved_at ?? Date.now()) - i.started_at)}</span>
									</div>
									<p className="mt-1 text-sm">{i.cause ?? "No cause recorded"}</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										{formatDateTime(i.started_at)}
										{i.resolved_at && ` → ${formatDateTime(i.resolved_at)}`}
									</p>
								</li>
							))}
						</ul>
					)}
				</Card>
			</div>
		</>
	);
}

function HeartbeatHelp({ url, lastPing }: { url: string; lastPing: number | null }) {
	const [tab, setTab] = useState<"curl" | "cron" | "exit" | "systemd">("curl");
	const examples = {
		curl: `# Report success\ncurl -fsS -m 10 --retry 3 ${url}\n\n# Report failure with a message\ncurl -fsS -m 10 --data-raw "disk full" ${url}/fail`,
		cron: `# Ping only when the job succeeds\n0 3 * * * /usr/local/bin/backup.sh && curl -fsS -m 10 --retry 3 ${url}`,
		exit: `# Send the exit code: 0 = up, anything else = down\n/usr/local/bin/backup.sh; curl -fsS -m 10 --retry 3 ${url}/$?`,
		systemd: `[Service]\nType=oneshot\nExecStartPre=-/usr/bin/curl -fsS -m 10 --retry 3 ${url}/start\nExecStart=/usr/local/bin/backup.sh\nExecStopPost=/usr/bin/curl -fsS -m 10 --retry 3 ${url}/\${EXIT_STATUS}`,
	};
	return (
		<Card className="mb-4 p-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<div>
					<h3 className="text-sm font-semibold">Ping URL</h3>
					<p className="text-xs text-muted-foreground">Last ping {timeAgo(lastPing)}. Any method works (GET, POST, HEAD). Uptime Kuma push params (?status=up&amp;msg=…) are accepted too.</p>
				</div>
			</div>
			<CopyField value={url} className="mb-2" />
			<div className="mb-3 grid gap-2 lg:grid-cols-3">
				{(
					[
						["start", "Job started"],
						["fail", "Job failed"],
						["0", "Exit code (0 = ok)"],
					] as const
				).map(([suffix, label]) => (
					<div key={suffix} className="grid min-w-0 gap-1">
						<span className="text-xs text-muted-foreground">
							{label} · <code className="font-mono">/{suffix}</code>
						</span>
						<CopyField value={`${url}/${suffix}`} />
					</div>
				))}
			</div>
			<Segmented
				value={tab}
				onChange={setTab}
				options={[
					{ value: "curl", label: "curl" },
					{ value: "cron", label: "cmd && curl" },
					{ value: "exit", label: "Exit code" },
					{ value: "systemd", label: "systemd" },
				]}
				className="mb-2"
			/>
			<CodeBlock code={examples[tab]} />
		</Card>
	);
}
