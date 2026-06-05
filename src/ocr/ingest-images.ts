/**
 * OCR a directory of images into an IngestResult.
 *
 * Reads every supported image in `dir`, runs vision OCR, and aggregates the
 * extracted people. Bounded concurrency keeps API usage polite.
 */
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { mapPool } from "../core/concurrency.js";
import { IngestError } from "../core/errors.js";
import type { RawContact } from "../core/schema.js";
import type { IngestResult } from "../ingest/types.js";
import { type OcrOptions, ocrImage } from "./gemini-ocr.js";

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

export interface OcrDirOptions extends Omit<OcrOptions, "sourceRef"> {
	concurrency?: number;
	/** Called after each image with its name and how many contacts it yielded. */
	onProgress?: (file: string, count: number) => void;
}

/** List supported image files (non-recursive) in a directory. */
export async function listImages(dir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch (error) {
		throw new IngestError(`Cannot read images directory: ${dir}`, "ocr", error);
	}
	return entries
		.filter((name) => MIME_BY_EXT[extname(name).toLowerCase()])
		.sort()
		.map((name) => join(dir, name));
}

/** OCR every image in `dir`, returning the aggregated contacts. */
export async function ingestImages(
	dir: string,
	options: OcrDirOptions = {},
): Promise<IngestResult> {
	const { concurrency = 3, onProgress, ...ocrOptions } = options;
	const files = await listImages(dir);

	const results = await mapPool(files, concurrency, async (file) => {
		const bytes = await readFile(file);
		const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? "image/png";
		const contacts = await ocrImage(new Uint8Array(bytes), mime, {
			...ocrOptions,
			sourceRef: file,
		});
		onProgress?.(file, contacts.length);
		return contacts;
	});

	const contacts: RawContact[] = results
		.filter((r): r is RawContact[] => r !== null)
		.flat();

	return { contacts, events: [] };
}
