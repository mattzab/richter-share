// Richter TCP probe: a tiny HTTP service that opens TCP connections on Richter's behalf.
// Cloudflare Workers can't connect to port 25 or reach private networks, so a TCP monitor with
// "Check via probe" calls GET /tcp?host=&port=&timeout_ms=&expect= here instead.
// No dependencies. Node 18+. Put it behind HTTPS (Cloudflare Tunnel or a reverse proxy).
import { createServer } from "node:http";
import { connect } from "node:net";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.PROBE_TOKEN || "";
// Optional allow-list so a leaked token can't turn the probe into a port scanner: "mail.example.com:25,10.0.0.0/8"
const ALLOW = (process.env.PROBE_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!TOKEN) console.warn("[probe] PROBE_TOKEN is not set: anyone who can reach this port can use the probe.");

const authorized = (req) => {
	if (!TOKEN) return true;
	const got = Buffer.from(String(req.headers.authorization || ""));
	const want = Buffer.from(`Bearer ${TOKEN}`);
	return got.length === want.length && timingSafeEqual(got, want);
};

const ipv4 = (s) => /^\d+\.\d+\.\d+\.\d+$/.test(s) && s.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const allowed = (host, port) =>
	!ALLOW.length ||
	ALLOW.some((rule) => {
		const [h, p] = rule.includes(":") ? rule.split(":") : [rule, ""];
		if (p && Number(p) !== port) return false;
		if (h.includes("/")) {
			const [net, bits] = h.split("/");
			const a = ipv4(host), b = ipv4(net), mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
			return a !== false && b !== false && (a & mask) === (b & mask);
		}
		return h === "*" || h.toLowerCase() === host.toLowerCase();
	});

function probe(host, port, timeoutMs, expect) {
	return new Promise((resolve) => {
		const start = Date.now();
		let connectedAt = 0, banner = "", done = false;
		const sock = connect({ host, port });
		const finish = (r) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (connectedAt && !sock.destroyed && expect) sock.write("QUIT\r\n");
			sock.destroy();
			resolve(r);
		};
		const timer = setTimeout(
			() => finish(connectedAt && expect ? { ok: false, latency_ms: null, message: `No banner within ${timeoutMs} ms` } : { ok: false, latency_ms: null, message: `Timeout after ${timeoutMs} ms` }),
			timeoutMs,
		);
		sock.on("connect", () => {
			connectedAt = Date.now();
			if (!expect) finish({ ok: true, latency_ms: connectedAt - start, message: `Connected to ${host}:${port}` });
		});
		sock.on("data", (d) => {
			banner += d.toString("utf8");
			const nl = banner.indexOf("\n");
			if (nl === -1 && banner.length < 512) return;
			const line = banner.slice(0, nl === -1 ? 512 : nl).trim();
			finish(
				line.startsWith(expect)
					? { ok: true, latency_ms: Date.now() - start, message: line.slice(0, 120) }
					: { ok: false, latency_ms: null, message: `Unexpected banner: ${line.slice(0, 120)}` },
			);
		});
		sock.on("error", (e) => finish({ ok: false, latency_ms: null, message: e.code || e.message }));
		sock.on("close", () => finish({ ok: false, latency_ms: null, message: "Connection closed before banner" }));
	});
}

const send = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
	const url = new URL(req.url, "http://probe");
	if (url.pathname === "/healthz") return send(res, 200, { ok: true });
	if (url.pathname !== "/tcp" || req.method !== "GET") return send(res, 404, { error: "Not found" });
	if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });
	const host = url.searchParams.get("host") || "";
	const port = Number(url.searchParams.get("port"));
	const timeoutMs = Math.min(Math.max(Number(url.searchParams.get("timeout_ms")) || 10000, 1000), 30000);
	const expect = url.searchParams.get("expect") || "";
	if (!host || !(port > 0 && port < 65536)) return send(res, 400, { error: "host and port are required" });
	if (!allowed(host, port)) return send(res, 403, { error: `${host}:${port} is not in PROBE_ALLOW` });
	send(res, 200, await probe(host, port, timeoutMs, expect));
}).listen(PORT, () => console.log(`[probe] listening on :${PORT}`));
