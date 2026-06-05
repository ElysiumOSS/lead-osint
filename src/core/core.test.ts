import { describe, expect, it } from "vitest";
import { hashId, leadId, orgId, slug } from "./ids.js";
import {
	collapseWhitespace,
	decodeEntities,
	domainOf,
	stripBoilerplate,
} from "./text.js";
import {
	cosineSimilarity,
	deserializeVector,
	serializeVector,
	topKCosine,
} from "./vector.js";

describe("text", () => {
	it("decodes entities and strips tags", () => {
		expect(decodeEntities("<p>A &amp; B<br>C</p>")).toBe("A & B\nC");
	});

	it("collapses whitespace", () => {
		expect(collapseWhitespace("  a\n\t b   c ")).toBe("a b c");
	});

	it("strips boilerplate marker", () => {
		expect(
			stripBoilerplate("Real text. This event is a part of #NYTechWeek blah"),
		).toBe("Real text.");
	});

	it("extracts domain from email and url", () => {
		expect(domainOf("ada@hooli.com")).toBe("hooli.com");
		expect(domainOf("https://www.hooli.com/team")).toBe("hooli.com");
		expect(domainOf(null)).toBeNull();
	});
});

describe("ids", () => {
	it("slugifies", () => {
		expect(slug("Pied Piper, Inc.")).toBe("pied-piper-inc");
	});

	it("hash is stable and order-independent of nullish", () => {
		expect(hashId("a", "b")).toBe(hashId("a", "b", undefined));
	});

	it("lead id is email-driven and case-insensitive", () => {
		expect(leadId({ email: "ADA@x.com" })).toBe(leadId({ email: "ada@x.com" }));
	});

	it("lead id falls back to name+org when no email", () => {
		const a = leadId({ name: "Ada", org: "Hooli" });
		expect(a.startsWith("n_")).toBe(true);
		expect(a).not.toBe(leadId({ name: "Ada", org: "PiedPiper" }));
	});

	it("org id derived from name", () => {
		expect(orgId("Hooli Labs")).toBe("hooli-labs");
	});
});

describe("vector", () => {
	it("serializes and deserializes round-trip", () => {
		const v = Float32Array.from([0.1, -0.2, 0.3]);
		const back = deserializeVector(serializeVector(v));
		expect(back).not.toBeNull();
		expect(Array.from(back as Float32Array)).toEqual(Array.from(v));
	});

	it("cosine similarity: orthogonal=0, identical=1", () => {
		expect(
			cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1])),
		).toBeCloseTo(0);
		expect(
			cosineSimilarity(Float32Array.from([1, 1]), Float32Array.from([2, 2])),
		).toBeCloseTo(1);
	});

	it("topKCosine orders by similarity", () => {
		const q = Float32Array.from([1, 0]);
		const rows = [
			{ id: "far", vector: Float32Array.from([0, 1]) },
			{ id: "near", vector: Float32Array.from([0.9, 0.1]) },
		];
		const out = topKCosine(q, rows, 2);
		expect(out[0]?.id).toBe("near");
		expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
	});
});
