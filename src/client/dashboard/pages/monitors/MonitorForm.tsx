import type {
	CheckNowResult,
	ContainerPoint,
	Monitor,
	MonitorConfig,
	MonitorInput,
	MonitorListItem,
	MonitorType,
	NotificationChannel,
	SystemRecord,
} from "@shared/types";
import { Activity, ArrowLeft, Box, CalendarClock, FolderOpen, Globe, HeartPulse, Network, Server, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { admin, ApiError, errorMessage, request } from "@/api";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Section } from "@/components/ui/collapsible";
import { ErrorState } from "@/components/ui/empty-state";
import { DurationInput } from "@/components/ui/duration-input";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckRow, SwitchRow } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { formatMs } from "@/lib/format";
import { useDocumentTitle } from "@/lib/hooks";
import { cn, splitList } from "@/lib/utils";

const TYPES: { type: MonitorType; label: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
	{ type: "http", label: "HTTP(s)", description: "Status code, keyword, JSON or header checks", icon: Globe },
	{ type: "tcp", label: "TCP port", description: "Port accepts a connection", icon: Network },
	{ type: "dns", label: "DNS", description: "Record resolves (to expected values)", icon: Activity },
	{ type: "heartbeat", label: "Heartbeat", description: "Cron jobs ping Richter", icon: HeartPulse },
	{ type: "domain", label: "Domain expiry", description: "RDAP expiration date", icon: CalendarClock },
	{ type: "system", label: "System", description: "Mirror a Beszel system's status", icon: Server },
	{ type: "container", label: "Container", description: "Docker container is running & healthy", icon: Box },
	{ type: "group", label: "Group", description: "Worst status of its members", icon: FolderOpen },
];

const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA", "SRV", "PTR"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Flat, string-friendly form state; converted to MonitorInput on save. */
interface FormState {
	name: string;
	type: MonitorType;
	description: string;
	tags: string;
	parent_id: string;
	interval_s: number;
	retries: number;
	retry_interval_s: number;
	timeout_ms: number;
	max_latency_ms: string;
	upside_down: boolean;
	resend_every: number;
	notification_ids: string[];
	// http
	url: string;
	method: string;
	accepted_codes: string;
	keyword: string;
	invert_keyword: boolean;
	json_path: string;
	json_expected: string;
	headers: string;
	body: string;
	follow_redirects: boolean;
	// tcp
	host: string;
	port: string;
	via_probe: boolean;
	expect_banner: string;
	// dns
	dns_name: string;
	record_type: string;
	expected: string;
	resolver: string;
	// heartbeat
	period_s: number;
	grace_s: number;
	// domain
	domain: string;
	warn_days: number;
	// system/container
	system_id: string;
	container_name: string;
}

const EMPTY: FormState = {
	name: "",
	type: "http",
	description: "",
	tags: "",
	parent_id: "",
	interval_s: 60,
	retries: 1,
	retry_interval_s: 60,
	timeout_ms: 10_000,
	max_latency_ms: "",
	upside_down: false,
	resend_every: 0,
	notification_ids: [],
	url: "https://",
	method: "GET",
	accepted_codes: "200-299",
	keyword: "",
	invert_keyword: false,
	json_path: "",
	json_expected: "",
	headers: "",
	body: "",
	follow_redirects: true,
	host: "",
	port: "",
	via_probe: false,
	expect_banner: "",
	dns_name: "",
	record_type: "A",
	expected: "",
	resolver: "https://cloudflare-dns.com/dns-query",
	period_s: 86400,
	grace_s: 3600,
	domain: "",
	warn_days: 30,
	system_id: "",
	container_name: "",
};

