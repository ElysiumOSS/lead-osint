import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { LeadRepository } from "./core/repository.js";
import { createHandler } from "./server.js";

function setup() {
	const store = openDatabase(":memory:");
	const repo = new LeadRepository(store);
	repo.upsertLead({
		id: "L1",
		fullName: "Ada Sample",
		title: "Founder",
		source: "sessions",
	});
	return { store, repo, handler: createHandler(repo) };
}

const get = (h: ReturnType<typeof createHandler>, path: string) =>
	h(new Request(`http://x${path}`));
const post = (
	h: ReturnType<typeof createHandler>,
	path: string,
	bodyObj: unknown,
) =>
	h(
		new Request(`http://x${path}`, {
			method: "POST",
			body: JSON.stringify(bodyObj),
		}),
	);

describe("server API", () => {
	it("serves the dashboard HTML", async () => {
		const { handler, store } = setup();
		const res = await get(handler, "/");
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("live CRM");
		store.close();
	});

	it("returns graph data with leads", async () => {
		const { handler, store } = setup();
		const data = (await (await get(handler, "/api/data")).json()) as {
			leads: unknown[];
		};
		expect(data.leads).toHaveLength(1);
		store.close();
	});

	it("moves a lead's stage and persists it", async () => {
		const { handler, repo, store } = setup();
		const res = await post(handler, "/api/lead/L1/stage", {
			stage: "contacted",
		});
		expect(res.status).toBe(200);
		expect(repo.getLead("L1")?.stage).toBe("contacted");
		store.close();
	});

	it("rejects an invalid stage", async () => {
		const { handler, store } = setup();
		const res = await post(handler, "/api/lead/L1/stage", { stage: "bogus" });
		expect(res.status).toBe(400);
		store.close();
	});

	it("adds a note and a due reminder, then lists it", async () => {
		const { handler, repo, store } = setup();
		await post(handler, "/api/lead/L1/note", { note: "met at mixer" });
		expect(repo.getLead("L1")?.notes).toContain("met at mixer");

		await post(handler, "/api/lead/L1/remind", {
			when: "2020-01-01",
			note: "ping",
		});
		const due = (await (await get(handler, "/api/due")).json()) as unknown[];
		expect(due).toHaveLength(1);
		store.close();
	});

	it("404s an unknown lead", async () => {
		const { handler, store } = setup();
		expect((await get(handler, "/api/lead/nope")).status).toBe(404);
		store.close();
	});

	it("slims the /api/data leads payload but keeps full detail per lead", async () => {
		const { handler, repo, store } = setup();
		repo.enrichLead("L1", { note: "private dossier detail" });
		const data = (await (await get(handler, "/api/data")).json()) as {
			leads: Record<string, unknown>[];
		};
		const lead = data.leads[0] as Record<string, unknown>;
		// List/graph fields present…
		expect(lead).toHaveProperty("relationship");
		expect(lead).toHaveProperty("pitchFit");
		// …heavy fields excluded from the bulk payload.
		expect(lead).not.toHaveProperty("notes");
		expect(lead).not.toHaveProperty("email");
		// Full detail still available on demand.
		const detail = (await (await get(handler, "/api/lead/L1")).json()) as {
			lead: { notes?: string };
		};
		expect(detail.lead.notes).toContain("private dossier detail");
		store.close();
	});

	it("exports a CSV download of the leads", async () => {
		const { handler, store } = setup();
		const res = await get(handler, "/api/export?format=csv");
		expect(res.headers.get("content-type")).toContain("text/csv");
		expect(res.headers.get("content-disposition")).toContain("leads.csv");
		const csv = await res.text();
		expect(csv.split("\r\n")[0]).toContain("Name");
		expect(csv).toContain("Ada Sample");
		store.close();
	});

	it("export respects the relationship filter", async () => {
		const { handler, repo, store } = setup();
		repo.setAssessment("L1", {
			relevance: 0.8,
			relationship: "investor",
			rationale: "x",
		});
		const investors = await (
			await get(handler, "/api/export?format=csv&rel=investor")
		).text();
		expect(investors).toContain("Ada Sample");
		const customers = await (
			await get(handler, "/api/export?format=csv&rel=customer")
		).text();
		expect(customers).not.toContain("Ada Sample"); // header only
		store.close();
	});

	it("gzip-compresses large responses when the client accepts it", async () => {
		const { handler, store } = setup();
		const gz = await handler(
			new Request("http://x/", { headers: { "accept-encoding": "gzip" } }),
		);
		expect(gz.headers.get("content-encoding")).toBe("gzip");
		const plain = await handler(new Request("http://x/"));
		expect(plain.headers.get("content-encoding")).toBeNull();
		store.close();
	});
});
