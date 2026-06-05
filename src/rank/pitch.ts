/**
 * Your startup pitch -> a "pitch profile" embedding.
 *
 * The pitch is the query the whole CRM is ranked against: leads whose
 * identity/role embeds close to it are the people most worth reaching out to.
 */
import { readFile } from "node:fs/promises";
import { embed } from "../core/embeddings.js";
import { IngestError } from "../core/errors.js";

/** Read a pitch from `.md`/`.txt`/`.json` and flatten it to plain text. */
export async function loadPitch(path: string): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		throw new IngestError(`Cannot read pitch file: ${path}`, "pitch", error);
	}
	const trimmed = raw.trim();
	if (path.toLowerCase().endsWith(".json")) {
		try {
			return flattenJson(JSON.parse(trimmed));
		} catch {
			return trimmed;
		}
	}
	return trimmed;
}

/** Embed pitch text into the profile vector used for ranking + search. */
export async function embedPitch(text: string): Promise<Float32Array> {
	return embed(text);
}

function flattenJson(value: unknown): string {
	const parts: string[] = [];
	const walk = (v: unknown): void => {
		if (v == null) return;
		if (
			typeof v === "string" ||
			typeof v === "number" ||
			typeof v === "boolean"
		) {
			parts.push(String(v));
		} else if (Array.isArray(v)) {
			for (const item of v) walk(item);
		} else if (typeof v === "object") {
			for (const item of Object.values(v as Record<string, unknown>))
				walk(item);
		}
	};
	walk(value);
	return parts.join(". ");
}
