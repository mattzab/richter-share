<img src="public/favicon.svg" width="64" height="64" alt="">

# Richter

A serverless uptime and infrastructure monitor for self-hosted gear that runs entirely on Cloudflare (Workers, Durable Objects, D1 and Cron). No server of its own to keep up.

- **Server metrics, Beszel-compatible.** Richter is a drop-in hub for the stock [`henrygd/beszel-agent`](https://github.com/henrygd/beszel): CPU, memory, disk, network, temperatures, Docker containers, systemd services and (with an agent that reports them) pending package and security updates.
- **Uptime checks.** HTTP(S) with keyword or JSON-path matching, TCP, DNS, domain expiry (RDAP), heartbeat/push monitors (cron jobs, backups), container monitors, auto-discovered Proxmox VE guests (LXC and VMs), and groups. Retries, upside-down mode, latency limits, tags, pause/clone.
- **Public status pages.** As many as you like, each with its own slug or custom domain, groups, 90-day uptime bars, sparklines, incidents, maintenance windows and announcements, an Atom feed, badges, embeds and link previews. Per item you can hide the link to a site so its address never appears publicly.
- **Alerts.** Discord, Slack, Telegram, ntfy, Gotify, Pushover and generic webhooks, with per-monitor routing, "still down" reminders and a send log.
- **Dashboard behind Cloudflare Access**, with optional extra users (Full or Read-only) managed from Settings.
- **Prometheus `/metrics`** and an HTTP API ([`docs/API.md`](docs/API.md)).

Design notes live in [`docs/DECISIONS.md`](docs/DECISIONS.md); the original build spec is [`PROMPT.md`](PROMPT.md).

## Cloudflare free plan

Richter is built to sit comfortably inside the Workers Free plan for a homelab (a handful of servers and a few dozen monitors):

- One cron trigger (every minute) fans out the checks; Durable Objects hold live state so D1 sees few writes (hourly check buckets, daily rollups, sparse heartbeat history).
- Agents connect over a hibernating WebSocket to a SQLite-backed Durable Object and are polled every 60 s.
- Public pages are edge-cached.
- Watch **Workers requests**, **Durable Object requests/duration** and **D1 rows written** in the Cloudflare dashboard as you add systems. `SUBREQUEST_BUDGET` (default 40) caps outbound checks per cron run so you stay under the free plan's 50-subrequest limit.

Workers can't do ICMP ping, raw TLS-expiry checks or port 25; see `docs/DECISIONS.md`.

## Requirements

- A Cloudflare account with a zone (domain) you control, for two hostnames, for example `richter.example.com` (dashboard) and `status.example.com` (public pages, pings, agents).
- Cloudflare Zero Trust (free up to 50 users) for Access.
- Node.js (current LTS) and npm.

## Setup

1. **Install and log in**

   ```sh
   npm install
   npx cf auth login        # or export CLOUDFLARE_API_TOKEN=...
   ```

2. **Protect the dashboard with Cloudflare Access.** In Zero Trust → Access → Applications, add a *self-hosted* application for your dashboard hostname only (not the status hostname). Add an Allow policy for your own email. Note:
   - the application's **AUD tag** (Overview tab),
   - the application **ID** (optional, only needed for Settings → Access, see step 5),
   - your team domain, `<team>.cloudflareaccess.com`.

3. **Configure.** Copy the example config and fill it in. `richter.config.json` is gitignored, so your domains and ids never get committed.

   ```sh
   cp richter.config.example.json richter.config.json
   ```

   Every key can also come from an environment variable (handy in CI); see [Configuration](#configuration).

4. **Deploy.**

   ```sh
   npx cf deploy --dry-run   # check the bindings and hostnames it prints
   npx cf deploy
   ```

   The first deploy creates the `richter-db` D1 database and the Durable Objects and attaches both hostnames as Worker custom domains. Within a few minutes the first cron run creates the schema, the hub's signing key and a few example monitors (delete them whenever you like).

5. **Optional: let others sign in.** Settings → Access can add people as Full or Read-only. It keeps a separate Access policy, `Richter users (managed)`, in sync and never touches your own policy. It needs `accessAppId` in the config plus a Worker secret holding an API token scoped to **Account → Access: Apps and Policies → Edit**:

   Add it in the Cloudflare dashboard (Workers → richter → Settings → Variables and Secrets) or with `npx cf workers secrets update` (see `--help`).

   Without it, only the policies you set up in Zero Trust decide who gets in.

## Add a server

In the dashboard, open **Systems → Add system** and run the install command it shows (Linux, macOS/Homebrew, Windows, FreeBSD or Docker). The agent connects out to `wss://<publicHost>/api/beszel/agent-connect` with the `HUB_URL`, `TOKEN` and `KEY` it is given, so you don't need to open any ports. WebSocket mode only; Beszel's SSH mode isn't supported.

## Proxmox VE hosts

The stock agent sees only the machine it runs on, so on a Proxmox VE node pick **Proxmox VE node** in the install dialog and paste it into a root shell on the host. It installs the Linux agent for the host itself, plus `richter-pve`, a systemd timer that pushes the node's LXC containers and VMs (`pvesh get /cluster/resources` and each guest's `onboot`) to `https://<publicHost>/api/pve/push` every minute, authenticated with the system's token.

Richter then creates a **Proxmox guest** monitor for every guest, under a "<system> guests" group, and shows a Guests table (plus storage usage) on the system page:

- **LXC:** Down when stopped while set to start on boot; Degraded when memory or rootfs passes 90% of the container's own limit.
- **VM:** Down when stopped while set to start on boot; Degraded on memory. Disk usage is only checked when the QEMU guest agent is running, because Proxmox reports 0 without it.
- Guests that aren't set to start on boot are created paused. Templates are skipped. A guest that disappears keeps its monitor, which goes Down ("no longer on <node>"). Renames and threshold edits you make in the dashboard are kept.

Rotating the system's token also stops the companion: re-run the install command afterwards. Remove the companion with `richter-pve uninstall`. Why this is a companion script and not a forked agent is explained in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Heartbeats

Create a **Heartbeat** monitor and have your job call its ping URL, `https://<publicHost>/ping/<token>` (`/start`, `/fail` or `/<exit code>` suffixes work too, as does Uptime Kuma's `?status=up&msg=&ping=`). Treat the token like a password.

## Configuration

`cloudflare.config.ts` reads `richter.config.json`; a `RICHTER_*` environment variable overrides each key.

| Key | Env var | Worker var | Purpose |
| --- | --- | --- | --- |
| `accountId` | `RICHTER_ACCOUNT_ID` | `CF_ACCOUNT_ID` | Cloudflare account to deploy to |
| `dashboardHost` | `RICHTER_DASHBOARD_HOST` | `DASHBOARD_HOST` | Dashboard hostname (behind Access) |
| `publicHost` | `RICHTER_PUBLIC_HOST` | `PUBLIC_HOST` | Status pages, pings and agent WebSocket (public) |
| `accessTeamDomain` | `RICHTER_ACCESS_TEAM_DOMAIN` | `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com` |
| `accessAud` | `RICHTER_ACCESS_AUD` | `ACCESS_AUD` | AUD tag of the dashboard Access app (not secret) |
| `ownerEmail` | `RICHTER_OWNER_EMAIL` | `OWNER_EMAIL` | Always has Full access; can't be removed or demoted |
| `accessAppId` | `RICHTER_ACCESS_APP_ID` | `ACCESS_APP_ID` | Optional, for Settings → Access |
| `subrequestBudget` | `RICHTER_SUBREQUEST_BUDGET` | `SUBREQUEST_BUDGET` | Max outbound checks per cron run (default 40) |

Secrets (Worker secrets, never in the config):

| Secret | Purpose |
| --- | --- |
| `CF_ACCESS_API_TOKEN` | Optional. Access: Apps and Policies Edit, for managing dashboard users |

Notification channel credentials (webhook URLs, bot tokens) are entered in the dashboard and stored in D1; Read-only users never see them.

## Develop

```sh
npx cf dev     # http://localhost:5173 (localhost skips Access and signs you in as dev@localhost)
npm test       # protocol, state machine and helper tests
npm run typecheck
VITE_MOCK=1 npx vite --config vite.mock.config.ts --port 5199   # UI against mock data
```

Trigger the cron locally:

```sh
curl -X POST 'localhost:5173/cdn-cgi/local/explorer/api/local/scheduled?worker=richter' -d '{"cron":"* * * * *"}'
```

`cf dev` works without `richter.config.json` (it uses `example.com` placeholders). For local secrets, copy `.dev.vars.example` to `.dev.vars`.

## Credits

- Originally created as Richter by jdustinlewis (commits by lightsong).
- The Beszel agent protocol and the SystemdFailed alert follow [henrygd/beszel](https://github.com/henrygd/beszel) (MIT). Richter is not affiliated with Beszel.
- Ideas borrowed from [Uptime Kuma](https://github.com/louislam/uptime-kuma) and FlareWatch.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
