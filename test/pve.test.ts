import { describe, expect, it } from "vitest";
import { fakeD1 } from "./fake-env";
import { MIGRATIONS } from "../src/worker/db";
import type { Env } from "../src/worker/env";
import { checkGuest, discoverGuests, guestKey, normalizePvePush } from "../src/worker/beszel/pve";
import { runCheck } from "../src/worker/monitors/engine";
import type { GuestMonitorConfig, PveSnapshot } from "../src/shared/types";
import PVE_SCRIPT from "../pve/richter-pve.sh?raw";

const GiB = 1024 ** 3;
const NOW = 1_800_000_000_000;

// Shape of `pvesh get /cluster/resources --output-format json` on a two-node cluster.
const RESOURCES = [
	{ id: "node/pve02", type: "node", node: "pve02", status: "online", cpu: 0.05, maxcpu: 16, mem: 20 * GiB, maxmem: 64 * GiB },
	{ id: "lxc/212", type: "lxc", vmid: 212, name: "smtp-probe", node: "pve02", status: "running", cpu: 0.01, maxcpu: 1, mem: 0.2 * GiB, maxmem: 0.5 * GiB, disk: 1 * GiB, maxdisk: 8 * GiB, uptime: 90061, template: 0 },
	{ id: "lxc/213", type: "lxc", vmid: 213, name: "full", node: "pve02", status: "running", mem: 0.95 * GiB, maxmem: 1 * GiB, disk: 7.6 * GiB, maxdisk: 8 * GiB, uptime: 600 },
	{ id: "qemu/101", type: "qemu", vmid: 101, name: "web", node: "pve02", status: "stopped", mem: 0, maxmem: 4 * GiB, disk: 0, maxdisk: 32 * GiB, template: 0 },
	{ id: "qemu/102", type: "qemu", vmid: 102, name: "scratch", node: "pve02", status: "stopped", maxmem: 2 * GiB },
	{ id: "qemu/9000", type: "qemu", vmid: 9000, name: "debian-tpl", node: "pve02", status: "stopped", template: 1 },
	{ id: "qemu/300", type: "qemu", vmid: 300, name: "elsewhere", node: "pve01", status: "running" },
	{ id: "storage/pve02/local-zfs", type: "storage", storage: "local-zfs", node: "pve02", plugintype: "zfspool", status: "available", disk: 100 * GiB, maxdisk: 900 * GiB, shared: 0 },
];
const PUSH = { node: "pve02", version: "8.4.1", resources: RESOURCES, onboot: { "212": 1, "213": 1, "101": 1, "102": 0, "9000": 0 } };

const lxc = (vmid: number, extra: Partial<GuestMonitorConfig> = {}): GuestMonitorConfig => ({ system_id: "sys1", vmid, guest_type: "lxc", ...extra });
const vm = (vmid: number): GuestMonitorConfig => ({ system_id: "sys1", vmid, guest_type: "qemu" });

describe("normalizePvePush", () => {
	const snap = normalizePvePush(PUSH, NOW);
	it("keeps only this node's guests and storages, with onboot", () => {
		expect(snap.node).toBe("pve02");
		expect(snap.pve_version).toBe("8.4.1");
		expect(snap.guests.map((g) => g.vmid)).toEqual([101, 102, 212, 213, 9000]);
		expect(snap.guests.find((g) => g.vmid === 212)).toMatchObject({ type: "lxc", name: "smtp-probe", onboot: true, status: "running" });
		expect(snap.guests.find((g) => g.vmid === 102)?.onboot).toBe(false);
		expect(snap.guests.find((g) => g.vmid === 9000)?.template).toBe(true);
		expect(snap.storages).toEqual([{ storage: "local-zfs", node: "pve02", type: "zfspool", status: "available", disk: 100 * GiB, maxdisk: 900 * GiB, shared: false }]);
	});
	it("rejects malformed pushes", () => {
		expect(() => normalizePvePush(null)).toThrow();
		expect(() => normalizePvePush({ resources: [] })).toThrow(/node/);
		expect(() => normalizePvePush({ node: "x", resources: "nope" })).toThrow(/resources/);
	});
	it("guestKey ignores templates", () => {
		expect(guestKey(snap)).toBe("qemu:101,qemu:102,lxc:212,lxc:213");
	});
});

