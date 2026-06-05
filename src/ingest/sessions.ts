/**
 * Conference session / CFP speaker export -> RawContact[].
 *
 * Pure parser (no I/O, no process.exit) for the common "sessions with speakers"
 * export shape (e.g. a call-for-papers / agenda dump). Pulls accepted-session
 * speakers into the normalized contact shape, attaching the session as the event
 * they spoke at.
 */

import { z } from "zod";
import type { RawContact } from "../core/schema.js";
import { collapseWhitespace, stripHtml } from "../core/text.js";

const SpeakerSchema = z
	.object({
		full_name: z.string().nullish(),
		first_name: z.string().nullish(),
		last_name: z.string().nullish(),
		email: z.string().nullish(),
		company_name: z.string().nullish(),
		title: z.string().nullish(),
		phone_home: z.string().nullish(),
		phone_mobile: z.string().nullish(),
		linkedin_url: z.string().nullish(),
		twitter_url: z.string().nullish(),
		facebook_url: z.string().nullish(),
		website_url: z.string().nullish(),
	})
	.passthrough();

const SessionSchema = z
	.object({
		friendly_id: z.string().nullish(),
		title: z.string().nullish(),
		description: z.string().nullish(),
		status: z.string().nullish(),
		starts_at: z.string().nullish(),
		ends_at: z.string().nullish(),
		speakers: z.array(SpeakerSchema).default([]),
	})
	.passthrough();

export const SessionsFileSchema = z.array(SessionSchema);
export type SessionExport = z.infer<typeof SessionSchema>;

/** Parse raw JSON into RawContacts. Only `accepted` sessions are included. */
export function parseSessions(raw: unknown): RawContact[] {
	const sessions = SessionsFileSchema.parse(raw);
	const contacts: RawContact[] = [];

	for (const session of sessions) {
		if ((session.status ?? "").toLowerCase() !== "accepted") continue;
		const description = session.description
			? stripHtml(session.description)
			: null;
		const eventName = session.title?.trim() || "Conference session";

		for (const speaker of session.speakers) {
			const fullName = (
				speaker.full_name ||
				[speaker.first_name, speaker.last_name].filter(Boolean).join(" ")
			)?.trim();
			if (!fullName) continue;

			const phones = [speaker.phone_home, speaker.phone_mobile]
				.map((p) => p?.trim())
				.filter((p): p is string => !!p);

			contacts.push({
				fullName,
				firstName: speaker.first_name ?? null,
				lastName: speaker.last_name ?? null,
				email: speaker.email ?? null,
				title: speaker.title ?? null,
				company: speaker.company_name ?? null,
				phones,
				linkedin: speaker.linkedin_url ?? null,
				twitter: speaker.twitter_url ?? null,
				facebook: speaker.facebook_url ?? null,
				website: speaker.website_url ?? null,
				notes: description
					? `Spoke at "${eventName}": ${collapseWhitespace(description).slice(0, 280)}`
					: null,
				source: "sessions",
				sourceRef: session.friendly_id ?? null,
				relation: "speaks_at",
				event: {
					name: eventName,
					date: session.starts_at ?? null,
					description,
					source: "sessions",
				},
			});
		}
	}

	return contacts;
}
