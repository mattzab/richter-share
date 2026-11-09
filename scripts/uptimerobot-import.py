#!/usr/bin/env python3
"""Convert Uptime Robot monitors into a Richter backup file for Settings -> Import.

  python3 scripts/uptimerobot-import.py --api-key "$UPTIMEROBOT_API_KEY"   # read-only key is enough
  python3 scripts/uptimerobot-import.py --input getMonitors.json            # saved API response

Optional: --ntfy-topic richter [--ntfy-server https://ntfy.example.com] adds an ntfy channel and
attaches every imported monitor to it. An ntfy access token is read from $NTFY_TOKEN, never argv.

Writes richter-import.json and migration-report.md (a table of how each monitor was mapped).
Import only adds or replaces rows by id; it never deletes existing Richter monitors.

Mapping notes:
- HTTP(S) and keyword monitors -> http (GET, 2xx/3xx plus any extra "up" codes, follow redirects).
- Port monitors -> tcp. Port 25 is blocked from Workers: with --probe those run through the TCP
  probe (probe/) and expect an SMTP "220" banner; without it they are imported paused.
- Ping (ICMP) can't run on Workers -> tcp :443, imported paused for review.
- Heartbeat monitors -> heartbeat with a NEW ping URL; repoint the jobs (see the report).
- HTTP basic-auth credentials are not carried over.
"""
import argparse, json, os, secrets, string, sys, time, urllib.parse, urllib.request

ALNUM = string.ascii_letters + string.digits
ID_ALPHA = string.ascii_lowercase + string.digits
PORT_SUBTYPES = {1: 80, 2: 443, 3: 21, 4: 25, 5: 110, 6: 143}
PROBE = False  # set by --probe
TYPE_NAMES = {1: "HTTP", 2: "Keyword", 3: "Ping", 4: "Port", 5: "Heartbeat"}


def rid(prefix):
    return prefix + "".join(secrets.choice(ID_ALPHA) for _ in range(15 - len(prefix)))


def fetch(api_key):
    out, offset = [], 0
    while True:
        data = urllib.parse.urlencode({"api_key": api_key, "format": "json", "limit": 50, "offset": offset,
                                       "custom_http_headers": 1, "custom_http_statuses": 1,
                                       "http_request_details": "true"}).encode()
        req = urllib.request.Request("https://api.uptimerobot.com/v2/getMonitors", data=data,
                                     headers={"content-type": "application/x-www-form-urlencoded"})
        body = json.load(urllib.request.urlopen(req, timeout=30))
        if body.get("stat") != "ok":
            sys.exit(f"Uptime Robot API error: {body.get('error')}")
        out += body["monitors"]
        offset += 50
        if offset >= body["pagination"]["total"]:
            return {"monitors": out}


def accepted_codes(m):
    raw = m.get("custom_http_statuses") or ""
    if isinstance(raw, dict):  # {"up": [...], "down": [...]}
        extra = [str(c) for c in raw.get("up", []) if not 200 <= int(c) <= 399]
    else:  # "404:1_500:0" (1 = up, 0 = down)
        extra = [p.split(":")[0] for p in str(raw).split("_") if p.endswith(":1")]
    return ["200-399"] + extra


def host_of(url):
    return url.split("://")[-1].split("/")[0].split(":")[0]