function fromMonitor(m: Monitor): FormState {
	const c = m.config as Record<string, unknown>;
	const s = (k: string, d = "") => (c[k] == null ? d : String(c[k]));
	return {
		...EMPTY,
		name: m.name,
		type: m.type,
		description: m.description ?? "",
		tags: m.tags.join(", "),
		parent_id: m.parent_id ?? "",
		interval_s: m.interval_s,
		retries: m.retries,
		retry_interval_s: m.retry_interval_s,
		timeout_ms: m.timeout_ms,
		max_latency_ms: m.max_latency_ms == null ? "" : String(m.max_latency_ms),
		upside_down: m.upside_down,
		resend_every: m.resend_every,
		notification_ids: m.notification_ids,
		url: s("url", EMPTY.url),
		method: s("method", "GET"),
		accepted_codes: ((c.accepted_codes as string[]) ?? ["200-299"]).join(", "),
		keyword: s("keyword"),
		invert_keyword: c.invert_keyword === true,
		json_path: s("json_path"),
		json_expected: s("json_expected"),
		headers: Object.entries((c.headers as Record<string, string>) ?? {})
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n"),
		body: s("body"),
		follow_redirects: c.follow_redirects !== false,
		host: s("host"),
		port: s("port"),
		via_probe: c.via_probe === true,
		expect_banner: s("expect_banner"),
		dns_name: m.type === "dns" ? s("name") : "",
		record_type: s("record_type", "A"),
		expected: ((c.expected as string[]) ?? []).join(", "),
		resolver: s("resolver", EMPTY.resolver),
		period_s: Number(c.period_s ?? EMPTY.period_s),
		grace_s: Number(c.grace_s ?? EMPTY.grace_s),
		domain: s("domain"),
		warn_days: Number(c.warn_days ?? 30),
		system_id: s("system_id"),
		container_name: s("container_name"),
	};
}

type Errors = Partial<Record<keyof FormState, string>>;

function validate(f: FormState): Errors {
	const e: Errors = {};
	if (!f.name.trim()) e.name = "Required";
	switch (f.type) {
		case "http":
			try {
				const u = new URL(f.url);
				if (!/^https?:$/.test(u.protocol)) e.url = "Must start with http:// or https://";
			} catch {
				e.url = "Enter a full URL, e.g. https://example.com/health";
			}
			for (const line of f.headers.split("\n").filter((l) => l.trim())) if (!line.includes(":")) e.headers = `Invalid header line: "${line}" (use Name: value)`;
			break;
		case "tcp": {
			if (!f.host.trim()) e.host = "Required";
			const p = Number(f.port);
			if (!Number.isInteger(p) || p < 1 || p > 65535) e.port = "Port must be 1–65535";
			else if (p === 25 && !f.via_probe) e.port = "Workers can't connect to port 25; turn on \"Check via probe\"";
			break;
		}
		case "dns":
			if (!f.dns_name.trim()) e.dns_name = "Required";
			break;
		case "heartbeat":
			if (!Number.isInteger(f.period_s) || f.period_s <= 0) e.period_s = "Enter a positive whole number";
			else if (f.period_s < 60) e.period_s = "At least 60 seconds";
			if (!Number.isInteger(f.grace_s) || f.grace_s < 0) e.grace_s = "Enter a whole number (0 for none)";
			break;
		case "domain":
			if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f.domain.trim())) e.domain = "Enter a registrable domain, e.g. example.com";
			break;
		case "system":
			if (!f.system_id) e.system_id = "Pick a system";
			break;
		case "container":
			if (!f.system_id) e.system_id = "Pick a system";
			if (!f.container_name.trim()) e.container_name = "Required";
			break;
	}
	if (f.type !== "group" && f.type !== "heartbeat" && f.type !== "system" && f.type !== "container" && !(f.interval_s >= 60 && Number.isInteger(f.interval_s))) e.interval_s = "Minimum is 60 seconds (cron runs every minute)";
	if (!["heartbeat", "system", "container", "group"].includes(f.type) && !(f.retry_interval_s >= 60 && Number.isInteger(f.retry_interval_s))) e.retry_interval_s = "Minimum is 60 seconds";
	return e;
}

