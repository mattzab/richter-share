import type { AgentConnection } from "./beszel/agent-do";
import type { Hub } from "./hub";

export interface Env {
	DB: D1Database;
	AGENT: DurableObjectNamespace<AgentConnection>;
	HUB: DurableObjectNamespace<Hub>;
	ASSETS: Fetcher;
	DASHBOARD_HOST: string;
	PUBLIC_HOST: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	SUBREQUEST_BUDGET: string;
	/** The owner's Access email: always allowed, always Full. */
	OWNER_EMAIL: string;
	CF_ACCOUNT_ID: string;
	/** The "Richter dashboard" Access application. */
	ACCESS_APP_ID: string;
	/** Secret: API token with Access: Apps and Policies Edit (optional; user management needs it). */
	CF_ACCESS_API_TOKEN?: string;
	/** Optional external TCP probe (see probe/README.md), e.g. https://probe.example.com. Empty = disabled. */
	PROBE_URL: string;
	/** Secret: bearer token the probe expects (optional, but set it). */
	PROBE_TOKEN?: string;
}
