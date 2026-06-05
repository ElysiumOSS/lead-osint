/**
 * Event-listing export -> events + host organizations.
 *
 * Handles a flat array of event listings whose `hosts` are company-name strings,
 * with `themes`/`formats`/`target_audiences` (e.g. a city tech-week directory),
 * and falls back to the Partiful-style calendar (`{events:[…]}` with people
 * hosts). Listing hosts are organizations, so they become org nodes that `hosts`
 * the event rather than people.
 */
import type { RawEvent } from "../core/schema.js";
import {
	buildResult,
	enrichDescriptions,
	type PartifulOptions,
	parseCalendar,
} from "./partiful.js";
import type { IngestResult } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

function strArr(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string" && !!x.trim())
		: [];
}
function pick(o: Obj, ...keys: string[]): string | null {
	for (const k of keys) {
		const val = o[k];
		if (typeof val === "string" && val.trim()) return val.trim();
	}
	return null;
}

/** True if the payload looks like the flat event-listing array shape. */
function looksLikeEventListingArray(items: unknown[]): boolean {
	const first = items.find(isObj) as Obj | undefined;
	return !!first && ("event_name" in first || "invite_url" in first);
}

/** Parse the flat event-listing array into events with host orgs (no people). */
function parseEventListingArray(items: unknown[]): IngestResult {
	const events: RawEvent[] = [];
	for (const item of items) {
		if (!isObj(item)) continue;
		const name = pick(item, "event_name", "name", "title");
		if (!name) continue;
		const location = [pick(item, "neighborhood"), pick(item, "city")]
			.filter(Boolean)
			.join(", ");
		const description = [
			strArr(item.themes).join(", "),
			strArr(item.formats).join(", "),
			strArr(item.target_audiences).join(", "),
		]
			.filter(Boolean)
			.join(" · ");
		events.push({
			name,
			date: pick(item, "start_time", "starts_at", "date"),
			location: location || null,
			url: pick(item, "invite_url", "url", "externalHref"),
			description: description || null,
			source: "event-listings",
			hostOrgs: strArr(item.hosts),
		});
	}
	return { contacts: [], events };
}

/** Parse + (optionally) enrich an event-listing export into an IngestResult. */
export async function ingestEventListings(
	raw: unknown,
	options: PartifulOptions = {},
): Promise<IngestResult> {
	// The export may be a bare array or an object keyed by index.
	const asArray = Array.isArray(raw)
		? raw
		: isObj(raw) && !("events" in raw)
			? Object.values(raw)
			: null;

	if (asArray && looksLikeEventListingArray(asArray)) {
		return parseEventListingArray(asArray);
	}

	// Fall back to the Partiful-style calendar (people hosts).
	const events = parseCalendar(raw);
	if (options.enrich !== false) await enrichDescriptions(events, options);
	return buildResult(events, "event-listings");
}
