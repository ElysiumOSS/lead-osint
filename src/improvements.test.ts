import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { modelChain } from "./core/gemini.js";
import { leadId, normalizeName } from "./core/ids.js";
import { LeadRepository } from "./core/repository.js";
import { applyDedupe, planDedupe } from "./dedupe.js";
import { normalizeInto } from "./ingest/normalize.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

describe("normalizeName", () => {
	it("strips honorifics, suffixes, punctuation", () => {
		expect(normalizeName("Dr. Bernard  Jones Jr.")).toBe("bernard jones");
		expect(normalizeName("MEREDITH MARK")).toBe("meredith mark");
		expect(normalizeName("José Núñez")).toBe("jose nunez");
	});
});

describe("modelChain", () => {
	it("puts preferred first and de-dupes the fallback chain", () => {
		expect(modelChain("gemini-2.5-flash")[0]).toBe("gemini-2.5-flash");
		expect(new Set(modelChain("gemini-2.5-flash")).size).toBe(
			modelChain("gemini-2.5-flash").length,
		);
		expect(modelChain(undefined)[0]).toBe("gemini-2.5-flash");
	});
});

describe("dedupe + mergeLeads", () => {
	it("merges name variants when at most one email exists", () => {
		const { store, repo } = freshRepo();
		// same person, two sources: sessions (with email) + OCR (name only, no email)
		const a = leadId({ email: "bj@pwc.test", name: "Dr. Bernard Jones Jr." });
		const b = leadId({ name: "Bernard Jones" });
		expect(a).not.toBe(b);
		repo.upsertLead({
			id: a,
			fullName: "Dr. Bernard Jones Jr.",
			email: "bj@pwc.test",
			source: "sessions",
		});
		repo.upsertLead({
			id: b,
			fullName: "Bernard Jones",
			title: "Director",
			source: "ocr",
		});

		const plans = planDedupe(repo);
		expect(plans).toHaveLength(1);
		expect(plans[0]?.keep.id).toBe(a); // the one with an email survives
		const res = applyDedupe(repo, plans);
		expect(res.merged).toBe(1);
		expect(repo.counts().leads).toBe(1);
		const merged = repo.getLead(a);
		expect(merged?.email).toBe("bj@pwc.test");
		expect(merged?.title).toBe("Director"); // filled from the dropped record
		store.close();
	});

	it("does NOT merge namesakes with different emails", () => {
		const { store, repo } = freshRepo();
		repo.upsertLead({
			id: "1",
			fullName: "John Smith",
			email: "john@a.test",
			source: "sessions",
		});
		repo.upsertLead({
			id: "2",
			fullName: "John Smith",
			email: "john@b.test",
			source: "sessions",
		});
		expect(planDedupe(repo)).toHaveLength(0);
		store.close();
	});

	it("repoints edges onto the surviving lead", () => {
		const { store, repo } = freshRepo();
		const a = leadId({ email: "x@x.test", name: "Ada Lovelace" });
		const b = leadId({ name: "Ada Lovelace" });
		repo.upsertLead({
			id: a,
			fullName: "Ada Lovelace",
			email: "x@x.test",
			source: "sessions",
		});
		repo.upsertLead({ id: b, fullName: "Ada Lovelace", source: "ocr" });
		const org = repo.upsertOrg("Hooli");
		repo.link("lead", b, "org", org, "works_at");
		applyDedupe(repo, planDedupe(repo));
		const edges = repo.listEdges();
		expect(edges).toHaveLength(1);
		expect(edges[0]?.srcId).toBe(a); // edge moved from dropped b -> kept a
		store.close();
	});
});

describe("richer embedding text", () => {
	it("includes org + connected events", () => {
		const { store, repo } = freshRepo();
		normalizeInto(repo, {
			contacts: [
				{
					fullName: "Ada Sample",
					title: "Founder",
					company: "Hooli",
					phones: [],
					source: "sessions",
					relation: "speaks_at",
					event: { name: "AI Infra Panel", source: "sessions" },
				},
			],
			events: [],
		});
		const pending = repo.leadsMissingVectors();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.text).toContain("Hooli");
		expect(pending[0]?.text).toContain("AI Infra Panel");
		store.close();
	});
});
