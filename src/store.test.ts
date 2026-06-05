import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { EMBED_DIM } from "./core/embeddings.js";
import { LeadRepository } from "./core/repository.js";
import { normalizeInto } from "./ingest/normalize.js";
import { parseSessions } from "./ingest/sessions.js";
import { buildViewData, renderGraphHtml } from "./view/graph-html.js";

const fixture = JSON.parse(
	readFileSync(
		join(import.meta.dir, "../test/fixtures/sessions.sample.json"),
		"utf-8",
	),
);

/** One-hot 384-d vector so cosine ordering is trivially predictable. */
function oneHot(i: number): Float32Array {
	const v = new Float32Array(EMBED_DIM);
	v[i % EMBED_DIM] = 1;
	return v;
}

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

describe("store integration", () => {
	it("normalizes sessions fixture into leads/orgs/events/edges", () => {
		const { store, repo } = freshRepo();
		const stats = normalizeInto(repo, {
			contacts: parseSessions(fixture),
			events: [],
		});
		expect(stats.leads).toBe(2); // rejected session skipped
		const counts = repo.counts();
		expect(counts.leads).toBe(2);
		expect(counts.orgs).toBe(2);
		expect(counts.events).toBe(2);
		// each lead -> org (works_at) + event (speaks_at)
		expect(counts.edges).toBe(4);
		store.close();
	});

	it("is idempotent across re-ingest", () => {
		const { store, repo } = freshRepo();
		normalizeInto(repo, { contacts: parseSessions(fixture), events: [] });
		normalizeInto(repo, { contacts: parseSessions(fixture), events: [] });
		expect(repo.counts().leads).toBe(2);
		store.close();
	});

	it("vector search returns nearest lead (sqlite-vec path)", () => {
		const { store, repo } = freshRepo();
		const a = repo.upsertLead({ id: "a", fullName: "A", source: "t" });
		const b = repo.upsertLead({ id: "b", fullName: "B", source: "t" });
		repo.setLeadVector(a.id, oneHot(0));
		repo.setLeadVector(b.id, oneHot(5));
		const matches = repo.searchSimilar(oneHot(0), 2);
		expect(matches[0]?.lead.id).toBe("a");
		expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
		store.close();
	});

	it("js-fallback produces the same top result as sqlite-vec", () => {
		const { store, repo } = freshRepo();
		const a = repo.upsertLead({ id: "a", fullName: "A", source: "t" });
		const b = repo.upsertLead({ id: "b", fullName: "B", source: "t" });
		repo.setLeadVector(a.id, oneHot(0));
		repo.setLeadVector(b.id, oneHot(5));

		const vecTop = repo.searchSimilar(oneHot(5), 2)[0]?.lead.id;
		const fallbackRepo = new LeadRepository({ ...store, hasVec: false });
		const fbTop = fallbackRepo.searchSimilar(oneHot(5), 2)[0]?.lead.id;
		expect(fbTop).toBe(vecTop);
		expect(fbTop).toBe("b");
		store.close();
	});

	it("similarityEdges links near vectors and skips distant ones", () => {
		const { store, repo } = freshRepo();
		const a = repo.upsertLead({ id: "a", fullName: "A", source: "t" });
		const b = repo.upsertLead({ id: "b", fullName: "B", source: "t" });
		const c = repo.upsertLead({ id: "c", fullName: "C", source: "t" });
		repo.setLeadVector(a.id, oneHot(0));
		repo.setLeadVector(b.id, oneHot(0)); // identical → cosine 1 with a
		repo.setLeadVector(c.id, oneHot(7)); // orthogonal → cosine 0
		const edges = repo.similarityEdges({ k: 3, minSim: 0.5 });
		const pairs = edges.map((e) => [e.source, e.target].sort().join("-"));
		expect(pairs).toContain("a-b");
		expect(pairs.some((p) => p.includes("c"))).toBe(false);
		// undirected + deduped: a-b appears once
		expect(pairs.filter((p) => p === "a-b")).toHaveLength(1);
		store.close();
	});

	it("clusters partitions leads into themed groups (k-means)", () => {
		const { store, repo } = freshRepo();
		for (const [id, slot] of [
			["a", 0],
			["b", 0],
			["c", 7],
			["d", 7],
		] as const) {
			repo.upsertLead({
				id,
				fullName: id.toUpperCase(),
				title: "x",
				source: "t",
			});
			repo.setLeadVector(id, oneHot(slot));
		}
		const clusters = repo.clusters({ k: 2, minSize: 2 });
		expect(clusters).toHaveLength(2);
		// a,b land together and c,d together (two distinct vector groups)
		const groups = clusters.map((c) =>
			c.top
				.map((m) => m.id)
				.sort()
				.join(""),
		);
		expect(groups.sort()).toEqual(["ab", "cd"]);
		store.close();
	});

	it("investorFirms lists orgs with investor-tagged members + warm contacts", () => {
		const { store, repo } = freshRepo();
		const oc = repo.upsertOrg("Acme Ventures");
		const og = repo.upsertOrg("Globex");
		repo.upsertLead({ id: "i1", fullName: "Vee Cee", orgId: oc, source: "t" });
		repo.upsertLead({ id: "i2", fullName: "Ann Gel", orgId: oc, source: "t" });
		repo.upsertLead({ id: "e1", fullName: "Eng One", orgId: og, source: "t" });
		repo.setAssessment("i1", {
			relevance: 0.9,
			relationship: "investor",
			rationale: "x",
		});
		repo.setAssessment("i2", {
			relevance: 0.6,
			relationship: "investor",
			rationale: "y",
		});
		repo.setAssessment("e1", {
			relevance: 0.5,
			relationship: "hire",
			rationale: "z",
		});
		const firms = repo.investorFirms();
		expect(firms).toHaveLength(1); // only Acme has investors
		expect(firms[0]?.name).toBe("Acme Ventures");
		expect(firms[0]?.investors).toBe(2);
		expect(firms[0]?.top[0]?.name).toBe("Vee Cee"); // best fit first
		store.close();
	});

	it("builds graph data and renders self-contained HTML", () => {
		const { store, repo } = freshRepo();
		normalizeInto(repo, { contacts: parseSessions(fixture), events: [] });
		const data = buildViewData(repo, "2026-06-02T00:00:00.000Z");
		expect(data.nodes.length).toBeGreaterThan(0);
		expect(data.leads.length).toBe(2);
		const html = renderGraphHtml(data);
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("Ada Sample");
		expect(html).not.toContain("</script><script>"); // data did not break out
		store.close();
	});
});
