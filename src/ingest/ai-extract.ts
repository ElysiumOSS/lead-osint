/**
 * Generic AI ingest: arbitrary JSON or pasted text -> RawContact[].
 *
 * The deterministic parsers (sessions/partiful/event-listings/luma) handle known formats
 * for free. This is the catch-all for everything else — paste a LinkedIn export,
 * a messy attendee list, a scraped JSON blob, a CRM dump — and Gemini normalizes
 * it into the lead model. Output is validated with zod before it touches the store.
 */

import { z } from "zod";
import { getConfig, requireGeminiKey } from "../core/config.js";
import { errorMessage, IngestError } from "../core/errors.js";
import { generateText, modelChain } from "../core/gemini.js";
import type { RawContact } from "../core/schema.js";
import type { IngestResult } from "./types.js";

const ExtractContactSchema = z.object({
	fullName: z.string().min(1),
	firstName: z.string().nullish(),
	lastName: z.string().nullish(),
	email: z.string().nullish(),
	title: z.string().nullish(),
	company: z.string().nullish(),
	phones: z.array(z.string()).nullish(),
	linkedin: z.string().nullish(),
	twitter: z.string().nullish(),
	website: z.string().nullish(),
	notes: z.string().nullish(),
	event: z
		.object({
			name: z.string().nullish(),
			date: z.string().nullish(),
			location: z.string().nullish(),
		})
		.nullish(),
});

const ExtractResponseSchema = z.object({
	contacts: z.array(ExtractContactSchema).default([]),
});

const PROMPT = `You normalize arbitrary data into structured contacts.

The INPUT below is some blob about people — it may be JSON (any shape), a pasted
list, scraped output, notes, or a mix. Extract every distinct PERSON. Infer
fields only when clearly present; never invent. If a person is tied to an event
(a talk, dinner, conference), include it. Normalize URLs to full https:// links.
Put anything useful but unstructured (skills, bio, certifications, context) into
"notes".

Return ONLY JSON of this shape:
{"contacts":[{"fullName":"","firstName":"","lastName":"","email":"","title":"","company":"","phones":[""],"linkedin":"","twitter":"","website":"","notes":"","event":{"name":"","date":"","location":""}}]}

INPUT:
`;

export interface AiExtractOptions {
	apiKey?: string;
	model?: string;
	/** Provenance label recorded on each lead (default "paste"). */
	source?: string;
	sourceRef?: string;
}

/** Extract contacts from an arbitrary text/JSON blob via Gemini. */
export async function aiExtract(
	text: string,
	options: AiExtractOptions = {},
): Promise<IngestResult> {
	const config = getConfig();
	const apiKey = options.apiKey ?? requireGeminiKey(config);
	const model = options.model ?? config.geminiTextModel;
	const trimmed = text.trim();
	if (!trimmed) return { contacts: [], events: [] };

	let raw: string;
	try {
		raw = await generateText({
			apiKey,
			models: modelChain(model),
			contents: [
				{ role: "user", parts: [{ text: PROMPT + trimmed.slice(0, 100_000) }] },
			],
			config: { responseMimeType: "application/json", temperature: 0 },
		});
	} catch (error) {
		throw new IngestError(
			`AI extraction failed: ${errorMessage(error)}`,
			"auto",
			error,
		);
	}

	return {
		contacts: mapExtractResponse(
			raw,
			options.source ?? "paste",
			options.sourceRef,
		),
		events: [],
	};
}

/** Parse + validate a Gemini extraction response into RawContacts. For tests. */
export function mapExtractResponse(
	text: string,
	source = "paste",
	sourceRef?: string,
): RawContact[] {
	const json = extractJson(text);
	if (!json) throw new IngestError("AI extraction did not return JSON", "auto");
	const parsed = ExtractResponseSchema.safeParse(json);
	if (!parsed.success) {
		throw new IngestError(
			`AI extraction failed validation: ${parsed.error.message}`,
			"auto",
		);
	}
	return parsed.data.contacts.map((c) => {
		const eventName = c.event?.name?.trim();
		return {
			fullName: c.fullName,
			firstName: c.firstName ?? null,
			lastName: c.lastName ?? null,
			email: c.email ?? null,
			title: c.title ?? null,
			company: c.company ?? null,
			phones: (c.phones ?? []).filter((p): p is string => !!p?.trim()),
			linkedin: c.linkedin ?? null,
			twitter: c.twitter ?? null,
			facebook: null,
			website: c.website ?? null,
			notes: c.notes ?? null,
			source,
			sourceRef: sourceRef ?? null,
			relation: eventName ? "attended" : null,
			event: eventName
				? {
						name: eventName,
						date: c.event?.date ?? null,
						location: c.event?.location ?? null,
						source,
					}
				: null,
		} satisfies RawContact;
	});
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const match = trimmed.match(/[[{][\s\S]*[\]}]/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}
