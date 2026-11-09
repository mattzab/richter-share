# Richter: design decisions

This file explains why the spec in `PROMPT.md` looks the way it does. It is not part of the prompt.

## Auth: Cloudflare Access instead of bknd

| | Cloudflare Access | bknd |
| --- | --- | --- |
| Code to write and secure | none: the edge blocks requests before the Worker runs | login, sessions, password reset, rate limiting |
| Login methods | email OTP, GitHub, Google, passkeys, and more, set in the dashboard | email/password plus OAuth you wire up |
| Cost | free up to 50 users | free, but it is another dependency in the Worker |
| Failure mode | an auth bug can't expose metrics, because Access fails closed | an app bug can expose everything |
| Public pages | a separate hostname, never behind Access | route-level checks in code |

The Worker still verifies the `Cf-Access-Jwt-Assertion` JWT, so a misconfigured Access policy can't silently open the admin API.

## Beszel: WebSocket mode only

The Beszel hub reaches agents in two ways:

1. **SSH:** the hub dials the agent on port 45876.
2. **WebSocket** (agent 0.12+): the agent dials `HUB_URL/api/beszel/agent-connect`.

A Worker can't keep a pool of SSH client connections. A Durable Object can hold an inbound WebSocket and hibernate between messages, so Richter supports WebSocket mode only. The agent is unmodified.

Protocol facts confirmed against `henrygd/beszel` at commit `5750cea` (v0.21.1):

- Frames are binary CBOR with integer map keys.
- The hub proves its identity by sending the agent's own token signed with Ed25519. The signature is the raw 64 bytes, and `KEY` is the matching `ssh-ed25519` public key.
- The agent binds to the system through a fingerprint returned in the handshake.
- The hub polls `GetData` every 60 s with `CacheTimeMs = 60000`.
- Rollup tiers are 1m/10m/20m/120m/480m, kept for 1h/12h/24h/7d/30d.

**Verified on 2026-10-29:** the stock `henrygd/beszel-agent:latest` (0.21.1) connected to the Richter Durable Object, passed the signature check, bound its fingerprint, and streamed CPU, memory, disk, temperatures, per-core CPU, network interfaces, and Docker containers.

## Proxmox guests: a companion script, not a forked agent

The stock beszel-agent sees only the machine it runs on, plus Docker/Podman containers. It has no Proxmox integration, so on a Proxmox VE host it never lists LXC containers or VMs. Richter gets them from `richter-pve` (`pve/richter-pve.sh`), a small script that a systemd timer runs every minute on each node. It reads `pvesh get /cluster/resources` and each guest's `onboot` flag, then POSTs them to `/api/pve/push`, authenticated with the system's agent token. Richter keeps the latest snapshot in the system's Durable Object and creates one `guest` monitor per guest under a per-host group.

Hypervisors, VMs and LXC containers get different checks because each has a different source of truth:

| | Where the data comes from | What Richter checks |
| --- | --- | --- |
| Proxmox host | beszel-agent on the host (temps, real disks, ZFS ARC) | the usual system alerts |
| LXC container | the host, through richter-pve | running if set to start on boot; memory against its own limit; rootfs usage |
| VM | the host, through richter-pve; optionally an agent inside the VM | running if set to start on boot; memory as the host sees it; disk only with the QEMU guest agent, because Proxmox reports 0 without it |

An agent inside an LXC container is usually redundant. It reports the host's kernel and temperatures, and the host's memory unless `USE_CGROUP=true` is set. Install one only in a container that runs Docker or systemd services worth watching.

**Why not fork beszel-agent?** A fork that collects guests and sends them over the existing WebSocket would be one install instead of two. It was turned down for these reasons:

- **Upkeep.** Beszel releases often (0.18 to 0.21 in a few months). Every release would have to be rebased and rebuilt.
- **Auto-update.** The agent's daily auto-update installs the upstream binary and would silently replace the fork. Keeping the fork would mean running our own release channel or turning auto-update off on every host.
- **Compatibility.** Richter is built as a hub for the unmodified agent (see above). A fork breaks that promise for the hosts that matter most.
- **Size.** The companion is about 80 lines of bash with no build step. It reads Proxmox state as root through Proxmox's own CLI and changes nothing on the host.

The Richter side does not depend on the script. `AgentConnection.pveIngest` takes a normalized snapshot, so guest data from a future agent, whether a fork or an upstream Proxmox feature, can feed the same monitors over the WebSocket, and the script can then be retired.

## Uptime Kuma features worth taking

These are Kuma's most-used features that neither FlareWatch nor Beszel already covers, ranked by value for effort:

1. **Multiple status pages with custom domains.** FlareWatch has one page.
2. **Retries and a retry interval before alerting.** Fewer false alarms.
3. **Upside-down mode.** Alerts when something *is* reachable, e.g. a port that should be closed.
4. **Per-monitor notification routing, plus "default" channels applied to new monitors.**
5. **Monitor groups.** A group's status is the worst status of its children; groups also nest on the status page.
6. **Tags with colors** for filtering.
7. **Resend notification every N failed checks.** A "still down" reminder.
8. **Pinned incident posts and maintenance on status pages.** This overlaps with FlareWatch announcements.
9. **Prometheus `/metrics`.**
10. **Push monitors compatible with `?status=up&msg=&ping=`.** Kuma's push URLs work with Richter.
11. **Clone and pause/resume a monitor.**
12. **Container monitor.** Kuma needs a Docker socket for this; Richter gets it free from the Beszel agent's container list.

Skipped because Workers can't do them: ICMP ping; game-server, MQTT, and database protocol monitors; Kuma's own TLS-expiry check (a Worker can't read the peer certificate, so it would need an external probe, as in FlareWatch). Port 25 is also blocked.

## Hostnames

- `richter.example.com`: the dashboard behind Access.
- `status.example.com`: public status pages, heartbeat `/ping/*`, and the Beszel agent WebSocket.

Agents and pings stay off the Access host so they never need service tokens.

## Known limits of the Free plan

- Each cron invocation gets **50 subrequests**. The scheduler budgets 40 for checks and defers the rest to the next minute. On the Paid plan, raise `SUBREQUEST_BUDGET`.
- D1 Free allows 5 M row reads/day and 100 k rows written/day, and index updates count as writes. Each check writes about 3 rows plus index entries; each agent poll writes 2–3. That covers roughly 10–15 one-minute monitors plus a few agents. Workers Paid ($5/mo) includes 50 M rows written/month.
- **Same-zone checks:** a Worker's `fetch()` to a hostname in its *own* zone goes straight to the origin. Checks against `*.example.com` sites therefore skip Cloudflare's proxy.
