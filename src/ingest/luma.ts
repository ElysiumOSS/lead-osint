/**
 * Luma (lu.ma) export -> events + people.
 *
 * Luma's exports come in a few shapes (calendar `entries`, an `events` array,
 * a single event with `hosts`, or a flat `guests` list). This parses the common
 * ones deterministically; for anything unusual, `ingest auto` (AI) is the
 * catch-all.
 */
import type { RawContact, RawEvent } from "../core/schema.js";
import type { IngestResult } from "./types.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function pick(obj: Obj, ...keys: string[]): string | null {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return null;
}

function eventFrom(obj: Obj): RawEvent | null {
	const name = pick(obj, "name", "title");
	if (!name) return null;
	const geo = isObj(obj.geo_address_info)
		? (obj.geo_address_info as Obj)
		: null;
	return {
		name,
		date: pick(obj, "start_at", "starts_at", "start_date", "start", "date"),
		location:
			pick(obj, "location", "address") ??
			(geo ? pick(geo, "full_address", "address", "city") : null),
		url: pick(obj, "url", "event_url", "permalink"),
		description: pick(obj, "description", "description_md"),
		source: "luma",
	};
}

function contactFrom(
	person: Obj,
	event: RawEvent | null,
	relation: "hosts" | "attended",
): RawContact | null {
	const user = isObj(person.user) ? (person.user as Obj) : person;
	const fullName =
		pick(user, "name", "full_name") ?? pick(person, "name", "full_name");
	if (!fullName) return null;
	// The guest-modal scrape carries Instagram, which we have no column for.
	// Keep it from being lost by folding the handle into the note text.
	const instagram = pick(user, "instagram", "instagram_url");
	const base = event
		? `${relation === "hosts" ? "Host" : "Guest"} of "${event.name}" (Luma)`
		: null;
	const igNote = instagram ? `IG: ${instagram}` : null;
	const notes = [base, igNote].filter(Boolean).join(" · ") || null;
	return {
		fullName,
		firstName: pick(user, "first_name"),
		lastName: pick(user, "last_name"),
		email: pick(user, "email") ?? pick(person, "email"),
		title: pick(user, "title", "headline", "job_title"),
		company: pick(user, "company_name", "company", "organization"),
		phones: [],
		linkedin: pick(user, "linkedin", "linkedin_url"),
		twitter: pick(user, "twitter", "twitter_handle"),
		facebook: null,
		website: pick(user, "website", "website_url"),
		notes,
		source: "luma",
		sourceRef: event?.url ?? null,
		relation,
		event,
	};
}

/** Parse a Luma export into events + host/guest leads. */
export function parseLuma(raw: unknown): IngestResult {
	const events: RawEvent[] = [];
	const contacts: RawContact[] = [];

	// Normalize the various container shapes into a flat list of entries.
	let entries: unknown[] = [];
	if (Array.isArray(raw)) entries = raw;
	else if (isObj(raw)) {
		if (Array.isArray(raw.entries)) entries = raw.entries;
		else if (Array.isArray(raw.events)) entries = raw.events;
		else if (Array.isArray(raw.guests)) {
			const ev = isObj(raw.event) ? eventFrom(raw.event as Obj) : null;
			if (ev) events.push(ev);
			for (const g of raw.guests)
				if (isObj(g)) push(contactFrom(g, ev, "attended"), contacts);
			return { contacts, events };
		} else entries = [raw];
	}

	for (const entry of entries) {
		if (!isObj(entry)) continue;
		// calendar form: { event: {...}, hosts: [...] }
		const eventObj = isObj(entry.event) ? (entry.event as Obj) : entry;
		const ev = eventFrom(eventObj);
		if (ev) events.push(ev);

		for (const h of asArr(entry.hosts ?? eventObj.hosts))
			if (isObj(h)) push(contactFrom(h, ev, "hosts"), contacts);
		for (const g of asArr(entry.guests ?? eventObj.guests))
			if (isObj(g)) push(contactFrom(g, ev, "attended"), contacts);

		// Bare guest entry (no event/hosts/guests keys): treat the entry as a person.
		if (!ev && !entry.hosts && !entry.guests)
			push(contactFrom(entry, null, "attended"), contacts);
	}

	return { contacts, events };
}

function push(c: RawContact | null, into: RawContact[]): void {
	if (c) into.push(c);
}
