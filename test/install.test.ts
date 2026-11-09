import { describe, expect, it } from "vitest";
import { buildInstall } from "../src/shared/install";

const HUB = "https://status.example.com";
const TOKEN = "tok-test123";
const KEY = "ssh-ed25519 AAAATESTKEY";

describe("buildInstall", () => {
	const inst = buildInstall(HUB, TOKEN, KEY);
	const cmds = ["compose", "docker_run", "binary", "brew", "windows", "freebsd", "proxmox"] as const;

	it.each(cmds)("%s configures WebSocket-only mode", (k) => {
		const c = inst[k];
		expect(c).toContain(HUB);
		expect(c).toContain(TOKEN);
		expect(c).toContain(KEY);
		expect(c).toMatch(/DISABLE_SSH[=:]\s*"?true/);
		expect(c).not.toMatch(/\bLISTEN\b/);
		expect(c).not.toMatch(/-Port\b|install-agent\S*\s+-p\s/);
	});

	it("linux command keeps the systemd drop-in and tty auto-update prompt", () => {
		const c = inst.binary;
		expect(c).toContain("/etc/systemd/system/beszel-agent.service.d/richter.conf");
		expect(c).toContain('Environment="DISABLE_SSH=true"');
		expect(c).toContain("</dev/tty");
		expect(c).toContain("--auto-update=$au");
		expect(c).toMatch(/\*\) au=true/);
	});

	it("proxmox command runs as root without sudo and installs richter-pve", () => {
		const c = inst.proxmox;
		expect(c).not.toContain("sudo");
		expect(c).toContain("/etc/systemd/system/beszel-agent.service.d/richter.conf");
		expect(c).toContain(`curl -fsSL ${HUB}/pve/richter-pve.sh -o /tmp/richter-pve.sh`);
		expect(c).toContain(`bash /tmp/richter-pve.sh install "${HUB}" "${TOKEN}"`);
		expect(c.startsWith("(set -e")).toBe(true);
		expect(c.endsWith("rm -f /tmp/richter-pve.sh)")).toBe(true);
		expect(c.match(/\)$/gm)?.length).toBe(1);
	});

	it("freebsd command runs under sh and rewrites the rc env file", () => {
		expect(inst.freebsd.startsWith("sh <<'RICHTER'")).toBe(true);
		expect(inst.freebsd).toContain("/usr/local/etc/beszel-agent/env");
		expect(inst.freebsd).toContain("fetch -qo");
	});

	it("brew and windows enforce DISABLE_SSH after upstream install", () => {
		expect(inst.brew).toContain("beszel-agent.env");
		expect(inst.brew).toContain("brew services restart beszel-agent");
		expect(inst.windows).toContain("AppEnvironmentExtra '+DISABLE_SSH=true'");
		expect(inst.windows).toContain("Administrator");
	});
});
