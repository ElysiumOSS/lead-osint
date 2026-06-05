import { describe, expect, it } from "vitest";
import { parseOcrResponse } from "./ocr/gemini-ocr.js";
import { parseDraft } from "./outreach/draft.js";

describe("parseOcrResponse", () => {
	it("parses clean JSON into RawContacts tagged as ocr", () => {
		const json = JSON.stringify({
			contacts: [
				{
					fullName: "Ada Sample",
					email: "ada@hooli.test",
					company: "Hooli",
					phones: ["+1-555", ""],
				},
			],
		});
		const contacts = parseOcrResponse(json, "card.png");
		expect(contacts).toHaveLength(1);
		expect(contacts[0]?.source).toBe("ocr");
		expect(contacts[0]?.sourceRef).toBe("card.png");
		expect(contacts[0]?.phones).toEqual(["+1-555"]);
	});

	it("tolerates code fences / surrounding prose", () => {
		const text =
			'Here you go:\n```json\n{"contacts":[{"fullName":"Bo Tanaka"}]}\n```';
		expect(parseOcrResponse(text)[0]?.fullName).toBe("Bo Tanaka");
	});

	it("throws on non-JSON", () => {
		expect(() => parseOcrResponse("not json at all")).toThrow();
	});
});

describe("parseDraft", () => {
	it("extracts subject + body", () => {
		const out = parseDraft(
			'prefix {"subject":"Hi","body":"Hello there"} suffix',
		);
		expect(out).toEqual({ subject: "Hi", body: "Hello there" });
	});

	it("returns null when fields missing", () => {
		expect(parseDraft('{"subject":"only"}')).toBeNull();
		expect(parseDraft("no json")).toBeNull();
	});
});
