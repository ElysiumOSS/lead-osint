/**
 * Vector (de)serialization + similarity helpers.
 *
 * Vectors are stored two ways: in the sqlite-vec `vec0` virtual table (fast
 * ANN) and as a raw Float32 BLOB on `leads` (so a pure-JS cosine fallback works
 * even when the sqlite-vec extension cannot be loaded).
 */

/** Pack a Float32Array as the little-endian byte buffer sqlite-vec expects. */
export function serializeVector(vec: Float32Array): Uint8Array {
	return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Read a Float32 vector back from a stored BLOB. */
export function deserializeVector(
	blob: Uint8Array | ArrayBuffer | null,
): Float32Array | null {
	if (!blob) return null;
	const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	if (buf.byteLength % 4 !== 0) return null;
	// Copy to guarantee 4-byte alignment for the Float32 view.
	const aligned = new Uint8Array(buf.byteLength);
	aligned.set(buf);
	return new Float32Array(aligned.buffer);
}

/** Cosine similarity in [-1, 1]. Assumes finite vectors of equal length. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < n; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ScoredRow {
	id: string;
	score: number;
}

/**
 * Brute-force top-k cosine search over in-memory (id, vector) pairs.
 * Used as the fallback when sqlite-vec is unavailable, and by tests.
 */
export function topKCosine(
	query: Float32Array,
	rows: { id: string; vector: Float32Array }[],
	k: number,
): ScoredRow[] {
	return rows
		.map((r) => ({ id: r.id, score: cosineSimilarity(query, r.vector) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, k));
}