function toInput(f: FormState): MonitorInput {
	let config: MonitorConfig;
	switch (f.type) {
		case "http": {
			const headers = Object.fromEntries(
				f.headers
					.split("\n")
					.filter((l) => l.includes(":"))
					.map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
			);
			config = {
				url: f.url.trim(),
				method: f.method,
				accepted_codes: splitList(f.accepted_codes),
				follow_redirects: f.follow_redirects,
				...(Object.keys(headers).length ? { headers } : {}),
				...(f.body && f.method !== "GET" && f.method !== "HEAD" ? { body: f.body } : {}),
				...(f.keyword ? { keyword: f.keyword, invert_keyword: f.invert_keyword } : {}),
				...(f.json_path ? { json_path: f.json_path.trim(), json_expected: f.json_expected } : {}),
			};
			break;
		}
		case "tcp":
			config = { host: f.host.trim(), port: Number(f.port), ...(f.via_probe ? { via_probe: true, ...(f.expect_banner.trim() ? { expect_banner: f.expect_banner.trim() } : {}) } : {}) };
			break;
		case "dns":
			config = { name: f.dns_name.trim(), record_type: f.record_type, resolver: f.resolver.trim() || undefined, ...(f.expected.trim() ? { expected: splitList(f.expected) } : {}) };
			break;
		case "heartbeat":
			config = { period_s: f.period_s, grace_s: f.grace_s };
			break;
		case "domain":
			config = { domain: f.domain.trim().toLowerCase(), warn_days: f.warn_days };
			break;
		case "system":
			config = { system_id: f.system_id };
			break;
		case "container":
			config = { system_id: f.system_id, container_name: f.container_name.trim() };
			break;
		default:
			config = {};
	}
	return {
		name: f.name.trim(),
		type: f.type,
		config,
		description: f.description.trim() || null,
		tags: splitList(f.tags),
		parent_id: f.type === "group" ? null : f.parent_id || null,
		interval_s: f.interval_s,
		retries: f.retries,
		retry_interval_s: f.retry_interval_s,
		timeout_ms: f.timeout_ms,
		max_latency_ms: f.max_latency_ms.trim() ? Number(f.max_latency_ms) : null,
		upside_down: f.upside_down,
		resend_every: f.resend_every,
		notification_ids: f.notification_ids,
	};
}

