import type { SystemInstall } from "@shared/types";
import { Check, ChevronDown, Copy, ExternalLink, Info } from "lucide-react";
import { useState } from "react";
import { AppleIcon, DockerIcon, FreeBsdIcon, TuxIcon, WindowsIcon } from "@/components/icons/platforms";
import { Button } from "@/components/ui/button";
import { CodeBlock, CopyField } from "@/components/ui/copy";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { copyText } from "@/lib/utils";

type Icon = React.ComponentType<React.SVGProps<SVGSVGElement>>;
interface Option {
	id: keyof SystemInstall;
	label: string;
	icons: Icon[];
	hint: React.ReactNode;
}

const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 py-px font-mono text-[11px]">{children}</code>;

const BINARY: Option[] = [
	{
		id: "binary",
		label: "Linux command",
		icons: [TuxIcon],
		hint: (
			<>
				Paste into a shell on the server (uses <C>sudo</C>). Installs a systemd service with a <C>richter.conf</C> drop-in holding the four variables, and asks once whether to enable
				daily auto-updates (Enter = yes). Safe to re-run, including over an old SSH-mode agent.
			</>
		),
	},
	{
		id: "proxmox",
		label: "Proxmox VE node",
		icons: [TuxIcon],
		hint: (
			<>
				Paste into a <strong>root</strong> shell on the Proxmox host (no <C>sudo</C> needed). Installs the Linux agent for the host itself, plus the <C>richter-pve</C> timer that
				pushes this node's LXC containers and VMs every minute. Richter then creates a monitor per guest, grouped under this system; guests not set to start on boot are added
				paused. Safe to re-run; remove with <C>richter-pve uninstall</C>.
			</>
		),
	},
	{
		id: "brew",
		label: "Homebrew command",
		icons: [AppleIcon, TuxIcon],
		hint: (
			<>
				For macOS (or Linux with Homebrew), as your normal user. Installs the <C>beszel-agent</C> formula as a <C>brew services</C> service and writes{" "}
				<C>~/.config/beszel/beszel-agent.env</C>. Update with <C>brew upgrade beszel-agent</C>; there is no auto-update. Install Homebrew first if it's missing.
			</>
		),
	},
	{
		id: "windows",
		label: "Windows command",
		icons: [WindowsIcon],
		hint: (
			<>
				Paste into <strong>PowerShell run as Administrator</strong>. Installs via WinGet (or Scoop) and registers an NSSM service, then adds <C>DISABLE_SSH=true</C> to it. Update
				with <C>winget upgrade henrygd.beszel-agent</C>.
			</>
		),
	},
	{
		id: "freebsd",
		label: "FreeBSD command",
		icons: [FreeBsdIcon],
		hint: (
			<>
				Paste as <strong>root</strong> (works from sh, csh or tcsh; pfSense and OPNsense too). Installs an rc.d service with its env file at{" "}
				<C>/usr/local/etc/beszel-agent/env</C> and asks about daily auto-updates (cron). Safe to re-run.
			</>
		),
	},
];

const DOCKER: Option[] = [
	{
		id: "compose",
		label: "Docker compose",
		icons: [DockerIcon],
		hint: (
			<>
				Save as <C>docker-compose.yml</C> on the server and run <C>docker compose up -d</C>. Uses host networking; no ports are published.
			</>
		),
	},
	{
		id: "docker_run",
		label: "Docker run",
		icons: [DockerIcon],
		hint: <>One command: pulls the latest image and replaces any existing <C>beszel-agent</C> container, so it's safe to re-run.</>,
	},
];

/** Beszel-style split button: copy the selected command, chevron to pick another. */
function CommandPicker({ install, options, manual }: { install: SystemInstall; options: Option[]; manual: string }) {
	const [sel, setSel] = useState(options[0]);
	const [done, setDone] = useState(false);
	const code = install[sel.id] as string;
	const copy = async () => {
		if (await copyText(code)) {
			setDone(true);
			setTimeout(() => setDone(false), 1500);
		}
	};
	return (
		<div className="space-y-3">
			<div className="flex">
				<Button variant="outline" onClick={copy} className="grow justify-center rounded-e-none">
					{done ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
					{done ? "Copied" : `Copy ${sel.label}`}
					<span className="flex items-center gap-1 text-muted-foreground">
						{sel.icons.map((I, i) => (
							<I key={i} className="size-4" />
						))}
					</span>
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" className="rounded-s-none border-s-0 px-2.5" aria-label="Choose platform">
							<ChevronDown className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-56">
						<DropdownMenuLabel>Platform</DropdownMenuLabel>
						{options.map((o) => (
							<DropdownMenuItem key={o.id} onSelect={() => setSel(o)} className={o.id === sel.id ? "bg-accent/60 font-medium" : undefined}>
								<span className="flex-1">{o.label}</span>
								{o.icons.map((I, i) => (
									<I key={i} />
								))}
								<Check className={o.id === sel.id ? "!text-foreground" : "invisible"} />
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							<a href={manual} target="_blank" rel="noopener noreferrer">
								<span className="flex-1">Manual setup instructions</span>
								<ExternalLink />
							</a>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<CodeBlock code={code} preClassName="max-h-64" />
			<p className="text-xs leading-relaxed text-muted-foreground">{sel.hint}</p>
		</div>
	);
}

/** Copy-ready agent install instructions: binary (Linux, Homebrew, Windows, FreeBSD) or Docker. */
export function InstallInfo({ install }: { install: SystemInstall }) {
	return (
		<div className="space-y-5">
			<div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-x-4">
				<span className="text-xs font-medium text-muted-foreground sm:text-right">Hub URL</span>
				<CopyField value={install.hub_url} />
				<span className="text-xs font-medium text-muted-foreground sm:text-right">Token</span>
				<CopyField value={install.token} secret />
				<span className="text-xs font-medium text-muted-foreground sm:text-right">Public key</span>
				<CopyField value={install.key} />
			</div>
			<Tabs defaultValue="binary">
				<TabsList className="grid w-full grid-cols-2">
					<TabsTrigger value="binary">
						<TuxIcon /> Binary
					</TabsTrigger>
					<TabsTrigger value="docker">
						<DockerIcon /> Docker
					</TabsTrigger>
				</TabsList>
				<TabsContent value="binary" className="mt-4">
					<CommandPicker install={install} options={BINARY} manual="https://beszel.dev/guide/agent-installation#binary" />
				</TabsContent>
				<TabsContent value="docker" className="mt-4">
					<CommandPicker install={install} options={DOCKER} manual="https://beszel.dev/guide/agent-installation#docker" />
				</TabsContent>
			</Tabs>
			<div className="flex gap-2.5 rounded-md border border-sky-500/30 bg-sky-500/10 p-3 text-xs leading-relaxed text-sky-900 dark:text-sky-100">
				<Info className="mt-0.5 size-4 shrink-0 text-sky-500" />
				<p>
					<strong>WebSocket mode only.</strong> The agent dials out to <C>{install.hub_url}</C>, so outbound HTTPS is all it needs. Every command sets <C>DISABLE_SSH=true</C> and
					never <C>LISTEN</C>/<C>PORT</C>; don't open an inbound port.
				</p>
			</div>
		</div>
	);
}
