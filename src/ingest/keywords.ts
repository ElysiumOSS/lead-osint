/**
 * Pitch-relevance keyword scoring.
 *
 * Extracted from `scrape-partiful.ts`. Word-boundary, case-insensitive matches
 * over arbitrary text (event name + description + a lead's title/company) give a
 * cheap, explainable signal of how relevant something is to a startup pitch.
 * The semantic embedding score complements this (see `rank/relevance.ts`).
 */

/** Default signal vocabulary. Tailor to your own thesis/interests. */
export const PRIORITY_KEYWORDS: readonly string[] = [
	// Stage / fundraising
	"founder",
	"founders",
	"startup",
	"startups",
	"seed",
	"pre-seed",
	"series A",
	"early stage",
	"raising",
	"fund",
	"fundraise",
	"fundraising",
	"demo day",
	"pitch",
	"GTM",
	// Investors
	"VC",
	"VCs",
	"venture capital",
	"investor",
	"investors",
	"angel",
	"LP",
	"GP",
	// AI / ML
	"AI",
	"ML",
	"LLM",
	"machine learning",
	"deep learning",
	"agents",
	"agentic",
	"GenAI",
	// Tech themes
	"deep tech",
	"frontier tech",
	"hardware",
	"robotics",
	"infrastructure",
	"infra",
	// Engineering / builder
	"engineer",
	"engineering",
	"open source",
	"hackathon",
	// Domain signal (emergency / resilience / gov / robotics — tailor to your thesis)
	"emergency",
	"disaster",
	"first responder",
	"public safety",
	"resilience",
	"government",
	"gov",
	"municipal",
	"logistics",
	"supply chain",
	"drone",
	"drones",
	"swarm",
	"autonomous",
	"computer vision",
	"edge computing",
	"federated learning",
	"geospatial",
	"climate",
	"workforce",
];

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(keywords: readonly string[]): { kw: string; re: RegExp }[] {
	return keywords.map((kw) => ({
		kw,
		re: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i"),
	}));
}

const DEFAULT_REGEXES = compile(PRIORITY_KEYWORDS);

export interface KeywordScore {
	/** Number of distinct keywords matched. */
	score: number;
	/** The matched keywords, for explainability. */
	matches: string[];
}

/** Count distinct keyword matches in `text`. */
export function scoreText(
	text: string,
	keywords?: readonly string[],
): KeywordScore {
	const regexes = keywords ? compile(keywords) : DEFAULT_REGEXES;
	const matches: string[] = [];
	for (const { kw, re } of regexes) {
		if (re.test(text)) matches.push(kw);
	}
	return { score: matches.length, matches };
}

/**
 * Normalize a raw keyword count into [0, 1] with diminishing returns, so a few
 * strong matches already score high and the value stays bounded for blending
 * with cosine similarity.
 */
export function normalizedKeywordScore(
	rawScore: number,
	saturateAt = 5,
): number {
	if (rawScore <= 0) return 0;
	return Math.min(1, rawScore / saturateAt);
}
