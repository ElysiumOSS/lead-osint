import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { normalizeOrg } from "./core/ids.js";
import { LeadRepository } from "./core/repository.js";
import { applyOrgDedupe, planOrgDedupe } from "./dedupe.js";
import { parseOcrResponse } from "./ocr/gemini-ocr.js";
import { findNodes, shortestPath } from "./paths.js";
import { explainMatch, hybridSearch } from "./search.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

describe("normalizeOrg + org dedup", () => {
	it("collapses legal suffixes / variants", () => {
		expect(normalizeOrg("Capital One")).toBe("capital one");
		expect(normalizeOrg("Capital One Bank")).toBe("capital one");
		expect(normalizeOrg("Capital One, Inc.")).toBe("capital one");
	});

	it("merges org variants and repoints lead org_id", () => {
		const { store, repo } = freshRepo();
		const a = repo.upsertOrg("Capital One");
		const b = repo.upsertOrg("Capital One Bank");
		expect(a).not.toBe(b);
		const lead = repo.upsertLead({
			id: "L",
			fullName: "Pat",
			orgId: b,
			source: "ocr",
		});
		expect(lead.orgId).toBe(b);

		const plans = planOrgDedupe(repo);
		expect(plans).toHaveLength(1);
		const res = applyOrgDedupe(repo, plans);
		expect(res.merged).toBe(1);
		expect(repo.counts().orgs).toBe(1);
		expect(repo.getLead("L")?.orgId).toBe(plans[0]?.keep.id);
		store.close();
	});
});

describe("OCR confidence filtering", () => {
	it("drops low-confidence and nameless rows", () => {
		const json = JSON.stringify({
			contacts: [
				{ fullName: "Ada Sample", title: "Founder", confidence: 0.95 },
				{ fullName: "Blurry Row", confidence: 0.2 }, // too low
				{ fullName: "X", confidence: 0.9 }, // single token, no other field
			],
		});
		const out = parseOcrResponse(json, "dir.png", 0.45);
		expect(out).toHaveLength(1);
		expect(out[0]?.fullName).toBe("Ada Sample");
	});

	it("keeps confident single-token name when it has a contact field", () => {
		const json = JSON.stringify({
			contacts: [{ fullName: "Madonna", email: "m@x.test", confidence: 0.9 }],
		});
		expect(parseOcrResponse(json, undefined, 0.45)).toHaveLength(1);
	});
});

describe("hybrid search + why (keyword path)", () => {
	it("matches by keyword and explains why", async () => {
		const { store, repo } = freshRepo();
		repo.upsertLead({
			id: "1",
			fullName: "Ada Sample",
			title: "Robotics Founder",
			source: "sessions",
		});
		repo.upsertLead({
			id: "2",
			fullName: "Bob Other",
			title: "Accountant",
			source: "sessions",
		});
		const hits = await hybridSearch(repo, "robotics", 10);
		expect(hits[0]?.lead.id).toBe("1");
		expect(hits[0]?.why).toContain("robotics");
		store.close();
	});

	it("explainMatch finds query tokens in lead text", () => {
		const lead = {
			fullName: "Ada Sample",
			title: "Infra Engineer",
			notes: null,
			email: null,
		} as never;
		expect(explainMatch("infra engineer", lead)).toEqual(
			expect.arrayContaining(["infra", "engineer"]),
		);
	});
});

describe("warm-intro path finder", () => {
	it("finds the shared-org chain between two people", () => {
		const { store, repo } = freshRepo();
		const org = repo.upsertOrg("Hooli");
		repo.upsertLead({
			id: "A",
			fullName: "Ada",
			orgId: org,
			source: "sessions",
		});
		repo.upsertLead({
			id: "B",
			fullName: "Bob",
			orgId: org,
			source: "sessions",
		});
		repo.link("lead", "A", "org", org, "works_at");
		repo.link("lead", "B", "org", org, "works_at");

		const path = shortestPath(repo, "A", "B");
		expect(path?.nodes.map((n) => n.id)).toEqual(["A", org, "B"]);
		expect(path?.rels).toEqual(["works_at", "works_at"]);
		store.close();
	});

	it("resolves a node ref and returns null when disconnected", () => {
		const { store, repo } = freshRepo();
		repo.upsertLead({ id: "A", fullName: "Ada Lovelace", source: "sessions" });
		repo.upsertLead({ id: "B", fullName: "Zed Zonk", source: "sessions" });
		expect(findNodes(repo, "Ada").map((n) => n.id)).toContain("A");
		expect(shortestPath(repo, "A", "B")).toBeNull();
		store.close();
	});
});
