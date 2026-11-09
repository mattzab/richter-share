// Agent install commands, built the way Beszel's add-system dialog builds them
// (internal/site/src/components/install-dropdowns.tsx: get.beszel.dev scripts and
// flags), adapted to Richter: WebSocket mode only, so every command also sets
// DISABLE_SSH=true and never LISTEN/PORT, and each one is safe to re-run.
import type { SystemInstall } from "./types";

const SCRIPT = "https://get.beszel.dev";
const IMAGE = "henrygd/beszel-agent:latest";

// Ask about daily auto-updates via /dev/tty (default yes, also without a tty),
// after draining pending tty input so only a fresh keypress answers. Callers wrap
// everything in one compound command so the shell has read every pasted line first.
const prompt = (readTimeout: string) => `ans=
if { printf 'Enable automatic daily agent updates? [Y/n] ' >/dev/tty; } 2>/dev/null; then
  while { read -r -t ${readTimeout} _ </dev/tty; } 2>/dev/null; do :; done
  { read -r ans </dev/tty; } 2>/dev/null || ans=
fi
case "$ans" in [Nn]*) au=false ;; *) au=true ;; esac`;

export function buildInstall(hub: string, token: string, key: string): SystemInstall {
	const compose = `services:
  beszel-agent:
    image: ${IMAGE}
    container_name: beszel-agent
    restart: unless-stopped
    network_mode: host
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./beszel_agent_data:/var/lib/beszel-agent
    environment:
      HUB_URL: "${hub}"
      TOKEN: "${token}"
      KEY: "${key}"
      DISABLE_SSH: "true"
`;

	// Beszel's "docker run", made re-runnable: pull, replace any old container.
	const dockerRun = `docker pull ${IMAGE} && \\
docker rm -f beszel-agent >/dev/null 2>&1; \\
docker run -d --name beszel-agent --network host --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v beszel_agent_data:/var/lib/beszel-agent \\
  -e HUB_URL="${hub}" -e TOKEN="${token}" -e KEY="${key}" -e DISABLE_SSH=true \\
  ${IMAGE}`;

	// Linux (systemd). The upstream script only edits Environment= lines already in
	// the unit, so HUB_URL/TOKEN/KEY/DISABLE_SSH live in a drop-in that is written
	// first (the script's own service start then uses them) and always overwritten.
	// The script runs with --auto-update=true|false and stdin closed; upstream
	// rewrites the same timer files on re-run. set -e stops at the first failed step.
	const binary = `(set -e
${prompt("0.3")}
curl -fsSL ${SCRIPT} -o /tmp/install-agent.sh
sudo mkdir -p /etc/systemd/system/beszel-agent.service.d
sudo tee /etc/systemd/system/beszel-agent.service.d/richter.conf >/dev/null <<'EOF'
[Service]
Environment="HUB_URL=${hub}"
Environment="TOKEN=${token}"
Environment="KEY=${key}"
Environment="DISABLE_SSH=true"
EOF
sudo sh /tmp/install-agent.sh -url "${hub}" -t "${token}" -k "${key}" --auto-update=$au </dev/null
sudo systemctl daemon-reload
sudo systemctl restart beszel-agent
rm -f /tmp/install-agent.sh)`;

	// Homebrew (macOS, or Linuxbrew). get.beszel.dev/brew taps henrygd/beszel,
	// installs the formula, writes ~/.config/beszel/beszel-agent.env (with LISTEN)
	// and starts the brew service; the service's launcher sources that file. We then
	// overwrite the file with exactly our variables and restart.
	const brew = `(set -e
curl -fsSL ${SCRIPT}/brew -o /tmp/install-agent-brew.sh
bash /tmp/install-agent-brew.sh -k "${key}" -t "${token}" -url "${hub}"
cat > ~/.config/beszel/beszel-agent.env <<'EOF'
KEY="${key}"
TOKEN="${token}"
HUB_URL="${hub}"
DISABLE_SSH=true
EOF
brew services restart beszel-agent
rm -f /tmp/install-agent-brew.sh)`;

	// Windows (PowerShell as Administrator). Beszel's install-agent.ps1 installs via
	// Scoop or WinGet and registers an NSSM service with KEY/TOKEN/HUB_URL (it has no
	// DISABLE_SSH option), so we add that to the service environment and restart.
	// Running elevated keeps the script in this window (no detached relaunch).
	const windows = `& {
$ErrorActionPreference = 'Stop'
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in PowerShell as Administrator.' }
$s = "$env:TEMP\\install-agent.ps1"
iwr -useb ${SCRIPT} -OutFile $s
& powershell -ExecutionPolicy Bypass -File $s -Key "${key}" -Token "${token}" -Url "${hub}"
if ($LASTEXITCODE) { throw "install-agent.ps1 failed ($LASTEXITCODE)" }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { $nssm = (Get-ChildItem "$env:LOCALAPPDATA\\Microsoft\\WinGet", "$env:ProgramFiles\\WinGet", "$env:USERPROFILE\\scoop\\apps\\nssm", "$env:ProgramData\\scoop\\apps\\nssm" -Filter nssm.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1).FullName }
if (-not $nssm) { throw 'nssm.exe not found' }
& $nssm set beszel-agent AppEnvironmentExtra '+DISABLE_SSH=true'
& $nssm restart beszel-agent
Remove-Item $s -ErrorAction SilentlyContinue
}`;

	// FreeBSD (also pfSense/OPNsense), as root. Same upstream script: it installs an
	// rc.d service whose env file is /usr/local/etc/beszel-agent/env and a cron job for
	// --auto-update=true. We then write that file with exactly our variables and
	// restart. Fed to sh via a heredoc so it also works from a csh/tcsh root shell;
	// fetch(1) is in base, curl may not be.
	const freebsd = `sh <<'RICHTER'
set -e
[ "$(id -u)" = 0 ] || { echo 'Run this as root (su -).' >&2; exit 1; }
${prompt("1")}
fetch -qo /tmp/install-agent.sh ${SCRIPT}
sh /tmp/install-agent.sh -url "${hub}" -t "${token}" -k "${key}" --auto-update=$au </dev/null
cat > /usr/local/etc/beszel-agent/env <<'EOF'
KEY="${key}"
TOKEN=${token}
HUB_URL=${hub}
DISABLE_SSH=true
EOF
chmod 640 /usr/local/etc/beszel-agent/env
chown root:"$(sysrc -n beszel_agent_user 2>/dev/null || echo beszel)" /usr/local/etc/beszel-agent/env
service beszel-agent restart
rm -f /tmp/install-agent.sh
RICHTER`;

	// Proxmox VE node, as root (PVE has no sudo by default): the Linux agent for the host itself,
	// then the richter-pve companion, which pushes the node's LXC containers and VMs every minute
	// so Richter can create a monitor per guest. Both are safe to re-run.
	const proxmox = `${binary.replace(/sudo /g, "").replace(/\)$/, "")}
curl -fsSL ${hub}/pve/richter-pve.sh -o /tmp/richter-pve.sh
bash /tmp/richter-pve.sh install "${hub}" "${token}"
rm -f /tmp/richter-pve.sh)`;

	return { hub_url: hub, token, key, compose, docker_run: dockerRun, binary, brew, windows, freebsd, proxmox };
}
