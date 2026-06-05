/**
 * Resilient Gemini text generation.
 *
 * Centralizes every `@google/genai` call so OCR, AI ingest, and outreach all get
 * the same robustness: if a model is retired (404 / "no longer available") it
 * falls back to the next model in the list; transient 429/503s are retried with
 * backoff. Returns the raw response text — callers parse it.
 */
import { errorMessage } from "./errors.js";

/** Preferred → fallback chain. Retired models drop through to the next. */
export const FALLBACK_MODELS = [
	"gemini-2.5-flash",
	"gemini-2.0-flash-001",
	"gemini-1.5-flash",
];

/** Build a de-duplicated model list with `preferred` first. */
export function modelChain(preferred?: string): string[] {
	const seen = new Set<string>();
	return [preferred, ...FALLBACK_MODELS].filter((m): m is string => {
		if (!m || seen.has(m)) return false;
		seen.add(m);
		return true;
	});
}

// Reuse one client per key (cheap, avoids re-handshaking).
const clients = new Map<string, unknown>();
async function client(apiKey: string): Promise<{
	models: { generateContent: (req: unknown) => Promise<{ text?: string }> };
}> {
	let c = clients.get(apiKey);
	if (!c) {
		const { GoogleGenAI } = await import("@google/genai");
		c = new GoogleGenAI({ apiKey });
		clients.set(apiKey, c);
	}
	return c as never;
}

export interface GenerateOptions {
	apiKey: string;
	models: string[];
	contents: unknown;
	config?: Record<string, unknown>;
	retries?: number;
}

function statusOf(error: unknown): number {
	const e = error as { status?: number };
	if (typeof e?.status === "number") return e.status;
	const m = errorMessage(error).match(/"code"\s*:\s*(\d+)/);
	return m ? Number(m[1]) : 0;
}

const isRetryable = (s: number) => s === 429 || s === 503 || s === 500;
const isModelGone = (s: number, msg: string) =>
	s === 404 || /no longer available|not found|NOT_FOUND/i.test(msg);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate content, trying each model in turn and retrying transient failures.
 * Throws only when every model is exhausted.
 */
export async function generateText(options: GenerateOptions): Promise<string> {
	const { apiKey, models, contents, config, retries = 3 } = options;
	const ai = await client(apiKey);
	let lastError: unknown;

	for (const model of models) {
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				const res = await ai.models.generateContent({
					model,
					contents,
					config,
				});
				return res.text ?? "";
			} catch (error) {
				lastError = error;
				const status = statusOf(error);
				const msg = errorMessage(error);
				if (isModelGone(status, msg)) break; // try next model
				if (isRetryable(status) && attempt < retries) {
					await sleep(attempt * 1500);
					continue;
				}
				throw error; // non-retryable, non-model error (auth, bad request, …)
			}
		}
	}
	throw new Error(
		`All Gemini models failed (${models.join(", ")}): ${errorMessage(lastError)}`,
	);
}
