/**
 * Local web dashboard server (Bun native HTTP — no extra deps).
 *
 * Serves the interactive CRM and a small JSON API so stage / note / reminder
 * edits persist straight to SQLite — no regenerating a static HTML file. The
 * request handler is a pure function of (repo, Request) so it can be unit-tested
 * without binding a port.
 */
import { parseWhen } from "./core/dates.js";
import { errorMessage } from "./core/errors.js";
import type { LeadRepository } from "./core/repository.js";
import { STAGES, type Stage } from "./core/schema.js";
import { buildExportRows, toCsv, toVcard } from "./export.js";
import { warmContactForInvestor } from "./ingest/investors.js";
import { draftForLead } from "./outreach/draft.js";
import { findNodes, shortestPath } from "./paths.js";
import { hybridSearch } from "./search.js";
import { renderDashboard } from "./view/dashboard.js";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Respond with `text`, gzip-compressed when the client accepts it and the body
 * is large enough to be worth it. JSON/HTML compress ~85–90%, which matters a
 * lot for the big `/api/data` payload and the dashboard document.
 */
function compressed(
	req: Request,
	text: string,
	contentType: string,
	status = 200,
): Response {
	const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes(
		"gzip",
	);
	if (acceptsGzip && text.length > 1024) {
		return new Response(Bun.gzipSync(Buffer.from(text)), {
			status,
			headers: { "content-type": contentType, "content-encoding": "gzip" },
		});
	}
	return new Response(text, {
		status,
		headers: { "content-type": contentType },
	});
}

