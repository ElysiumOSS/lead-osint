/**
 * AI relevance assessment — research a lead and reason about how they matter to
 * YOUR business, so important people aren't false-negatived by shallow
 * title/keyword matching.
 *
 * Per lead: optionally web-research (GitHub/Exa) for real material, then ask
 * Gemini to score business relevance (0–100), pick a relationship type, and give
 * a one-line rationale. The score is blended into pitch_fit so ranking reflects
 * strategic value, not just vector similarity.
 */

import { z } from "zod";
import { mapPool } from "./core/concurrency.js";
import { getConfig, requireGeminiKey } from "./core/config.js";
import { errorMessage } from "./core/errors.js";
import { generateText, modelChain } from "./core/gemini.js";
import type { LeadRepository } from "./core/repository.js";
import { MemoryRateLimitStore, withResilience } from "./core/resilience.js";
import { type Lead, RELATIONSHIPS, type Relationship } from "./core/schema.js";
import { researchLead } from "./enrich.js";

const ResponseSchema = z.object({
	relevance: z.coerce.number(),
	relationship: z.string(),
	rationale: z.string(),
});

export interface Assessment {
	/** 0–1 business-relevance. */
	relevance: number;
	relationship: Relationship;
	rationale: string;
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

function coerceRelationship(s: string): Relationship {
	const v = s.trim().toLowerCase();
	return (RELATIONSHIPS as readonly string[]).includes(v)
		? (v as Relationship)
		: "other";
}

/** Parse + validate a model assessment response. Exported for tests. */
export function parseAssessment(text: string): Assessment | null {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	let json: unknown;
	try {
		json = JSON.parse(m[0]);
	} catch {
		return null;
	}
	const parsed = ResponseSchema.safeParse(json);
	if (!parsed.success) return null;
	const raw = parsed.data.relevance;
	// Accept either 0–1 or 0–100.
	const relevance = clamp01(raw > 1 ? raw / 100 : raw);
	return {
		relevance,
		relationship: coerceRelationship(parsed.data.relationship),
		rationale: parsed.data.rationale.trim(),
	};
}

function buildPrompt(
	lead: Lead,
	orgName: string | null,
	pitch: string,
): string {
	const ctx = [
		`Name: ${lead.fullName}`,
		lead.title ? `Title: ${lead.title}` : null,
		orgName ? `Company: ${orgName}` : null,
		lead.notes ? `What we know: ${lead.notes.slice(0, 1200)}` : null,
	]
		.filter(Boolean)
		.join("\n");

	return `You assess how a specific person can help a startup — including INDIRECT
and STRATEGIC value, not just keyword overlap.

OUR STARTUP / PITCH:
${pitch.slice(0, 2000)}

THE PERSON:
${ctx}

Pick the SINGLE relationship that best captures the highest-leverage way this
person helps the business:
- investor: funds startups (VC, angel, LP/GP, startup banker)
- customer: would use or buy what we're building (target user, buyer, design partner)
- partner: strategic / BD / channel / integration partner or collaborating org
- connector: well-networked; can make warm intros to investors, customers, or talent
- advisor: would give strategic guidance (operator, domain leader, mentor)
- expert: deep domain knowledge relevant to us, even if they wouldn't advise directly
- hire: realistically RECRUITABLE onto our team (job-seeking, early-career, or a clear fit likely to move)
- peer: fellow founder / builder / engineer in an adjacent space — community, not a direct ask
- other: none of the above

IMPORTANT: do NOT default to "hire" for every technical person. A senior or
happily-employed engineer is usually "peer" or "expert", not "hire" — reserve
"hire" for people who would plausibly join. Favor investor/customer/connector/
partner when the person can move the business forward, not just the codebase.

Return ONLY JSON:
{"relevance": <0-100 how worth contacting for THIS business>,
 "relationship": "<investor|customer|partner|connector|advisor|expert|hire|peer|other>",
 "rationale": "<one sentence on why / how they connect to what we're building>"}`;
}

export interface AssessOptions {
	pitch: string;
	web?: boolean;
	apiKey?: string;
	model?: string;
}

/** Assess a single lead (no persistence). */
export async function assessLead(
	lead: Lead,
	orgName: string | null,
	options: AssessOptions,
): Promise<Assessment> {
	const config = getConfig();
	const apiKey = options.apiKey ?? requireGeminiKey(config);
	const text = await generateText({
		apiKey,
		models: modelChain(options.model ?? config.geminiTextModel),
		contents: [
			{
				role: "user",
				parts: [{ text: buildPrompt(lead, orgName, options.pitch) }],
			},
		],
		config: { responseMimeType: "application/json", temperature: 0.2 },
	});
	const a = parseAssessment(text);
	if (!a) throw new Error("could not parse assessment JSON");
	return a;
}

export interface RunAssessOptions extends AssessOptions {
	concurrency?: number;
	limit?: number;
	onlyUnassessed?: boolean;
	/** Cap Gemini calls to this many requests/minute (shared across workers). */
	rpm?: number;
	onProgress?: (lead: Lead, a: Assessment) => void;
}

export interface AssessStats {
	assessed: number;
	failed: number;
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Assess leads, blend the score into pitch_fit, and persist. */
export async function runAssess(
	repo: LeadRepository,
	options: RunAssessOptions,
): Promise<AssessStats> {
	const concurrency = options.concurrency ?? 4;
	let leads = options.onlyUnassessed
		? repo.leadsUnassessed()
		: repo.listLeads({ orderByFit: true, limit: options.limit });
	if (options.limit) leads = leads.slice(0, options.limit);

	const stats: AssessStats = { assessed: 0, failed: 0 };
	// Snapshot org names once instead of a getOrg query per lead (orgs don't
	// change during a run).
	const orgNames = new Map(repo.listOrgs().map((o) => [o.id, o.name]));
	const orgName = (l: Lead) =>
		l.orgId ? (orgNames.get(l.orgId) ?? null) : null;

	// Engine-level resilience (jam-nodes pattern): a shared windowed limiter keeps
	// the whole pool politely under Gemini's quota, plus a per-call timeout so one
	// stuck request can't stall a worker lane. See `jam-nodes-inspiration` memory.
	const rlStore = options.rpm ? new MemoryRateLimitStore() : null;
	const assessResilient = (lead: Lead) =>
		withResilience(() => assessLead(lead, orgName(lead), options), {
			...(rlStore
				? {
						rateLimit: {
							store: rlStore,
							maxRequests: options.rpm as number,
							windowMs: 60_000,
							key: "gemini",
						},
					}
				: {}),
			timeoutMs: 60_000,
		});

	await mapPool(leads, concurrency, async (lead) => {
		try {
			let current = lead;
			if (options.web) {
				const note = await researchLead(lead);
				if (note) {
					repo.enrichLead(lead.id, { note });
					current = repo.getLead(lead.id) ?? lead;
				}
			}
			const a = await assessResilient(current);
			// Blend: the AI relevance leads, semantic pitch_fit supports.
			const base = current.pitchFit ?? 0;
			const blended = round(0.6 * a.relevance + 0.4 * base);
			repo.setAssessment(lead.id, {
				relevance: a.relevance,
				relationship: a.relationship,
				rationale: a.rationale,
				pitchFit: blended,
			});
			repo.addInteraction(
				lead.id,
				"assess",
				`${a.relationship} · ${a.rationale}`,
			);
			stats.assessed += 1;
			options.onProgress?.(current, a);
		} catch (e) {
			// Count the failure AND say why — a parse miss, timeout, or rate-limit
			// shouldn't vanish into a bare "failed N".
			stats.failed += 1;
			console.warn(
				`  ⚠ assess failed for ${lead.fullName}: ${errorMessage(e)}`,
			);
		}
	});

	return stats;
}
