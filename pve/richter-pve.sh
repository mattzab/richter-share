#!/bin/bash
# richter-pve: Proxmox VE companion for Richter's beszel-agent support.
#
# The stock beszel-agent sees only the machine it runs on. This script, run every minute by a
# systemd timer on each Proxmox VE node, pushes the node's guest list (LXC containers and VMs,
# from `pvesh get /cluster/resources`) plus each guest's onboot flag to Richter, which creates
# and checks one monitor per guest. Read-only on the host: it never changes a guest.
#
#   richter-pve.sh install [HUB_URL TOKEN]   install to /usr/local/bin + systemd timer, then push once
#   richter-pve.sh push                      push once (what the timer runs)
#   richter-pve.sh uninstall                 remove the timer, unit, script and config
#
# Without HUB_URL/TOKEN, install reuses the ones beszel-agent's systemd service already has.
set -euo pipefail

CONF=/etc/richter-pve.env
BIN=/usr/local/bin/richter-pve
UNIT=/etc/systemd/system/richter-pve

die() { echo "richter-pve: $*" >&2; exit 1; }

push() {
	[ -r "$CONF" ] && . "$CONF"
	[ -n "${HUB_URL:-}" ] && [ -n "${TOKEN:-}" ] || die "HUB_URL and TOKEN must be set in $CONF"
	command -v pvesh >/dev/null || die "pvesh not found: run this on a Proxmox VE node"
	local node res ver onboot="" f id v
	node=$(basename "$(readlink -f /etc/pve/local)")
	res=$(pvesh get /cluster/resources --output-format json)
	ver=$(pveversion 2>/dev/null | head -n1 | sed -n 's|^pve-manager/\([^ /]*\).*|\1|p')
	for f in /etc/pve/nodes/"$node"/lxc/*.conf /etc/pve/nodes/"$node"/qemu-server/*.conf; do
		[ -e "$f" ] || continue
		id=$(basename "$f" .conf)
		# Only the main section: snapshot sections ([name]) repeat the keys.
		v=$(sed -n '/^\[/q; s/^onboot: *\([01]\).*/\1/p' "$f")
		onboot+="${onboot:+,}\"$id\":${v:-0}"
	done
	printf '{"node":"%s","version":"%s","resources":%s,"onboot":{%s}}' "$node" "$ver" "$res" "$onboot" |
		curl -fsS -m 20 -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
			--data-binary @- "${HUB_URL%/}/api/pve/push" >/dev/null
}

install() {
	[ "$(id -u)" = 0 ] || die "run as root"
	command -v pvesh >/dev/null || die "pvesh not found: this is not a Proxmox VE node"
	local hub="${1:-}" token="${2:-}" envs
	if [ -z "$hub" ] || [ -z "$token" ]; then
		envs=$(systemctl show beszel-agent -p Environment --value 2>/dev/null || true)
		hub=${hub:-$(tr ' ' '\n' <<<"$envs" | sed -n 's/^HUB_URL=//p' | tail -n1)}
		token=${token:-$(tr ' ' '\n' <<<"$envs" | sed -n 's/^TOKEN=//p' | tail -n1)}
	fi
	[ -n "$hub" ] && [ -n "$token" ] || die "usage: $0 install HUB_URL TOKEN (or install beszel-agent first)"
	cp "$0" "$BIN" 2>/dev/null || cat "$0" >"$BIN"
	chmod 755 "$BIN"
	umask 077
	printf 'HUB_URL=%s\nTOKEN=%s\n' "$hub" "$token" >"$CONF"
	umask 022
	cat >"$UNIT.service" <<UNIT
[Unit]
Description=Push Proxmox guest list to Richter
After=pve-cluster.service network-online.target
[Service]
Type=oneshot
ExecStart=$BIN push
UNIT
	cat >"$UNIT.timer" <<UNIT
[Unit]
Description=Push Proxmox guest list to Richter every minute
[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT
	systemctl daemon-reload
	systemctl enable --now richter-pve.timer >/dev/null
	"$BIN" push && echo "richter-pve installed: guests of $(basename "$(readlink -f /etc/pve/local)") are pushed to $hub every minute."
}

uninstall() {
	systemctl disable --now richter-pve.timer 2>/dev/null || true
	rm -f "$UNIT.timer" "$UNIT.service" "$BIN" "$CONF"
	systemctl daemon-reload
	echo "richter-pve removed (monitors in Richter are kept; delete them there)."
}

case "${1:-push}" in
	push) push ;;
	install) shift; install "$@" ;;
	uninstall) uninstall ;;
	*) die "usage: $0 [push|install [HUB_URL TOKEN]|uninstall]" ;;
esac
