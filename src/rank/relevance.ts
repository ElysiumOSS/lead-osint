/**
 * Rank every lead by how well they fit your pitch.
 *
 * pitch_fit = semanticWeight * cosine(lead, pitch) + keywordWeight * keywordHit.
 * The semantic term captures meaning ("she builds inference infra" ~ an AI-infra
 * pitch even with no shared words); the keyword term rewards explicit signal.
 */
import type { LeadRepository } from "../core/repository.js";
import type { Lead } from "../core/schema.js";
import { normalizedKeywordScore, scoreText } from "../ingest/keywords.js";
import { embedPitch } from "./pitch.js";

export interface RankOptions {
	semanticWeight?: number;
	keywordWeight?: number;
}

export interface RankedLead {
	lead: Lead;
	fit: number;
	semantic: number;
	keyword: number;
}

/** Compute + persist pitch_fit for all leads; returns them sorted best-first. */
export async function rankLeads(
	repo: LeadRepository,
	pitchText: string,
	options: RankOptions = {},
): Promise<RankedLead[]> {
	const semanticWeight = options.semanticWeight ?? 0.7;
	const keywordWeight = options.keywordWeight ?? 0.3;

	const pitchVector = await embedPitch(pitchText);
	// Score every lead by a full cosine scan — sqlite-vec KNN caps k at 4096, and
	// ranking needs all leads, so we don't route this through the vec index.
	const semanticRaw = repo.scoreAllByVector(pitchVector);
	const semanticById = new Map<string, number>();
	for (const [id, score] of semanticRaw)
		semanticById.set(id, Math.max(0, score));

	const ranked: RankedLead[] = [];
	for (const lead of repo.listLeads()) {
		const semantic = semanticById.get(lead.id) ?? 0;
		const keywordText = [lead.title, lead.notes, lead.fullName]
			.filter(Boolean)
			.join(". ");
		const keyword = normalizedKeywordScore(scoreText(keywordText).score);
		const fit = round(semanticWeight * semantic + keywordWeight * keyword);
		repo.setPitchFit(lead.id, fit);
		ranked.push({ lead: { ...lead, pitchFit: fit }, fit, semantic, keyword });
	}

	ranked.sort((a, b) => b.fit - a.fit);
	return ranked;
}

function round(n: number): number {
	return Math.round(n * 10000) / 10000;
}
