/**
 * Vision OCR via Gemini.
 *
 * One call does both OCR and structured field extraction: a business card,
 * conference badge, event flyer, or LinkedIn screenshot becomes one or more
 * normalized `RawContact`s. JSON output is validated with zod before use.
 */

import { z } from "zod";
import { getConfig, requireGeminiKey } from "../core/config.js";
import { errorMessage, OcrError } from "../core/errors.js";
import { generateText, modelChain } from "../core/gemini.js";
import type { RawContact } from "../core/schema.js";

const OcrContactSchema = z.object({
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
	/** Model's self-rated 0–1 confidence that this is a real, fully-read person. */
	confidence: z.number().nullish(),
});

const OcrResponseSchema = z.object({
	contacts: z.array(OcrContactSchema).default([]),
});

const PROMPT = `You are an OSINT contact extractor. The image is one of: a business
card, a conference badge, an event flyer/slide, a profile screenshot, OR a
screenshot of an attendee directory / list with MANY people.

Extract every distinct PERSON. Rules:
- Do NOT invent data — omit any field you cannot actually read.
- Skip rows that are cut off at the image edge, blurred, or unreadable.
- Skip section headers, UI chrome, company-only entries, and decorative text.
- A real person needs at least a plausible full name (given + family, or a clearly
  personal handle). Ignore single stray words.
- Normalize URLs to full https:// links. Put extra context (role at event, booth,
  tagline, skills) into "notes".
- For each person add "confidence": a 0–1 number for how sure you are it's a real,
  fully-legible person (1 = crisp business card, 0.3 = partially cut-off row).

Respond with ONLY JSON of this exact shape:
{"contacts":[{"fullName":"","firstName":"","lastName":"","email":"","title":"","company":"","phones":[""],"linkedin":"","twitter":"","website":"","notes":"","confidence":0.0}]}`;

export interface OcrOptions {
	apiKey?: string;
	model?: string;
	/** Provenance reference recorded on each extracted lead (e.g. file name). */
	sourceRef?: string;
	/** Drop contacts the model rates below this (default 0.45). */
	minConfidence?: number;
}

/** Run OCR + extraction on a single image's bytes. */
export async function ocrImage(
	bytes: Uint8Array,
	mimeType: string,
	options: OcrOptions = {},
): Promise<RawContact[]> {
	const config = getConfig();
	const apiKey = options.apiKey ?? requireGeminiKey(config);
	const model = options.model ?? config.geminiOcrModel;

	let text: string;
	try {
		text = await generateText({
			apiKey,
			models: modelChain(model),
			contents: [
				{
					role: "user",
					parts: [
						{ inlineData: { mimeType, data: toBase64(bytes) } },
						{ text: PROMPT },
					],
				},
			],
			config: { responseMimeType: "application/json", temperature: 0 },
		});
	} catch (error) {
		throw new OcrError(
			`Gemini OCR request failed: ${errorMessage(error)}`,
			options.sourceRef,
			error,
		);
	}

	return parseOcrResponse(text, options.sourceRef, options.minConfidence);
}

/** A name worth keeping: two tokens, or one token plus some other signal. */
function hasUsableName(fullName: string, hasOtherField: boolean): boolean {
	const tokens = fullName.trim().split(/\s+/).filter(Boolean);
	return (
		tokens.length >= 2 ||
		(tokens.length === 1 && fullName.length >= 3 && hasOtherField)
	);
}

/** Parse + validate a Gemini OCR JSON response into RawContacts. Exported for tests. */
export function parseOcrResponse(
	text: string,
	sourceRef?: string,
	minConfidence = 0.45,
): RawContact[] {
	const json = extractJson(text);
	if (!json) {
		throw new OcrError("OCR response was not valid JSON", sourceRef);
	}
	const parsed = OcrResponseSchema.safeParse(json);
	if (!parsed.success) {
		throw new OcrError(
			`OCR response failed validation: ${parsed.error.message}`,
			sourceRef,
		);
	}
	return parsed.data.contacts
		.filter((c) => {
			// Confidence defaults to 1 when the model omits it (e.g. a crisp card).
			if ((c.confidence ?? 1) < minConfidence) return false;
			const hasField = !!(
				c.email ||
				c.title ||
				c.company ||
				c.linkedin ||
				c.phones?.length
			);
			return hasUsableName(c.fullName, hasField);
		})
		.map((c) => ({
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
			source: "ocr",
			sourceRef: sourceRef ?? null,
			relation: null,
			event: null,
		}));
}

function extractJson(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// Tolerate code fences or surrounding prose.
		const match = trimmed.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