async function body(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Build the request handler for `repo`. Pure: same input → same effect. */
export function createHandler(
	repo: LeadRepository,
): (req: Request) => Promise<Response> {
	// Cache similarity edges per (k,minSim) — computing them scans every vector,
	// so we don't want to redo it each time the client toggles the layer.
	const simCache = new Map<
		string,
		{ source: string; target: string; sim: number }[]
	>();
	// Cluster summaries are derived from the same expensive scan — cache too.
	const clusterCache = new Map<string, unknown>();

	return async (req: Request): Promise<Response> => {
		const url = new URL(req.url);
		const path = url.pathname;
		const method = req.method;

		try {
			if (method === "GET" && path === "/") {
				return compressed(req, renderDashboard(), "text/html; charset=utf-8");
			}

			// Silence the browser's automatic favicon request (no asset to serve).
			if (method === "GET" && path === "/favicon.ico") {
				return new Response(null, { status: 204 });
			}

			if (method === "GET" && path === "/api/data") {
				const graph = repo.graph();
				// Normalize edges to {source,target} so the client can index them.
				const edges = graph.edges.map((e) => ({
					source: e.srcId,
					target: e.dstId,
					rel: e.rel,
				}));
				// Slim projection: the list + graph only need these fields. Full
				// detail (notes, contacts, rationale) is lazy-loaded per lead via
				// /api/lead/:id when the drawer opens. Keeps this payload small.
				const leads = repo.listLeads({ orderByFit: true }).map((l) => ({
					id: l.id,
					fullName: l.fullName,
					title: l.title,
					stage: l.stage,
					pitchFit: l.pitchFit,
					relationship: l.relationship,
					relevance: l.relevance,
				}));
				const due = repo.listReminders({
					dueBefore: new Date().toISOString(),
				}).length;
				return compressed(
					req,
					JSON.stringify({ nodes: graph.nodes, edges, leads, due }),
					"application/json",
				);
			}

			const leadMatch = path.match(
				/^\/api\/lead\/([^/]+)(\/(stage|note|remind|draft))?$/,
			);
			if (leadMatch) {
				const id = decodeURIComponent(leadMatch[1] as string);
				const action = leadMatch[3];
				const lead = repo.getLead(id);
				if (!lead) return json({ error: "lead not found" }, 404);

				if (method === "GET" && !action) {
					return json({
						lead,
						org: lead.orgId ? repo.getOrg(lead.orgId) : null,
						interactions: repo.listInteractions(id),
						reminders: repo
							.listReminders({ includeDone: true })
							.filter((r) => r.leadId === id),
					});
				}
				if (method === "POST" && action === "stage") {
					const stage = String((await body(req)).stage) as Stage;
					if (!STAGES.includes(stage))
						return json({ error: "invalid stage" }, 400);
					repo.setStage(id, stage);
					repo.addInteraction(id, "stage", `Stage → ${stage}`);
					return json({ ok: true, lead: repo.getLead(id) });
				}
				if (method === "POST" && action === "note") {
					const note = String((await body(req)).note ?? "").trim();
					if (!note) return json({ error: "empty note" }, 400);
					repo.enrichLead(id, { note });
					repo.addInteraction(id, "note", note);
					return json({ ok: true, lead: repo.getLead(id) });
				}
				if (method === "POST" && action === "draft") {
					const b = await body(req);
					try {
						const d = await draftForLead(lead, {
							pitch: b.pitch ? String(b.pitch) : undefined,
						});
						return json({ ok: true, ...d });
					} catch (e) {
						return json({ error: errorMessage(e) }, 502);
					}
				}
				if (method === "POST" && action === "remind") {
					const b = await body(req);
					try {
						const dueAt = parseWhen(String(b.when ?? ""));
						repo.addReminder(id, dueAt, b.note ? String(b.note) : null);
						repo.addInteraction(
							id,
							"reminder",
							`Follow up by ${dueAt.slice(0, 10)}`,
						);
						return json({ ok: true, dueAt });
					} catch (e) {
						return json({ error: errorMessage(e) }, 400);
					}
				}
			}

			const doneMatch = path.match(/^\/api\/remind\/(\d+)\/done$/);
			if (doneMatch && method === "POST") {
				return json({ ok: repo.completeReminder(Number(doneMatch[1])) });
			}

			if (method === "GET" && path === "/api/due") {
				const reminders = repo.listReminders({
					dueBefore: new Date().toISOString(),
				});
				return json(
					reminders.map((r) => ({ ...r, lead: repo.getLead(r.leadId) })),
				);
			}

			if (method === "GET" && path === "/api/stats") {
				const c = repo.counts();
				const due = repo.listReminders({
					dueBefore: new Date().toISOString(),
				}).length;
				return json({
					people: c.leads,
					assessed: c.assessed,
					orgs: c.orgs,
					links: c.edges,
					due,
				});
			}

			if (method === "GET" && path === "/api/similar") {
				const k = Math.min(10, Number(url.searchParams.get("k") ?? 4) || 4);
				const minSim = Math.min(
					0.99,
					Math.max(0.3, Number(url.searchParams.get("min") ?? 0.65) || 0.65),
				);
				const key = `${k}|${minSim}`;
				let edges = simCache.get(key);
				if (!edges) {
					edges = repo.similarityEdges({ k, minSim });
					simCache.set(key, edges);
				}
				return compressed(req, JSON.stringify({ edges }), "application/json");
			}

			if (method === "GET" && path === "/api/clusters") {
				const k = Math.max(
					2,
					Math.min(60, Number(url.searchParams.get("k") ?? 36) || 36),
				);
				const minSize = Math.max(
					2,
					Number(url.searchParams.get("minSize") ?? 4) || 4,
				);
				const key = `${k}|${minSize}`;
				let clusters = clusterCache.get(key);
				if (!clusters) {
					clusters = repo.clusters({ k, minSize });
					clusterCache.set(key, clusters);
				}
				return compressed(
					req,
					JSON.stringify({ clusters }),
					"application/json",
				);
			}

			if (method === "GET" && path === "/api/vcs") {
				const all = url.searchParams.get("all") === "1";
				const firms = repo.investorFirms();
				return compressed(
					req,
					JSON.stringify({ firms: all ? firms : firms.filter((f) => f.isVc) }),
					"application/json",
				);
			}

			// Ranked investor matches (from the last `match` run) + the warm-intro
			// contact resolved against your people graph, for the Investors tab.
			if (method === "GET" && path === "/api/investors") {
				const investors = repo.listInvestors().map((inv) => {
					const warm = warmContactForInvestor(repo, inv);
					return {
						id: inv.id,
						name: inv.name,
						domain: inv.domain,
						website: inv.website,
						stages: inv.stages,
						sectors: inv.sectors,
						geo: inv.geo,
						checkMin: inv.checkMin,
						checkMax: inv.checkMax,
						investorType: inv.investorType,
						partnerName: inv.partnerName,
						partnerEmail: inv.partnerEmail,
						matchScore: inv.matchScore,
						matchBreakdown: inv.matchBreakdown,
						warm: warm ? { id: warm.id, name: warm.fullName } : null,
					};
				});
				return compressed(
					req,
					JSON.stringify({ investors }),
					"application/json",
				);
			}

			if (method === "GET" && path === "/api/export") {
				const fmt =
					url.searchParams.get("format") === "vcard" ? "vcard" : "csv";
				const minFitRaw = url.searchParams.get("min-fit");
				const rows = buildExportRows(repo, {
					stage: url.searchParams.get("stage") ?? undefined,
					relationship: url.searchParams.get("rel") ?? undefined,
					minFit: minFitRaw ? Number(minFitRaw) : undefined,
				});
				const body = fmt === "vcard" ? toVcard(rows) : toCsv(rows);
				return new Response(body, {
					headers: {
						"content-type":
							fmt === "vcard" ? "text/vcard" : "text/csv; charset=utf-8",
						"content-disposition": `attachment; filename="leads.${fmt === "vcard" ? "vcf" : "csv"}"`,
					},
				});
			}

			if (method === "GET" && path === "/api/search") {
				const q = url.searchParams.get("q")?.trim();
				if (!q) return json({ error: "missing q" }, 400);
				const k = Number(url.searchParams.get("k") ?? 20) || 20;
				return json(await hybridSearch(repo, q, k));
			}

			if (method === "GET" && path === "/api/path") {
				const from = url.searchParams.get("from")?.trim();
				const to = url.searchParams.get("to")?.trim();
				if (!from || !to) return json({ error: "need from + to" }, 400);
				const a = findNodes(repo, from)[0];
				const b = findNodes(repo, to)[0];
				if (!a || !b)
					return json({ error: "could not resolve both nodes" }, 404);
				const result = shortestPath(repo, a.id, b.id);
				return json(result ?? { error: "no connection" });
			}

			return json({ error: "not found" }, 404);
		} catch (error) {
			return json({ error: errorMessage(error) }, 500);
		}
	};
}

export interface ServerHandle {
	url: string;
	stop: () => void;
}

/** Start the dashboard server for an already-open repo. */
export function serve(repo: LeadRepository, port = 8787): ServerHandle {
	const handler = createHandler(repo);
	const server = Bun.serve({ port, fetch: handler });
	return {
		url: `http://localhost:${server.port}`,
		stop: () => server.stop(true),
	};
}
