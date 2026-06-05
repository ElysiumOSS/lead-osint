import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { EMBED_DIM } from "./core/embeddings.js";
import { LeadRepository } from "./core/repository.js";
import { mapExtractResponse } from "./ingest/ai-extract.js";
import { parseLuma } from "./ingest/luma.js";
import { normalizeInto } from "./ingest/normalize.js";
import { buildDump, renderDumpMarkdown } from "./view/dump.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

describe("parseLuma", () => {
	it("parses calendar entries with hosts", () => {
		const result = parseLuma({
			entries: [
				{
					event: {
						name: "Founder Mixer",
						start_at: "2026-06-10",
						url: "https://lu.ma/x",
					},
					hosts: [{ name: "Pat Host", email: "pat@host.test" }],
				},
			],
		});
		expect(result.events[0]?.name).toBe("Founder Mixer");
		expect(result.events[0]?.source).toBe("luma");
		expect(result.contacts[0]?.fullName).toBe("Pat Host");
		expect(result.contacts[0]?.relation).toBe("hosts");
	});

	it("parses a flat guest list", () => {
		const result = parseLuma({
			event: { name: "Dinner" },
			guests: [{ user: { name: "Gail Guest", email: "g@guest.test" } }],
		});
		expect(result.contacts[0]?.fullName).toBe("Gail Guest");
		expect(result.contacts[0]?.relation).toBe("attended");
		expect(result.contacts[0]?.event?.name).toBe("Dinner");
	});

	it("keeps Instagram (no column) by folding it into the note", () => {
		const result = parseLuma({
			event: { name: "dApp Kickstart" },
			guests: [
				{
					name: "Iggy Gram",
					twitter: "https://x.com/iggy",
					instagram: "https://instagram.com/iggy",
				},
			],
		});
		const c = result.contacts[0];
		expect(c?.twitter).toBe("https://x.com/iggy");
		expect(c?.notes).toContain('Guest of "dApp Kickstart"');
		expect(c?.notes).toContain("IG: https://instagram.com/iggy");
	});
});

describe("mapExtractResponse (AI paste)", () => {
	it("maps contacts with optional event and tags source", () => {
		const json = JSON.stringify({
			contacts: [
				{
					fullName: "Ada Sample",
					company: "Hooli",
					event: { name: "TechWeek Panel", date: "2026-06-10" },
				},
			],
		});
		const out = mapExtractResponse(json, "paste");
		expect(out[0]?.source).toBe("paste");
		expect(out[0]?.relation).toBe("attended");
		expect(out[0]?.event?.name).toBe("TechWeek Panel");
	});

	it("drops empty event scaffolding the model sometimes emits", () => {
		const json = JSON.stringify({
			contacts: [
				{ fullName: "Bo", event: { name: "", date: "", location: "" } },
			],
		});
		const out = mapExtractResponse(json, "paste");
		expect(out[0]?.event).toBeNull();
		expect(out[0]?.relation).toBeNull();
	});
});

describe("repository.enrichLead", () => {
	it("fills gaps, appends note, and clears the embedding", () => {
		const { store, repo } = freshRepo();
		const lead = repo.upsertLead({
			id: "x",
			fullName: "Ada",
			source: "sessions",
		});
		repo.setLeadVector(lead.id, new Float32Array(EMBED_DIM).fill(0.1));
		expect(repo.leadsMissingVectors()).toHaveLength(0);

		const changed = repo.enrichLead(lead.id, {
			website: "https://ada.dev",
			note: "from github",
		});
		expect(changed).toBe(true);
		const after = repo.getLead(lead.id);
		expect(after?.website).toBe("https://ada.dev");
		expect(after?.notes).toContain("from github");
		// embedding cleared so `embed` re-vectorizes
		expect(repo.leadsMissingVectors().map((p) => p.id)).toContain(lead.id);

		// no-op enrichment reports no change
		expect(repo.enrichLead(lead.id, { website: "https://other" })).toBe(false);
		store.close();
	});
});

describe("dump", () => {
	it("builds dossiers and renders markdown", () => {
		const { store, repo } = freshRepo();
		normalizeInto(repo, {
			contacts: [
				{
					fullName: "Ada Sample",
					company: "Hooli",
					title: "Founder",
					phones: [],
					source: "sessions",
					relation: "speaks_at",
					event: { name: "AI Panel", source: "sessions" },
				},
			],
			events: [],
		});
		const dump = buildDump(repo, "2026-06-02T00:00:00.000Z");
		expect(dump.count).toBe(1);
		expect(dump.leads[0]?.org?.name).toBe("Hooli");
		expect(dump.leads[0]?.events[0]?.name).toBe("AI Panel");
		const md = renderDumpMarkdown(dump);
		expect(md).toContain("# Lead-OSINT — Information Dump");
		expect(md).toContain("Ada Sample");
		expect(md).toContain("Hooli");
		store.close();
	});
});
