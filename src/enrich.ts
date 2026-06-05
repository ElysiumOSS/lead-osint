/**
 * Legal OSINT enrichment: fill gaps on existing leads/orgs from public sources.
 *
 * - GitHub  : official API, finds a dev by name -> bio/blog/twitter/location
 * - Exa     : web search (needs EXA_API_KEY) -> a short sourced summary into notes
 * - Registry: Wikidata + SEC EDGAR -> company description / identity (keyless)
 *
 * Network calls are thin and fail soft (return null); the mappers are pure and
 * unit-tested. Enrichment only fills empty fields and appends sourced notes —
 * it never overwrites data you already have. Respect each API's ToS + limits.
 */
import { mapPool } from "./core/concurrency.js";
import { errorMessage } from "./core/errors.js";
import type { LeadRepository } from "./core/repository.js";
import type { Lead } from "./core/schema.js";

export interface LeadPatch {
	firstName?: string | null;
	lastName?: string | null;
	email?: string | null;
	title?: string | null;
	linkedin?: string | null;
	twitter?: string | null;
	website?: string | null;
	note?: string | null;
}

const UA = "lead-osint (+https://github.com/ElysiumOSS/lead-osint)";

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

interface GithubUser {
	login?: string;
	name?: string | null;
	company?: string | null;
	blog?: string | null;
	bio?: string | null;
	location?: string | null;
	twitter_username?: string | null;
	html_url?: string | null;
}

/** Map a GitHub user payload to a lead patch (pure). */
export function mapGithubUser(user: GithubUser): LeadPatch {
	const noteBits = [
		user.bio?.trim(),
		user.location ? `Location: ${user.location}` : null,
		user.html_url ? `GitHub: ${user.html_url}` : null,
	].filter(Boolean);
	return {
		website: normalizeUrl(user.blog),
		twitter: user.twitter_username
			? `https://x.com/${user.twitter_username}`
			: null,
		note: noteBits.length ? `GitHub — ${noteBits.join(" · ")}` : null,
	};
}

/** True when a GitHub profile name plausibly matches the lead (guards false hits). */
export function githubNameMatches(
	leadName: string,
	ghName?: string | null,
): boolean {
	if (!ghName) return false;
	const a = leadName
		.toLowerCase()
		.replace(/[^a-z ]/g, "")
		.trim();
	const b = ghName
		.toLowerCase()
		.replace(/[^a-z ]/g, "")
		.trim();
	if (!a || !b) return false;
	return a === b || a.includes(b) || b.includes(a);
}