def convert(m, now):
    t, url = m.get("type"), (m.get("url") or "").strip()
    interval = max(60, min(86400, int(m.get("interval") or 300)))
    timeout_ms = max(1000, min(30000, int(m.get("timeout") or 30) * 1000))
    notes, push, paused = [], None, m.get("status") == 0
    if t in (1, 2):
        mtype = "http"
        cfg = {"url": url, "method": "GET", "accepted_codes": accepted_codes(m), "follow_redirects": True}
        if m.get("custom_http_headers"):
            cfg["headers"] = m["custom_http_headers"]
        if m.get("http_username"):
            notes.append("Basic-auth credentials not migrated; add an Authorization header.")
        if t == 2:
            cfg["keyword"] = m.get("keyword_value") or ""
            # UR keyword_type 1 = alert when keyword exists, 2 = alert when it doesn't
            cfg["invert_keyword"] = m.get("keyword_type") == 1
            if m.get("keyword_case_type") == 0:
                notes.append("UR keyword was case-insensitive; Richter matches case-sensitively.")
    elif t == 4:
        port = int(m.get("port") or PORT_SUBTYPES.get(m.get("sub_type"), 0) or 0)
        mtype, cfg = "tcp", {"host": host_of(url), "port": port}
        if port == 25 and PROBE:
            cfg.update(via_probe=True, expect_banner="220")
            notes.append("Port 25: checked via the TCP probe (SMTP banner 220).")
        elif port == 25:
            paused = True
            notes.append("Port 25 is blocked from Workers; imported paused (rerun with --probe once probe/ is set up).")
    elif t == 3:
        mtype, cfg, paused = "tcp", {"host": host_of(url), "port": 443}, True
        notes.append("ICMP ping isn't possible on Workers; converted to TCP 443 and imported paused.")
    elif t == 5:
        mtype, cfg = "heartbeat", {"period_s": interval, "grace_s": max(60, interval // 2)}
        push = "".join(secrets.choice(ALNUM) for _ in range(32))
        notes.append(f"New ping URL https://<publicHost>/ping/{push} (was {url}).")
    else:
        return None, f"Unsupported Uptime Robot type {t}; skipped."
    row = {"id": rid("ur"), "name": m["friendly_name"][:100], "type": mtype, "config": json.dumps(cfg),
           "parent_id": None, "interval_s": interval, "retries": 1, "retry_interval_s": 60,
           "timeout_ms": timeout_ms, "max_latency_ms": None, "upside_down": 0, "resend_every": 0,
           "paused": int(paused), "description": f"Migrated from Uptime Robot monitor {m.get('id')}",
           "tags": json.dumps(["uptimerobot"]), "status": "pending", "fail_streak": 0, "down_checks": 0,
           "next_check_at": now, "push_token": push, "sort": 0, "created_at": now}
    return row, " ".join(notes)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--api-key", help="Uptime Robot API key (read-only is enough)")
    src.add_argument("--input", help="saved getMonitors JSON")
    ap.add_argument("--out", default="richter-import.json")
    ap.add_argument("--report", default="migration-report.md")
    ap.add_argument("--ntfy-topic")
    ap.add_argument("--ntfy-server", default="https://ntfy.sh")
    ap.add_argument("--probe", action="store_true", help="check port-25 monitors via the TCP probe (probe/README.md)")
    a = ap.parse_args()
    global PROBE
    PROBE = a.probe

    data = fetch(a.api_key) if a.api_key else json.load(open(a.input))
    now = int(time.time() * 1000)
    rows, report = [], ["| Uptime Robot monitor | Type | Richter | Notes |", "| --- | --- | --- | --- |"]
    for m in data["monitors"]:
        row, note = convert(m, now)
        if row:
            rows.append(row)
        rich = (row["type"] + (" (paused)" if row["paused"] else "")) if row else "skipped"
        report.append(f"| {m['friendly_name']} | {TYPE_NAMES.get(m.get('type'), m.get('type'))} | {rich} | {note} |")

    backup = {"version": 1, "exported_at": now, "monitors": rows}
    if a.ntfy_topic:
        cfg = {"server": a.ntfy_server.rstrip("/"), "topic": a.ntfy_topic}
        if os.environ.get("NTFY_TOKEN"):
            cfg["token"] = os.environ["NTFY_TOKEN"]
        nid = rid("ntfy")
        backup["notifications"] = [{"id": nid, "name": f"ntfy {a.ntfy_topic}", "type": "ntfy",
                                    "config": json.dumps(cfg), "enabled": 1, "apply_default": 1, "created_at": now}]
        backup["monitor_notifications"] = [{"monitor_id": r["id"], "notification_id": nid} for r in rows]

    with open(a.out, "w") as f:
        json.dump(backup, f, indent=2)
    with open(a.report, "w") as f:
        f.write("\n".join(report) + "\n")
    print(f"{len(rows)} monitors -> {a.out}; mapping in {a.report}")


if __name__ == "__main__":
    main()
