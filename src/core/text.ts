/**
 * Shared text-cleaning helpers.
 *
 * Extracted and generalized from the original `scrape-partiful.ts` so every
 * ingest path produces consistently cleaned, embeddable text.
 */

/** Convert common HTML entities + block tags to readable plain text. */
export function decodeEntities(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x27;|&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&mdash;/g, "—")
		.replace(/&ndash;/g, "–")
		.replace(/&hellip;/g, "…");
}

/** Strip all HTML tags and collapse whitespace runs. */
export function stripHtml(html: string): string {
	return collapseWhitespace(decodeEntities(html));
}

/** Collapse repeated whitespace; trim. Keeps single newlines as spaces. */
export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Remove a trailing boilerplate marker (e.g. event-platform footers). */
export function stripBoilerplate(
	description: string,
	marker = /\s*This event is a part of #NYTechWeek[\s\S]*$/i,
): string {
	return description.replace(marker, "").trim();
}

const PLACEHOLDERS = new Set([
	"",
	"n/a",
	"na",
	"none",
	"null",
	"nil",
	"-",
	"—",
	"tbd",
	"unknown",
]);

/** Normalize placeholder junk ("N/A", "none", "-", …) to null; trim otherwise. */
export function cleanField(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return trimmed && !PLACEHOLDERS.has(trimmed.toLowerCase()) ? trimmed : null;
}

/** Title-cased display name from an arbitrary token (best effort). */
export function titleCase(input: string): string {
	return input
		.toLowerCase()
		.replace(/\b([a-z])/g, (m) => m.toUpperCase())
		.trim();
}

/** Extract the registrable-ish domain from an email or URL, else null. */
export function domainOf(value: string | null | undefined): string | null {
	if (!value) return null;
	const v = value.trim();
	const at = v.indexOf("@");
	if (at !== -1) return v.slice(at + 1).toLowerCase() || null;
	try {
		return new URL(v.startsWith("http") ? v : `https://${v}`).hostname
			.replace(/^www\./, "")
			.toLowerCase();
	} catch {
		return null;
	}
}
