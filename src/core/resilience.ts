/**
 * Engine-level resilience for async work — retry, rate-limit, timeout, abort.
 *
 * Ported from the jam-nodes execution engine (`executeNode`), whose principle is
 * that cross-cutting concerns belong around a pure function, not baked into it.
 * lead-osint isn't node-based, so this wraps a plain async thunk instead: the
 * network call stays pure and fail-soft, while retry/rate-limit/timeout are
 * configured by the caller. See the `jam-nodes-inspiration` memory.
 *
 * Stores are pluggable (swap in Redis later); the in-memory implementations
 * below are the defaults and are enough for a single-process CLI run.
 */

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RetryConfig {
	/** Maximum number of attempts (1 = no retry). */
	maxAttempts: number;
	/** Initial delay between retries, in ms. */
	backoffMs: number;
	/** Multiplier applied to the delay after each attempt (default 2). */
	backoffMultiplier?: number;
	/** Upper bound on the backoff delay, in ms. */
	maxBackoffMs?: number;
	/** Predicate deciding whether an error is retriable (default: always). */
	retryOn?: (error: unknown) => boolean;
}

/** Pluggable windowed rate-limit state backend. */
export interface RateLimitStore {
	record(key: string): Promise<void>;
	getCount(key: string, windowMs: number): Promise<number>;
	getOldestInWindow(key: string, windowMs: number): Promise<number | undefined>;
}

export interface RateLimitConfig {
	/** Max requests permitted within the window. */
	maxRequests: number;
	/** Window length in ms. */
	windowMs: number;
	/** State backend. */
	store: RateLimitStore;
	/** Bucket key (default "default"); group calls that share a quota. */
	key?: string;
}

/** Pluggable cache backend. */
export interface CacheStore {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, value: T, ttlMs: number): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface CacheConfig {
	store: CacheStore;
	key: string;
	ttlMs: number;
}

export interface ResilienceConfig {
	retry?: RetryConfig;
	rateLimit?: RateLimitConfig;
	cache?: CacheConfig;
	/** Per-attempt timeout in ms (aborts the thunk's signal, then rejects). */
	timeoutMs?: number;
	/** External cancellation. */
	signal?: AbortSignal;
	/** Called after each failed attempt, before the next retry. */
	onRetry?: (attempt: number, error: unknown) => void;
}

// ---------------------------------------------------------------------------
// In-memory store implementations (default backends)
// ---------------------------------------------------------------------------

/** In-memory windowed rate-limit store; expired timestamps pruned on access. */
export class MemoryRateLimitStore implements RateLimitStore {
	private windows = new Map<string, number[]>();

	async record(key: string): Promise<void> {
		const ts = this.windows.get(key) ?? [];
		ts.push(Date.now());
		this.windows.set(key, ts);
	}

	async getCount(key: string, windowMs: number): Promise<number> {
		this.prune(key, windowMs);
		return (this.windows.get(key) ?? []).length;
	}

	async getOldestInWindow(
		key: string,
		windowMs: number,
	): Promise<number | undefined> {
		this.prune(key, windowMs);
		return this.windows.get(key)?.[0];
	}

	private prune(key: string, windowMs: number): void {
		const ts = this.windows.get(key);
		if (!ts) return;
		const cutoff = Date.now() - windowMs;
		const kept = ts.filter((t) => t > cutoff);
		if (kept.length === 0) this.windows.delete(key);
		else this.windows.set(key, kept);
	}
}

interface CacheEntry {
	value: unknown;
	expireAt: number;
}

/** In-memory cache; expired entries evicted lazily on read. */
export class MemoryCacheStore implements CacheStore {
	private cache = new Map<string, CacheEntry>();

	async get<T>(key: string): Promise<T | undefined> {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expireAt) {
			this.cache.delete(key);
			return undefined;
		}
		return entry.value as T;
	}

	async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
		this.cache.set(key, { value, expireAt: Date.now() + ttlMs });
	}

	async delete(key: string): Promise<void> {
		this.cache.delete(key);
	}
}

// ---------------------------------------------------------------------------
// withResilience
// ---------------------------------------------------------------------------

/**
 * Run `fn` with optional rate-limiting, caching, timeout, and retry.
 *
 * Order mirrors jam-nodes: wait for a rate-limit slot, return a cached result if
 * present, otherwise retry `fn` (each attempt bounded by `timeoutMs`) and cache
 * a successful result. `fn` receives an AbortSignal it may honor for early exit.
 */
export async function withResilience<T>(
	fn: (signal?: AbortSignal) => Promise<T>,
	config: ResilienceConfig = {},
): Promise<T> {
	if (config.rateLimit) await waitForRateLimit(config.rateLimit);

	if (config.cache) {
		const { store, key, ttlMs } = config.cache;
		const cached = await store.get<T>(key);
		if (cached !== undefined) return cached;
		const result = await runWithRetry(fn, config);
		await store.set(key, result, ttlMs);
		return result;
	}

	return runWithRetry(fn, config);
}

async function runWithRetry<T>(
	fn: (signal?: AbortSignal) => Promise<T>,
	config: ResilienceConfig,
): Promise<T> {
	const maxAttempts = config.retry?.maxAttempts ?? 1;
	const backoffMs = config.retry?.backoffMs ?? 0;
	const multiplier = config.retry?.backoffMultiplier ?? 2;
	const maxBackoffMs = config.retry?.maxBackoffMs ?? Number.POSITIVE_INFINITY;
	const retryOn = config.retry?.retryOn;

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (config.signal?.aborted) throw new Error("Execution aborted");
		try {
			return await runWithTimeout(fn, config);
		} catch (error) {
			lastError = error;
			const canRetry = attempt < maxAttempts && (!retryOn || retryOn(error));
			if (!canRetry) throw error;
			config.onRetry?.(attempt, error);
			const delay = Math.min(
				backoffMs * multiplier ** (attempt - 1),
				maxBackoffMs,
			);
			if (delay > 0) await sleep(delay);
		}
	}
	throw lastError;
}

async function runWithTimeout<T>(
	fn: (signal?: AbortSignal) => Promise<T>,
	config: ResilienceConfig,
): Promise<T> {
	const { timeoutMs, signal } = config;
	if (!timeoutMs && !signal) return fn();

	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onExternalAbort, { once: true });
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const racers: Promise<T>[] = [fn(controller.signal)];
	if (timeoutMs) {
		racers.push(
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error(`Execution timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		);
	}

	try {
		return await Promise.race(racers);
	} finally {
		if (timer) clearTimeout(timer);
		if (signal) signal.removeEventListener("abort", onExternalAbort);
	}
}

/** Block until a request slot is free in the window, then record this request. */
async function waitForRateLimit(rl: RateLimitConfig): Promise<void> {
	const key = rl.key ?? "default";
	// Re-check after each wait: other in-flight callers may free or fill the window.
	while (true) {
		const count = await rl.store.getCount(key, rl.windowMs);
		if (count < rl.maxRequests) break;
		const oldest = await rl.store.getOldestInWindow(key, rl.windowMs);
		if (oldest === undefined) break;
		const waitMs = oldest + rl.windowMs - Date.now();
		if (waitMs <= 0) break;
		await sleep(waitMs);
	}
	await rl.store.record(key);
}
