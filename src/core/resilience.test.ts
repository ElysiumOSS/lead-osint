import { describe, expect, it } from "vitest";
import {
	MemoryCacheStore,
	MemoryRateLimitStore,
	withResilience,
} from "./resilience.js";

describe("withResilience — retry", () => {
	it("retries until the thunk succeeds", async () => {
		let calls = 0;
		const result = await withResilience(
			async () => {
				calls += 1;
				if (calls < 3) throw new Error("transient");
				return "ok";
			},
			{ retry: { maxAttempts: 3, backoffMs: 0 } },
		);
		expect(result).toBe("ok");
		expect(calls).toBe(3);
	});

	it("throws after exhausting attempts", async () => {
		let calls = 0;
		await expect(
			withResilience(
				async () => {
					calls += 1;
					throw new Error("always");
				},
				{ retry: { maxAttempts: 2, backoffMs: 0 } },
			),
		).rejects.toThrow("always");
		expect(calls).toBe(2);
	});

	it("does not retry when retryOn returns false", async () => {
		let calls = 0;
		await expect(
			withResilience(
				async () => {
					calls += 1;
					throw new Error("fatal");
				},
				{
					retry: {
						maxAttempts: 5,
						backoffMs: 0,
						retryOn: (e) => !(e instanceof Error && e.message === "fatal"),
					},
				},
			),
		).rejects.toThrow("fatal");
		expect(calls).toBe(1);
	});
});

describe("withResilience — timeout", () => {
	it("rejects when the thunk exceeds the timeout", async () => {
		await expect(
			withResilience(() => new Promise((r) => setTimeout(r, 100)), {
				timeoutMs: 20,
			}),
		).rejects.toThrow(/timed out/);
	});

	it("passes an abort signal the thunk can observe", async () => {
		let aborted = false;
		await expect(
			withResilience(
				(signal) =>
					new Promise((_, reject) => {
						signal?.addEventListener("abort", () => {
							aborted = true;
							reject(new Error("aborted by signal"));
						});
					}),
				{ timeoutMs: 20 },
			),
		).rejects.toThrow();
		expect(aborted).toBe(true);
	});
});

describe("withResilience — rate limit", () => {
	it("spaces calls so they stay within the window", async () => {
		const store = new MemoryRateLimitStore();
		const cfg = {
			rateLimit: { store, maxRequests: 2, windowMs: 60, key: "k" },
		};
		const start = Date.now();
		// 3rd call must wait for the window to roll over past the 1st.
		await withResilience(async () => 1, cfg);
		await withResilience(async () => 2, cfg);
		await withResilience(async () => 3, cfg);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(40);
	});

	it("does not delay while under the limit", async () => {
		const store = new MemoryRateLimitStore();
		const cfg = {
			rateLimit: { store, maxRequests: 5, windowMs: 1000, key: "k" },
		};
		const start = Date.now();
		await withResilience(async () => 1, cfg);
		await withResilience(async () => 2, cfg);
		expect(Date.now() - start).toBeLessThan(40);
	});
});

describe("withResilience — cache", () => {
	it("returns the cached result without re-running the thunk", async () => {
		const store = new MemoryCacheStore();
		let calls = 0;
		const run = () =>
			withResilience(
				async () => {
					calls += 1;
					return "value";
				},
				{ cache: { store, key: "c", ttlMs: 1000 } },
			);
		expect(await run()).toBe("value");
		expect(await run()).toBe("value");
		expect(calls).toBe(1);
	});

	it("does not cache a thrown failure", async () => {
		const store = new MemoryCacheStore();
		let calls = 0;
		const run = (shouldThrow: boolean) =>
			withResilience(
				async () => {
					calls += 1;
					if (shouldThrow) throw new Error("nope");
					return "good";
				},
				{ cache: { store, key: "c", ttlMs: 1000 } },
			);
		await expect(run(true)).rejects.toThrow("nope");
		expect(await run(false)).toBe("good");
		expect(calls).toBe(2);
	});
});

describe("MemoryRateLimitStore", () => {
	it("counts only timestamps within the window", async () => {
		const store = new MemoryRateLimitStore();
		await store.record("a");
		await store.record("a");
		expect(await store.getCount("a", 1000)).toBe(2);
		expect(await store.getCount("a", 0)).toBe(0);
	});
});
