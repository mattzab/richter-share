import type { GuestMonitorConfig, GuestType, PveGuest, PveSnapshot, PveStorage } from "../../shared/types";
import { addEvent, newId, parseJson } from "../db";
import type { Env } from "../env";
import { hubReload } from "../hub-client";
import type { CheckResult } from "../monitors/checks";

/**
 * Proxmox VE guest discovery. The stock beszel-agent only sees the machine it runs on (plus
 * Docker/Podman), so a Proxmox host also runs the small richter-pve companion (see
 * src/shared/pve-script.ts). Every minute it POSTs the host's `pvesh get /cluster/resources`
 * and each local guest's onboot flag to /api/pve/push, authenticated with the system's agent
 * token. The latest snapshot lives in the system's AgentConnection Durable Object, and every
 * guest gets a "guest" monitor, created automatically under a per-host group.
 */

export const PVE_STALE_MS = 180_000; // no push for 3 minutes: the guest monitors go Down
export const MAX_PUSH_BYTES = 512 * 1024;
const DEFAULT_WARN = 90;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v.slice(0, 200) : undefined);

/**
 * Validate and trim a richter-pve push: `{ node, version?, resources: [...], onboot: { "<vmid>": 0|1 } }`.
 * Only this node's guests and storages are kept (in a cluster every node pushes its own).
 */
export function normalizePvePush(body: unknown, now = Date.now()): PveSnapshot {
	if (!body || typeof body !== "object") throw new Error("body must be a JSON object");
	const b = body as Record<string, unknown>;
	const node = str(b.node);
	if (!node) throw new Error("node is required");
	if (!Array.isArray(b.resources)) throw new Error("resources must be an array");
	const onboot = (b.onboot && typeof b.onboot === "object" ? b.onboot : {}) as Record<string, unknown>;
	const guests: PveGuest[] = [];
	const storages: PveStorage[] = [];
	for (const raw of b.resources as unknown[]) {
		if (!raw || typeof raw !== "object") continue;
		const r = raw as Record<string, unknown>;
		if (r.node !== node) continue;
		if (r.type === "lxc" || r.type === "qemu") {
			const vmid = num(r.vmid);
			if (vmid == null) continue;
			guests.push({
				vmid,
				type: r.type as GuestType,
				name: str(r.name) ?? `${r.type === "lxc" ? "CT" : "VM"} ${vmid}`,
				node,
				status: str(r.status) ?? "unknown",
				onboot: Number(onboot[String(vmid)] ?? 0) === 1,
				template: Number(r.template ?? 0) === 1,
				lock: str(r.lock),
				hastate: str(r.hastate),
				cpu: num(r.cpu),
				maxcpu: num(r.maxcpu),
				mem: num(r.mem),
				maxmem: num(r.maxmem),
				disk: num(r.disk),
				maxdisk: num(r.maxdisk),
				uptime: num(r.uptime),
			});
		} else if (r.type === "storage") {
			const storage = str(r.storage);
			if (!storage) continue;
			storages.push({ storage, node, type: str(r.plugintype), status: str(r.status), disk: num(r.disk), maxdisk: num(r.maxdisk), shared: Number(r.shared ?? 0) === 1 });
		}
	}
	guests.sort((a, b) => a.vmid - b.vmid);
	return { at: now, node, pve_version: str(b.version), guests, storages };
}

const label = (t: GuestType) => (t === "lxc" ? "LXC" : "VM");
export const guestMonitorName = (g: Pick<PveGuest, "name" | "type" | "vmid">) => `${g.name} (${label(g.type)} ${g.vmid})`.slice(0, 100);
const pct = (used?: number, max?: number) => (used != null && max ? (used / max) * 100 : null);

function uptimeText(s?: number): string | null {
	if (!s) return null;
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	return d ? `up ${d} d ${h} h` : `up ${h} h ${Math.floor((s % 3600) / 60)} min`;
}

/**
 * One guest monitor check. LXC and VM are judged differently: an LXC's memory and rootfs are its
 * own cgroup/volume limits, so both are checked; a VM's disk is only known with the QEMU guest
 * agent (Proxmox reports 0 otherwise), and its memory is the host's view of the guest.
 * Returns null for a stopped guest that is not set to start on boot (nothing to record).
 */
