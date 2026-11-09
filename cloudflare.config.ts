import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Deployment settings live outside git so a fork never commits its owner's domains or ids.
 * Copy `richter.config.example.json` to `richter.config.json` (gitignored) and fill it in,
 * or set the matching RICHTER_* environment variables (they win over the file).
 * See README → Configuration.
 */
type RichterConfig = {
	accountId: string;
	dashboardHost: string;
	publicHost: string;
	accessTeamDomain: string;
	accessAud: string;
	ownerEmail: string;
	accessAppId?: string;
	subrequestBudget?: string;
	probeUrl?: string;
};

const FILE = new URL("./richter.config.json", import.meta.url);
const file: Partial<RichterConfig> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const env = (k: string) => process.env[k] || undefined;
const cfg: RichterConfig = {
	accountId: env("RICHTER_ACCOUNT_ID") ?? file.accountId ?? "",
	dashboardHost: env("RICHTER_DASHBOARD_HOST") ?? file.dashboardHost ?? "richter.example.com",
	publicHost: env("RICHTER_PUBLIC_HOST") ?? file.publicHost ?? "status.example.com",
	accessTeamDomain: env("RICHTER_ACCESS_TEAM_DOMAIN") ?? file.accessTeamDomain ?? "your-team.cloudflareaccess.com",
	accessAud: env("RICHTER_ACCESS_AUD") ?? file.accessAud ?? "",
	ownerEmail: env("RICHTER_OWNER_EMAIL") ?? file.ownerEmail ?? "",
	accessAppId: env("RICHTER_ACCESS_APP_ID") ?? file.accessAppId ?? "",
	subrequestBudget: env("RICHTER_SUBREQUEST_BUDGET") ?? file.subrequestBudget ?? "40",
	probeUrl: env("RICHTER_PROBE_URL") ?? file.probeUrl ?? "",
};
if (!existsSync(FILE) && !env("RICHTER_ACCOUNT_ID")) {
	console.warn("[richter] No richter.config.json found; using example.com placeholders (fine for `cf dev`, not for deploy).");
}

export default defineConfig({
	...(cfg.accountId ? { accountId: cfg.accountId } : {}),
	worker: {
		name: "richter",
		compatibilityDate: "2026-10-23",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		observability: { enabled: true },
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: ["/api/*", "/ping/*", "/feed.atom", "/badge/*", "/embed/*", "/metrics", "/healthz", "/", "/s/*", "/og.png", "/og/*"],
		},
		domains: [cfg.dashboardHost, cfg.publicHost],
		workersDev: false,
		previewUrls: false,
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
		env: {
			DB: bindings.d1({ name: "richter-db" }),
			AGENT: bindings.durableObject({ worker: "richter", exportName: "AgentConnection" }),
			HUB: bindings.durableObject({ worker: "richter", exportName: "Hub" }),
			ASSETS: bindings.assets(),
			DASHBOARD_HOST: bindings.text(cfg.dashboardHost),
			PUBLIC_HOST: bindings.text(cfg.publicHost),
			ACCESS_TEAM_DOMAIN: bindings.text(cfg.accessTeamDomain),
			// AUD tag of the dashboard's Access application (not a secret).
			ACCESS_AUD: bindings.text(cfg.accessAud),
			SUBREQUEST_BUDGET: bindings.text(cfg.subrequestBudget ?? "40"),
			// Always allowed, always Full; can't be removed or demoted in Settings → Access.
			OWNER_EMAIL: bindings.text(cfg.ownerEmail),
			CF_ACCOUNT_ID: bindings.text(cfg.accountId),
			// Optional: lets Settings → Access manage the app's "Richter users (managed)" policy.
			ACCESS_APP_ID: bindings.text(cfg.accessAppId ?? ""),
			// CF_ACCESS_API_TOKEN is a Worker secret (Access: Apps and Policies Edit), optional.
			// Optional external TCP probe for port 25 / private hosts (probe/README.md); PROBE_TOKEN is a Worker secret.
			PROBE_URL: bindings.text(cfg.probeUrl ?? ""),
		},
		exports: {
			AgentConnection: exports.durableObject({ storage: "sqlite" }),
			Hub: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
