import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { LeadRepository } from "./core/repository.js";
import { applyRevalidate, planRevalidate } from "./revalidate.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

describe("revalidate", () => {
	it("flags free-email orgs + non-person leads, keeps real ones", () => {
		const { store, repo } = freshRepo();
		repo.upsertLead({ id: "ok", fullName: "Ada Sample", source: "sessions" });
		repo.upsertLead({ id: "junk", fullName: "Speaker", source: "ocr" });
		const free = repo.upsertOrg("Hooli", "gmail.com"); // free-email domain
		const real = repo.upsertOrg("Acme", "acme.com");

		const plan = planRevalidate(repo);
		expect(plan.orgs.map((o) => o.id)).toContain(free);
		expect(plan.orgs.map((o) => o.id)).not.toContain(real);
		expect(plan.leads.map((l) => l.id)).toEqual(["junk"]);

		const res = applyRevalidate(repo, plan);
		expect(res.orgsDeleted).toBe(1);
		expect(res.leadsDeleted).toBe(1);
		expect(repo.getOrg(free)).toBeNull();
		expect(repo.getLead("junk")).toBeNull();
		expect(repo.getLead("ok")).not.toBeNull();
		store.close();
	});

	it("detaches leads from a dissolved org", () => {
		const { store, repo } = freshRepo();
		const free = repo.upsertOrg("Whatever", "gmail.com");
		repo.upsertLead({
			id: "p",
			fullName: "Pat Lee",
			orgId: free,
			source: "sessions",
		});
		repo.link("lead", "p", "org", free, "works_at");

		applyRevalidate(repo, planRevalidate(repo));
		expect(repo.getLead("p")?.orgId).toBeNull();
		expect(repo.listEdges()).toHaveLength(0);
		store.close();
	});
});
