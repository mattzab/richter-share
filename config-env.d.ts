// Minimal Node typings for cloudflare.config.ts (runs in Node at build time, not in the Worker).
declare module "node:fs" {
	export function existsSync(path: string | URL): boolean;
	export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

// Text imports bundled by Vite (e.g. the richter-pve script served by the Worker).
declare module "*?raw" {
	const text: string;
	export default text;
}