export function MonitorForm({ id }: { id?: string }) {
	const [, navigate] = useLocation();
	const toast = useToast();
	const editing = id != null;
	const [form, setForm] = useState<FormState | null>(editing ? null : EMPTY);
	const [loadError, setLoadError] = useState<Error>();
	const [errors, setErrors] = useState<Errors>({});
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [test, setTest] = useState<CheckNowResult | { error: string }>();
	const [channels, setChannels] = useState<NotificationChannel[]>([]);
	const [groups, setGroups] = useState<MonitorListItem[]>([]);
	const [systems, setSystems] = useState<SystemRecord[]>([]);
	const [containers, setContainers] = useState<string[]>([]);
	useDocumentTitle(editing ? "Edit monitor · Richter" : "New monitor · Richter");

	useEffect(() => {
		request<NotificationChannel[]>("/api/admin/notifications").then((ch) => {
			setChannels(ch);
			// Pre-select default channels on new monitors.
			if (!editing) setForm((f) => f && { ...f, notification_ids: ch.filter((c) => c.apply_default).map((c) => c.id) });
		}, () => {});
		request<MonitorListItem[]>("/api/admin/monitors").then((ms) => setGroups(ms.filter((m) => m.type === "group" && m.id !== id)), () => {});
		request<SystemRecord[]>("/api/admin/systems").then(setSystems, () => {});
		if (editing) request<Monitor>(`/api/admin/monitors/${id}`).then((m) => setForm(fromMonitor(m)), setLoadError);
	}, [id, editing]);

	const systemId = form?.type === "container" ? form.system_id : "";
	useEffect(() => {
		setContainers([]);
		if (!systemId) return;
		request<ContainerPoint[]>(`/api/admin/systems/${systemId}/containers?range=1h`).then(
			(pts) => setContainers(pts.length ? pts[pts.length - 1].stats.map((c) => c.n).sort() : []),
			() => {},
		);
	}, [systemId]);

	const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
		setForm((f) => f && { ...f, [k]: v });
		setErrors((e) => ({ ...e, [k]: undefined }));
	};

	const typeMeta = useMemo(() => TYPES.find((t) => t.type === form?.type), [form?.type]);

	if (loadError) return <ErrorState error={loadError} />;
	if (!form)
		return (
			<div className="mx-auto max-w-3xl space-y-4">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-64" />
			</div>
		);

	const runTest = async () => {
		const errs = validate(form);
		if (Object.keys(errs).length) return setErrors(errs);
		setTesting(true);
		setTest(undefined);
		try {
			setTest(await admin.post<CheckNowResult>("/monitors/test", toInput(form)));
		} catch (e) {
			setTest({ error: errorMessage(e) });
		} finally {
			setTesting(false);
		}
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const errs = validate(form);
		setErrors(errs);
		if (Object.keys(errs).length) {
			toast.error("Please fix the highlighted fields");
			return;
		}
		setSaving(true);
		try {
			const body = toInput(form);
			const m = editing ? await admin.patch<Monitor>(`/monitors/${id}`, body) : await admin.post<Monitor>("/monitors", body);
			toast.success(editing ? "Monitor saved" : "Monitor created");
			navigate(`/monitors/${m.id}`);
		} catch (err) {
			if (err instanceof ApiError && err.field) setErrors({ [err.field as keyof FormState]: err.message });
			toast.error("Could not save monitor", errorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	const num = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, Number(e.target.value) as never);
	const txt = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => set(k, e.target.value as never);
	const passive = form.type === "heartbeat" || form.type === "system" || form.type === "container" || form.type === "group";

	return (
		<form onSubmit={submit} className="mx-auto max-w-3xl">
			<Link href={editing ? `/monitors/${id}` : "/monitors"} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
				<ArrowLeft className="size-4" /> {editing ? "Back to monitor" : "Monitors"}
			</Link>
			<PageHeader title={editing ? `Edit ${form.name || "monitor"}` : "New monitor"} />

			<div className="space-y-4">
				{!editing && (
					<Card className="p-4">
						<p className="mb-3 text-sm font-medium">Monitor type</p>
						<div className="grid grid-cols-2 gap-2 md:grid-cols-4">
							{TYPES.map((t) => (
								<button
									key={t.type}
									type="button"
									onClick={() => {
										set("type", t.type);
										if (t.type === "domain") set("interval_s", 86400);
										else if (form.interval_s === 86400) set("interval_s", 60);
									}}
									className={cn(
										"flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
										form.type === t.type ? "border-primary bg-primary/10 ring-1 ring-primary/40" : "hover:border-primary/40 hover:bg-accent/40",
									)}
								>
									<t.icon className={cn("size-5", form.type === t.type ? "text-primary" : "text-muted-foreground")} />
									<span className="text-sm font-medium">{t.label}</span>
									<span className="text-xs leading-snug text-muted-foreground">{t.description}</span>
								</button>
							))}
						</div>
					</Card>
				)}

				<Card className="space-y-4 p-4">
					{editing && typeMeta && (
						<p className="flex items-center gap-2 text-sm text-muted-foreground">
							<typeMeta.icon className="size-4" /> {typeMeta.label} monitor
						</p>
					)}
					<Field label="Name" error={errors.name}>
						<Input value={form.name} onChange={txt("name")} placeholder={form.type === "group" ? "Websites" : "My service"} autoFocus={!editing} />
					</Field>

					{form.type === "http" && (
						<>
							<Field label="URL" error={errors.url} hint="Checks run from Cloudflare's edge. A host in the same Cloudflare zone as Richter is fetched origin-direct and skips the proxy, so the check may not see what visitors see.">
								<Input value={form.url} onChange={txt("url")} placeholder="https://example.com/health" />
							</Field>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label="Method">
									<Select value={form.method} onChange={txt("method")}>
										{METHODS.map((m) => (
											<option key={m}>{m}</option>
										))}
									</Select>
								</Field>
								<Field label="Accepted status codes" hint="Comma separated; ranges allowed (200-299, 301)">
									<Input value={form.accepted_codes} onChange={txt("accepted_codes")} />
								</Field>
							</div>
							<div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
								<Field label="Keyword" hint="Case-sensitive text that must appear in the body (first 1 MiB)">
									<Input value={form.keyword} onChange={txt("keyword")} placeholder="Optional" />
								</Field>
								<div className="pb-6">
									<SwitchRow label="Invert" checked={form.invert_keyword} onCheckedChange={(v) => set("invert_keyword", v)} disabled={!form.keyword} />
								</div>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								<Field label="JSON path" hint="Dots and [i], e.g. data.items[0].status">
									<Input value={form.json_path} onChange={txt("json_path")} placeholder="Optional" />
								</Field>
								<Field label="Expected JSON value">
									<Input value={form.json_expected} onChange={txt("json_expected")} placeholder="ok" disabled={!form.json_path} />
								</Field>
							</div>
						</>
					)}

					{form.type === "tcp" && (
						<div className="grid gap-4 sm:grid-cols-[1fr_140px]">
							<Field label="Host" error={errors.host}>
								<Input value={form.host} onChange={txt("host")} placeholder="db.example.com or 1.1.1.1" />
							</Field>
							<Field label="Port" error={errors.port}>
								<Input type="number" value={form.port} onChange={txt("port")} placeholder="443" />
							</Field>
							<div className="sm:col-span-2">
								<CheckRow
									label="Check via probe"
									description="Connect from your external probe instead of Cloudflare. Use it for port 25 and hosts Workers can't reach."
									checked={form.via_probe}
									onCheckedChange={(v) => set("via_probe", v)}
								/>
							</div>
							{form.via_probe && (
								<Field label="Expected banner (optional)" className="sm:col-span-2">
									<Input value={form.expect_banner} onChange={txt("expect_banner")} placeholder="220 (SMTP greeting)" />
								</Field>
							)}
						</div>
					)}

					{form.type === "dns" && (
						<>
							<div className="grid gap-4 sm:grid-cols-[1fr_140px]">
								<Field label="Hostname" error={errors.dns_name}>
									<Input value={form.dns_name} onChange={txt("dns_name")} placeholder="example.com" />
								</Field>
								<Field label="Record type">
									<Select value={form.record_type} onChange={txt("record_type")}>
										{DNS_TYPES.map((t) => (
											<option key={t}>{t}</option>
										))}
									</Select>
								</Field>
							</div>
							<Field label="Expected values" hint="Comma separated. Every value must appear in the answers. Leave empty to only require NOERROR.">
								<Input value={form.expected} onChange={txt("expected")} placeholder="93.184.215.14" />
							</Field>
							<Field label="DoH resolver">
								<Input value={form.resolver} onChange={txt("resolver")} />
							</Field>
						</>
					)}

					{form.type === "heartbeat" && (
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Expected every" error={errors.period_s}>
								<DurationInput aria-label="Expected every" value={form.period_s} onChange={(v) => set("period_s", v)} />
							</Field>
							<Field label="Grace period" error={errors.grace_s} hint="Extra time before the monitor goes down">
								<DurationInput aria-label="Grace period" value={form.grace_s} onChange={(v) => set("grace_s", v)} />
							</Field>
							<p className="text-xs text-muted-foreground sm:col-span-2">The ping URL and copy-ready curl, cron and systemd examples appear on the monitor page after saving.</p>
						</div>
					)}

					{form.type === "domain" && (
						<div className="grid gap-4 sm:grid-cols-[1fr_160px]">
							<Field label="Domain" error={errors.domain}>
								<Input value={form.domain} onChange={txt("domain")} placeholder="example.com" />
							</Field>
							<Field label="Warn days before">
								<Input type="number" min={1} value={form.warn_days} onChange={num("warn_days")} />
							</Field>
						</div>
					)}

					{(form.type === "system" || form.type === "container") && (
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="System" error={errors.system_id}>
								<Select value={form.system_id} onChange={txt("system_id")}>
									<option value="">Select a system…</option>
									{systems.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</Select>
							</Field>
							{form.type === "container" && (
								<Field label="Container name" error={errors.container_name} hint={form.system_id && !containers.length ? "No containers reported in the last hour; type the name." : undefined}>
									<Input value={form.container_name} onChange={txt("container_name")} list="container-names" placeholder="app" />
									<datalist id="container-names">
										{containers.map((c) => (
											<option key={c} value={c} />
										))}
									</datalist>
								</Field>
							)}
						</div>
					)}

					{form.type === "group" && <p className="text-sm text-muted-foreground">A group is never checked directly. Its status is the worst status of its members (down &gt; degraded &gt; maintenance &gt; up). Assign monitors to it with their “Group” setting.</p>}

					<div className="grid gap-4 sm:grid-cols-2">
						<Field label="Tags" hint="Comma separated">
							<Input value={form.tags} onChange={txt("tags")} placeholder="prod, api" />
						</Field>
						{form.type !== "group" && (
							<Field label="Group">
								<Select value={form.parent_id} onChange={txt("parent_id")}>
									<option value="">No group</option>
									{groups.map((g) => (
										<option key={g.id} value={g.id}>
											{g.name}
										</option>
									))}
								</Select>
							</Field>
						)}
					</div>
					<Field label="Description">
						<Textarea value={form.description} onChange={txt("description")} rows={2} placeholder="Optional, shown on the monitor page" />
					</Field>
				</Card>

				{form.type === "http" && (
					<Section title="HTTP request options" description="Headers, body and redirects">
						<div className="space-y-4">
							<Field label="Headers" error={errors.headers} hint="One per line: Name: value">
								<Textarea value={form.headers} onChange={txt("headers")} rows={3} className="font-mono text-xs" placeholder={"Authorization: Bearer …\nAccept: application/json"} />
							</Field>
							{form.method !== "GET" && form.method !== "HEAD" && (
								<Field label="Body">
									<Textarea value={form.body} onChange={txt("body")} rows={3} className="font-mono text-xs" />
								</Field>
							)}
							<SwitchRow label="Follow redirects" checked={form.follow_redirects} onCheckedChange={(v) => set("follow_redirects", v)} />
						</div>
					</Section>
				)}

				{form.type !== "group" && (
					<Section title="Advanced" description="Interval, retries, timeouts, degraded threshold, upside-down mode and reminders">
						<div className="grid gap-4 sm:grid-cols-2">
							{!passive && (
								<>
									<Field label="Check interval" error={errors.interval_s}>
										<DurationInput aria-label="Check interval" value={form.interval_s} onChange={(v) => set("interval_s", v)} />
									</Field>
									<Field label="Timeout (ms)">
										<Input type="number" min={1000} max={30000} step={500} value={form.timeout_ms} onChange={num("timeout_ms")} />
									</Field>
								</>
							)}
							<Field label="Retries" hint="Failed checks before the monitor is marked down">
								<Input type="number" min={0} max={10} value={form.retries} onChange={num("retries")} />
							</Field>
							{!passive && (
								<Field label="Retry interval" error={errors.retry_interval_s}>
									<DurationInput aria-label="Retry interval" value={form.retry_interval_s} onChange={(v) => set("retry_interval_s", v)} />
								</Field>
							)}
							{!passive && (
								<Field label="Degraded above (ms)" hint="Slower responses are shown as degraded (no alert)">
									<Input type="number" min={0} value={form.max_latency_ms} onChange={txt("max_latency_ms")} placeholder="Off" />
								</Field>
							)}
							<Field label="Resend notification every N failed checks" hint="0 = notify once">
								<Input type="number" min={0} value={form.resend_every} onChange={num("resend_every")} />
							</Field>
							{!passive && (
								<div className="sm:col-span-2">
									<SwitchRow
										label="Upside-down mode"
										description="Swap up and down: the monitor is up when the check fails (e.g. a port that must stay closed)."
										checked={form.upside_down}
										onCheckedChange={(v) => set("upside_down", v)}
									/>
								</div>
							)}
						</div>
					</Section>
				)}

				<Card className="p-4">
					<p className="text-sm font-medium">Notifications</p>
					<p className="mb-2 text-xs text-muted-foreground">Channels alerted when this monitor goes down or recovers.</p>
					{channels.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No channels configured.{" "}
							<Link href="/notifications" className="text-primary hover:underline">
								Add one
							</Link>
							.
						</p>
					) : (
						<div className="grid gap-0.5 sm:grid-cols-2">
							{channels.map((c) => (
								<CheckRow
									key={c.id}
									label={c.name}
									description={`${c.type}${c.apply_default ? " · default" : ""}${c.enabled ? "" : " · disabled"}`}
									checked={form.notification_ids.includes(c.id)}
									onCheckedChange={(on) => set("notification_ids", on ? [...form.notification_ids, c.id] : form.notification_ids.filter((x) => x !== c.id))}
								/>
							))}
						</div>
					)}
				</Card>

				{test && (
					<div
						className={cn(
							"flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm",
							"error" in test || !test.ok ? "border-red-500/30 bg-red-500/10" : "border-emerald-500/30 bg-emerald-500/10",
						)}
					>
						{"error" in test ? (
							<span className="text-red-600 dark:text-red-400">{test.error}</span>
						) : (
							<>
								<StatusBadge status={test.status} />
								<span className="tabular-nums">{formatMs(test.latency_ms)}</span>
								{test.message && <span className="text-muted-foreground">· {test.message}</span>}
							</>
						)}
					</div>
				)}

				<div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
					{form.type !== "group" && form.type !== "heartbeat" && (
						<Button variant="outline" onClick={runTest} loading={testing} className="mr-auto">
							<Zap /> Test
						</Button>
					)}
					<Button variant="ghost" asChild>
						<Link href={editing ? `/monitors/${id}` : "/monitors"}>Cancel</Link>
					</Button>
					<Button type="submit" loading={saving}>
						{editing ? "Save changes" : "Create monitor"}
					</Button>
				</div>
			</div>
		</form>
	);
}
