import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../core/db.js";
import { leadId } from "../core/ids.js";
import { LeadRepository } from "../core/repository.js";
import { parseAirtable } from "./airtable.js";
import { normalizeInvestorsInto, warmContactForInvestor } from "./investors.js";
import { parseOpenVc } from "./openvc.js";

const openvcCsv = readFileSync(
	join(import.meta.dir, "../../test/fixtures/openvc.sample.csv"),
	"utf-8",
);
const airtableCsv = readFileSync(
	join(import.meta.dir, "../../test/fixtures/airtable.sample.csv"),
	"utf-8",
);

describe("parseOpenVc", () => {
	it("parses firms with canonical stages, geo, and cheque sizes", () => {
		// Act
		const investors = parseOpenVc(openvcCsv);
		// Assert
		expect(investors).toHaveLength(3);
		const acme = investors[0];
		expect(acme.name).toBe("Acme Seed Partners");
		expect(acme.domain).toBe("acme.vc");
		expect(acme.stages).toContain("seed");
		expect(acme.geo).toEqual(["us", "canada"]);
		expect(acme.checkMin).toBe(100000);
		expect(acme.checkMax).toBe(1_000_000);
		// The multiline quoted thesis survived CSV parsing.
		expect(acme.thesis).toContain("shipping fast");
	});
});

describe("parseAirtable", () => {
	it("parses firms with sectors, partner, and portfolio", () => {
		const investors = parseAirtable(airtableCsv);
		const northwind = investors.find((i) => i.name === "Northwind Ventures");
		expect(northwind).toBeDefined();
		expect(northwind?.stages).toEqual(["seed", "series-a"]);
		expect(northwind?.sectors).toContain("fintech");
		expect(northwind?.partnerEmail).toBe("dana@northwind.example");
		expect(northwind?.portfolio).toEqual(["Stripe", "Plaid"]);
	});
});

describe("normalizeInvestorsInto", () => {
	it("upserts firms idempotently (re-running does not duplicate)", () => {
		// Arrange
		const store = openDatabase(":memory:");
		const repo = new LeadRepository(store);
		const records = parseOpenVc(openvcCsv);
		// Act
		normalizeInvestorsInto(repo, records);
		normalizeInvestorsInto(repo, records); // run twice
		// Assert
		expect(repo.counts().investors).toBe(3);
		store.close();
	});
});

describe("warmContactForInvestor", () => {
	it("resolves an investor's partner to an existing lead by email", () => {
		// Arrange: a person already in the CRM, then ingest a firm whose partner is them.
		const store = openDatabase(":memory:");
		const repo = new LeadRepository(store);
		const id = leadId({ email: "dana@northwind.example" });
		repo.upsertLead({
			id,
			fullName: "Dana Lee",
			email: "dana@northwind.example",
			source: "test",
		});
		normalizeInvestorsInto(repo, parseAirtable(airtableCsv));
		const northwind = repo.findInvestors("Northwind")[0];
		// Act
		const warm = warmContactForInvestor(repo, northwind);
		// Assert
		expect(warm?.fullName).toBe("Dana Lee");
		store.close();
	});

	it("returns null for a cold firm with no matching contact", () => {
		const store = openDatabase(":memory:");
		const repo = new LeadRepository(store);
		normalizeInvestorsInto(repo, parseOpenVc(openvcCsv));
		const acme = repo.findInvestors("Acme")[0];
		expect(warmContactForInvestor(repo, acme)).toBeNull();
		store.close();
	});
});
