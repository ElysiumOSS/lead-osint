/**
 * Deterministic id + slug helpers.
 *
 * Ids are derived from natural keys so re-ingesting the same source is
 * idempotent (an upsert hits the same row instead of creating duplicates).
 */

/** Lowercase, strip accents, collapse non-alphanumerics to single hyphens. */
export function slug(input: string): string {
	return input
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

/** Stable, short, non-cryptographic hash (FNV-1a 32-bit) as base36. */
export function hashId(...parts: (string | undefined | null)[]): string {
	const str = parts.filter(Boolean).join("|").toLowerCase();
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Org id: prefer domain, else slug of name. */
export function orgId(nameOrDomain: string): string {
	const cleaned = nameOrDomain.trim();
	const s = slug(cleaned);
	return s || hashId(cleaned);
}

/**
 * Investor (firm) id: prefer the domain (most stable natural key across the
 * OpenVC/Airtable sources), else a slug of the firm name. Prefixed `inv_` so it
 * never collides with an org id derived from the same string.
 */
export function investorId(name: string, domain?: string | null): string {
	const key = (domain || name).trim();
	const s = slug(key);
	return `inv_${s || hashId(key)}`;
}

const NAME_NOISE =
	/\b(jr|sr|ii|iii|iv|v|phd|ph\.d|md|m\.d|mba|esq|dr|mr|mrs|ms|prof|professor|hon)\b/g;

/**
 * Canonical form of a person's name for matching: lowercase, accent- and
 * punctuation-stripped, with honorifics/suffixes removed. So "Dr. Bernard
 * Jones Jr." and "Bernard Jones" collapse to the same key.
 */
export function normalizeName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[.,]/g, " ")
		.replace(NAME_NOISE, " ")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// Only true legal/suffix noise — NOT words that are part of real names
// (e.g. "Capital" in Capital One, "Ventures"/"Partners"/"Group" in firm names).
const ORG_NOISE =
	/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|the|plc|gmbh|s\.a|bank|labs|lab|technologies|technology)\b/g;

/**
 * Canonical form of a company name for matching: lowercase, punctuation- and
 * legal-suffix-stripped. So "Capital One", "Capital One Bank" and
 * "Capital One, Inc." collapse to the same key.
 */
export function normalizeOrg(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(ORG_NOISE, " ")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Extract the stable profile slug from a LinkedIn URL (e.g. "jane-doe-123"). */
export function linkedinKey(url?: string | null): string | null {
	if (!url) return null;
	const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
	return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

/**
 * Lead id: email is the strongest natural key; then a LinkedIn profile slug
 * (stable + unique, so same-named connections without an email stay distinct);
 * else normalized name + org.
 */
export function leadId(opts: {
	email?: string | null;
	name?: string | null;
	org?: string | null;
	linkedin?: string | null;
}): string {
	const email = opts.email?.trim().toLowerCase();
	if (email) return `e_${hashId(email)}`;
	const li = linkedinKey(opts.linkedin);
	if (li) return `l_${hashId(li)}`;
	return `n_${hashId(normalizeName(opts.name ?? ""), opts.org ?? "")}`;
}

/** Event id: source + name + date keeps cross-source events distinct. */
export function eventId(
	source: string,
	name: string,
	date?: string | null,
): string {
	return `ev_${hashId(source, name, date ?? "")}`;
}
