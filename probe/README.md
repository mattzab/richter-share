# Richter TCP probe

Cloudflare Workers can't open connections to port 25, and they can't reach private networks. So when a TCP monitor has **Check via probe** turned on, Richter asks this small service to make the connection for it. The service has no dependencies and runs on Node 18 or later.

Run it on a machine that can reach the hosts you want to check. Don't run it on one of those hosts: if that machine goes down, nothing is left to report the outage.

```sh
docker build -t richter-probe probe/
docker run -d --restart unless-stopped --name richter-probe \
  -e PROBE_TOKEN="$(openssl rand -hex 32)" \
  -e PROBE_ALLOW="mail.example.com:25,10.0.0.0/8" \
  -p 127.0.0.1:8787:8787 richter-probe
```

Then publish it over HTTPS, for example with a Cloudflare Tunnel (`probe.example.com` → `http://localhost:8787`), and give Richter the URL and the token:

```sh
# richter.config.json
"probeUrl": "https://probe.example.com"

npx cf workers secrets update   # add PROBE_TOKEN with the same value as above
npx cf deploy
```

| Env var | Purpose |
| --- | --- |
| `PROBE_TOKEN` | Bearer token Richter sends. Without it the probe is open to anyone who can reach it. |
| `PROBE_ALLOW` | Optional comma-separated allow list: `host`, `host:port`, `cidr`, `cidr:port` or `*`. It stops a leaked token from turning the probe into a port scanner. |
| `PORT` | Listen port (default 8787). |

The API is `GET /tcp?host=&port=&timeout_ms=&expect=` and returns `{ ok, latency_ms, message }`. When `expect` is set (for example `220` for SMTP), the probe reads the server's first line and only reports up if that line starts with the given text. After that it sends `QUIT`. `GET /healthz` returns `{ ok: true }`.

Don't put the probe behind Cloudflare Access. If you do, Richter's requests never reach it.