describe("checkGuest", () => {
	const snap = normalizePvePush(PUSH, NOW);
	it("running LXC is up with its own limits in the message", () => {
		const r = checkGuest(lxc(212), snap, NOW + 1000)!;
		expect(r.ok).toBe(true);
		expect(r.degraded).toBe(false);
		expect(r.message).toBe("running · up 1 d 1 h · mem 40% · disk 13%");
	});
	it("LXC near its memory limit or rootfs full is degraded; thresholds are per monitor", () => {
		const r = checkGuest(lxc(213), snap, NOW)!;
		expect(r).toMatchObject({ ok: true, degraded: true });
		expect(r.message).toBe("memory 95% of its 1.0 GiB limit, rootfs 95% full");
		expect(checkGuest(lxc(213, { mem_warn: 99, disk_warn: 99 }), snap, NOW)!.degraded).toBe(false);
	});
	it("stopped guest set to start on boot is down; one that isn't records nothing", () => {
		expect(checkGuest(vm(101), snap, NOW)).toMatchObject({ ok: false, message: "Stopped (set to start on boot)" });
		expect(checkGuest(vm(102), snap, NOW)).toBeNull();
	});
	it("VM disk is unknown without the guest agent, not 0%", () => {
		const s: PveSnapshot = { ...snap, guests: [{ ...snap.guests[0], status: "running", mem: 1 * GiB, uptime: 60 }] };
		expect(checkGuest(vm(101), s, NOW)!.message).toBe("running · up 0 h 1 min · mem 25%");
	});
	it("a stopped guest locked for backup is degraded, not down", () => {
		const s: PveSnapshot = { ...snap, guests: snap.guests.map((g) => (g.vmid === 101 ? { ...g, lock: "backup" } : g)) };
		expect(checkGuest(vm(101), s, NOW)).toMatchObject({ ok: true, degraded: true, message: "Stopped, locked (backup)" });
	});
	it("vanished guests and stale or missing snapshots are down", () => {
		expect(checkGuest(lxc(999), snap, NOW)).toMatchObject({ ok: false, message: "LXC 999 is no longer on pve02" });
		expect(checkGuest(lxc(212), snap, NOW + 181_000)!.ok).toBe(false);
		expect(checkGuest(lxc(212), null, NOW)!.message).toMatch(/richter-pve/);
	});
	it("runCheck routes guest monitors through the pve dependency", async () => {
		const m = { id: "m", type: "guest" as const, config: JSON.stringify(lxc(212)), timeout_ms: 10000, last_ping_at: null, run_started_at: null, created_at: NOW };
		const r = await runCheck({} as Env, m, NOW, { pve: async (id) => (id === "sys1" ? snap : null) });
		expect(r?.ok).toBe(true);
	});
});

describe("discoverGuests", () => {
	const setup = () => {
		const d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.exec("INSERT INTO notifications(id, name, type, config, enabled, apply_default, created_at) VALUES ('n1', 'ntfy', 'ntfy', '{}', 1, 1, 0), ('n2', 'other', 'ntfy', '{}', 1, 0, 0)");
		const reloads: unknown[] = [];
		const env = { DB: d1.db, HUB: { idFromName: () => "hub", get: () => ({ reload: async (o: unknown) => void reloads.push(o) }) } } as unknown as Env;
		return { d1, env, reloads };
	};
	const snap = normalizePvePush(PUSH, NOW);

	it("creates a group and one monitor per non-template guest, paused unless onboot", async () => {
		const { d1, env, reloads } = setup();
		expect(await discoverGuests(env, "sys1", "pve02", snap, NOW)).toBe(4);
		const rows = d1.sql.prepare("SELECT id, name, type, config, parent_id, paused, tags FROM monitors ORDER BY name").all() as Record<string, string | number>[];
		const group = rows.find((r) => r.type === "group")!;
		expect(group.name).toBe("pve02 guests");
		const guests = rows.filter((r) => r.type === "guest");
		expect(guests.map((r) => [r.name, r.paused])).toEqual([
			["full (LXC 213)", 0],
			["scratch (VM 102)", 1],
			["smtp-probe (LXC 212)", 0],
			["web (VM 101)", 0],
		]);
		expect(guests.every((r) => r.parent_id === group.id)).toBe(true);
		expect(JSON.parse(String(guests[2].config))).toEqual({ system_id: "sys1", vmid: 212, guest_type: "lxc" });
		expect(JSON.parse(String(guests[2].tags))).toEqual(["proxmox", "lxc", "pve02"]);
		const links = d1.sql.prepare("SELECT DISTINCT notification_id FROM monitor_notifications").all() as { notification_id: string }[];
		expect(links).toEqual([{ notification_id: "n1" }]);
		expect(reloads.length).toBe(1);
	});

	it("only adds guests that are new, under the existing group, and never touches edited monitors", async () => {
		const { d1, env } = setup();
		await discoverGuests(env, "sys1", "pve02", snap, NOW);
		d1.sql.exec("UPDATE monitors SET name = 'renamed' WHERE type = 'guest' AND json_extract(config, '$.vmid') = 212");
		expect(await discoverGuests(env, "sys1", "pve02", snap, NOW)).toBe(0);
		const more: PveSnapshot = { ...snap, guests: [...snap.guests, { ...snap.guests[2], vmid: 214, name: "new" }] };
		expect(await discoverGuests(env, "sys1", "pve02", more, NOW)).toBe(1);
		expect(d1.sql.prepare("SELECT COUNT(*) n FROM monitors WHERE type = 'group'").get()).toEqual({ n: 1 });
		expect(d1.sql.prepare("SELECT COUNT(*) n FROM monitors WHERE name = 'renamed'").get()).toEqual({ n: 1 });
	});
});

describe("richter-pve script", () => {
	it("posts to /api/pve/push with the token and reads onboot from the main config section only", () => {
		expect(PVE_SCRIPT.startsWith("#!/bin/bash")).toBe(true);
		expect(PVE_SCRIPT).toContain("/api/pve/push");
		expect(PVE_SCRIPT).toContain('Authorization: Bearer $TOKEN');
		expect(PVE_SCRIPT).toContain("pvesh get /cluster/resources --output-format json");
		expect(PVE_SCRIPT).toContain("sed -n '/^\\[/q; s/^onboot:");
	});
});