async function enrichLeadGithub(
	lead: Lead,
	token?: string,
): Promise<LeadPatch | null> {
	const headers: Record<string, string> = {
		"User-Agent": UA,
		Accept: "application/vnd.github+json",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	try {
		const search = await fetchJson(
			`https://api.github.com/search/users?per_page=1&q=${encodeURIComponent(
				`${lead.fullName} in:name`,
			)}`,
			{ headers },
		);
		const login = (search as { items?: { login?: string }[] })?.items?.[0]
			?.login;
		if (!login) return null;
		const user = (await fetchJson(`https://api.github.com/users/${login}`, {
			headers,
		})) as GithubUser;
		if (!githubNameMatches(lead.fullName, user.name)) return null;
		return mapGithubUser(user);
	} catch (e) {
		// Fail soft so a batch keeps going, but never silently — a bad token or
		// rate-limit should be visible, not look like "no results".
		console.warn(
			`  ⚠ GitHub enrich failed for ${lead.fullName}: ${errorMessage(e)}`,
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Exa web search
// ---------------------------------------------------------------------------

interface ExaResult {
	title?: string;
	url?: string;
	text?: string;
}

/** Map Exa results to a sourced note (pure). */
export function mapExaResults(results: ExaResult[]): string | null {
	const lines = results
		.slice(0, 3)
		.map((r) => {
			const snippet = r.text?.replace(/\s+/g, " ").trim().slice(0, 180);
			return r.url
				? `${r.title ?? r.url} — ${r.url}${snippet ? `: ${snippet}` : ""}`
				: null;
		})
		.filter(Boolean) as string[];
	return lines.length ? `Web (Exa):\n${lines.join("\n")}` : null;
}

async function enrichLeadExa(
	lead: Lead,
	apiKey: string,
): Promise<LeadPatch | null> {
	const query = [lead.fullName, lead.title].filter(Boolean).join(" ");
	try {
		const res = await fetchJson("https://api.exa.ai/search", {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": apiKey },
			body: JSON.stringify({
				query,
				numResults: 3,
				contents: { text: { maxCharacters: 400 } },
			}),
		});
		const note = mapExaResults(
			(res as { results?: ExaResult[] })?.results ?? [],
		);
		return note ? { note } : null;
	} catch (e) {
		// Surface auth/credit/HTTP failures instead of swallowing them.
		console.warn(
			`  ⚠ Exa enrich failed for ${lead.fullName}: ${errorMessage(e)}`,
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Company registries (Wikidata + SEC EDGAR)
// ---------------------------------------------------------------------------

/** Org-like descriptions, used to avoid matching a same-named person on Wikidata. */
const ORG_DESC =
	/company|business|organi[sz]ation|enterprise|corporation|firm|startup|agency|non-?profit|manufacturer|software|technology|bank|institution|publisher|developer|airline|retailer|provider|brand|studio|platform|venture/i;

/**
 * Map a Wikidata `wbsearchentities` payload to a note (pure).
 *
 * Wikidata is free, keyless, and global. We pick the first result whose
 * description reads like an organization (not a person who shares the name).
 */
export function mapWikidata(json: unknown): { note: string | null } {
	const results =
		(
			json as {
				search?: {
					id?: string;
					label?: string;
					description?: string;
					concepturi?: string;
				}[];
			}
		)?.search ?? [];
	const hit = results.find(
		(r) => r.description && ORG_DESC.test(r.description),
	);
	if (!hit) return { note: null };
	const url =
		hit.concepturi ??
		(hit.id ? `https://www.wikidata.org/wiki/${hit.id}` : null);
	const bits = [
		hit.label,
		hit.description ? `(${hit.description})` : null,
		url,
	].filter(Boolean);
	return { note: bits.length ? `Wikidata — ${bits.join(" ")}` : null };
}

/** Map an SEC EDGAR full-text-search payload to a note (pure). */
export function mapEdgar(json: unknown): string | null {
	const hit = (
		json as { hits?: { hits?: { _source?: Record<string, unknown> }[] } }
	)?.hits?.hits?.[0]?._source;
	if (!hit) return null;
	const names = Array.isArray(hit.display_names)
		? (hit.display_names as string[])
		: [];
	return names.length ? `SEC EDGAR — ${names[0]}` : null;
}

async function enrichOrgRegistry(
	name: string,
	secUa?: string,
): Promise<{ note: string | null }> {
	const notes: string[] = [];
	try {
		const wdUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
			name,
		)}&language=en&type=item&limit=5&format=json&origin=*`;
		const wd = mapWikidata(
			await fetchJson(wdUrl, { headers: { "User-Agent": UA } }),
		);
		if (wd.note) notes.push(wd.note);
	} catch {
		/* soft fail */
	}
	try {
		const edgar = mapEdgar(
			await fetchJson(
				`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name}"`)}`,
				{ headers: { "User-Agent": secUa ?? UA } },
			),
		);
		if (edgar) notes.push(edgar);
	} catch {
		/* soft fail */
	}
	return { note: notes.length ? notes.join("\n") : null };
}

/**
 * Research one lead via public sources (GitHub always; Exa when EXA_API_KEY is
 * set) and return a sourced note, or null. Used by `assess` to give the model
 * real material instead of just a title.
 */
export async function researchLead(
	lead: Lead,
	opts: { githubToken?: string; exaApiKey?: string } = {},
): Promise<string | null> {
	const ghToken =
		opts.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const exaKey = opts.exaApiKey ?? process.env.EXA_API_KEY;
	const patches: (LeadPatch | null)[] = [await enrichLeadGithub(lead, ghToken)];
	if (exaKey) patches.push(await enrichLeadExa(lead, exaKey));
	return mergePatches(patches)?.note ?? null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface EnrichOptions {
	github?: boolean;
	exa?: boolean;
	orgs?: boolean;
	concurrency?: number;
	githubToken?: string;
	exaApiKey?: string;
	secUserAgent?: string;
	onProgress?: (label: string) => void;
}

export interface EnrichStats {
	leadsChanged: number;
	orgsChanged: number;
	skipped: string[];
}

/** Run the enabled enrichers across the store. */
export async function runEnrich(
	repo: LeadRepository,
	options: EnrichOptions,
): Promise<EnrichStats> {
	const stats: EnrichStats = { leadsChanged: 0, orgsChanged: 0, skipped: [] };
	const concurrency = options.concurrency ?? 3;

	const exaKey = options.exaApiKey ?? process.env.EXA_API_KEY;
	if (options.exa && !exaKey) stats.skipped.push("exa (EXA_API_KEY not set)");
	const githubToken =
		options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

	if (options.github || (options.exa && exaKey)) {
		const leads = repo.listLeads();
		await mapPool(leads, concurrency, async (lead) => {
			const patches: (LeadPatch | null)[] = [];
			if (options.github)
				patches.push(await enrichLeadGithub(lead, githubToken));
			if (options.exa && exaKey)
				patches.push(await enrichLeadExa(lead, exaKey));
			const merged = mergePatches(patches);
			if (merged && repo.enrichLead(lead.id, merged)) {
				stats.leadsChanged += 1;
				repo.addInteraction(lead.id, "enrich", "Enriched from public sources");
				options.onProgress?.(`✓ ${lead.fullName}`);
			}
		});
	}

	if (options.orgs) {
		const secUa = options.secUserAgent ?? process.env.SEC_USER_AGENT;
		const orgs = repo.listOrgs();
		await mapPool(orgs, concurrency, async (org) => {
			const { note } = await enrichOrgRegistry(org.name, secUa);
			if (note && repo.updateOrg(org.id, { note })) {
				stats.orgsChanged += 1;
				options.onProgress?.(`✓ org ${org.name}`);
			}
		});
	}

	return stats;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Merge multiple patches; first non-empty value wins, notes concatenate. */
export function mergePatches(patches: (LeadPatch | null)[]): LeadPatch | null {
	const out: LeadPatch = {};
	const notes: string[] = [];
	let any = false;
	for (const p of patches) {
		if (!p) continue;
		any = true;
		for (const [k, v] of Object.entries(p) as [
			keyof LeadPatch,
			string | null | undefined,
		][]) {
			if (k === "note") {
				if (v) notes.push(v);
			} else if (v && !out[k]) {
				out[k] = v;
			}
		}
	}
	if (notes.length) out.note = notes.join("\n");
	return any ? out : null;
}

function normalizeUrl(value?: string | null): string | null {
	const v = value?.trim();
	if (!v) return null;
	return v.startsWith("http") ? v : `https://${v}`;
}

async function fetchJson(
	url: string,
	init: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	} = {},
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		const res = await fetch(url, {
			method: init.method ?? "GET",
			headers: init.headers,
			body: init.body,
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}
