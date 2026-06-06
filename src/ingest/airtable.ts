/**
 * Parse an Airtable "Pitch Deck Database" CSV export into `RawInvestor[]`.
 *
 * Airtable columns: Investor Name, Fund Type, Fund Stage, Website, Fund Focus
 * (Sectors), Partner Name, Partner Email, Portfolio Companies, Location, Twitter
 * Link, LinkedIn Link. The partner name/email carry the warm-intro bridge into
 * your people graph.
 */
import { parseCsvRecords, pick } from "../core/csv.js";
import type { RawInvestor } from "../core/schema.js";
import { cleanField, domainOf } from "../core/text.js";
import {
	normalizeGeo,
	normalizeSectors,
	normalizeStages,
	splitList,
} from "./investor-normalize.js";

/** Parse Airtable CSV text. Rows without an investor name are skipped. */
export function parseAirtable(csvText: string): RawInvestor[] {
	const records = parseCsvRecords(csvText);
	const out: RawInvestor[] = [];
	for (const rec of records) {
		const name = cleanField(
			pick(rec, "Investor Name", "Investor name", "Name"),
		);
		if (!name) continue;
		const website = cleanField(pick(rec, "Website", "Website (if available)"));
		out.push({
			name,
			website,
			domain: domainOf(website),
			hq: cleanField(pick(rec, "Location", "HQ")),
			stages: normalizeStages(pick(rec, "Fund Stage", "Stage")),
			sectors: normalizeSectors(
				pick(rec, "Fund Focus (Sectors)", "Fund Focus", "Sectors"),
			),
			geo: normalizeGeo(pick(rec, "Location", "Geography")),
			checkMin: null,
			checkMax: null,
			investorType: cleanField(pick(rec, "Fund Type", "Investor Type")),
			thesis: cleanField(pick(rec, "Fund Focus (Sectors)", "Thesis", "Notes")),
			partnerName: cleanField(pick(rec, "Partner Name", "Partner")),
			partnerEmail: cleanField(pick(rec, "Partner Email", "Email")),
			twitter: cleanField(pick(rec, "Twitter Link", "Twitter")),
			linkedin: cleanField(pick(rec, "LinkedIn Link", "LinkedIn")),
			portfolio: splitList(pick(rec, "Portfolio Companies", "Portfolio")),
			source: "airtable",
			sourceRef: null,
		});
	}
	return out;
}
