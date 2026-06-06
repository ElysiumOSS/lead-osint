import { describe, expect, it } from "vitest";
import { openDatabase } from "../core/db.js";
import { EMBED_DIM } from "../core/embeddings.js";
import { LeadRepository } from "../core/repository.js";
import type { Investor } from "../core/schema.js";
import {
	checkScore,
	geoScore,
	jaccard,
	matchInvestors,
	scoreInvestor,
	stageScore,
} from "./match.js";
import { parseProfile, type StartupProfile } from "./startup-profile.js";

/** One-hot 384-d vector so cosine ordering is trivially predictable. */
function oneHot(i: number): Float32Array {
	const v = new Float32Array(EMBED_DIM);
	v[i % EMBED_DIM] = 1;
	return v;
}

const profile: StartupProfile = parseProfile({
	stage: "seed",
	sectors: ["fintech"],
	geo: { hq: "us", targetMarkets: ["us"] },
	raising: { checkTarget: 500000 },
});

function inv(p: Partial<Investor>): Investor {
	return {
		id: "x",
		name: "X",
		domain: null,
		website: null,
		hq: null,
		stages: [],
		sectors: [],
		geo: [],
		checkMin: null,
		checkMax: null,
		investorType: null,
		thesis: null,
		partnerName: null,
		partnerEmail: null,
		twitter: null,
		linkedin: null,
		portfolio: [],
		source: "test",
		sourceRef: null,
		matchScore: null,
		matchBreakdown: null,
		notes: null,
		createdAt: "",
		updatedAt: "",
		...p,
	};
}

describe("stageScore", () => {
	it("scores 1 on a backed stage, 0.5 adjacent, 0 far, neutral if unknown", () => {
		expect(stageScore(profile, inv({ stages: ["seed"] }))).toBe(1);
		expect(stageScore(profile, inv({ stages: ["pre-seed"] }))).toBe(0.5);
		expect(stageScore(profile, inv({ stages: ["growth"] }))).toBe(0);
		expect(stageScore(profile, inv({ stages: [] }))).toBe(0.5);
	});
});

describe("jaccard", () => {
	it("computes set overlap", () => {
		expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
		expect(jaccard([], ["a"])).toBe(0);
	});
});

describe("geoScore / checkScore", () => {
	it("geo: 1 on overlap or global, 0 on confirmed mismatch", () => {
		expect(geoScore(profile, inv({ geo: ["us"] }))).toBe(1);
		expect(geoScore(profile, inv({ geo: ["global"] }))).toBe(1);
		expect(geoScore(profile, inv({ geo: ["canada"] }))).toBe(0);
	});

	it("check: 1 inside the band, 0.5 near, 0 far", () => {
		expect(
			checkScore(profile, inv({ checkMin: 100000, checkMax: 1000000 })),
		).toBe(1);
		expect(
			checkScore(profile, inv({ checkMin: 700000, checkMax: 2000000 })),
		).toBe(0.5);
		expect(
			checkScore(profile, inv({ checkMin: 5000000, checkMax: 10000000 })),
		).toBe(0);
	});
});

describe("scoreInvestor", () => {
	it("blends factors into a score with breakdown", () => {
		// Arrange: a perfect-stage, strong-sector, in-geo, in-check firm
		const investor = inv({
			stages: ["seed", "series-a"],
			sectors: ["fintech", "saas"],
			geo: ["us"],
			checkMin: 100000,
			checkMax: 1000000,
		});
		// Act — semantic thesis cosine of 1
		const { score, breakdown } = scoreInvestor(profile, investor, 1);
		// Assert
		expect(breakdown.stage).toBe(1);
		expect(breakdown.geo).toBe(1);
		expect(breakdown.check).toBe(1);
		expect(score).toBeGreaterThan(0.85);
	});
});

describe("matchInvestors", () => {
	it("ranks a fitting firm first and honors --require-stage", () => {
		// Arrange
		const store = openDatabase(":memory:");
		const repo = new LeadRepository(store);
		repo.upsertInvestor({
			id: "inv_fit",
			name: "Fit Fund",
			stages: ["seed", "series-a"],
			sectors: ["fintech"],
			geo: ["us"],
			checkMin: 100000,
			checkMax: 1000000,
			source: "test",
		});
		repo.upsertInvestor({
			id: "inv_off",
			name: "Off Fund",
			stages: ["growth"],
			sectors: ["cannabis"],
			geo: ["canada"],
			checkMin: 5000000,
			checkMax: 10000000,
			source: "test",
		});
		repo.setInvestorVector("inv_fit", oneHot(0));
		repo.setInvestorVector("inv_off", oneHot(5));

		// Act — pitch vector aligned with the fitting firm's thesis embedding
		const ranked = matchInvestors(repo, profile, oneHot(0));
		// Assert
		expect(ranked[0]?.investor.id).toBe("inv_fit");
		expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 1);
		// Persisted back onto the row.
		expect(repo.getInvestor("inv_fit")?.matchScore).not.toBeNull();

		// require-stage drops the off-stage firm entirely.
		const strict = matchInvestors(repo, profile, oneHot(0), {
			requireStage: true,
		});
		expect(strict.map((m) => m.investor.id)).toEqual(["inv_fit"]);
		store.close();
	});
});
