/**
 * The VC matcher: score every investor against a structured startup profile.
 *
 * Four explainable factors, each in [0, 1], blended by tunable weights:
 *   stage   — is the investor backing your current round?
 *   sector  — sector overlap (jaccard) blended with semantic thesis similarity
 *   geo     — do they invest where you are / sell?
 *   check   — does your target cheque fall inside their first-cheque band?
 *
 * Unknown data scores a neutral mid value rather than a zero, so a fund with a
 * blank field isn't unfairly buried — but a CONFIRMED mismatch (wrong stage,
 * wrong geo) scores low. `--require-*` flags turn a factor into a hard filter.
 */
import type { LeadRepository } from "../core/repository.js";
import { INVESTOR_STAGES, type Investor } from "../core/schema.js";
import type { StartupProfile } from "./startup-profile.js";

export interface MatchWeights {
	stage: number;
	sector: number;
	geo: number;
	check: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
	stage: 0.3,
	sector: 0.4,
	geo: 0.15,
	check: 0.15,
};

/** Neutral score for an unknown/blank field — don't reward, don't bury. */
const NEUTRAL = 0.5;

export interface MatchBreakdown {
	stage: number;
	sector: number;
	geo: number;
	check: number;
	/** Index signature so a breakdown is a valid `Record<string, number>`. */
	[factor: string]: number;
}

export interface MatchedInvestor {
	investor: Investor;
	score: number;
	breakdown: MatchBreakdown;
}

export interface MatchOptions {
	weights?: Partial<MatchWeights>;
	/** Drop investors whose stage factor is 0 (a confirmed stage mismatch). */
	requireStage?: boolean;
	/** Drop investors whose geo factor is 0 (a confirmed geo mismatch). */
	requireGeo?: boolean;
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

/** Stage fit: 1 if backed, 0.5 one round away, 0.25 two away, else 0. */
export function stageScore(
	profile: StartupProfile,
	investor: Investor,
): number {
	if (investor.stages.length === 0) return NEUTRAL;
	const target = INVESTOR_STAGES.indexOf(profile.stage);
	let best = 0;
	for (const s of investor.stages) {
		const idx = INVESTOR_STAGES.indexOf(s);
		if (idx < 0) continue;
		const dist = Math.abs(idx - target);
		const v = dist === 0 ? 1 : dist === 1 ? 0.5 : dist === 2 ? 0.25 : 0;
		if (v > best) best = v;
	}
	return best;
}

/** Jaccard overlap of two token sets, in [0, 1]. */
export function jaccard(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let inter = 0;
	for (const x of setA) if (setB.has(x)) inter++;
	const union = setA.size + setB.size - inter;
	return union === 0 ? 0 : inter / union;
}

/**
 * Sector + thesis fit: 0.6·semantic(cosine, clamped ≥0) + 0.4·jaccard(sectors).
 * `semantic` is the precomputed cosine of the pitch vector against the
 * investor's thesis embedding (0 when the investor has no vector).
 */
export function sectorScore(
	profile: StartupProfile,
	investor: Investor,
	semantic: number,
): number {
	const sem = Math.max(0, Math.min(1, semantic));
	const overlap = jaccard(profile.sectors, investor.sectors);
	return 0.6 * sem + 0.4 * overlap;
}

/** Geo fit: 1 if global or any overlap; neutral if unknown; else 0. */
export function geoScore(profile: StartupProfile, investor: Investor): number {
	if (investor.geo.length === 0) return NEUTRAL;
	if (investor.geo.includes("global")) return 1;
	const wanted = new Set<string>(profile.geo.targetMarkets);
	if (profile.geo.hq) wanted.add(profile.geo.hq);
	if (wanted.size === 0) return NEUTRAL;
	for (const g of investor.geo) if (wanted.has(g)) return 1;
	return 0;
}

/** Cheque fit: 1 inside the band, 0.5 within 2× of an edge, neutral if unknown. */
export function checkScore(
	profile: StartupProfile,
	investor: Investor,
): number {
	const target = profile.raising.checkTarget;
	if (target == null) return NEUTRAL;
	const min = investor.checkMin;
	const max = investor.checkMax;
	if (min == null && max == null) return NEUTRAL;
	const lo = min ?? 0;
	const hi = max ?? Number.POSITIVE_INFINITY;
	if (target >= lo && target <= hi) return 1;
	// Near-miss: within 2× of the nearest edge gets partial credit.
	if (target < lo && target * 2 >= lo) return 0.5;
	if (target > hi && target <= hi * 2) return 0.5;
	return 0;
}

/** Score a single investor; returns the blended score + per-factor breakdown. */
export function scoreInvestor(
	profile: StartupProfile,
	investor: Investor,
	semantic: number,
	weights: MatchWeights = DEFAULT_WEIGHTS,
): { score: number; breakdown: MatchBreakdown } {
	const breakdown: MatchBreakdown = {
		stage: round(stageScore(profile, investor)),
		sector: round(sectorScore(profile, investor, semantic)),
		geo: round(geoScore(profile, investor)),
		check: round(checkScore(profile, investor)),
	};
	const totalWeight =
		weights.stage + weights.sector + weights.geo + weights.check || 1;
	const weighted =
		weights.stage * breakdown.stage +
		weights.sector * breakdown.sector +
		weights.geo * breakdown.geo +
		weights.check * breakdown.check;
	return { score: round(weighted / totalWeight), breakdown };
}

/**
 * Score + persist a match for every investor, best first. The pitch vector
 * drives the semantic term; `repo.scoreAllInvestorsByVector` gives one cosine per
 * investor in a single scan.
 */
export function matchInvestors(
	repo: LeadRepository,
	profile: StartupProfile,
	pitchVector: Float32Array,
	options: MatchOptions = {},
): MatchedInvestor[] {
	const weights = { ...DEFAULT_WEIGHTS, ...options.weights };
	const semanticById = repo.scoreAllInvestorsByVector(pitchVector);

	const out: MatchedInvestor[] = [];
	for (const investor of repo.listInvestors()) {
		const semantic = semanticById.get(investor.id) ?? 0;
		const { score, breakdown } = scoreInvestor(
			profile,
			investor,
			semantic,
			weights,
		);
		if (options.requireStage && breakdown.stage === 0) continue;
		if (options.requireGeo && breakdown.geo === 0) continue;
		repo.setInvestorMatch(investor.id, score, breakdown);
		out.push({
			investor: { ...investor, matchScore: score },
			score,
			breakdown,
		});
	}

	out.sort((a, b) => b.score - a.score);
	return out;
}
