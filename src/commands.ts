/**
 * CLI command handlers + dispatch for lead-osint.
 *
 * Thin orchestration: each handler opens the store, wires the relevant pipeline
 * modules, prints a concise human summary, and closes cleanly. The heavy lifting
 * lives in core/ingest/ocr/rank/outreach/view.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runAssess } from "./assess.js";
import { getConfig } from "./core/config.js";
import { parseWhen } from "./core/dates.js";
import { type LeadDb, openDatabase } from "./core/db.js";
import { embedMany } from "./core/embeddings.js";
import { errorMessage, LeadOsintError } from "./core/errors.js";
import { LeadRepository } from "./core/repository.js";
import {
	applyDedupe,
	applyOrgDedupe,
	planDedupe,
	planOrgDedupe,
} from "./dedupe.js";
import { runEnrich } from "./enrich.js";
import { buildExportRows, writeExport } from "./export.js";
import { aiExtract } from "./ingest/ai-extract.js";
import { parseAirtable } from "./ingest/airtable.js";
import { ingestEventListings } from "./ingest/event-listings.js";
import { aiExtractInvestors } from "./ingest/investor-extract.js";
import {
	type InvestorNormalizeStats,
	normalizeInvestorsInto,
	warmContactForInvestor,
} from "./ingest/investors.js";
import { parseLinkedinConnections } from "./ingest/linkedin.js";
import { parseLuma } from "./ingest/luma.js";
import { normalizeInto } from "./ingest/normalize.js";
import { parseOpenVc } from "./ingest/openvc.js";
import { ingestPartiful } from "./ingest/partiful.js";
import { parseSessions } from "./ingest/sessions.js";
import { fromContacts, type IngestResult } from "./ingest/types.js";
import { ingestImages } from "./ocr/ingest-images.js";
import { draftForInvestor, generateDrafts } from "./outreach/draft.js";
import { sendDraft } from "./outreach/send.js";
import { findNodes, shortestPath } from "./paths.js";
import {
	DEFAULT_WEIGHTS,
	type MatchedInvestor,
	type MatchWeights,
	matchInvestors,
} from "./rank/match.js";
import { embedPitch, loadPitch } from "./rank/pitch.js";
import { rankLeads } from "./rank/relevance.js";
import {
	loadProfile,
	profileText,
	type StartupProfile,
} from "./rank/startup-profile.js";
import { applyRevalidate, planRevalidate } from "./revalidate.js";
import { hybridSearch, matchedSignals } from "./search.js";
import { serve } from "./server.js";
import { displayHeader, type ParsedArgs, parseArgs } from "./utils/args.js";
import { writeDump } from "./view/dump.js";
import { writeGraphHtml } from "./view/graph-html.js";

const BOOLEAN_FLAGS = [
	"no-enrich",
	"yes",
	"help",
	"github",
	"exa",
	"orgs",
	"leads",
	"all",
	"apply",
	"web",
	"only-new",
	"force",
	"allow-external",
	"local-only",
	"require-stage",
	"require-geo",
	"investors",
];

/** Parse argv and run the matching command. Returns a process exit code. */
export async function runCli(argv: string[]): Promise<number> {
	const args = parseArgs(argv, BOOLEAN_FLAGS);
	const command = args.positional[0];

	if (!command || args.options.help) {
		printHelp();
		return 0;
	}

	try {
		switch (command) {
			case "ingest":
				await cmdIngest(args);
				return 0;
			case "ocr":
				await cmdOcr(args);
				return 0;
			case "embed":
				await cmdEmbed(args);
				return 0;
			case "rank":
				await cmdRank(args);
				return 0;
			case "match":
				await cmdMatch(args);
				return 0;
			case "search":
				await cmdSearch(args);
				return 0;
			case "view":
				await cmdView(args);
				return 0;
			case "enrich":
				await cmdEnrich(args);
				return 0;
			case "dedupe":
				await cmdDedupe(args);
				return 0;
			case "revalidate":
				await cmdRevalidate(args);
				return 0;
			case "forget":
				await cmdForget(args);
				return 0;
			case "vcs":
			case "firms":
				await cmdVcs(args);
				return 0;
			case "assess":
				await cmdAssess(args);
				return 0;
			case "stage":
				await cmdStage(args);
				return 0;
			case "note":
				await cmdNote(args);
				return 0;
			case "next":
				await cmdNext(args);
				return 0;
			case "path":
				await cmdPath(args);
				return 0;
			case "export":
				await cmdExport(args);
				return 0;
			case "remind":
				await cmdRemind(args);
				return 0;
			case "due":
				await cmdDue(args);
				return 0;
			case "serve":
				await cmdServe(args);
				return 0;
			case "outreach":
				await cmdOutreach(args);
				return 0;
			case "dump":
				await cmdDump(args);
				return 0;
			case "run":
				await cmdRun(args);
				return 0;
			case "stats":
				await cmdStats();
				return 0;
			case "help":
				printHelp();
				return 0;
			default:
				console.error(
					`Unknown command: ${command}\nRun \`lead-osint help\` for usage.`,
				);
				return 1;
		}
	} catch (error) {
		if (error instanceof LeadOsintError) {
			console.error(`\n✖ ${error.name}: ${error.message}`);
		} else {
			console.error(`\n✖ ${errorMessage(error)}`);
		}
		return 1;
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withStore<T>(
	fn: (store: LeadDb, repo: LeadRepository) => Promise<T> | T,
): Promise<T> {
	const store = openDatabase();
	const repo = new LeadRepository(store);
	return Promise.resolve(fn(store, repo)).finally(() => store.close());
}

async function readJson(path: string): Promise<unknown> {
	const text = await readFile(path, "utf-8");
	return JSON.parse(text);
}

/**
 * Expand ingest inputs into a concrete list of JSON files: a directory becomes
 * its `*.json` children (sorted), a file passes through. Lets `ingest luma`
 * fold in a whole folder of per-event guest exports in one command.
 */
async function expandJsonInputs(paths: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const p of paths) {
		const info = await stat(p).catch(() => null);
		if (info?.isDirectory()) {
			const entries = await readdir(p);
			for (const name of entries.sort())
				if (name.toLowerCase().endsWith(".json")) out.push(join(p, name));
		} else {
			out.push(p);
		}
	}
	return out;
}

function str(args: ParsedArgs, key: string): string | undefined {
	const v = args.options[key];
	return typeof v === "string" ? v : undefined;
}

function num(args: ParsedArgs, key: string): number | undefined {
	const v = str(args, key);
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Privacy guard. Commands that transmit a lead's data to a third party call this;
 * when local-only mode is on (env LEAD_OSINT_LOCAL_ONLY or --local-only) it blocks
 * the run unless --allow-external is passed for that invocation.
 */
function assertExternalAllowed(args: ParsedArgs, what: string): void {
	const localOnly = getConfig().localOnly || !!args.options["local-only"];
	if (localOnly && !args.options["allow-external"]) {
		throw new LeadOsintError(
			`Blocked by local-only mode: "${what}" would send lead data to an external service.\n` +
				"  Pass --allow-external to permit this run, or unset LEAD_OSINT_LOCAL_ONLY.",
		);
	}
}

function reportIngest(result: IngestResult, repo: LeadRepository): void {
	const stats = normalizeInto(repo, result);
	console.log(
		`  + ${stats.leads} leads · ${stats.orgs} orgs · ${stats.events} events · ${stats.edges} links` +
			(stats.skipped ? `  (skipped ${stats.skipped} invalid)` : ""),
	);
	const totals = repo.counts();
	console.log(
		`  store now: ${totals.leads} leads, ${totals.events} events, ${totals.edges} links`,
	);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdIngest(args: ParsedArgs): Promise<void> {
	const source = args.positional[1];
	const file = args.positional[2];
	if (!source) {
		throw new LeadOsintError(
			"Usage: lead-osint ingest <sessions|partiful|event-listings|luma|linkedin|auto|paste|openvc|airtable|investors> [file]",
		);
	}
	const enrich = !args.options["no-enrich"];

	// Investor (firm) sources write to the `investors` table, not `leads`.
	if (source === "openvc" || source === "airtable" || source === "investors") {
		await cmdIngestInvestors(args, source, file);
		return;
	}

	await withStore(async (_store, repo) => {
		displayHeader("Ingest", { source, file: file ?? "(stdin)" });
		let result: IngestResult;
		switch (source) {
			case "sessions":
				result = fromContacts(
					parseSessions(await readJson(requireFile(file, source))),
				);
				break;
			case "partiful":
				result = await ingestPartiful(
					await readJson(requireFile(file, source)),
					{ enrich },
				);
				break;
			case "event-listings":
				result = await ingestEventListings(
					await readJson(requireFile(file, source)),
					{ enrich },
				);
				break;
			case "luma": {
				// Accept multiple files and/or a directory of per-event guest
				// exports — merge them all (normalizeInto dedupes by deterministic id).
				const inputs = args.positional.slice(2);
				if (inputs.length === 0) requireFile(undefined, source);
				const files = await expandJsonInputs(inputs);
				if (files.length === 0)
					throw new LeadOsintError(
						`ingest luma: no .json files found in ${inputs.join(", ")}`,
					);
				const merged: IngestResult = { contacts: [], events: [] };
				for (const f of files) {
					const r = parseLuma(await readJson(f));
					merged.contacts.push(...r.contacts);
					merged.events.push(...r.events);
					console.log(
						`  ${f}: ${r.contacts.length} contacts, ${r.events.length} events`,
					);
				}
				result = merged;
				break;
			}
			case "linkedin":
				result = fromContacts(
					parseLinkedinConnections(await readJson(requireFile(file, source))),
				);
				break;
			case "auto":
				// Arbitrary JSON/text file → AI-normalized contacts.
				result = await aiExtract(
					await readFile(requireFile(file, source), "utf-8"),
					{
						source: "auto",
						sourceRef: file,
					},
				);
				break;
			case "paste": {
				// Freeform blob from --text or stdin → AI-normalized contacts.
				const text = str(args, "text") ?? (await readStdin());
				if (!text.trim()) {
					throw new LeadOsintError(
						'Nothing to ingest. Pipe text in (cat blob | lead-osint ingest paste) or pass --text "…".',
					);
				}
				result = await aiExtract(text, { source: "paste" });
				break;
			}
			default:
				throw new LeadOsintError(`Unknown ingest source: ${source}`);
		}
		reportIngest(result, repo);
		console.log(
			"  next: `lead-osint embed` then `lead-osint rank --pitch <file>`",
		);
	});
}

function requireFile(file: string | undefined, source: string): string {
	if (!file)
		throw new LeadOsintError(
			`ingest ${source} needs a file: lead-osint ingest ${source} <file.json>`,
		);
	return file;
}

async function readStdin(): Promise<string> {
	try {
		return await Bun.stdin.text();
	} catch {
		return "";
	}
}

async function cmdOcr(args: ParsedArgs): Promise<void> {
	assertExternalAllowed(args, "ocr (sends images to Gemini)");
	const dir = args.positional[1];
	if (!dir) throw new LeadOsintError("Usage: lead-osint ocr <images-dir>");

	const concurrency = num(args, "concurrency") ?? 4;
	const minConfidence = num(args, "min-confidence");
	await withStore(async (_store, repo) => {
		displayHeader("OCR ingest", {
			dir,
			model: getConfig().geminiOcrModel,
			concurrency: String(concurrency),
		});
		const result = await ingestImages(dir, {
			concurrency,
			minConfidence,
			onProgress: (file, count) =>
				console.log(`  ${file}: ${count} contact(s)`),
		});
		reportIngest(result, repo);
	});
}

async function cmdEmbed(args: ParsedArgs): Promise<void> {
	const force = !!args.options.force;
	await withStore(async (store, repo) => {
		displayHeader("Embed", {
			store: store.path,
			vectorIndex: store.hasVec ? "sqlite-vec" : "js-fallback",
			...(force ? { mode: "force (re-embed all)" } : {}),
		});
		const pending = repo.leadsMissingVectors(force);
		if (pending.length > 0) {
			console.log(`  embedding ${pending.length} leads…`);
			const vectors = await embedMany(pending.map((p) => p.text));
			pending.forEach((p, i) => {
				const vec = vectors[i];
				if (vec) repo.setLeadVector(p.id, vec);
			});
			console.log(`  embedded ${pending.length} leads.`);
		}

		// Investors share the same embedding model (thesis text → 384-d vector).
		const investors = await embedPendingInvestors(repo, force);
		if (investors > 0) console.log(`  embedded ${investors} investor theses.`);

		if (pending.length === 0 && investors === 0) {
			console.log(
				"  all leads + investors already embedded. (use --force to re-embed)",
			);
		}
	});
}

async function cmdRank(args: ParsedArgs): Promise<void> {
	const pitchPath = str(args, "pitch");
	if (!pitchPath)
		throw new LeadOsintError("Usage: lead-osint rank --pitch <file>");

	await withStore(async (_store, repo) => {
		displayHeader("Rank by pitch-fit", { pitch: pitchPath });
		const pitch = await loadPitch(pitchPath);
		const ranked = await rankLeads(repo, pitch, {
			semanticWeight: num(args, "semantic-weight"),
			keywordWeight: num(args, "keyword-weight"),
		});
		console.log(`  scored ${ranked.length} leads. Top matches:`);
		for (const r of ranked.slice(0, 10)) {
			console.log(
				`   ${r.fit.toFixed(2)}  ${r.lead.fullName}${r.lead.title ? ` — ${r.lead.title}` : ""}`,
			);
		}
	});
}

/** Ingest investor firms from OpenVC/Airtable CSV, or AI-extract any blob. */
async function cmdIngestInvestors(
	args: ParsedArgs,
	source: string,
	file: string | undefined,
): Promise<void> {
	await withStore(async (_store, repo) => {
		displayHeader("Ingest investors", { source, file: file ?? "(stdin)" });
		let records: Awaited<ReturnType<typeof aiExtractInvestors>>;
		switch (source) {
			case "openvc":
				records = parseOpenVc(
					await readFile(requireFile(file, source), "utf-8"),
				);
				break;
			case "airtable":
				records = parseAirtable(
					await readFile(requireFile(file, source), "utf-8"),
				);
				break;
			case "investors": {
				// `ingest investors auto <file>` — AI-normalize an arbitrary blob.
				const sub = file; // positional[2]
				const aiFile = args.positional[3];
				if (sub !== "auto") {
					throw new LeadOsintError(
						"Usage: lead-osint ingest investors auto <file>",
					);
				}
				assertExternalAllowed(
					args,
					"ingest investors auto (sends data to Gemini)",
				);
				records = await aiExtractInvestors(
					await readFile(requireFile(aiFile, "investors auto"), "utf-8"),
					{ source: "ai", sourceRef: aiFile },
				);
				break;
			}
			default:
				throw new LeadOsintError(`Unknown investor source: ${source}`);
		}
		const stats = normalizeInvestorsInto(repo, records);
		reportInvestorIngest(stats, repo);
		console.log(
			"  next: `lead-osint embed` then `lead-osint match --profile startup.json`",
		);
	});
}

function reportInvestorIngest(
	stats: InvestorNormalizeStats,
	repo: LeadRepository,
): void {
	console.log(
		`  + ${stats.investors} investors` +
			(stats.skipped ? `  (skipped ${stats.skipped} nameless)` : ""),
	);
	const totals = repo.counts();
	console.log(`  store now: ${totals.investors} investors`);
}

/** Embed investors that lack a thesis vector. Returns how many were embedded. */
async function embedPendingInvestors(
	repo: LeadRepository,
	force = false,
): Promise<number> {
	const pending = repo.investorsMissingVectors(force);
	if (pending.length === 0) return 0;
	const vectors = await embedMany(pending.map((p) => p.text));
	pending.forEach((p, i) => {
		const vec = vectors[i];
		if (vec) repo.setInvestorVector(p.id, vec);
	});
	return pending.length;
}

/** Parse the tunable match weights from flags, falling back to defaults. */
function matchWeights(args: ParsedArgs): MatchWeights {
	return {
		stage: num(args, "stage-weight") ?? DEFAULT_WEIGHTS.stage,
		sector: num(args, "sector-weight") ?? DEFAULT_WEIGHTS.sector,
		geo: num(args, "geo-weight") ?? DEFAULT_WEIGHTS.geo,
		check: num(args, "check-weight") ?? DEFAULT_WEIGHTS.check,
	};
}

/**
 * Resolve the pitch text used for semantic thesis matching: an explicit --pitch
 * file wins, then the profile's own `pitchPath`, else the structured profile
 * flattened to text. Always returns something embeddable.
 */
async function resolvePitchText(
	args: ParsedArgs,
	profile: StartupProfile,
): Promise<string> {
	const pitchPath = str(args, "pitch") ?? profile.pitchPath ?? undefined;
	if (pitchPath) {
		try {
			return await loadPitch(pitchPath);
		} catch (error) {
			// A missing/unreadable pitch shouldn't sink a match — the structured
			// profile still carries stage/sector/geo/cheque + a thesis description.
			console.warn(
				`  ⚠ could not read pitch "${pitchPath}" (${errorMessage(error)}); using profile text instead.`,
			);
		}
	}
	return profileText(profile);
}

async function cmdMatch(args: ParsedArgs): Promise<void> {
	const profilePath = str(args, "profile");
	if (!profilePath) {
		throw new LeadOsintError(
			"Usage: lead-osint match --profile startup.json [--pitch f] [--top N] [--min-score s] [--require-stage] [--require-geo]",
		);
	}
	const top = num(args, "top") ?? 20;
	const minScore = num(args, "min-score");
	const out = str(args, "out");

	await withStore(async (_store, repo) => {
		const profile = await loadProfile(profilePath);
		displayHeader("Match investors", {
			profile: profilePath,
			stage: profile.stage,
			sectors: profile.sectors.join(", ") || "(any)",
		});
		if (repo.counts().investors === 0) {
			console.log(
				"  no investors yet — run `lead-osint ingest openvc <file.csv>` first.",
			);
			return;
		}
		// Make sure every investor has a thesis vector before scoring.
		const embedded = await embedPendingInvestors(repo);
		if (embedded) console.log(`  embedded ${embedded} investor theses…`);

		const pitchText = await resolvePitchText(args, profile);
		const pitchVector = await embedPitch(pitchText);
		let matches = matchInvestors(repo, profile, pitchVector, {
			weights: matchWeights(args),
			requireStage: !!args.options["require-stage"],
			requireGeo: !!args.options["require-geo"],
		});
		if (minScore != null) matches = matches.filter((m) => m.score >= minScore);

		console.log(`  scored ${matches.length} investors. Top matches:\n`);
		for (const m of matches.slice(0, top)) {
			printInvestorMatch(repo, m);
		}
		if (out) await writeInvestorCsv(repo, matches, out);
	});
}

/** Print one ranked investor with its per-factor breakdown + warm contact. */
function printInvestorMatch(repo: LeadRepository, m: MatchedInvestor): void {
	const inv = m.investor;
	const b = m.breakdown;
	const warm = warmContactForInvestor(repo, inv);
	const bits = [
		inv.stages.length ? inv.stages.join("/") : null,
		inv.sectors.slice(0, 3).join(", ") || null,
		inv.checkMin != null || inv.checkMax != null
			? `$${fmtCheck(inv.checkMin)}–${fmtCheck(inv.checkMax)}`
			: null,
	]
		.filter(Boolean)
		.join(" · ");
	console.log(
		`  ${m.score.toFixed(2)}  ${inv.name}${inv.domain ? ` (${inv.domain})` : ""}`,
	);
	console.log(
		`        stage ${b.stage.toFixed(2)} · sector ${b.sector.toFixed(2)} · geo ${b.geo.toFixed(2)} · check ${b.check.toFixed(2)}${bits ? `   [${bits}]` : ""}`,
	);
	if (inv.partnerEmail || inv.partnerName) {
		const w = warm ? `  ⟵ WARM via ${warm.fullName}` : "";
		console.log(
			`        ${inv.partnerName ?? ""}${inv.partnerEmail ? ` <${inv.partnerEmail}>` : ""}${w}`,
		);
	}
}

function fmtCheck(n: number | null): string {
	if (n == null) return "?";
	if (n >= 1e6) return `${n / 1e6}M`;
	if (n >= 1e3) return `${n / 1e3}k`;
	return String(n);
}

/** Write ranked investor matches to a CSV (score + per-factor breakdown). */
async function writeInvestorCsv(
	_repo: LeadRepository,
	matches: MatchedInvestor[],
	out: string,
): Promise<void> {
	const cell = (s: string) =>
		/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	const header =
		"Score,Investor,Domain,Stages,Sectors,Geo,CheckMin,CheckMax,Stage,Sector,GeoFit,Check,Partner,PartnerEmail";
	const lines = matches.map((m) => {
		const i = m.investor;
		const b = m.breakdown;
		return [
			m.score.toFixed(4),
			cell(i.name),
			cell(i.domain ?? ""),
			cell(i.stages.join("/")),
			cell(i.sectors.join("; ")),
			cell(i.geo.join("; ")),
			i.checkMin ?? "",
			i.checkMax ?? "",
			b.stage,
			b.sector,
			b.geo,
			b.check,
			cell(i.partnerName ?? ""),
			cell(i.partnerEmail ?? ""),
		].join(",");
	});
	const path = resolve(out);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, [header, ...lines].join("\r\n"), "utf-8");
	console.log(`\n  wrote ${matches.length} investors → ${path}`);
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
	const query = args.positional.slice(1).join(" ").trim();
	if (!query)
		throw new LeadOsintError('Usage: lead-osint search "<query>" [--k 20]');
	const k = num(args, "k") ?? 20;

	await withStore(async (_store, repo) => {
		displayHeader("Hybrid search", { query, k: String(k) });
		if (repo.counts().embedded === 0) {
			console.log(
				"  (no vectors yet — keyword only. Run `lead-osint embed` for semantic search.)",
			);
		}
		const hits = await hybridSearch(repo, query, k);
		if (hits.length === 0) {
			console.log("  no matches.");
			return;
		}
		for (const h of hits) {
			const why = h.why.length ? `  ⟵ matched: ${h.why.join(", ")}` : "";
			console.log(
				`   ${h.score.toFixed(3)}  ${h.lead.fullName}${h.lead.title ? ` — ${h.lead.title}` : ""}` +
					`${h.lead.email ? `  <${h.lead.email}>` : ""}${why}`,
			);
		}
	});
}

async function cmdView(args: ParsedArgs): Promise<void> {
	const out = str(args, "out") ?? "crm.html";
	await withStore(async (_store, repo) => {
		displayHeader("Build relationship view", { out });
		const path = await writeGraphHtml(repo, out, new Date().toISOString());
		const c = repo.counts();
		console.log(
			`  wrote ${path} — ${c.leads} people, ${c.orgs} orgs, ${c.events} events, ${c.edges} links`,
		);
		console.log(`  open it: file://${resolve(path)}`);
	});
}

async function cmdOutreach(args: ParsedArgs): Promise<void> {
	const sub = args.positional[1];
	if (sub === "draft") return outreachDraft(args);
	if (sub === "send") return outreachSend(args);
	if (sub === "list") return outreachList(args);
	throw new LeadOsintError("Usage: lead-osint outreach <draft|send|list>");
}

async function outreachDraft(args: ParsedArgs): Promise<void> {
	if (args.options.investors) return outreachDraftInvestors(args);
	assertExternalAllowed(args, "outreach draft (sends lead context to Gemini)");
	const top = num(args, "top") ?? 10;
	const pitchPath = str(args, "pitch");
	await withStore(async (_store, repo) => {
		displayHeader("Draft outreach", {
			top: String(top),
			model: getConfig().geminiTextModel,
		});
		const pitch = pitchPath ? await loadPitch(pitchPath) : undefined;
		const summaries = await generateDrafts(repo, {
			top,
			pitch,
			sender: {
				name: str(args, "name") ?? getConfig().smtp?.fromName ?? "Me",
				linkedin: str(args, "linkedin"),
				github: str(args, "github"),
				portfolio: str(args, "portfolio"),
			},
			onProgress: (lead, draft) =>
				console.log(`  ✎ ${lead.fullName}: ${draft.subject}`),
		});
		console.log(
			`  drafted ${summaries.length}. Review with \`lead-osint outreach list\`,`,
		);
		console.log(
			"  then send one with `lead-osint outreach send --id <id> --yes`.",
		);
	});
}

/**
 * Draft fundraising outreach to the top-matched investor firms. Drafts print to
 * the console; when a warm contact (a person already in your CRM) is found, the
 * draft is also stored under that lead so it shows up in `outreach list`.
 */
async function outreachDraftInvestors(args: ParsedArgs): Promise<void> {
	assertExternalAllowed(
		args,
		"outreach draft --investors (sends investor context to Gemini)",
	);
	const top = num(args, "top") ?? 10;
	const pitchPath = str(args, "pitch");
	const profilePath = str(args, "profile");
	await withStore(async (_store, repo) => {
		displayHeader("Draft investor outreach", {
			top: String(top),
			model: getConfig().geminiTextModel,
		});
		const investors = repo
			.listInvestors()
			.filter((i) => i.matchScore != null)
			.slice(0, top);
		if (investors.length === 0) {
			console.log(
				"  no scored investors — run `lead-osint match --profile startup.json` first.",
			);
			return;
		}
		const profile = profilePath ? await loadProfile(profilePath) : null;
		const pitch = pitchPath
			? await loadPitch(pitchPath)
			: profile
				? profileText(profile)
				: undefined;
		const sender = {
			name: str(args, "name") ?? getConfig().smtp?.fromName ?? "Me",
			linkedin: str(args, "linkedin"),
		};
		for (const inv of investors) {
			const warm = warmContactForInvestor(repo, inv);
			const draft = await draftForInvestor(inv, {
				pitch,
				sender,
				warmContact: warm ? { name: warm.fullName } : null,
			});
			console.log(`\n  ✎ ${inv.name}: ${draft.subject}`);
			if (warm) {
				// Persist under the warm lead so it appears in `outreach list`.
				const id = repo.addDraft(warm.id, "email", draft.subject, draft.body);
				repo.addInteraction(
					warm.id,
					"draft",
					`Investor intro to ${inv.name}: ${draft.subject}`,
				);
				console.log(`     stored as draft #${id} (warm via ${warm.fullName})`);
			}
		}
		console.log(
			"\n  warm drafts are stored; cold drafts are printed above (no lead row to attach).",
		);
	});
}

async function outreachSend(args: ParsedArgs): Promise<void> {
	assertExternalAllowed(args, "outreach send (emails a contact via SMTP)");
	const id = num(args, "id");
	if (id === undefined)
		throw new LeadOsintError("Usage: lead-osint outreach send --id <id> --yes");

	await withStore(async (_store, repo) => {
		const draft = repo.getDraft(id);
		if (!draft) throw new LeadOsintError(`No draft with id ${id}`);
		const lead = repo.getLead(draft.leadId);
		console.log(
			`Draft #${id} → ${lead?.fullName ?? draft.leadId} <${lead?.email ?? "?"}>`,
		);
		console.log(`Subject: ${draft.subject}`);
		console.log(`${"-".repeat(60)}\n${draft.body}\n${"-".repeat(60)}`);
		if (!args.options.yes) {
			console.log("\nNot sent. Re-run with --yes to actually send this email.");
			return;
		}
		const result = await sendDraft(repo, id);
		console.log(`✓ sent to ${result.to} (messageId ${result.messageId})`);
	});
}

async function outreachList(args: ParsedArgs): Promise<void> {
	const status = str(args, "status") as
		| "draft"
		| "sent"
		| "skipped"
		| undefined;
	await withStore(async (_store, repo) => {
		const drafts = repo.listDrafts(status);
		if (drafts.length === 0) {
			console.log("No drafts yet. Run `lead-osint outreach draft`.");
			return;
		}
		for (const d of drafts) {
			const lead = repo.getLead(d.leadId);
			console.log(
				`  #${d.id} [${d.status}] ${lead?.fullName ?? d.leadId} — ${d.subject}`,
			);
		}
	});
}

async function cmdRun(args: ParsedArgs): Promise<void> {
	const pitchPath = str(args, "pitch");
	const out = str(args, "out") ?? "crm.html";
	const top = num(args, "top") ?? 0;

	await withStore(async (store, repo) => {
		displayHeader("Full pipeline", {
			pitch: pitchPath ?? "(none)",
			out,
			vectorIndex: store.hasVec ? "sqlite-vec" : "js-fallback",
		});

		const sessions = str(args, "sessions");
		const partiful = str(args, "partiful");
		const eventListings = str(args, "event-listings");
		const luma = str(args, "luma");
		const linkedin = str(args, "linkedin");
		const images = str(args, "images");
		const openvc = str(args, "openvc");
		const airtable = str(args, "airtable");
		const profilePath = str(args, "profile");
		const enrich = !args.options["no-enrich"];

		if (sessions) {
			console.log(`[ingest] sessions: ${sessions}`);
			reportIngest(fromContacts(parseSessions(await readJson(sessions))), repo);
		}
		if (partiful) {
			console.log(`[ingest] partiful: ${partiful}`);
			reportIngest(
				await ingestPartiful(await readJson(partiful), { enrich }),
				repo,
			);
		}
		if (eventListings) {
			console.log(`[ingest] event-listings: ${eventListings}`);
			reportIngest(
				await ingestEventListings(await readJson(eventListings), { enrich }),
				repo,
			);
		}
		if (luma) {
			console.log(`[ingest] luma: ${luma}`);
			reportIngest(parseLuma(await readJson(luma)), repo);
		}
		if (linkedin) {
			console.log(`[ingest] linkedin: ${linkedin}`);
			reportIngest(
				fromContacts(parseLinkedinConnections(await readJson(linkedin))),
				repo,
			);
		}
		if (images) {
			assertExternalAllowed(args, "run --images (OCR sends images to Gemini)");
			console.log(`[ingest] ocr: ${images}`);
			reportIngest(
				await ingestImages(images, {
					onProgress: (f, c) => console.log(`  ${f}: ${c}`),
				}),
				repo,
			);
		}
		if (openvc) {
			console.log(`[ingest] openvc: ${openvc}`);
			reportInvestorIngest(
				normalizeInvestorsInto(
					repo,
					parseOpenVc(await readFile(openvc, "utf-8")),
				),
				repo,
			);
		}
		if (airtable) {
			console.log(`[ingest] airtable: ${airtable}`);
			reportInvestorIngest(
				normalizeInvestorsInto(
					repo,
					parseAirtable(await readFile(airtable, "utf-8")),
				),
				repo,
			);
		}

		const pending = repo.leadsMissingVectors();
		if (pending.length) {
			console.log(`[embed] ${pending.length} leads`);
			const vecs = await embedMany(pending.map((p) => p.text));
			pending.forEach((p, i) => {
				const v = vecs[i];
				if (v) repo.setLeadVector(p.id, v);
			});
		}
		const pendingInvestors = await embedPendingInvestors(repo);
		if (pendingInvestors) console.log(`[embed] ${pendingInvestors} investors`);

		if (pitchPath) {
			console.log(`[rank] pitch: ${pitchPath}`);
			const pitch = await loadPitch(pitchPath);
			const ranked = await rankLeads(repo, pitch);
			for (const r of ranked.slice(0, 10)) {
				console.log(`   ${r.fit.toFixed(2)}  ${r.lead.fullName}`);
			}
			if (top > 0) {
				console.log(`[outreach] drafting top ${top}`);
				await generateDrafts(repo, {
					top,
					pitch,
					sender: {
						name: str(args, "name") ?? getConfig().smtp?.fromName ?? "Me",
					},
					onProgress: (lead, d) =>
						console.log(`  ✎ ${lead.fullName}: ${d.subject}`),
				});
			}
		}

		if (profilePath && repo.counts().investors > 0) {
			console.log(`[match] profile: ${profilePath}`);
			const profile = await loadProfile(profilePath);
			const pitchVector = await embedPitch(
				await resolvePitchText(args, profile),
			);
			const matches = matchInvestors(repo, profile, pitchVector);
			for (const m of matches.slice(0, 10)) {
				console.log(
					`   ${m.score.toFixed(2)}  ${m.investor.name}${m.investor.stages.length ? ` [${m.investor.stages.join("/")}]` : ""}`,
				);
			}
		}

		console.log("[view] building graph");
		const path = await writeGraphHtml(repo, out, new Date().toISOString());
		console.log(`\n✓ done — open file://${resolve(path)}`);
	});
}

async function cmdEnrich(args: ParsedArgs): Promise<void> {
	assertExternalAllowed(args, "enrich (queries GitHub/Exa/Wikidata/SEC)");
	const all = !!args.options.all;
	const github = all || !!args.options.github;
	const exa = all || !!args.options.exa;
	const orgs = all || !!args.options.orgs;
	if (!github && !exa && !orgs) {
		throw new LeadOsintError(
			"Usage: lead-osint enrich [--github] [--exa] [--orgs] [--all]",
		);
	}

	await withStore(async (_store, repo) => {
		displayHeader("Enrich (public OSINT)", {
			github: String(github),
			exa: String(exa),
			orgs: String(orgs),
		});
		const stats = await runEnrich(repo, {
			github,
			exa,
			orgs,
			onProgress: (label) => console.log(`  ${label}`),
		});
		for (const s of stats.skipped) console.log(`  ⚠ skipped ${s}`);
		console.log(
			`  enriched ${stats.leadsChanged} leads, ${stats.orgsChanged} orgs`,
		);
		if (stats.leadsChanged > 0)
			console.log("  tip: re-run `lead-osint embed` to refresh vectors");
	});
}

async function cmdDump(args: ParsedArgs): Promise<void> {
	const out = str(args, "out") ?? "out/dump";
	const fmt = (str(args, "format") ?? "both") as "json" | "md" | "both";
	await withStore(async (_store, repo) => {
		displayHeader("Information dump", { out, format: fmt });
		const paths = await writeDump(repo, out, new Date().toISOString(), fmt);
		for (const p of paths) console.log(`  wrote ${p}`);
	});
}

const STAGE_VALUES = [
	"new",
	"contacted",
	"replied",
	"meeting",
	"passed",
] as const;
type StageValue = (typeof STAGE_VALUES)[number];

/** Resolve a lead reference to exactly one lead, or throw with guidance. */
function resolveOne(repo: LeadRepository, ref: string) {
	const matches = repo.findLeads(ref);
	if (matches.length === 0)
		throw new LeadOsintError(`No lead matches "${ref}"`);
	if (matches.length > 1) {
		const list = matches
			.slice(0, 8)
			.map((l) => `   ${l.id}  ${l.fullName}${l.email ? ` <${l.email}>` : ""}`)
			.join("\n");
		throw new LeadOsintError(
			`"${ref}" matches ${matches.length} leads — be more specific or use an id:\n${list}`,
		);
	}
	return matches[0];
}

async function cmdDedupe(args: ParsedArgs): Promise<void> {
	const apply = !!args.options.apply;
	// Default does both; --leads or --orgs narrows it.
	const onlyLeads = !!args.options.leads;
	const onlyOrgs = !!args.options.orgs;
	const doLeads = !onlyOrgs || onlyLeads;
	const doOrgs = !onlyLeads || onlyOrgs;

	await withStore(async (_store, repo) => {
		displayHeader("Dedupe", { mode: apply ? "apply" : "dry-run" });

		let leadDupes = 0;
		if (doLeads) {
			const plans = planDedupe(repo);
			leadDupes = plans.reduce((n, p) => n + p.drop.length, 0);
			for (const p of plans.slice(0, 20)) {
				console.log(
					`  person: keep ${p.keep.fullName} ⟵ ${p.drop.map((d) => d.fullName).join(", ")}`,
				);
			}
			if (plans.length > 20)
				console.log(`  …and ${plans.length - 20} more person groups`);
			if (apply) {
				const res = applyDedupe(repo, plans);
				console.log(`  merged ${res.merged} duplicate people.`);
			}
		}

		let orgDupes = 0;
		if (doOrgs) {
			const plans = planOrgDedupe(repo);
			orgDupes = plans.reduce((n, p) => n + p.drop.length, 0);
			for (const p of plans.slice(0, 20)) {
				console.log(
					`  org: keep ${p.keep.name} ⟵ ${p.drop.map((d) => d.name).join(", ")}`,
				);
			}
			if (plans.length > 20)
				console.log(`  …and ${plans.length - 20} more org groups`);
			if (apply) {
				const res = applyOrgDedupe(repo, plans);
				console.log(`  merged ${res.merged} duplicate orgs.`);
			}
		}

		if (leadDupes + orgDupes === 0) {
			console.log("  no duplicates found.");
		} else if (!apply) {
			console.log(
				`\n  ${leadDupes} duplicate people, ${orgDupes} duplicate orgs. Re-run with --apply to merge.`,
			);
		} else {
			console.log("\n  done. Run `lead-osint embed` to refresh vectors.");
		}
	});
}

async function cmdStage(args: ParsedArgs): Promise<void> {
	const ref = args.positional[1];
	const stage = args.positional[2] as StageValue | undefined;
	if (!ref || !stage || !STAGE_VALUES.includes(stage)) {
		throw new LeadOsintError(
			`Usage: lead-osint stage <id|name|email> <${STAGE_VALUES.join("|")}>`,
		);
	}
	await withStore((_store, repo) => {
		const lead = resolveOne(repo, ref);
		repo.setStage(lead.id, stage);
		repo.addInteraction(lead.id, "stage", `Stage → ${stage}`);
		console.log(`✓ ${lead.fullName}: stage → ${stage}`);
	});
}

async function cmdNote(args: ParsedArgs): Promise<void> {
	const ref = args.positional[1];
	const note = args.positional.slice(2).join(" ") || str(args, "text");
	if (!ref || !note)
		throw new LeadOsintError(
			'Usage: lead-osint note <id|name|email> "your note"',
		);
	await withStore((_store, repo) => {
		const lead = resolveOne(repo, ref);
		repo.enrichLead(lead.id, { note });
		repo.addInteraction(lead.id, "note", note);
		console.log(
			`✓ noted on ${lead.fullName} (re-run \`embed\` to refresh its vector)`,
		);
	});
}

async function cmdNext(args: ParsedArgs): Promise<void> {
	const limit = num(args, "limit") ?? 15;
	const stage = (str(args, "stage") ?? "new") as StageValue;
	const relationship = str(args, "relationship");
	await withStore((_store, repo) => {
		displayHeader("Next to contact", {
			stage,
			limit: String(limit),
			...(relationship ? { relationship } : {}),
		});
		const leads = repo.listLeads({
			stage,
			relationship,
			orderByFit: true,
			limit,
		});
		if (leads.length === 0) {
			console.log(
				`  nothing in stage "${stage}". Try --stage replied or run rank first.`,
			);
			return;
		}
		for (const l of leads) {
			const fit = l.pitchFit == null ? "—  " : l.pitchFit.toFixed(2);
			const contact = l.email ?? l.linkedin ?? "(no contact)";
			// Prefer the AI rationale; fall back to keyword signals.
			const why = l.rationale
				? `  · ${l.relationship ?? "?"}: ${l.rationale}`
				: matchedSignals(l).length
					? `  · ${matchedSignals(l).slice(0, 5).join(", ")}`
					: "";
			console.log(
				`  ${fit}  ${l.fullName}${l.title ? ` — ${l.title}` : ""}${why}\n        ${contact}`,
			);
		}
		console.log(`\n  mark progress: lead-osint stage "<name>" contacted`);
	});
}

async function cmdPath(args: ParsedArgs): Promise<void> {
	const fromRef = args.positional[1];
	const toRef = args.positional[2];
	if (!fromRef || !toRef) {
		throw new LeadOsintError(
			'Usage: lead-osint path "<you/name>" "<target name|org|event>"',
		);
	}
	await withStore((_store, repo) => {
		displayHeader("Connection path", { from: fromRef, to: toRef });
		const from = pickNode(repo, fromRef);
		const to = pickNode(repo, toRef);
		const path = shortestPath(repo, from.id, to.id);
		if (!path) {
			console.log(
				`  no connection found between ${from.label} and ${to.label}.`,
			);
			return;
		}
		const glyph = { lead: "●", org: "■", event: "◆" } as const;
		let line = `  ${glyph[from.type]} ${from.label}`;
		for (let i = 1; i < path.nodes.length; i++) {
			const n = path.nodes[i];
			if (!n) continue;
			line += `\n      └─[${path.rels[i - 1]}]─ ${glyph[n.type]} ${n.label}`;
		}
		console.log(line);
		const hops = path.nodes.length - 1;
		console.log(`\n  ${hops} hop${hops === 1 ? "" : "s"} apart.`);
	});
}

/** Resolve a path ref to one node, reporting ambiguity. */
function pickNode(repo: LeadRepository, ref: string) {
	const matches = findNodes(repo, ref);
	if (matches.length === 0)
		throw new LeadOsintError(`No node matches "${ref}"`);
	if (matches.length > 1) {
		const list = matches
			.slice(0, 8)
			.map((n) => `   [${n.type}] ${n.label}`)
			.join("\n");
		throw new LeadOsintError(
			`"${ref}" is ambiguous — be more specific:\n${list}`,
		);
	}
	return matches[0];
}

async function cmdExport(args: ParsedArgs): Promise<void> {
	// Default to CSV so a bare `export` does something useful instead of erroring.
	const format = args.positional[1] === "vcard" ? "vcard" : "csv";
	const stage = str(args, "stage");
	const relationship = str(args, "relationship");
	const minFit = num(args, "min-fit");
	const out =
		str(args, "out") ?? `out/leads.${format === "vcard" ? "vcf" : "csv"}`;

	await withStore(async (_store, repo) => {
		displayHeader("Export", {
			format,
			out,
			...(stage ? { stage } : {}),
			...(relationship ? { relationship } : {}),
		});
		const rows = buildExportRows(repo, { stage, relationship, minFit });
		const path = await writeExport(rows, out, format);
		console.log(`  wrote ${rows.length} contacts → ${resolve(path)}`);
		if (rows.length === 0) {
			console.log(
				"  (no leads matched — drop the --stage/--relationship/--min-fit filters)",
			);
		}
	});
}

async function cmdRemind(args: ParsedArgs): Promise<void> {
	// `remind done <id>` completes a reminder.
	if (args.positional[1] === "done") {
		const rid = Number(args.positional[2]);
		if (!Number.isFinite(rid))
			throw new LeadOsintError("Usage: lead-osint remind done <id>");
		await withStore((_store, repo) => {
			console.log(
				repo.completeReminder(rid)
					? `✓ reminder ${rid} done`
					: `no reminder ${rid}`,
			);
		});
		return;
	}
	const ref = args.positional[1];
	const when = args.positional[2];
	const note = args.positional.slice(3).join(" ") || str(args, "note") || null;
	if (!ref || !when) {
		throw new LeadOsintError(
			'Usage: lead-osint remind <id|name|email> <3d|2w|2026-07-01> ["note"]',
		);
	}
	await withStore((_store, repo) => {
		const lead = resolveOne(repo, ref);
		const dueAt = parseWhen(when);
		repo.addReminder(lead.id, dueAt, note);
		repo.addInteraction(
			lead.id,
			"reminder",
			`Follow up by ${dueAt.slice(0, 10)}${note ? ` — ${note}` : ""}`,
		);
		console.log(`✓ reminder set: ${lead.fullName} by ${dueAt.slice(0, 10)}`);
	});
}

async function cmdDue(args: ParsedArgs): Promise<void> {
	const all = !!args.options.all;
	await withStore((_store, repo) => {
		displayHeader("Follow-ups due", {
			scope: all ? "all open" : "due now/overdue",
		});
		const now = new Date().toISOString();
		const reminders = repo.listReminders(all ? {} : { dueBefore: now });
		if (reminders.length === 0) {
			console.log(
				all
					? "  no open reminders."
					: "  nothing due. (use --all to see upcoming)",
			);
			return;
		}
		const today = now.slice(0, 10);
		for (const r of reminders) {
			const lead = repo.getLead(r.leadId);
			const day = r.dueAt.slice(0, 10);
			const overdue =
				day < today ? " ⚠ overdue" : day === today ? " · today" : "";
			console.log(
				`  #${r.id}  ${day}${overdue}  ${lead?.fullName ?? r.leadId}` +
					`${lead?.email ? ` <${lead.email}>` : ""}${r.note ? `\n        ${r.note}` : ""}`,
			);
		}
		console.log("\n  complete one: lead-osint remind done <id>");
	});
}

async function cmdServe(args: ParsedArgs): Promise<void> {
	const port = num(args, "port") ?? 8787;
	// Keep one DB handle open for the server's lifetime (not via withStore).
	const store = openDatabase();
	const repo = new LeadRepository(store);
	const { url } = serve(repo, port);
	displayHeader("Live CRM dashboard", { url, db: store.path });
	console.log(`  open ${url}  —  Ctrl-C to stop`);
	await new Promise<never>(() => {}); // run until the process is killed
}

async function cmdRevalidate(args: ParsedArgs): Promise<void> {
	const apply = !!args.options.apply;
	await withStore((_store, repo) => {
		displayHeader("Revalidate store", { mode: apply ? "apply" : "dry-run" });
		const plan = planRevalidate(repo);
		for (const o of plan.orgs.slice(0, 20))
			console.log(`  org   ✗ ${o.name}  (${o.reason})`);
		if (plan.orgs.length > 20)
			console.log(`  …and ${plan.orgs.length - 20} more orgs`);
		for (const l of plan.leads.slice(0, 20))
			console.log(`  lead  ✗ ${l.name}  (${l.reason})`);
		if (plan.leads.length > 20)
			console.log(`  …and ${plan.leads.length - 20} more leads`);

		if (plan.orgs.length + plan.leads.length === 0) {
			console.log("  store is clean — nothing to remove.");
			return;
		}
		if (!apply) {
			console.log(
				`\n  would remove ${plan.orgs.length} junk org(s) + ${plan.leads.length} invalid lead(s). Re-run with --apply.`,
			);
			return;
		}
		const res = applyRevalidate(repo, plan);
		console.log(
			`\n  removed ${res.orgsDeleted} orgs + ${res.leadsDeleted} leads.`,
		);
		console.log(
			"  tip: re-ingest your sources to re-link real orgs, then `embed`.",
		);
	});
}

async function cmdAssess(args: ParsedArgs): Promise<void> {
	assertExternalAllowed(args, "assess (sends lead context to Gemini)");
	const pitchPath = str(args, "pitch");
	if (!pitchPath) {
		throw new LeadOsintError(
			"Usage: lead-osint assess --pitch <file> [--web] [--only-new] [--limit N] [--concurrency 4] [--rpm N]",
		);
	}
	const web = !!args.options.web;
	const onlyNew = !!args.options["only-new"];
	const limit = num(args, "limit");
	const concurrency = num(args, "concurrency") ?? 4;
	const rpm = num(args, "rpm");
	await withStore(async (_store, repo) => {
		displayHeader("Assess relevance", {
			pitch: pitchPath,
			web: String(web),
			...(onlyNew ? { scope: "unassessed only" } : {}),
			model: getConfig().geminiTextModel,
			...(rpm ? { rpm: String(rpm) } : {}),
		});
		const pitch = await loadPitch(pitchPath);
		const stats = await runAssess(repo, {
			pitch,
			web,
			onlyUnassessed: onlyNew,
			limit,
			concurrency,
			rpm,
			onProgress: (lead, a) =>
				console.log(
					`  ${a.relevance.toFixed(2)}  ${a.relationship.padEnd(8)} ${lead.fullName} — ${a.rationale}`,
				),
		});
		console.log(`\n  assessed ${stats.assessed}, failed ${stats.failed}.`);
		if (web)
			console.log(
				"  (web research added notes — run `embed --force` to refresh vectors)",
			);
	});
}

async function cmdForget(args: ParsedArgs): Promise<void> {
	const ref = args.positional[1];
	if (!ref) {
		throw new LeadOsintError(
			"Usage: lead-osint forget <id|email|linkedin-url|name> [--yes]",
		);
	}
	await withStore((_store, repo) => {
		const matches = repo.findForErasure(ref);
		if (matches.length === 0) {
			console.log(`  no lead matches "${ref}".`);
			return;
		}
		displayHeader("Forget (erase)", { ref, matched: String(matches.length) });
		for (const m of matches) {
			const bits = [m.email, m.linkedin].filter(Boolean).join(" · ");
			console.log(`  • ${m.fullName}${bits ? ` — ${bits}` : ""}  [${m.id}]`);
		}
		if (!args.options.yes) {
			console.log(
				`\n  Permanently deletes ${matches.length} lead(s) + their edges, notes, reminders, and drafts.`,
			);
			console.log("  Re-run with --yes to confirm.");
			return;
		}
		let n = 0;
		for (const m of matches) if (repo.deleteLead(m.id)) n += 1;
		console.log(`\n  ✓ erased ${n} lead(s).`);
	});
}

async function cmdVcs(args: ParsedArgs): Promise<void> {
	const out = str(args, "out");
	const all = !!args.options.all;
	await withStore(async (_store, repo) => {
		const everything = repo.investorFirms();
		const firms = all ? everything : everything.filter((f) => f.isVc);
		const hidden = everything.length - firms.length;
		displayHeader("VC firms in your network", {
			firms: String(firms.length),
			...(all ? {} : { scope: "VC-like (use --all for every investor firm)" }),
		});
		if (firms.length === 0) {
			console.log(
				"  none yet — run `assess --pitch <file>` to tag investors, then re-run.",
			);
			return;
		}
		for (const f of firms) {
			console.log(
				`\n  ${f.name}${f.domain ? ` (${f.domain})` : ""}  ·  ${f.investors} investor${f.investors > 1 ? "s" : ""} of ${f.contacts} contact${f.contacts > 1 ? "s" : ""}`,
			);
			for (const c of f.top) {
				const fit = c.fit == null ? "—  " : c.fit.toFixed(2);
				const link = c.linkedin ? `  ${c.linkedin}` : "";
				console.log(
					`      ${fit}  ${c.name}${c.title ? ` — ${c.title}` : ""}${link}`,
				);
			}
		}
		console.log(
			`\n  ${firms.length} firms.${hidden > 0 ? `  (${hidden} more investor-affiliated firms hidden — likely banks/other; --all to show)` : ""}`,
		);

		if (out) {
			const header = "Firm,Domain,Investors,Contacts,Top contacts";
			const cell = (s: string) =>
				/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
			const lines = firms.map((f) =>
				[
					cell(f.name),
					cell(f.domain ?? ""),
					String(f.investors),
					String(f.contacts),
					cell(f.top.map((c) => c.name).join("; ")),
				].join(","),
			);
			const path = resolve(out);
			await writeFile(path, [header, ...lines].join("\r\n"), "utf-8");
			console.log(`  wrote ${firms.length} firms → ${path}`);
		}
	});
}

async function cmdStats(): Promise<void> {
	await withStore((store, repo) => {
		const c = repo.counts();
		displayHeader("Store stats", {
			db: store.path,
			vectorIndex: store.hasVec ? "sqlite-vec" : "js-fallback",
		});
		for (const [k, v] of Object.entries(c))
			console.log(`  ${k.padEnd(10)} ${v}`);
	});
}

function printHelp(): void {
	console.log(`lead-osint — OSINT lead pipeline for networking & pitching

USAGE
  lead-osint <command> [options]

COMMANDS
  ingest sessions <file.json>       Import a conference session/speaker export
  ingest partiful <file.json>       Import a Partiful calendar (--no-enrich to skip fetch)
  ingest event-listings <file.json> Import an event-listing directory (--no-enrich to skip fetch)
  ingest luma <file.json>           Import a Luma export (events + hosts/guests)
  ingest linkedin <file.json>       Import LinkedIn connections ([{name,bio,linkedin}]); splits "Title at Company"
  ingest auto <file>                AI-normalize ANY JSON/text file into leads (Gemini)
  ingest paste [--text "…"]         AI-normalize pasted text / stdin into leads (Gemini)
  ingest openvc <file.csv>          Import an OpenVC investor CSV export (firms)
  ingest airtable <file.csv>        Import an Airtable "Pitch Deck Database" CSV export (firms)
  ingest investors auto <file>      AI-normalize ANY blob into investor firms (Gemini)
  ocr <images-dir> [--concurrency 4] [--min-confidence 0.45]   Extract contacts from images (Gemini)
  embed [--force]                   Embed leads that lack a vector (local MiniLM); --force re-embeds all
  enrich [--github] [--exa] [--orgs] [--all]   Fill gaps from public OSINT sources
  dedupe [--apply] [--leads|--orgs] Merge duplicate people + orgs (dry-run by default)
  revalidate [--apply]              Clean an existing store: drop fake-email orgs, junk orgs, non-people
  forget <id|email|linkedin|name> [--yes]   Erase a lead + all their data (GDPR/CCPA deletion)
  rank --pitch <file>               Score every lead by fit to your pitch (vector + keyword)
  match --profile startup.json [--pitch f] [--top N] [--min-score s] [--require-stage] [--require-geo] [--out f]
                                    Rank investor firms for your startup (stage · sector+thesis · geo · check); --*-weight to tune
  assess --pitch <file> [--web] [--only-new] [--limit N] [--rpm N]   AI relevance + relationship + why per lead (Gemini; --web researches each; --only-new skips already-assessed; --rpm throttles)
  search "<query>" [--k 20]         Hybrid (semantic + keyword) search, with match reasons
  path "<you>" "<target>"           Warm-intro path: how you're connected (shared org/event)
  next [--stage new] [--limit 15]   Queue: who to contact next (by fit + stage)
  stage <id|name|email> <stage>     Move a lead through new→contacted→replied→meeting→passed
  note <id|name|email> "text"       Append a note to a lead (+ logs an interaction)
  serve [--port 8787]               Live web CRM (graph + table; edits persist to the store)
  view [--out crm.html]             Build the static interactive relationship graph
  dump [--out out/dump] [--format json|md|both]   Full dossier dump of every lead
  export [csv|vcard] [--out f] [--stage s] [--relationship r] [--min-fit 0.3]   Export contacts (defaults to CSV → out/leads.csv)
  vcs [--out f]                     Live list of VC firms in your network + warm contacts (alias: firms)
  remind <id|name> <3d|2026-07-01> ["note"]   Set a follow-up (remind done <id> to clear)
  due [--all]                       Follow-ups due now/overdue (--all = everything open)
  outreach draft [--top 10] [--pitch f] [--investors] [--profile f]   Generate drafts (stored, not sent); --investors drafts to matched firms
  outreach list [--status draft]    List stored drafts
  outreach send --id <id> --yes     Send one draft over SMTP (gated)
  run --pitch <file> [--sessions f] [--partiful f] [--event-listings f] [--luma f] [--linkedin f] [--images dir] [--openvc f] [--airtable f] [--profile startup.json] [--top N] [--out f]
                                    End-to-end: ingest → embed → rank → match → view (+ drafts)
  stats                             Show store counts
  help                              This message

ENV
  GEMINI_API_KEY        required for \`ocr\`, \`ingest auto|paste\`, \`outreach draft\`
  EXA_API_KEY           required for \`enrich --exa\`
  GITHUB_TOKEN          optional, raises \`enrich --github\` rate limit
  SEC_USER_AGENT        recommended for \`enrich --orgs\` (SEC EDGAR etiquette)
  SMTP_*                required for \`outreach send\` (see .env.example)
  LEAD_OSINT_DB         database path (default data/leads.db)
  LEAD_OSINT_LOCAL_ONLY when set, blocks ocr/enrich/assess/outreach from sending data out

PRIVACY
  Local-only mode (env LEAD_OSINT_LOCAL_ONLY=1 or --local-only) blocks any command
  that would transmit a lead's data to a third party; add --allow-external to permit
  a single run. Use \`forget\` to honor a deletion request.
`);
}
