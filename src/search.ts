/**
 * Hybrid search + match explanations.
 *
 * Pure vector search misses exact terms ("Stripe", an email); pure keyword
 * search misses meaning. This blends both — semantic cosine plus a keyword boost
 * for leads whose text literally contains the query — and explains *why* each
 * hit matched so results are trustworthy, not a black box.
 */
import { embed } from "./core/embeddings.js";
import type { LeadRepository } from "./core/repository.js";
import type { Lead } from "./core/schema.js";
import { scoreText } from "./ingest/keywords.js";

export interface SearchHit {
	lead: Lead;
	score: number;
	why: string[];
}

const KEYWORD_BOOST = 0.2;

function leadText(l: Lead): string {
	return [l.fullName, l.title, l.notes, l.email]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

/** Query tokens (≥3 chars) that literally appear in the lead's text. */
export function explainMatch(query: string, lead: Lead): string[] {
	const text = leadText(lead);
	const tokens = query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3);
	return [...new Set(tokens.filter((t) => text.includes(t)))];
}

/** Pitch-relevance signal keywords present on a lead (why it ranks for a pitch). */
export function matchedSignals(lead: Lead): string[] {
	return scoreText(
		[lead.fullName, lead.title, lead.notes].filter(Boolean).join(". "),
	).matches;
}

/**
 * Hybrid semantic + keyword search. Falls back to pure text search when nothing
 * is embedded yet.
 */
export async function hybridSearch(
	repo: LeadRepository,
	query: string,
	k = 20,
): Promise<SearchHit[]> {
	const hits = new Map<string, SearchHit>();

	if (repo.counts().embedded > 0) {
		const qv = await embed(query);
		for (const m of repo.searchSimilar(qv, k * 2)) {
			hits.set(m.lead.id, {
				lead: m.lead,
				score: Math.max(0, m.score),
				why: explainMatch(query, m.lead),
			});
		}
	}

	// Keyword pass: add text matches and boost overlaps.
	for (const lead of repo.searchLeadsText(query, k * 2)) {
		const why = explainMatch(query, lead);
		const existing = hits.get(lead.id);
		if (existing) {
			existing.score += KEYWORD_BOOST;
			existing.why = [...new Set([...existing.why, ...why])];
		} else {
			hits.set(lead.id, { lead, score: KEYWORD_BOOST + 0.05, why });
		}
	}

	return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, k);
}
