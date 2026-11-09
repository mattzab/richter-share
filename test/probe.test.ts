import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTcpViaProbe } from "../src/worker/monitors/checks";

afterEach(() => vi.unstubAllGlobals());

describe("TCP checks via the external probe", () => {
	it("fails clearly when no probe is configured", async () => {
		const r = await checkTcpViaProbe({ host: "mail.example.com", port: 25, via_probe: true }, 5000, "", undefined);
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/No probe configured/);
	});

	it("passes host, port, banner and token to the probe and relays its answer", async () => {
		const fetchMock = vi.fn(async () => Response.json({ ok: true, latency_ms: 42, message: "220 mail ESMTP" }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await checkTcpViaProbe({ host: "mail.example.com", port: 25, via_probe: true, expect_banner: "220" }, 5000, "https://probe.example.com", "s3cret");
		expect(r).toMatchObject({ ok: true, latency_ms: 42 });
		expect(r.message).toBe("220 mail ESMTP (via probe)");
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.toString()).toBe("https://probe.example.com/tcp?host=mail.example.com&port=25&timeout_ms=5000&expect=220");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
	});

	it("treats a probe error status as down", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
		const r = await checkTcpViaProbe({ host: "h", port: 25 }, 5000, "https://probe.example.com", "bad");
		expect(r).toMatchObject({ ok: false, latency_ms: null, message: "Probe HTTP 401" });
	});

	it("never reports latency for a failed check", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, latency_ms: 10, message: "ECONNREFUSED" })));
		const r = await checkTcpViaProbe({ host: "h", port: 25 }, 5000, "https://probe.example.com", undefined);
		expect(r).toMatchObject({ ok: false, latency_ms: null, message: "ECONNREFUSED (via probe)" });
	});
});
