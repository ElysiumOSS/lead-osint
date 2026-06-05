/**
 * Normalize RawContacts/RawEvents into the store.
 *
 * The single write path for every ingest source: dedupe people via deterministic
 * ids, upsert their org + event, score events by keyword relevance, and wire up
 * the relationship edges that power the graph view.
 */
import { leadId } from "../core/ids.js";
import type { LeadRepository, UpsertEventInput } from "../core/repository.js";
import type { RawContact, RawEvent, Relation } from "../core/schema.js";
import { cleanField } from "../core/text.js";
import { scoreText } from "./keywords.js";
import type { IngestResult } from "./types.js";
import { cleanCompany, orgDomain, validatePersonName } from "./validate.js";

export interface NormalizeStats {
	leads: number;
	orgs: number;
	events: number;
	edges: number;
	/** Contacts rejected by validation (not real people). */
	skipped: number;
}

/** Persist an entire IngestResult. Returns how much was written. */
export function normalizeInto(
	repo: LeadRepository,
	result: IngestResult,
): NormalizeStats {
	const stats: NormalizeStats = {
		leads: 0,
		orgs: 0,
		events: 0,
		edges: 0,
		skipped: 0,
	};
	const seenOrgs = new Set<string>();
	const seenEvents = new Set<string>();

	for (const rawEvent of result.events) {
		const id = repo.upsertEvent(toEventInput(rawEvent));
		if (!seenEvents.has(id)) {
			seenEvents.add(id);
			stats.events += 1;
		}
		// Host organizations become org nodes that `hosts` the event.
		for (const orgName of rawEvent.hostOrgs ?? []) {
			const name = orgName.trim();
			if (!name) continue;
			const oid = repo.upsertOrg(name);
			if (!seenOrgs.has(oid)) {
				seenOrgs.add(oid);
				stats.orgs += 1;
			}
			repo.link("org", oid, "event", id, "hosts");
			stats.edges += 1;
		}
	}

	for (const contact of result.contacts) {
		ingestContact(repo, contact, stats, seenOrgs, seenEvents);
	}

	return stats;
}

function ingestContact(
	repo: LeadRepository,
	contact: RawContact,
	stats: NormalizeStats,
	seenOrgs: Set<string>,
	seenEvents: Set<string>,
): void {
	// Reject entries that aren't real people before they become orphan nodes.
	if (!validatePersonName(contact.fullName).ok) {
		stats.skipped += 1;
		return;
	}

	const email = cleanField(contact.email);
	const website = cleanField(contact.website);
	const company = cleanCompany(contact.company, contact.fullName);
	let orgId: string | null = null;
	if (company) {
		// Free-email domains never define a company (they'd merge strangers).
		const domain = orgDomain(website, email);
		orgId = repo.upsertOrg(company, domain);
		if (!seenOrgs.has(orgId)) {
			seenOrgs.add(orgId);
			stats.orgs += 1;
		}
	}

	const id = leadId({
		email,
		name: contact.fullName,
		org: company,
		linkedin: cleanField(contact.linkedin),
	});
	repo.upsertLead({
		id,
		fullName: contact.fullName,
		firstName: cleanField(contact.firstName),
		lastName: cleanField(contact.lastName),
		email,
		title: cleanField(contact.title),
		orgId,
		phones: (contact.phones ?? [])
			.map((p) => cleanField(p))
			.filter((p): p is string => !!p),
		linkedin: cleanField(contact.linkedin),
		twitter: cleanField(contact.twitter),
		facebook: cleanField(contact.facebook),
		website,
		source: contact.source,
		sourceRef: cleanField(contact.sourceRef),
		notes: contact.notes ?? null,
	});
	stats.leads += 1;

	if (orgId) {
		repo.link("lead", id, "org", orgId, "works_at");
		stats.edges += 1;
	}

	if (contact.event) {
		const eventId = repo.upsertEvent(toEventInput(contact.event));
		if (!seenEvents.has(eventId)) {
			seenEvents.add(eventId);
			stats.events += 1;
		}
		const rel: Relation = contact.relation ?? "attended";
		repo.link("lead", id, "event", eventId, rel);
		stats.edges += 1;
	}
}

/** Score an event by keyword relevance and shape it for the repository. */
function toEventInput(event: RawEvent): UpsertEventInput {
	const text = [event.name, event.description].filter(Boolean).join(". ");
	const { score, matches } = scoreText(text);
	return {
		name: event.name,
		date: event.date ?? null,
		location: event.location ?? null,
		url: event.url ?? null,
		source: event.source ?? "unknown",
		description: event.description ?? null,
		priorityScore: score,
		priorityMatches: matches,
	};
}
