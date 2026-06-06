/**
 * AI investor ingest: arbitrary JSON/text about funds -> `RawInvestor[]`.
 *
 * The deterministic parsers (openvc/airtable) handle the known CSV schemas. This
 * is the catch-all for everything else — a scraped fund list, a pasted blurb, a
 * CRM dump — normalized into the investor model by Gemini and validated with zod.
 * A cloud step; gated by local-only mode at the command layer.
 */
import { z } from "zod";
import { getConfig, requireGeminiKey } from "../core/config.js";
import { errorMessage, IngestError } from "../core/errors.js";
import { generateText, modelChain } from "../core/gemini.js";
import type { RawInvestor } from "../core/schema.js";
import { domainOf } from "../core/text.js";
import {
	normalizeGeo,
	normalizeSectors,
	normalizeStages,
	parseCheck,
} from "./investor-normalize.js";

const ExtractInvestorSchema = z.object({
	name: z.string().min(1),
	website: z.string().nullish(),
	hq: z.string().nullish(),
	/** Free-text stage(s) — normalized to canonical stages after extraction. */
	stage: z.string().nullish(),
	sectors: z.string().nullish(),
	geo: z.string().nullish(),
	checkMin: z.string().nullish(),
	checkMax: z.string().nullish(),
	investorType: z.string().nullish(),
	thesis: z.string().nullish(),
	partnerName: z.string().nullish(),
	partnerEmail: z.string().nullish(),
});

const ExtractResponseSchema = z.object({
	investors: z.array(ExtractInvestorSchema).default([]),
});

const PROMPT = `You normalize arbitrary data into structured venture investors (firms or angels).

The INPUT below is some blob about investors — it may be JSON (any shape), a
pasted list, scraped output, or notes. Extract every distinct INVESTOR/FUND.
Infer fields only when clearly present; never invent. For "stage" give the
funding rounds they back (pre-seed, seed, series A, growth, …). For "sectors"
give a comma-separated list. For "geo" give countries/regions they invest in.
Cheque sizes are the first-cheque min/max (keep currency/units as written).

Return ONLY JSON of this shape:
{"investors":[{"name":"","website":"","hq":"","stage":"","sectors":"","geo":"","checkMin":"","checkMax":"","investorType":"","thesis":"","partnerName":"","partnerEmail":""}]}

INPUT:
`;

export interface AiExtractInvestorsOptions {
	apiKey?: string;
	model?: string;
	/** Provenance label recorded on each investor (default "ai"). */
	source?: string;
	sourceRef?: string;
}

/** Extract investors from an arbitrary text/JSON blob via Gemini. */
export async function aiExtractInvestors(
	text: string,
	options: AiExtractInvestorsOptions = {},
): Promise<RawInvestor[]> {
	const config = getConfig();
	const apiKey = options.apiKey ?? requireGeminiKey(config);
	const model = options.model ?? config.geminiTextModel;
	const trimmed = text.trim();
	if (!trimmed) return [];

	let raw: string;
	try {
		raw = await generateText({
			apiKey,
			models: modelChain(model),
			contents: [
				{ role: "user", parts: [{ text: PROMPT + trimmed.slice(0, 100_000) }] },
			],
			config: { responseMimeType: "application/json", temperature: 0 },
		});
	} catch (error) {
		throw new IngestError(
			`AI investor extraction failed: ${errorMessage(error)}`,
			"investors-auto",
			error,
		);
	}

	return mapInvestorResponse(raw, options.source ?? "ai", options.sourceRef);
}

/** Parse + validate a Gemini investor-extraction response. Exported for tests. */
export function mapInvestorResponse(
	text: string,
	source = "ai",
	sourceRef?: string,
): RawInvestor[] {
	const json = extractJson(text);
	if (!json)
		throw new IngestError(
			"AI investor extraction did not return JSON",
			"investors-auto",
		);
	const parsed = ExtractResponseSchema.safeParse(json);
	if (!parsed.success) {
		throw new IngestError(
			`AI investor extraction failed validation: ${parsed.error.message}`,
			"investors-auto",
		);
	}
	return parsed.data.investors.map((i) => ({
		name: i.name,
		website: i.website ?? null,
		domain: domainOf(i.website),
		hq: i.hq ?? null,
		stages: normalizeStages(i.stage),
		sectors: normalizeSectors(i.sectors),
		geo: normalizeGeo(i.geo),
		checkMin: parseCheck(i.checkMin),
		checkMax: parseCheck(i.checkMax),
		investorType: i.investorType ?? null,
		thesis: i.thesis ?? null,
		partnerName: i.partnerName ?? null,
		partnerEmail: i.partnerEmail ?? null,
		twitter: null,
		linkedin: null,
		portfolio: [],
		source,
		sourceRef: sourceRef ?? null,
	}));
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const match = trimmed.match(/[[{][\s\S]*[\]}]/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}
