import { describe, expect, it } from "vitest";
import {
	cleanCompany,
	isFreeEmailDomain,
	orgDomain,
	validatePersonName,
} from "./validate.js";

describe("free-email handling", () => {
	it("recognizes personal providers", () => {
		expect(isFreeEmailDomain("gmail.com")).toBe(true);
		expect(isFreeEmailDomain("Outlook.com")).toBe(true);
		expect(isFreeEmailDomain("acme.io")).toBe(false);
	});

	it("orgDomain never uses a free-email domain", () => {
		expect(orgDomain(null, "ada@gmail.com")).toBeNull(); // would merge strangers
		expect(orgDomain(null, "ada@acme.com")).toBe("acme.com");
		expect(orgDomain("https://acme.com", "ada@gmail.com")).toBe("acme.com");
	});
});

describe("cleanCompany", () => {
	it("drops generic / placeholder / self companies", () => {
		for (const junk of [
			"Self",
			"self-employed",
			"Freelance",
			"N/A",
			"Independent",
			"-",
			"x",
		]) {
			expect(cleanCompany(junk)).toBeNull();
		}
	});

	it("drops email/url and company==person", () => {
		expect(cleanCompany("ada@acme.com")).toBeNull();
		expect(cleanCompany("https://acme.com")).toBeNull();
		expect(cleanCompany("Ada Lovelace", "Ada Lovelace")).toBeNull();
	});

	it("keeps real companies", () => {
		expect(cleanCompany("Hooli Labs")).toBe("Hooli Labs");
		expect(cleanCompany("Capital One", "Ada Sample")).toBe("Capital One");
	});
});

describe("validatePersonName", () => {
	it("accepts plausible names", () => {
		expect(validatePersonName("Ada Sample").ok).toBe(true);
		expect(validatePersonName("Madonna").ok).toBe(true);
	});

	it("rejects non-people", () => {
		expect(validatePersonName("").ok).toBe(false);
		expect(validatePersonName("ada@acme.com").ok).toBe(false);
		expect(validatePersonName("https://x.test").ok).toBe(false);
		expect(validatePersonName("12345").ok).toBe(false);
		expect(validatePersonName("Speaker").ok).toBe(false);
	});
});
