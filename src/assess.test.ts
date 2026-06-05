import { describe, expect, it } from "vitest";
import { parseAssessment } from "./assess.js";
import { openDatabase } from "./core/db.js";
import { LeadRepository } from "./core/repository.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return new LeadRepository(store);
}

function makeLead(repo: LeadRepository, id: string, name: string) {
	return repo.upsertLead({ id, fullName: name, source: "test" });
}

describe("parseAssessment", () => {
	it("parses a clean 0-100 response and scales to 0-1", () => {
		const a = parseAssessment(
			'{"relevance": 80, "relationship": "investor", "rationale": "Leads a fund in our space."}',
		);
		expect(a).not.toBeNull();
		expect(a?.relevance).toBeCloseTo(0.8);
		expect(a?.relationship).toBe("investor");
		expect(a?.rationale).toBe("Leads a fund in our space.");
	});

	it("accepts a 0-1 relevance as-is", () => {
		const a = parseAssessment(
			'{"relevance": 0.42, "relationship": "customer", "rationale": "x"}',
		);
		expect(a?.relevance).toBeCloseTo(0.42);
	});

	it("extracts JSON from surrounding prose", () => {
		const a = parseAssessment(
			'Sure! Here is the result:\n{"relevance": 55, "relationship": "partner", "rationale": "y"} — done.',
		);
		expect(a?.relationship).toBe("partner");
		expect(a?.relevance).toBeCloseTo(0.55);
	});

	it("coerces an unknown relationship to 'other'", () => {
		const a = parseAssessment(
			'{"relevance": 10, "relationship": "frenemy", "rationale": "z"}',
		);
		expect(a?.relationship).toBe("other");
	});

	it("clamps out-of-range relevance into [0,1]", () => {
		expect(
			parseAssessment(
				'{"relevance": 250, "relationship": "expert", "rationale": "a"}',
			)?.relevance,
		).toBe(1);
		expect(
			parseAssessment(
				'{"relevance": -5, "relationship": "expert", "rationale": "a"}',
			)?.relevance,
		).toBe(0);
	});

	it("returns null when there is no JSON", () => {
		expect(parseAssessment("no json here")).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		expect(parseAssessment('{"relevance": 80, "relationship":}')).toBeNull();
	});
});

describe("repository assessment", () => {
	it("setAssessment persists fields and blends pitch_fit", () => {
		const repo = freshRepo();
		makeLead(repo, "l1", "Ada Lovelace");
		repo.setAssessment("l1", {
			relevance: 0.9,
			relationship: "advisor",
			rationale: "Deep domain expertise.",
			pitchFit: 0.74,
		});
		const lead = repo.getLead("l1");
		expect(lead?.relevance).toBeCloseTo(0.9);
		expect(lead?.relationship).toBe("advisor");
		expect(lead?.rationale).toBe("Deep domain expertise.");
		expect(lead?.pitchFit).toBeCloseTo(0.74);
	});

	it("setAssessment without pitchFit preserves existing pitch_fit", () => {
		const repo = freshRepo();
		makeLead(repo, "l2", "Grace Hopper");
		repo.setAssessment("l2", {
			relevance: 0.5,
			relationship: "hire",
			rationale: "r",
			pitchFit: 0.6,
		});
		repo.setAssessment("l2", {
			relevance: 0.55,
			relationship: "hire",
			rationale: "r2",
		});
		expect(repo.getLead("l2")?.pitchFit).toBeCloseTo(0.6);
	});

	it("leadsUnassessed returns only leads without a relevance score", () => {
		const repo = freshRepo();
		makeLead(repo, "a", "A");
		makeLead(repo, "b", "B");
		repo.setAssessment("a", {
			relevance: 0.3,
			relationship: "other",
			rationale: "x",
		});
		const unassessed = repo.leadsUnassessed().map((l) => l.id);
		expect(unassessed).toContain("b");
		expect(unassessed).not.toContain("a");
	});

	it("listLeads filters by relationship", () => {
		const repo = freshRepo();
		makeLead(repo, "inv", "Investor Person");
		makeLead(repo, "cust", "Customer Person");
		repo.setAssessment("inv", {
			relevance: 0.8,
			relationship: "investor",
			rationale: "x",
		});
		repo.setAssessment("cust", {
			relevance: 0.7,
			relationship: "customer",
			rationale: "y",
		});
		const investors = repo.listLeads({ relationship: "investor" });
		expect(investors.map((l) => l.id)).toEqual(["inv"]);
	});
});
