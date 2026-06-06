import { describe, expect, it } from "vitest";
import {
	normalizeGeo,
	normalizeSectors,
	normalizeStages,
	parseCheck,
	splitList,
} from "./investor-normalize.js";

describe("normalizeStages", () => {
	it("maps OpenVC numbered ladder onto canonical stages", () => {
		// Arrange + Act
		const stages = normalizeStages(
			"1. Idea or Patent,2. Prototype,3. Early Revenue",
		);
		// Assert — idea/pre-seed/seed/series-a, in canonical order
		expect(stages).toEqual(["idea", "pre-seed", "seed", "series-a"]);
	});

	it("maps Airtable round names", () => {
		expect(normalizeStages("Pre-Seed,Seed,Series A")).toEqual([
			"pre-seed",
			"seed",
			"series-a",
		]);
	});

	it("maps growth + late series to canonical buckets", () => {
		expect(normalizeStages("4. Scaling,5. Growth")).toEqual([
			"series-a",
			"series-b",
			"growth",
		]);
		expect(normalizeStages("Series C,Series D")).toEqual(["series-c"]);
	});

	it("returns empty for unrecognized input", () => {
		expect(normalizeStages("")).toEqual([]);
		expect(normalizeStages("whenever")).toEqual([]);
	});
});

describe("normalizeSectors / normalizeGeo", () => {
	it("lowercases and de-duplicates sectors", () => {
		expect(normalizeSectors("FinTech, SaaS, fintech")).toEqual([
			"fintech",
			"saas",
		]);
	});

	it("folds geo aliases to canonical tokens", () => {
		expect(normalizeGeo("USA,United States,UK,Worldwide")).toEqual([
			"us",
			"uk",
			"global",
		]);
	});
});

describe("parseCheck", () => {
	it("parses dollar amounts with commas", () => {
		expect(parseCheck("$250,000")).toBe(250000);
	});

	it("parses k/m/b suffixes", () => {
		expect(parseCheck("$1M")).toBe(1_000_000);
		expect(parseCheck("2.5m")).toBe(2_500_000);
		expect(parseCheck("500k")).toBe(500_000);
	});

	it("returns null for junk", () => {
		expect(parseCheck("")).toBeNull();
		expect(parseCheck("n/a")).toBeNull();
	});
});

describe("splitList", () => {
	it("splits on commas, slashes, semicolons, newlines", () => {
		expect(splitList("a, b/c;d\ne")).toEqual(["a", "b", "c", "d", "e"]);
	});
});
