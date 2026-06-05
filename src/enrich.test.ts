import { describe, expect, it } from "vitest";
import {
	githubNameMatches,
	mapEdgar,
	mapExaResults,
	mapGithubUser,
	mapWikidata,
	mergePatches,
} from "./enrich.js";

describe("github mapper", () => {
	it("maps blog/twitter/bio into a patch", () => {
		const patch = mapGithubUser({
			name: "Ada Sample",
			blog: "ada.dev",
			twitter_username: "ada",
			bio: "infra nerd",
			location: "NYC",
			html_url: "https://github.com/ada",
		});
		expect(patch.website).toBe("https://ada.dev");
		expect(patch.twitter).toBe("https://x.com/ada");
		expect(patch.note).toContain("infra nerd");
		expect(patch.note).toContain("NYC");
	});

	it("name match guards false positives", () => {
		expect(githubNameMatches("Ada Sample", "Ada Sample")).toBe(true);
		expect(githubNameMatches("Ada Sample", "ada")).toBe(true);
		expect(githubNameMatches("Ada Sample", "Bob Jones")).toBe(false);
		expect(githubNameMatches("Ada Sample", null)).toBe(false);
	});
});

describe("exa mapper", () => {
	it("summarizes top results with sources", () => {
		const note = mapExaResults([
			{
				title: "Ada at Hooli",
				url: "https://x.test/ada",
				text: "She   leads   infra.",
			},
			{ title: "Talk", url: "https://y.test/talk" },
		]);
		expect(note).toContain("Web (Exa):");
		expect(note).toContain("https://x.test/ada");
		expect(note).toContain("She leads infra.");
	});

	it("returns null with no usable results", () => {
		expect(mapExaResults([])).toBeNull();
		expect(mapExaResults([{ text: "no url" }])).toBeNull();
	});
});

describe("registry mappers", () => {
	it("maps the first org-like Wikidata hit, skipping a same-named person", () => {
		const { note } = mapWikidata({
			search: [
				{ id: "Q1", label: "Hooli", description: "American politician" },
				{
					id: "Q2",
					label: "Hooli Inc",
					description: "American technology company",
					concepturi: "http://www.wikidata.org/entity/Q2",
				},
			],
		});
		expect(note).toContain("Hooli Inc");
		expect(note).toContain("technology company");
		expect(note).toContain("Q2");
	});

	it("returns null when no result looks like an organization", () => {
		expect(
			mapWikidata({
				search: [{ id: "Q9", label: "Hooli", description: "given name" }],
			}).note,
		).toBeNull();
		expect(mapWikidata({}).note).toBeNull();
	});

	it("maps EDGAR display name", () => {
		expect(
			mapEdgar({
				hits: {
					hits: [{ _source: { display_names: ["HOOLI INC (CIK 0001)"] } }],
				},
			}),
		).toContain("HOOLI INC");
		expect(mapEdgar({})).toBeNull();
	});
});

describe("mergePatches", () => {
	it("first non-empty wins, notes concatenate", () => {
		const merged = mergePatches([
			{ website: "https://a", note: "n1" },
			{ website: "https://b", twitter: "https://x/t", note: "n2" },
			null,
		]);
		expect(merged?.website).toBe("https://a");
		expect(merged?.twitter).toBe("https://x/t");
		expect(merged?.note).toBe("n1\nn2");
	});

	it("returns null when all patches are null", () => {
		expect(mergePatches([null, null])).toBeNull();
	});
});
