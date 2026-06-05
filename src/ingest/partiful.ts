/**
 * Partiful / Luma-style calendar export -> events + host leads.
 *
 * Refactored from `scrape-partiful.ts`. Parses a calendar JSON, optionally
 * fetches partiful.com pages to fill in event descriptions, and emits the event
 * plus its hosts (as leads who `hosts` the event). Keyword scoring is applied
 * later in `normalize.ts`.
 */

import { z } from "zod";
import { mapPool } from "../core/concurrency.js";
import type { RawContact, RawEvent } from "../core/schema.js";
import { decodeEntities, stripBoilerplate } from "../core/text.js";
import type { IngestResult } from "./types.js";

const HostSchema = z.object({ label: z.string() }).passthrough();
// Attendees may be scraped as {label} or {name}, optionally with a headline.
const GuestSchema = z
	.object({
		label: z.string().nullish(),
		name: z.string().nullish(),
		bio: z.string().nullish(),
		headline: z.string().nullish(),
		company: z.string().nullish(),
		linkedin: z.string().nullish(),
	})
	.passthrough();

const CalendarEventSchema = z
	.object({
		id: z.number().nullish(),
		name: z.string(),
		externalHref: z.string().nullish(),
		company: z.string().nullish(),
		facets: z
			.object({
				hosts: z.array(HostSchema).optional(),
				guests: z.array(GuestSchema).optional(),
			})
			.passthrough()
			.nullish(),
		guests: z.array(GuestSchema).nullish(),
		attendees: z.array(GuestSchema).nullish(),
		description: z.string().nullish(),
		date: z.string().nullish(),
		time: z.string().nullish(),
		location: z.string().nullish(),
	})
	.passthrough();

const CalendarFileSchema = z
	.object({ events: z.array(CalendarEventSchema) })
	.passthrough();

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

export interface PartifulOptions {
	/** Fetch partiful pages to fill missing descriptions (network). Default true. */
	enrich?: boolean;
	concurrency?: number;
	timeoutMs?: number;
}

/** Parse a calendar file into typed events (no network). */
export function parseCalendar(raw: unknown): CalendarEvent[] {
	return CalendarFileSchema.parse(raw).events;
}

/** Fetch partiful pages to fill missing descriptions, mutating events in place. */
export async function enrichDescriptions(
	events: CalendarEvent[],
	options: Pick<PartifulOptions, "concurrency" | "timeoutMs"> = {},
): Promise<void> {
	const { concurrency = 8, timeoutMs = 15_000 } = options;
	const targets = events.filter(
		(e) => e.externalHref?.includes("partiful.com") && !e.description,
	);
	await mapPool(
		targets,
		concurrency,
		async (event) => {
			const html = await fetchHtml(event.externalHref as string, timeoutMs);
			if (html) event.description = extractDescription(html);
		},
		{ perWorkerDelayMs: 100 },
	);
}

/** Parse + (optionally) enrich a calendar file into an IngestResult. */
export async function ingestPartiful(
	raw: unknown,
	options: PartifulOptions = {},
): Promise<IngestResult> {
	const { enrich = true } = options;
	const events = parseCalendar(raw);
	if (enrich) await enrichDescriptions(events, options);
	return buildResult(events, "partiful");
}

/** Build an IngestResult from already-parsed/enriched calendar events. */
export function buildResult(
	events: CalendarEvent[],
	source = "partiful",
): IngestResult {
	const rawEvents: RawEvent[] = [];
	const contacts: RawContact[] = [];

	for (const event of events) {
		const rawEvent: RawEvent = {
			name: event.name,
			date: event.date ?? null,
			location: event.location ?? null,
			url: event.externalHref ?? null,
			description: event.description ?? null,
			source,
		};
		rawEvents.push(rawEvent);

		const ref =
			event.externalHref ?? (event.id != null ? String(event.id) : null);

		for (const host of event.facets?.hosts ?? []) {
			const fullName = host.label.trim();
			if (!fullName) continue;
			contacts.push({
				fullName,
				company: event.company ?? null,
				phones: [],
				source,
				sourceRef: ref,
				relation: "hosts",
				notes: `Host of "${event.name}"`,
				event: rawEvent,
			});
		}

		// Attendees from any of the accepted shapes → `attended` edge to the event.
		const guests = [
			...(event.facets?.guests ?? []),
			...(event.guests ?? []),
			...(event.attendees ?? []),
		];
		for (const g of guests) {
			const fullName = (g.label ?? g.name ?? "").trim();
			if (!fullName) continue;
			contacts.push({
				fullName,
				title: g.headline ?? null,
				company: g.company ?? null,
				phones: [],
				linkedin: g.linkedin ?? null,
				source,
				sourceRef: ref,
				relation: "attended",
				notes: g.bio
					? `Attended "${event.name}". ${g.bio}`
					: `Attended "${event.name}"`,
				event: rawEvent,
			});
		}
	}

	return { contacts, events: rawEvents };
}

// --- internals -------------------------------------------------------------

async function fetchHtml(
	url: string,
	timeoutMs: number,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		return await response.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Extract a partiful event description (hashed selector + meta fallbacks). */
export function extractDescription(html: string): string | null {
	const selectorMatch = html.match(
		/<div\s+class="ptf-l-mWmFQ[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
	);
	if (selectorMatch) {
		const cleaned = stripBoilerplate(
			decodeEntities(selectorMatch[1] as string),
		);
		if (cleaned.length > 0) return cleaned;
	}
	const ogMatch = html.match(
		/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
	);
	if (ogMatch) return stripBoilerplate(decodeEntities(ogMatch[1] as string));
	const metaMatch = html.match(
		/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
	);
	if (metaMatch)
		return stripBoilerplate(decodeEntities(metaMatch[1] as string));
	return null;
}
