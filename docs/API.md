# Richter HTTP API (as implemented)

Types live in `src/shared/types.ts`. All JSON. Errors are `{ "error": string, "field"?: string }` with a 4xx/5xx status.

## Host / public

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/whoami-host` | `HostInfo`: tells the SPA whether this host is the dashboard or a public status host |
| GET | `/api/public/page` | `PublicPage` for this host (default page, or the page mapped to this custom domain) |
| GET | `/api/public/pages/:slug` | `PublicPage` |
| GET | `/feed.atom?page=:slug` | Atom XML |
| GET | `/badge/:monitorId/status.svg` · `/uptime.svg?days=30` · `/latency.svg` | SVG |
| GET | `/embed/:monitorId?theme=dark` | HTML card |
| ANY | `/ping/:token[/start\|/fail\|/:code]` | `{ ok: true }` (heartbeat) |
| GET (ws) | `/api/beszel/agent-connect` | Beszel agent WebSocket |
| POST | `/api/pve/push` | richter-pve push (`Authorization: Bearer <system token>`, body `{ node, version?, resources, onboot }`): `{ ok, guests, created }` |
| GET | `/pve/richter-pve.sh` | The richter-pve companion script |

Public SPA routes: `/` (the default page or the custom-domain page), `/s/:slug`.

## Admin (`/api/admin`, dashboard host only, Cloudflare Access)

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/me` | | `{ email }` |
| GET | `/overview` | | `Overview` |
| GET | `/settings` | | `Settings` |
| PUT | `/settings` | `{ site_title?, timezone? }` | `Settings` |
| GET | `/systems` | | `SystemRecord[]` |
| POST | `/systems` | `{ name, tags? }` | `{ system: SystemRecord, install: SystemInstall }` |
| GET | `/systems/:id` | | `SystemRecord` |
| PATCH | `/systems/:id` | `{ name?, tags? }` | `SystemRecord` |
| DELETE | `/systems/:id` | | `{ ok }` |
| GET | `/systems/:id/install` | | `SystemInstall` |
| POST | `/systems/:id/pause` · `/resume` · `/reset-fingerprint` | | `SystemRecord` |
| POST | `/systems/:id/rotate-token` | | `SystemInstall` |
| GET | `/systems/:id/stats?range=1h\|12h\|24h\|1w\|30d` | | `StatsPoint[]` (oldest first) |
| GET | `/systems/:id/containers?range=…` | | `ContainerPoint[]` (oldest first) |
| GET | `/systems/:id/pve` | | `PveSnapshot \| null` (latest richter-pve push) |
| GET | `/systems/:id/alerts` | | `{ alerts: SystemAlert[], notification_ids: string[] }` |
| PUT | `/systems/:id/alerts` | `{ alerts: SystemAlert[], notification_ids: string[] }` | same |
| GET | `/monitors` | | `MonitorListItem[]` |
| POST | `/monitors` | `MonitorInput` | `Monitor` |
| POST | `/monitors/test` | `MonitorInput` | `CheckNowResult` (nothing saved) |
| GET | `/monitors/:id` | | `Monitor` |
| PATCH | `/monitors/:id` | `Partial<MonitorInput>` | `Monitor` |
| DELETE | `/monitors/:id` | | `{ ok }` |
| POST | `/monitors/:id/pause` · `/resume` | | `Monitor` |
| POST | `/monitors/:id/clone` | | `Monitor` |
| POST | `/monitors/:id/check-now` | | `CheckNowResult` |
| GET | `/monitors/:id/checks?hours=24` | | `CheckPoint[]` (oldest first, ≤ 7 days) |
| GET | `/monitors/:id/uptime` | | `UptimeSummary` |
| GET | `/monitors/:id/incidents` | | `Incident[]` |
| GET | `/incidents?open=1` | | `Incident[]` (newest first, with `monitor_name`) |
| GET/POST | `/notifications` | `{ name, type, config, enabled?, apply_default? }` | `NotificationChannel[]` / `NotificationChannel` |
| PATCH/DELETE | `/notifications/:id` | | `NotificationChannel` / `{ ok }` |
| POST | `/notifications/:id/test` | | `{ ok: boolean, error?: string }` |
| GET/POST | `/status-pages` | `StatusPageInput` | `StatusPage[]` / `StatusPage` |
| GET/PATCH/DELETE | `/status-pages/:id` | | `StatusPage` / `{ ok }` |
| GET/POST | `/maintenances` | `MaintenanceInput` | `Maintenance[]` / `Maintenance` |
| PATCH/DELETE | `/maintenances/:id` | | `Maintenance` / `{ ok }` |
| GET/POST | `/announcements` | `AnnouncementInput` | `Announcement[]` / `Announcement` |
| PATCH/DELETE | `/announcements/:id` | | `Announcement` / `{ ok }` |
| GET | `/events?limit=100` | | `EventRecord[]` |
| GET | `/export` | | JSON backup |
| POST | `/import` | JSON backup | `{ ok, counts }` |
| GET | `/metrics` (no `/api/admin` prefix) | | Prometheus text |
