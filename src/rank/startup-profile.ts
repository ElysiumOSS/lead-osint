/**
 * Your startup, as the structured query the investor matcher scores against.
 *
 * The free-text `pitch.md` still drives semantic thesis matching; this adds the
 * HARD factors a pitch can't express precisely — what stage you're at, which
 * sectors you're in, where you operate, and the cheque you want — so a Seed /
 * FinTech / US / $500k startup ranks Seed FinTech US funds above everyone else.
 */
import { readFile } from "node:fs/promises";
import { IngestError } from "../core/errors.js";
import type { InvestorStage } from "../core/schema.js";
import {
	normalizeGeo,
	normalizeSectors,
	normalizeStages,
} from "../ingest/investor-normalize.js";

/** The structured startup profile, after normalization. */
export interface StartupProfile {
	name: string | null;
	/** Canonical current raise stage (single). */
	stage: InvestorStage;
	/** Lowercased sector tokens. */
	sectors: string[];
	geo: {
		/** Canonical HQ token. */
		hq: string | null;
		/** Canonical target-market tokens. */
		targetMarkets: string[];
	};
	raising: {
		/** Total round size (USD). */
		amount: number | null;
		/** The cheque you'd want from a single investor (USD). */
		checkTarget: number | null;
	};
	businessModel: string | null;
	traction: string | null;
	/** Optional inline thesis/description used for semantic matching. */
	description: string | null;
	/** Optional path to a free-text pitch file (`.md`/`.txt`/`.json`). */
	pitchPath: string | null;
}

interface RawProfileJson {
	name?: unknown;
	stage?: unknown;
	sectors?: unknown;
	geo?: { hq?: unknown; targetMarkets?: unknown };
	raising?: { amount?: unknown; checkTarget?: unknown };
	businessModel?: unknown;
	traction?: unknown;
	description?: unknown;
	pitch?: unknown;
	pitchPath?: unknown;
}

const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const strArray = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Build a normalized `StartupProfile` from a parsed JSON object. Stage/sector/geo
 * strings are run through the same canonicalizers the investors went through, so
 * "Seed", "USA", "FinTech" line up with the stored tokens.
 */
export function parseProfile(json: RawProfileJson): StartupProfile {
	const stages = normalizeStages(
		typeof json.stage === "string"
			? json.stage
			: strArray(json.stage).join(","),
	);
	const stage = stages[0];
	if (!stage) {
		throw new IngestError(
			`startup profile is missing a recognizable "stage" (e.g. "seed", "series-a")`,
			"profile",
		);
	}
	const sectors = normalizeSectors(
		Array.isArray(json.sectors)
			? strArray(json.sectors).join(",")
			: (str(json.sectors) ?? ""),
	);
	const hqRaw = str(json.geo?.hq);
	const hq = hqRaw ? (normalizeGeo(hqRaw)[0] ?? null) : null;
	const targetMarkets = normalizeGeo(
		strArray(json.geo?.targetMarkets).join(","),
	);

	return {
		name: str(json.name),
		stage,
		sectors,
		geo: { hq, targetMarkets },
		raising: {
			amount: num(json.raising?.amount),
			checkTarget: num(json.raising?.checkTarget),
		},
		businessModel: str(json.businessModel),
		traction: str(json.traction),
		description: str(json.description),
		pitchPath: str(json.pitchPath) ?? str(json.pitch),
	};
}

/** Read + validate a startup profile from a `.json` file. */
export async function loadProfile(path: string): Promise<StartupProfile> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		throw new IngestError(
			`Cannot read profile file: ${path}`,
			"profile",
			error,
		);
	}
	let json: RawProfileJson;
	try {
		json = JSON.parse(raw) as RawProfileJson;
	} catch (error) {
		throw new IngestError(
			`Profile file is not valid JSON: ${path}`,
			"profile",
			error,
		);
	}
	return parseProfile(json);
}

/** Plain text describing the startup, for semantic/keyword matching fallback. */
export function profileText(profile: StartupProfile): string {
	return [
		profile.name,
		profile.sectors.length ? profile.sectors.join(", ") : null,
		profile.businessModel,
		profile.traction,
		profile.description,
	]
		.filter(Boolean)
		.join(". ");
}
