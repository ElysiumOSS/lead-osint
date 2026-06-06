/**
 * Canonicalizers that map the messy, source-specific investor strings
 * (OpenVC's "1. Idea or Patent", Airtable's "Series A", "$250,000", country
 * lists) onto the structured shapes the matcher scores against.
 *
 * Keeping all the fuzziness here means the parsers (openvc.ts / airtable.ts) and
 * the AI extractor stay thin, and the match engine only ever sees clean tokens.
 */
import { INVESTOR_STAGES, type InvestorStage } from "../core/schema.js";

/** Split a multi-value cell on commas, slashes, semicolons, pipes, newlines. */
export function splitList(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(/[,/;|\n]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

// Each rule maps a matched source token to one or more canonical stages. Ordered
// so the first hit wins; OpenVC numbered labels and Airtable round names both map.
const STAGE_RULES: { test: RegExp; stages: InvestorStage[] }[] = [
	{ test: /pre[\s-]?seed/, stages: ["pre-seed"] },
	{ test: /\bseed\b/, stages: ["seed"] },
	{ test: /series\s*a|^a$/, stages: ["series-a"] },
	{ test: /series\s*b|^b$/, stages: ["series-b"] },
	{ test: /series\s*[c-z]|^[c-z]$/, stages: ["series-c"] },
	// OpenVC numbered ladder ("1. Idea or Patent" … "5. Growth").
	{ test: /idea|patent/, stages: ["idea", "pre-seed"] },
	{ test: /prototype|\bmvp\b/, stages: ["pre-seed", "seed"] },
	{ test: /early[\s-]?revenue|early[\s-]?stage/, stages: ["seed", "series-a"] },
	{ test: /scaling|expansion/, stages: ["series-a", "series-b"] },
	{ test: /growth|late[\s-]?stage|pre[\s-]?ipo/, stages: ["growth"] },
	{ test: /\bangel\b/, stages: ["pre-seed", "seed"] },
];

/**
 * Map a raw stage cell (possibly multi-value) onto canonical `INVESTOR_STAGES`,
 * deduped and returned in canonical (earliest → latest) order.
 */
export function normalizeStages(
	raw: string | null | undefined,
): InvestorStage[] {
	const found = new Set<InvestorStage>();
	for (const token of splitList(raw)) {
		// Drop a leading "1. " / "2) " ordinal prefix before matching.
		const t = token.replace(/^\s*\d+\s*[.)]\s*/, "").toLowerCase();
		for (const rule of STAGE_RULES) {
			if (rule.test.test(t)) {
				for (const s of rule.stages) found.add(s);
			}
		}
	}
	return INVESTOR_STAGES.filter((s) => found.has(s));
}

/** Lowercased, de-duplicated sector tokens. */
export function normalizeSectors(raw: string | null | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of splitList(raw)) {
		const t = token.toLowerCase().replace(/\s+/g, " ").trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

// Common country/region aliases → a single canonical token, so "USA", "United
// States" and "U.S." all overlap with a profile that targets "us".
const GEO_ALIASES: Record<string, string> = {
	usa: "us",
	"u.s.": "us",
	"u.s.a.": "us",
	"united states": "us",
	america: "us",
	uk: "uk",
	"u.k.": "uk",
	"united kingdom": "uk",
	"great britain": "uk",
	britain: "uk",
	uae: "uae",
	"united arab emirates": "uae",
	worldwide: "global",
	global: "global",
	international: "global",
	anywhere: "global",
	europe: "eu",
	eu: "eu",
};

/** Lowercased, alias-folded, de-duplicated geography tokens. */
export function normalizeGeo(raw: string | null | undefined): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const token of splitList(raw)) {
		const lower = token.toLowerCase().replace(/\s+/g, " ").trim();
		const canon = GEO_ALIASES[lower] ?? lower;
		if (canon && !seen.has(canon)) {
			seen.add(canon);
			out.push(canon);
		}
	}
	return out;
}

/**
 * Parse a cheque/fund-size cell into a USD number. Handles "$250,000",
 * "1,000,000", "$1M", "2.5m", "500k", "€1.5M". Returns null when unparseable.
 */
export function parseCheck(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const cleaned = raw
		.toLowerCase()
		.replace(/[$€£,\s]/g, "")
		.replace(/usd|eur|gbp/g, "")
		.trim();
	if (!cleaned) return null;
	const m = cleaned.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	if (!Number.isFinite(n)) return null;
	const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
	return n * mult;
}
