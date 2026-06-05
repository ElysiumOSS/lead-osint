import { describe, expect, it } from "vitest";
import { normalizedKeywordScore, scoreText } from "./keywords.js";
import { buildResult, extractDescription } from "./partiful.js";
import { parseSessions } from "./sessions.js";

const sessionsFixture = [
	{
		friendly_id: "S1",
		title: "Scaling LLM Inference",
		status: "accepted",
		starts_at: "2026-06-10T15:00:00Z",
		description: "<p>For <b>founders</b>.</p>",
		speakers: [
			{
				full_name: "Ada Sample",
				first_name: "Ada",
				email: "ada@hooli.test",
				company_name: "Hooli",
				title: "Founder",
				phone_mobile: "+1-555",
				linkedin_url: "https://l/ada",
			},
		],
	},
	{
		friendly_id: "S3",
		title: "Nope",
		status: "rejected",
		speakers: [{ full_name: "Skip" }],
	},
];

describe("keywords", () => {
	it("matches whole words case-insensitively", () => {
		const { score, matches } = scoreText(
			"A Founder raising a seed round for an AI startup",
		);
		expect(matches).toEqual(
			expect.arrayContaining(["founder", "seed", "AI", "startup"]),
		);
		expect(score).toBeGreaterThanOrEqual(4);
	});

	it("does not match substrings across word boundaries", () => {
		expect(scoreText("nightmarish").matches).not.toContain("AI");
	});

	it("normalizes with diminishing returns", () => {
		expect(normalizedKeywordScore(0)).toBe(0);
		expect(normalizedKeywordScore(10)).toBe(1);
		expect(normalizedKeywordScore(2, 4)).toBeCloseTo(0.5);
	});
});

describe("parseSessions", () => {
	it("keeps only accepted sessions and maps fields", () => {
		const contacts = parseSessions(sessionsFixture);
		expect(contacts).toHaveLength(1);
		const c = contacts[0]!;
		expect(c.fullName).toBe("Ada Sample");
		expect(c.email).toBe("ada@hooli.test");
		expect(c.company).toBe("Hooli");
		expect(c.phones).toEqual(["+1-555"]);
		expect(c.relation).toBe("speaks_at");
		expect(c.event?.name).toBe("Scaling LLM Inference");
	});
});

describe("partiful", () => {
	it("builds events + host leads with the given source", () => {
		const result = buildResult(
			[
				{
					name: "Founders Dinner",
					externalHref: "https://partiful.com/e/x",
					facets: { hosts: [{ label: "Pat Host" }] },
					date: "2026-06-10",
				},
			],
			"event-listings",
		);
		expect(result.events[0]?.source).toBe("event-listings");
		expect(result.contacts[0]?.fullName).toBe("Pat Host");
		expect(result.contacts[0]?.relation).toBe("hosts");
	});

	it("captures attendees as `attended` edges", () => {
		const result = buildResult(
			[
				{
					name: "AI Mixer",
					externalHref: "https://partiful.com/e/y",
					facets: { hosts: [{ label: "Host A" }] },
					attendees: [
						{ name: "Ada Guest", headline: "SWE @ Google" },
						{ label: "Bo Guest" },
						{ name: "" },
					],
				},
			],
			"partiful",
		);
		const byRel = result.contacts.map((c) => `${c.fullName}:${c.relation}`);
		expect(byRel).toContain("Ada Guest:attended");
		expect(byRel).toContain("Bo Guest:attended");
		expect(byRel).toContain("Host A:hosts");
		expect(result.contacts.find((c) => c.fullName === "Ada Guest")?.title).toBe(
			"SWE @ Google",
		);
	});

	it("extracts description from og:description meta fallback", () => {
		const html = `<html><head><meta property="og:description" content="A great &amp; fun event"></head></html>`;
		expect(extractDescription(html)).toBe("A great & fun event");
	});
});
