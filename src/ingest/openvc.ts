/**
 * Parse an OpenVC CSV export into `RawInvestor[]`.
 *
 * OpenVC columns: Investor name, Website, Global HQ, Countries of investment,
 * Stage of investment, Investment thesis, Investor type, First cheque min,
 * First cheque maximum. Stage/geo/cheque cells are canonicalized here so the
 * matcher only sees clean tokens.
 */
import { parseCsvRecords, pick } from "../core/csv.js";
import type { RawInvestor } from "../core/schema.js";
import { cleanField, domainOf } from "../core/text.js";
import {
	normalizeGeo,
	normalizeSectors,
	normalizeStages,
	parseCheck,
} from "./investor-normalize.js";

/** Parse OpenVC CSV text. Rows without an investor name are skipped. */
export function parseOpenVc(csvText: string): RawInvestor[] {
	const records = parseCsvRecords(csvText);
	const out: RawInvestor[] = [];
	for (const rec of records) {
		const name = cleanField(
			pick(rec, "Investor name", "Investor Name", "Name"),
		);
		if (!name) continue;
		const website = cleanField(pick(rec, "Website"));
		const thesis = cleanField(
			pick(rec, "Investment thesis", "Thesis", "Investment Thesis"),
		);
		// OpenVC has no sectors column; the thesis text carries focus, which the
		// embedding picks up. Sectors stay empty (sector overlap is then 0, but the
		// semantic thesis term still scores the fit).
		out.push({
			name,
			website,
			domain: domainOf(website),
			hq: cleanField(pick(rec, "Global HQ", "HQ", "Headquarters")),
			stages: normalizeStages(pick(rec, "Stage of investment", "Stage")),
			sectors: normalizeSectors(pick(rec, "Sectors", "Sector", "Focus")),
			geo: normalizeGeo(pick(rec, "Countries of investment", "Countries")),
			checkMin: parseCheck(
				pick(
					rec,
					"First cheque minimum",
					"First cheque min",
					"First check minimum",
					"First check min",
				),
			),
			checkMax: parseCheck(
				pick(
					rec,
					"First cheque maximum",
					"First check maximum",
					"First cheque max",
				),
			),
			investorType: cleanField(pick(rec, "Investor type", "Investor Type")),
			thesis,
			partnerName: null,
			partnerEmail: null,
			twitter: null,
			linkedin: null,
			portfolio: [],
			source: "openvc",
			sourceRef: null,
		});
	}
	return out;
}
