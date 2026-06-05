/**
 * Cross-source lead de-duplication.
 *
 * The same person can arrive from sessions + OCR + paste with slightly different
 * names ("Dr. Bernard Jones Jr." vs "Bernard Jones"). Email-keyed ingest already
 * merges exact matches; this catches the rest by normalized name, conservatively:
 * a name group is only merged when it has at most one distinct email (so genuine
 * namesakes with different emails are left alone).
 */
import { normalizeName, normalizeOrg } from "./core/ids.js";
import type { LeadRepository } from "./core/repository.js";
import type { Lead } from "./core/schema.js";

interface OrgRow {
	id: string;
	name: string;
	domain: string | null;
	notes: string | null;
}

export interface OrgMergeGroup {
	keep: OrgRow;
	drop: OrgRow[];
}

export interface MergeGroup {
	keep: Lead;
	drop: Lead[];
}

/** Score how "complete" a lead is, to pick the survivor of a merge. */
function completeness(l: Lead): number {
	let n = 0;
	if (l.email) n += 3;
	if (l.title) n += 1;
	if (l.orgId) n += 1;
	if (l.linkedin) n += 1;
	if (l.phones.length) n += 1;
	if (l.notes) n += 1;
	n += (l.pitchFit ?? 0) * 2;
	return n;
}

/** Plan merges without writing. Each group lists the survivor + the duplicates. */
export function planDedupe(repo: LeadRepository): MergeGroup[] {
	const groups = new Map<string, Lead[]>();
	for (const lead of repo.listLeads()) {
		const key = normalizeName(lead.fullName);
		if (!key) continue;
		(groups.get(key) ?? groups.set(key, []).get(key))?.push(lead);
	}

	const plans: MergeGroup[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const distinctEmails = new Set(
			members.map((m) => m.email?.trim().toLowerCase()).filter(Boolean),
		);
		// More than one real email under the same name → likely namesakes. Skip.
		if (distinctEmails.size > 1) continue;
		const sorted = [...members].sort(
			(a, b) => completeness(b) - completeness(a),
		);
		const [keep, ...drop] = sorted;
		if (keep && drop.length) plans.push({ keep, drop });
	}
	return plans;
}

export interface DedupeResult {
	groups: number;
	merged: number;
}

/** Apply the planned merges. Returns how many leads were folded away. */
export function applyDedupe(
	repo: LeadRepository,
	plans: MergeGroup[],
): DedupeResult {
	let merged = 0;
	for (const plan of plans) {
		for (const dup of plan.drop) {
			if (repo.mergeLeads(plan.keep.id, dup.id)) merged += 1;
		}
	}
	return { groups: plans.length, merged };
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

function orgScore(o: OrgRow): number {
	return (o.domain ? 3 : 0) + (o.notes ? 1 : 0) + o.name.length / 100;
}

/**
 * Plan org merges by normalized name ("Capital One" ≡ "Capital One Bank").
 * The survivor is the most-complete record (prefers one with a domain).
 */
export function planOrgDedupe(repo: LeadRepository): OrgMergeGroup[] {
	const groups = new Map<string, OrgRow[]>();
	for (const org of repo.listOrgs()) {
		const key = normalizeOrg(org.name);
		if (!key) continue;
		(groups.get(key) ?? groups.set(key, []).get(key))?.push(org);
	}
	const plans: OrgMergeGroup[] = [];
	for (const members of groups.values()) {
		if (members.length < 2) continue;
		const sorted = [...members].sort((a, b) => orgScore(b) - orgScore(a));
		const [keep, ...drop] = sorted;
		if (keep && drop.length) plans.push({ keep, drop });
	}
	return plans;
}

/** Apply planned org merges. Returns how many orgs were folded away. */
export function applyOrgDedupe(
	repo: LeadRepository,
	plans: OrgMergeGroup[],
): DedupeResult {
	let merged = 0;
	for (const plan of plans) {
		for (const dup of plan.drop) {
			if (repo.mergeOrgs(plan.keep.id, dup.id)) merged += 1;
		}
	}
	return { groups: plans.length, merged };
}
