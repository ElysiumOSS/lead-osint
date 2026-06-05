/**
 * Bounded-concurrency worker pool.
 *
 * Extracted from `scrape-partiful.ts`. Runs `worker` over `items` with at most
 * `concurrency` in flight; an optional per-worker stagger avoids hammering a
 * remote host on burst start.
 */
export async function pool<T>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
	options: { perWorkerDelayMs?: number } = {},
): Promise<void> {
	const { perWorkerDelayMs = 0 } = options;
	const total = items.length;
	const lanes = Math.max(1, Math.min(concurrency, total));
	let cursor = 0;

	const runners = Array.from({ length: lanes }, async (_, workerId) => {
		while (cursor < total) {
			const index = cursor;
			cursor += 1;
			if (perWorkerDelayMs > 0 && workerId > 0) {
				await delay(perWorkerDelayMs);
			}
			await worker(items[index] as T, index);
		}
	});
	await Promise.all(runners);
}

/**
 * Map over items with bounded concurrency, collecting results in input order.
 * A worker that throws yields `null` for that slot rather than rejecting the
 * whole batch.
 */
export async function mapPool<T, R>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
	options: { perWorkerDelayMs?: number } = {},
): Promise<(R | null)[]> {
	const results: (R | null)[] = new Array(items.length).fill(null);
	await pool(
		items,
		concurrency,
		async (item, index) => {
			try {
				results[index] = await worker(item, index);
			} catch {
				results[index] = null;
			}
		},
		options,
	);
	return results;
}

/** Promise-based sleep. */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
