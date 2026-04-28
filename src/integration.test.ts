/**
 *
 * Copyright 2026 Mike Odnis
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 */

import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureConfigLive, UICaptureService } from "./service.js";

// Real browser+ffmpeg integration. Off by default; flip RUN_INTEGRATION=1 to opt in.
const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)(
	"integration: captureWebsite against a fixture site",
	() => {
		let server: http.Server;
		let baseUrl: string;
		let outDir: string;

		beforeAll(async () => {
			server = http.createServer((req, res) => {
				const route = req.url ?? "/";
				const links = [
					'<a href="/">Home</a>',
					'<a href="/about">About</a>',
					'<a href="/contact">Contact</a>',
				].join(" | ");
				const body =
					`<!doctype html><html><head><title>fixture ${route}</title></head>` +
					`<body><h1>route ${route}</h1><nav>${links}</nav>` +
					`<main><p>content for ${route}</p></main></body></html>`;
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(body);
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", () => resolve()),
			);
			const port = (server.address() as AddressInfo).port;
			baseUrl = `http://127.0.0.1:${port}/`;
			outDir = await fs.mkdtemp(path.join(os.tmpdir(), "uic-int-"));
		});

		afterAll(async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
		});

		it("crawls reachable routes, writes screenshots and a report", async () => {
			const program = Effect.gen(function* () {
				const svc = yield* UICaptureService;
				return yield* svc.captureWebsite(baseUrl);
			}).pipe(
				Effect.provide(UICaptureService.Default),
				Effect.provide(
					CaptureConfigLive({
						outputDir: outDir,
						maxDepth: 1,
						routeConcurrency: 1,
						waitTime: 100,
						warmupScroll: false,
						viewports: [{ name: "desktop", width: 1280, height: 720 }],
					}),
				),
			);

			const results = await Effect.runPromise(program);

			// root + at least about + contact (asset filter never engages here, none of
			// the fixture URLs end in an asset extension).
			expect(results.size).toBeGreaterThanOrEqual(3);

			const report = JSON.parse(
				await fs.readFile(path.join(outDir, "capture-report.json"), "utf8"),
			);
			expect(report.totalRoutes).toBeGreaterThanOrEqual(3);
			expect(report.failedCaptures).toBe(0);
			expect(report.successfulCaptures).toBe(report.totalRoutes);

			const md = await fs.readFile(path.join(outDir, "REPORT.md"), "utf8");
			expect(md).toMatch(/^# UI Capture Report/);
			expect(md).toContain("Total Routes:");

			// All three image formats land for the only viewport we configured.
			const rootDir = path.join(outDir, "root", "screenshots");
			for (const fmt of ["png", "webp", "jpg"] as const) {
				const file = path.join(rootDir, fmt, `desktop_1280x720_latest.${fmt}`);
				const stat = await fs.stat(file);
				expect(stat.size).toBeGreaterThan(0);
			}
		}, 60_000);
	},
);
