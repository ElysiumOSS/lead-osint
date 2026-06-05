/**
 * Local text embeddings via transformers.js (all-MiniLM-L6-v2, 384-d).
 *
 * Runs fully on-device (ONNX) — no per-embedding API cost. The model is
 * downloaded once and cached by the library, then reused via a lazy singleton.
 */
import { EmbedError, errorMessage } from "./errors.js";

/** Embedding dimensionality for all-MiniLM-L6-v2. */
export const EMBED_DIM = 384;

const MODEL = "Xenova/all-MiniLM-L6-v2";

type Extractor = (
	text: string | string[],
	opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

async function getExtractor(): Promise<Extractor> {
	if (!extractorPromise) {
		extractorPromise = (async () => {
			try {
				const { pipeline } = await import("@xenova/transformers");
				const pipe = await pipeline("feature-extraction", MODEL);
				return pipe as unknown as Extractor;
			} catch (error) {
				extractorPromise = null;
				throw new EmbedError(
					`Failed to load embedding model: ${errorMessage(error)}`,
					error,
				);
			}
		})();
	}
	return extractorPromise;
}

/** Embed a single string into a normalized 384-d vector. */
export async function embed(text: string): Promise<Float32Array> {
	const [vec] = await embedMany([text]);
	if (!vec) throw new EmbedError("Embedding produced no output");
	return vec;
}

/**
 * Embed many strings. Mean-pooled + L2-normalized so cosine similarity reduces
 * to a dot product. Empty/whitespace strings yield a zero vector.
 */
export async function embedMany(texts: string[]): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	const extractor = await getExtractor();
	const out: Float32Array[] = [];
	for (const text of texts) {
		const trimmed = text.trim();
		if (!trimmed) {
			out.push(new Float32Array(EMBED_DIM));
			continue;
		}
		try {
			const result = await extractor(trimmed, {
				pooling: "mean",
				normalize: true,
			});
			out.push(Float32Array.from(result.data));
		} catch (error) {
			throw new EmbedError(`Embedding failed: ${errorMessage(error)}`, error);
		}
	}
	return out;
}
