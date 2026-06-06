/**
 * The single write path for investor sources (openvc / airtable / ai).
 *
 * Dedupes firms by deterministic id, upserts them (field-merging), and exposes
 * the warm-intro bridge: resolving an investor's partner to a person already in
 * your people graph, so the matcher can offer a warm path instead of a cold one.
 */
import { investorId, leadId, normalizeName } from "../core/ids.js";
import type { LeadRepository } from "../core/repository.js";
import type { Investor, Lead, RawInvestor } from "../core/schema.js";
import { cleanField } from "../core/text.js";

export interface InvestorNormalizeStats {
	/** Distinct investors written (after in-batch dedupe). */
	investors: number;
	/** Records dropped for missing a usable name. */
	skipped: number;
}

/** Persist parsed investor records. Re-running is idempotent (upsert by id). */
export function normalizeInvestorsInto(
	repo: LeadRepository,
	records: RawInvestor[],
): InvestorNormalizeStats {
	const stats: InvestorNormalizeStats = { investors: 0, skipped: 0 };
	const seen = new Set<string>();

	for (const rec of records) {
		const name = cleanField(rec.name);
		if (!name) {
			stats.skipped += 1;
			continue;
		}
		const domain = cleanField(rec.domain);
		const id = investorId(name, domain);

		repo.upsertInvestor({
			id,
			name,
			domain,
			website: cleanField(rec.website),
			hq: cleanField(rec.hq),
			stages: rec.stages ?? [],
			sectors: rec.sectors ?? [],
			geo: rec.geo ?? [],
			checkMin: rec.checkMin ?? null,
			checkMax: rec.checkMax ?? null,
			investorType: cleanField(rec.investorType),
			thesis: cleanField(rec.thesis),
			partnerName: cleanField(rec.partnerName),
			partnerEmail: cleanField(rec.partnerEmail),
			twitter: cleanField(rec.twitter),
			linkedin: cleanField(rec.linkedin),
			portfolio: rec.portfolio ?? [],
			source: rec.source,
			sourceRef: cleanField(rec.sourceRef),
		});

		if (!seen.has(id)) {
			seen.add(id);
			stats.investors += 1;
		}
	}

	return stats;
}

/**
 * Resolve an investor's partner to a person already in your people graph — the
 * warm-intro bridge. Matches on the partner email first (strongest key), then on
 * an exact normalized-name match (only when unambiguous). Returns null for the
 * cold case (the vast majority of a bulk OpenVC import).
 */
export function warmContactForInvestor(
	repo: LeadRepository,
	investor: Pick<Investor, "partnerEmail" | "partnerName">,
): Lead | null {
	const email = cleanField(investor.partnerEmail);
	if (email) {
		const byEmail = repo.getLead(leadId({ email }));
		if (byEmail) return byEmail;
	}
	const name = cleanField(investor.partnerName);
	if (name) {
		const target = normalizeName(name);
		const candidates = repo
			.findLeads(name)
			.filter((l) => normalizeName(l.fullName) === target);
		if (candidates.length === 1) return candidates[0];
	}
	return null;
}
