import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { leadId } from "./core/ids.js";
import { LeadRepository } from "./core/repository.js";
import { parseLinkedinConnections } from "./ingest/linkedin.js";
import { normalizeInto } from "./ingest/normalize.js";
import { fromContacts } from "./ingest/types.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return new LeadRepository(store);
}

function seedConnection(repo: LeadRepository, name: string, url: string) {
	normalizeInto(
		repo,
		fromContacts(
			parseLinkedinConnections([{ name, bio: "Engineer", linkedin: url }]),
		),
	);
}

describe("findForErasure", () => {
	it("resolves a lead by its LinkedIn URL", () => {
		const repo = freshRepo();
		seedConnection(repo, "Jane Doe", "https://www.linkedin.com/in/jane-doe-1/");
		const matches = repo.findForErasure(
			"https://www.linkedin.com/in/jane-doe-1/",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.fullName).toBe("Jane Doe");
	});

	it("resolves by id and is precise (no same-name sweep)", () => {
		const repo = freshRepo();
		seedConnection(
			repo,
			"John Smith",
			"https://www.linkedin.com/in/john-smith-1/",
		);
		seedConnection(
			repo,
			"John Smith",
			"https://www.linkedin.com/in/john-smith-2/",
		);
		const id = leadId({
			linkedin: "https://www.linkedin.com/in/john-smith-1/",
		});
		const matches = repo.findForErasure(id);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.id).toBe(id);
	});

	it("falls back to name search when no exact key matches", () => {
		const repo = freshRepo();
		seedConnection(repo, "Ada Lovelace", "https://www.linkedin.com/in/ada/");
		expect(repo.findForErasure("ada lovelace").length).toBeGreaterThan(0);
		expect(repo.findForErasure("nobody here")).toHaveLength(0);
	});
});

describe("deleteLead cascades", () => {
	it("removes the lead and its interactions, idempotently", () => {
		const repo = freshRepo();
		seedConnection(repo, "Jane Doe", "https://www.linkedin.com/in/jane-doe-1/");
		const id = leadId({ linkedin: "https://www.linkedin.com/in/jane-doe-1/" });
		repo.addInteraction(id, "note", "met at mixer");
		expect(repo.getLead(id)).not.toBeNull();
		expect(repo.deleteLead(id)).toBe(true);
		expect(repo.getLead(id)).toBeNull();
		expect(repo.listInteractions(id)).toHaveLength(0);
		expect(repo.deleteLead(id)).toBe(false);
	});
});
