import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords, pick } from "./csv.js";

describe("parseCsv", () => {
	it("parses simple rows", () => {
		// Arrange
		const text = "a,b,c\n1,2,3";
		// Act
		const rows = parseCsv(text);
		// Assert
		expect(rows).toEqual([
			["a", "b", "c"],
			["1", "2", "3"],
		]);
	});

	it("keeps commas and newlines inside quoted fields", () => {
		const text = 'name,thesis\nAcme,"We back seed, pre-seed.\n\nFast teams."';
		const rows = parseCsv(text);
		expect(rows[1]).toEqual(["Acme", "We back seed, pre-seed.\n\nFast teams."]);
	});

	it("unescapes doubled quotes", () => {
		const rows = parseCsv('q\n"She said ""hi"""');
		expect(rows[1]).toEqual(['She said "hi"']);
	});

	it("handles CRLF line endings and a trailing newline", () => {
		const rows = parseCsv("a,b\r\n1,2\r\n");
		expect(rows).toEqual([
			["a", "b"],
			["1", "2"],
		]);
	});

	it("strips a UTF-8 BOM", () => {
		const rows = parseCsv("﻿a,b\n1,2");
		expect(rows[0]).toEqual(["a", "b"]);
	});
});

describe("parseCsvRecords", () => {
	it("keys cells by trimmed header and skips blank rows", () => {
		const recs = parseCsvRecords("Name, Stage\nAcme,Seed\n\n");
		expect(recs).toEqual([{ Name: "Acme", Stage: "Seed" }]);
	});
});

describe("pick", () => {
	it("matches header candidates case- and whitespace-insensitively", () => {
		const rec = { "Investor name": "Acme", " Fund  Stage ": "Seed" };
		expect(pick(rec, "Investor Name")).toBe("Acme");
		expect(pick(rec, "fund stage")).toBe("Seed");
	});

	it("returns the first non-empty candidate, else empty string", () => {
		const rec = { A: "", B: "x" };
		expect(pick(rec, "A", "B")).toBe("x");
		expect(pick(rec, "missing")).toBe("");
	});
});
