/**
 *
 * Copyright 2026 Mike Odnis
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 */

import { describe, expect, it } from "vitest";
import {
	canonicalizeHost,
	computeHostSuffixes,
	createHostFilterState,
	getRouteName,
	normalizeUrl,
} from "./shared.js";

describe("canonicalizeHost", () => {
	it("strips protocol, www, paths, and lowercases", () => {
		expect(canonicalizeHost("https://www.Example.COM/some/path")).toBe(
			"example.com",
		);
		expect(canonicalizeHost("HTTPS://APP.example.com")).toBe("app.example.com");
		expect(canonicalizeHost("  example.com  ")).toBe("example.com");
		expect(canonicalizeHost("www.example.com/")).toBe("example.com");
	});
});

describe("computeHostSuffixes", () => {
	it("returns the host plus every parent suffix", () => {
		expect(computeHostSuffixes("a.b.example.com")).toEqual([
			"a.b.example.com",
			"b.example.com",
			"example.com",
			"com",
		]);
	});

	it("handles single-segment hosts", () => {
		expect(computeHostSuffixes("localhost")).toEqual(["localhost"]);
	});
});

describe("createHostFilterState", () => {
	it("only allows the primary host when includeSubdomains=false", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(true);
		expect(f.hostMatchesFilters("www.example.com", false)).toBe(true);
		expect(f.hostMatchesFilters("api.example.com", false)).toBe(false);
		expect(f.hostMatchesFilters("evil.com", false)).toBe(false);
	});

	it("allows subdomains when includeSubdomains=true", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("api.example.com", true)).toBe(true);
		expect(f.hostMatchesFilters("a.b.example.com", true)).toBe(true);
		// Different TLD is rejected (no shared suffix with example.com).
		expect(f.hostMatchesFilters("evil.io", true)).toBe(false);
	});

	it("does not leak across the TLD when includeSubdomains=true", () => {
		// Regression: previously "evil.com" matched because the suffix list
		// for "example.com" included the bare TLD "com". Bare-TLD suffixes
		// are dropped during hydrate, so unrelated same-TLD hosts are rejected.
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("evil.com", true)).toBe(false);
		expect(f.hostMatchesFilters("example.org", true)).toBe(false);
	});

	it("honours extra allowed hosts", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", ["cdn.partner.io"]);
		expect(f.hostMatchesFilters("cdn.partner.io", false)).toBe(true);
		expect(f.hostMatchesFilters("partner.io", false)).toBe(false);
		expect(f.hostMatchesFilters("partner.io", true)).toBe(true);
	});

	it("re-hydrating replaces the previous allow-list", () => {
		const f = createHostFilterState();
		f.hydrate("example.com", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(true);
		f.hydrate("other.org", []);
		expect(f.hostMatchesFilters("example.com", false)).toBe(false);
		expect(f.hostMatchesFilters("other.org", false)).toBe(true);
	});
});

describe("normalizeUrl", () => {
	it("returns origin+pathname with the trailing slash stripped", () => {
		// Even the bare-origin slash is stripped — the result is the origin alone.
		expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
		expect(normalizeUrl("https://example.com/foo/")).toBe(
			"https://example.com/foo",
		);
		expect(normalizeUrl("https://example.com/foo")).toBe(
			"https://example.com/foo",
		);
	});

	it("strips query strings and fragments", () => {
		expect(normalizeUrl("https://example.com/foo?bar=1#x")).toBe(
			"https://example.com/foo",
		);
	});

	it("returns the input unchanged for invalid URLs", () => {
		expect(normalizeUrl("not a url")).toBe("not a url");
	});
});

describe("getRouteName", () => {
	it("returns 'root' for the bare origin", () => {
		expect(getRouteName("https://example.com/")).toBe("root");
		expect(getRouteName("https://example.com")).toBe("root");
	});

	it("slugifies multi-segment paths", () => {
		expect(getRouteName("https://example.com/blog/post-1")).toBe("blog-post-1");
		expect(getRouteName("https://example.com/en/legal/privacy/")).toBe(
			"en-legal-privacy",
		);
	});

	it("returns 'invalid-url' for unparseable input", () => {
		expect(getRouteName("::not-a-url::")).toBe("invalid-url");
	});

	it("collapses consecutive non-alphanumeric runs into single dashes", () => {
		expect(getRouteName("https://example.com/A%20B")).toBe("a-20b");
	});
});
