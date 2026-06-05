import { describe, expect, it } from "vitest";
import { openDatabase } from "./core/db.js";
import { LeadRepository } from "./core/repository.js";
import { type ExportRow, toCsv, toVcard } from "./export.js";

function freshRepo() {
	const store = openDatabase(":memory:");
	return { store, repo: new LeadRepository(store) };
}

const row: ExportRow = {
	name: "Ada Sample",
	firstName: "Ada",
	lastName: "Sample",
	email: "ada@hooli.test",
	title: "Founder, CEO", // comma → must be quoted in CSV
	company: "Hooli",
	phones: ["+1-555", "+1-666"],
	linkedin: "https://l/ada",
	twitter: "https://x/ada",
	website: "https://ada.dev",
	stage: "new",
	pitchFit: 0.66,
	source: "sessions",
	notes: 'said "hi"', // quote → escaped
};

describe("CSV export", () => {
	it("emits a header and quotes commas/quotes", () => {
		const csv = toCsv([row]);
		const [head, line] = csv.split("\r\n");
		expect(head).toContain("Name,First Name");
		expect(line).toContain('"Founder, CEO"');
		expect(line).toContain('"said ""hi"""');
		expect(line).toContain("+1-555; +1-666");
	});
});

describe("vCard export", () => {
	it("emits a valid 3.0 card with key fields", () => {
		const vcf = toVcard([row]);
		expect(vcf).toContain("BEGIN:VCARD");
		expect(vcf).toContain("VERSION:3.0");
		expect(vcf).toContain("FN:Ada Sample");
		expect(vcf).toContain("EMAIL;TYPE=INTERNET:ada@hooli.test");
		expect(vcf).toContain("TEL:+1-555");
		expect(vcf).toContain("ORG:Hooli");
		expect(vcf).toContain("END:VCARD");
	});
});

describe("reminders", () => {
	it("adds, lists due-before, and completes", () => {
		const { store, repo } = freshRepo();
		repo.upsertLead({ id: "L", fullName: "Ada", source: "sessions" });
		const past = repo.addReminder(
			"L",
			"2020-01-01T00:00:00.000Z",
			"overdue ping",
		);
		repo.addReminder("L", "2999-01-01T00:00:00.000Z", "future ping");

		const dueNow = repo.listReminders({ dueBefore: new Date().toISOString() });
		expect(dueNow).toHaveLength(1);
		expect(dueNow[0]?.note).toBe("overdue ping");

		expect(repo.listReminders()).toHaveLength(2); // all open
		expect(repo.completeReminder(past)).toBe(true);
		expect(repo.listReminders().map((r) => r.note)).toEqual(["future ping"]);
		store.close();
	});
});
