import { describe, expect, it } from "vitest";
import { leadId, linkedinKey } from "../core/ids.js";
import { extractAffiliation, parseLinkedinConnections } from "./linkedin.js";

describe("extractAffiliation", () => {
	it("splits 'Title at Company'", () => {
		expect(
			extractAffiliation("Solutions Engineer at Lumen Technologies"),
		).toEqual({ title: "Solutions Engineer", company: "Lumen Technologies" });
	});

	it("handles the '@ Company' shape (most common on LinkedIn)", () => {
		expect(
			extractAffiliation("Software Engineering Intern @ Morgan Stanley"),
		).toEqual({
			title: "Software Engineering Intern",
			company: "Morgan Stanley",
		});
	});

	it("takes the first affiliation across segments", () => {
		expect(
			extractAffiliation("SWE @ Google | Lead Organizer @ GDSC").company,
		).toBe("Google");
	});

	it("captures schools via @", () => {
		expect(
			extractAffiliation("AI/ML Researcher @ Grambling State University")
				.company,
		).toBe("Grambling State University");
	});

	it("returns no company for a description-only headline", () => {
		expect(
			extractAffiliation("Biosecurity | Immunoglobulin Engineering").company,
		).toBeNull();
	});

	it("rejects an implausibly long capture", () => {
		expect(extractAffiliation(`Eng @ ${"x ".repeat(40)}`).company).toBeNull();
	});
});

describe("parseLinkedinConnections", () => {
	const rows = [
		{
			name: "Brian Toyota",
			bio: "Solutions Engineer at Lumen Technologies",
			linkedin: "https://www.linkedin.com/in/brian-toyota-a19725/",
		},
		{ name: "Ada Lovelace", bio: "Harvard & Startups", linkedin: "" },
		{ name: "", bio: "no name skipped" },
	];

	it("maps name/bio/linkedin and extracts company from the headline", () => {
		const out = parseLinkedinConnections(rows);
		expect(out).toHaveLength(2); // empty name dropped
		const brian = out[0];
		expect(brian?.fullName).toBe("Brian Toyota");
		expect(brian?.company).toBe("Lumen Technologies");
		expect(brian?.title).toBe("Solutions Engineer");
		expect(brian?.source).toBe("linkedin");
		expect(brian?.notes).toContain("1st-degree LinkedIn connection");
		expect(brian?.notes).toContain("Lumen Technologies");
	});

	it("keeps a person with no parseable company (no org link)", () => {
		const ada = parseLinkedinConnections(rows)[1];
		expect(ada?.company).toBeNull();
		expect(ada?.notes).toContain("Harvard & Startups");
	});
});

describe("leadId dedupes connections by LinkedIn slug", () => {
	it("derives a stable key from the profile URL", () => {
		expect(linkedinKey("https://www.linkedin.com/in/jane-doe-123/")).toBe(
			"jane-doe-123",
		);
		expect(linkedinKey("https://linkedin.com/in/jane-doe-123?foo=1")).toBe(
			"jane-doe-123",
		);
	});

	it("keeps two same-named, email-less people distinct via linkedin", () => {
		const a = leadId({
			name: "John Smith",
			linkedin: "https://linkedin.com/in/john-smith-1",
		});
		const b = leadId({
			name: "John Smith",
			linkedin: "https://linkedin.com/in/john-smith-2",
		});
		expect(a).not.toBe(b);
		expect(a.startsWith("l_")).toBe(true);
	});

	it("still prefers email when present", () => {
		expect(
			leadId({
				email: "x@y.com",
				linkedin: "https://linkedin.com/in/x",
			}).startsWith("e_"),
		).toBe(true);
	});
});
