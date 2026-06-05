/**
 * Retroactively apply the ingest validation rules to an existing store.
 *
 * Stores built before validation can hold a fake "gmail" org (a free-email
 * domain that conflated unrelated people), junk org names, and non-person leads.
 * This finds and removes them in place. Note: dissolving a conflated free-email
 * org detaches its leads (their company link was wrong anyway) — for proper
 * re-linking, re-ingest the sources, which now validates on the way in.
 */
import type { LeadRepository } from "./core/repository.js";
import {
	cleanCompany,
	isFreeEmailDomain,
	validatePersonName,
} from "./ingest/validate.js";

export interface RevalidatePlan {
	orgs: { id: string; name: string; reason: string }[];
	leads: { id: string; name: string; reason: string }[];
}

/** Find junk orgs + non-person leads without changing anything. */
export function planRevalidate(repo: LeadRepository): RevalidatePlan {
	const orgs: RevalidatePlan["orgs"] = [];
	for (const o of repo.listOrgs()) {
		if (isFreeEmailDomain(o.domain))
			orgs.push({ id: o.id, name: o.name, reason: "free-email domain" });
		else if (cleanCompany(o.name) === null)
			orgs.push({ id: o.id, name: o.name, reason: "junk name" });
	}
	const leads: RevalidatePlan["leads"] = [];
	for (const l of repo.listLeads()) {
		const check = validatePersonName(l.fullName);
		if (!check.ok)
			leads.push({
				id: l.id,
				name: l.fullName,
				reason: check.reason ?? "invalid",
			});
	}
	return { orgs, leads };
}

export interface RevalidateResult {
	orgsDeleted: number;
	leadsDeleted: number;
}

/** Delete the planned junk. */
export function applyRevalidate(
	repo: LeadRepository,
	plan: RevalidatePlan,
): RevalidateResult {
	let orgsDeleted = 0;
	let leadsDeleted = 0;
	for (const o of plan.orgs) if (repo.deleteOrg(o.id)) orgsDeleted += 1;
	for (const l of plan.leads) if (repo.deleteLead(l.id)) leadsDeleted += 1;
	return { orgsDeleted, leadsDeleted };
}
