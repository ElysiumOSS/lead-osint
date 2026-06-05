/**
 * LinkedIn connections export -> RawContact[].
 *
 * Accepts the lightweight shape scraped from the connections page:
 *   { name, bio?, linkedin?, company?, title? }
 * where `bio` is the headline (often "Title at Company"). The headline is kept
 * as the note (it drives embedding + relevance assessment), and when it reads
 * like "… at <Company>" we split out title/company so the person links to an org
 * node (works_at) instead of floating unconnected in the graph.
 *
 * Pure parser (no I/O). Dedupe is by LinkedIn profile slug (see `leadId`), so
 * same-named connections without an email stay distinct.
 */
import { z } from "zod";
import type { RawContact } from "../core/schema.js";
import { collapseWhitespace } from "../core/text.js";

const ConnectionSchema = z
	.object({
		name: z.string(),
		bio: z.string().nullish(),
		linkedin: z.string().nullish(),
		company: z.string().nullish(),
		title: z.string().nullish(),
	})
	.passthrough();

export const LinkedinFileSchema = z.array(ConnectionSchema);

// Split a headline into its parts ("SWE @ Google | building X | ex-Meta").
const HEADLINE_SEP = /\s*[|·•;]\s*|\s+[—–]\s+/;

/** Tidy a captured org name; reject sentence-like / junk captures. */
function cleanOrg(raw: string): string | null {
	let c = raw
		.replace(/[^\p{L}\p{N}&.,'’/ -]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^the\s+/i, "")
		.split(/,| - | \/ /)[0]
		.trim();
	c = c.replace(/[.,'’/-]+$/, "").trim();
	const plausible =
		c.length >= 2 &&
		c.length <= 50 &&
		c.split(" ").length <= 6 &&
		/[a-z]/i.test(c);
	return plausible ? c : null;
}

/**
 * Pull a primary affiliation (current employer or school) + title from a
 * LinkedIn headline. Handles the common shapes — "Role @ Company", "Role at
 * Company", and the first usable segment — so connections link by a concrete
 * shared org instead of only fuzzy similarity. Best-effort + conservative.
 */
export function extractAffiliation(bio?: string | null): {
	title: string | null;
	company: string | null;
} {
	const text = (bio ?? "").trim();
	if (!text) return { title: null, company: null };
	const segs = text
		.split(HEADLINE_SEP)
		.map((s) => s.trim())
		.filter(Boolean);

	let title: string | null = null;
	let company: string | null = null;
	for (const seg of segs) {
		if (company) break;
		const at = seg.match(/^(.*?)@\s*(.+)$/); // "Role @ Company"
		if (at?.[2]) {
			const co = cleanOrg(at[2]);
			if (co) {
				company = co;
				if (!title && at[1].trim()) title = at[1].trim();
				continue;
			}
		}
		const atWord = seg.match(/^(.{2,60}?)\s+at\s+(.+)$/i); // "Role at Company"
		if (atWord?.[2]) {
			const co = cleanOrg(atWord[2]);
			if (co) {
				company = co;
				if (!title) title = atWord[1].trim();
			}
		}
	}
	// Title fallback: first segment that isn't an affiliation clause.
	if (!title) {
		const t = segs.find((s) => !s.includes("@") && !/\bat\b/i.test(s));
		if (t && t.length <= 60) title = t;
	}
	return { title: title || null, company };
}

/** Parse a LinkedIn connections array into RawContacts. */
export function parseLinkedinConnections(raw: unknown): RawContact[] {
	const rows = LinkedinFileSchema.parse(raw);
	const contacts: RawContact[] = [];

	for (const row of rows) {
		const fullName = row.name?.trim();
		if (!fullName) continue;

		const bio = row.bio ? collapseWhitespace(row.bio) : null;
		const headline = extractAffiliation(bio);
		const company = row.company?.trim() || headline.company || null;
		const title = row.title?.trim() || headline.title || null;

		contacts.push({
			fullName,
			title,
			company,
			phones: [],
			linkedin: row.linkedin?.trim() || null,
			// Flag the warm 1st-degree tie so `assess` weighs the existing
			// relationship, and keep the headline for semantic context.
			notes: bio
				? `1st-degree LinkedIn connection. ${bio}`
				: "1st-degree LinkedIn connection.",
			source: "linkedin",
			sourceRef: row.linkedin?.trim() || null,
		});
	}

	return contacts;
}