export function checkGuest(cfg: GuestMonitorConfig, snap: PveSnapshot | null, now = Date.now()): CheckResult | null {
	if (!snap || now - snap.at > PVE_STALE_MS) return { ok: false, latency_ms: null, message: "No recent Proxmox data from the host (is richter-pve running?)" };
	const g = snap.guests.find((x) => x.vmid === cfg.vmid);
	const what = `${label(cfg.guest_type)} ${cfg.vmid}`;
	if (!g) return { ok: false, latency_ms: null, message: `${what} is no longer on ${snap.node}` };
	const lock = g.lock ? `locked (${g.lock})` : null;
	if (g.status === "running") {
		const parts = ["running", uptimeText(g.uptime)];
		const warns: string[] = [];
		const mem = pct(g.mem, g.maxmem);
		const memWarn = cfg.mem_warn ?? DEFAULT_WARN;
		if (mem != null) {
			parts.push(`mem ${mem.toFixed(0)}%`);
			if (mem >= memWarn) warns.push(`memory ${mem.toFixed(0)}% of its ${fmtBytes(g.maxmem!)} limit`);
		}
		// Proxmox reports disk = 0 for VMs without the guest agent: unknown, not empty.
		const disk = g.type === "qemu" && !g.disk ? null : pct(g.disk, g.maxdisk);
		const diskWarn = cfg.disk_warn ?? DEFAULT_WARN;
		if (disk != null) {
			parts.push(`disk ${disk.toFixed(0)}%`);
			if (disk >= diskWarn) warns.push(`${g.type === "lxc" ? "rootfs" : "disk"} ${disk.toFixed(0)}% full`);
		}
		if (lock) parts.push(lock);
		const message = warns.length ? warns.join(", ") : parts.filter(Boolean).join(" · ");
		return { ok: true, degraded: warns.length > 0, latency_ms: null, message };
	}
	if (g.status === "paused") return { ok: false, latency_ms: null, message: `Paused${lock ? `, ${lock}` : ""}` };
	if (!g.onboot) return null;
	if (lock) return { ok: true, degraded: true, latency_ms: null, message: `Stopped, ${lock}` };
	return { ok: false, latency_ms: null, message: `${g.status === "stopped" ? "Stopped" : `Status ${g.status}`} (set to start on boot)` };
}

function fmtBytes(b: number): string {
	const gib = b / 1024 ** 3;
	return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB` : `${Math.round(b / 1024 ** 2)} MiB`;
}

/** Ids of the guests that should have monitors (templates are skipped), as a stable key. */
export const guestKey = (snap: PveSnapshot) =>
	snap.guests
		.filter((g) => !g.template)
		.map((g) => `${g.type}:${g.vmid}`)
		.join(",");

/**
 * Create the per-host group and a monitor for every guest that doesn't have one yet. Existing
 * monitors are never renamed, deleted or reconfigured, so edits in the dashboard stick; a guest
 * that disappears keeps its monitor, which then reports Down ("no longer on <node>").
 * Guests not set to start on boot are created paused. Returns the number of monitors created.
 */
export async function discoverGuests(env: Env, systemId: string, systemName: string, snap: PveSnapshot, now = Date.now()): Promise<number> {
	const db = env.DB;
	const [existing, groups] = await db.batch([
		db.prepare("SELECT id, config FROM monitors WHERE type = 'guest' AND json_extract(config, '$.system_id') = ?").bind(systemId),
		db.prepare("SELECT id FROM monitors WHERE type = 'group' AND json_extract(config, '$.pve_system_id') = ?").bind(systemId),
	]);
	const have = new Set((existing.results as { config: string }[]).map((r) => parseJson<Partial<GuestMonitorConfig>>(r.config, {}).vmid));
	const missing = snap.guests.filter((g) => !g.template && !have.has(g.vmid));
	if (!missing.length) return 0;

	const stmts: D1PreparedStatement[] = [];
	const addDefaults = (id: string) => db.prepare("INSERT INTO monitor_notifications(monitor_id, notification_id) SELECT ?, id FROM notifications WHERE apply_default = 1").bind(id);
	const insert = (id: string, name: string, type: string, config: object, parent: string | null, paused: boolean, description: string, tags: string[]) =>
		db
			.prepare(
				`INSERT INTO monitors(id, name, type, config, parent_id, interval_s, retries, retry_interval_s, timeout_ms, paused, description, tags, next_check_at, created_at)
				 VALUES (?, ?, ?, ?, ?, 60, 1, 60, 10000, ?, ?, ?, ?, ?)`,
			)
			.bind(id, name, type, JSON.stringify(config), parent, paused ? 1 : 0, description, JSON.stringify(tags), now, now);

	let groupId = (groups.results[0] as { id: string } | undefined)?.id ?? null;
	if (!groupId) {
		groupId = newId();
		stmts.push(insert(groupId, `${systemName} guests`.slice(0, 100), "group", { pve_system_id: systemId }, null, false, `Proxmox guests on ${snap.node}, discovered by richter-pve.`, ["proxmox", snap.node]), addDefaults(groupId));
	}
	for (const g of missing) {
		const id = newId();
		const cfg: GuestMonitorConfig = { system_id: systemId, vmid: g.vmid, guest_type: g.type };
		const desc = g.onboot ? `Proxmox ${label(g.type)} on ${snap.node}, discovered by richter-pve.` : `Proxmox ${label(g.type)} on ${snap.node}, discovered by richter-pve. Created paused because it is not set to start on boot.`;
		stmts.push(insert(id, guestMonitorName(g), "guest", cfg, groupId, !g.onboot, desc, ["proxmox", g.type === "lxc" ? "lxc" : "vm", snap.node]), addDefaults(id));
	}
	await db.batch(stmts);
	await addEvent(db, "monitor_added", groupId, `${systemName}: discovered ${missing.length} Proxmox guest${missing.length === 1 ? "" : "s"} (${missing.map((g) => g.vmid).join(", ")})`);
	await hubReload(env);
	return missing.length;
}
