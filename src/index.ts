/**
 * lead-osint — public library surface.
 *
 * Importable building blocks for the pipeline. The CLI (`./cli.ts`) is the
 * primary entry point; this barrel lets you embed the pieces in your own tools.
 */

export {
	type Assessment,
	assessLead,
	parseAssessment,
	runAssess,
} from "./assess.js";
export { runCli } from "./commands.js";
export { getConfig, requireGeminiKey, requireSmtp } from "./core/config.js";
export { type LeadDb, openDatabase } from "./core/db.js";
export { EMBED_DIM, embed, embedMany } from "./core/embeddings.js";
export * from "./core/errors.js";
export { FALLBACK_MODELS, generateText, modelChain } from "./core/gemini.js";
export { leadId, normalizeName, orgId, slug } from "./core/ids.js";
export { LeadRepository } from "./core/repository.js";
export {
	type CacheConfig,
	type CacheStore,
	MemoryCacheStore,
	MemoryRateLimitStore,
	type RateLimitConfig,
	type RateLimitStore,
	type ResilienceConfig,
	type RetryConfig,
	withResilience,
} from "./core/resilience.js";
export type {
	Edge,
	EventSource,
	Lead,
	OutreachDraft,
	RawContact,
	RawEvent,
	Relation,
	Stage,
} from "./core/schema.js";
export {
	cosineSimilarity,
	deserializeVector,
	serializeVector,
	topKCosine,
} from "./core/vector.js";
export {
	applyDedupe,
	applyOrgDedupe,
	planDedupe,
	planOrgDedupe,
} from "./dedupe.js";
export {
	mapEdgar,
	mapExaResults,
	mapGithubUser,
	mapWikidata,
	mergePatches,
	runEnrich,
} from "./enrich.js";
export { type ExportRow, toCsv, toVcard, writeExport } from "./export.js";
export { aiExtract, mapExtractResponse } from "./ingest/ai-extract.js";
export { ingestEventListings } from "./ingest/event-listings.js";
export { PRIORITY_KEYWORDS, scoreText } from "./ingest/keywords.js";
export { parseLinkedinConnections } from "./ingest/linkedin.js";
export { parseLuma } from "./ingest/luma.js";
export { normalizeInto } from "./ingest/normalize.js";
export { ingestPartiful } from "./ingest/partiful.js";
export { parseSessions } from "./ingest/sessions.js";
export type { IngestResult } from "./ingest/types.js";
export { ocrImage } from "./ocr/gemini-ocr.js";
export { ingestImages } from "./ocr/ingest-images.js";
export { draftForLead, generateDrafts } from "./outreach/draft.js";
export { sendDraft } from "./outreach/send.js";
export { findNodes, shortestPath } from "./paths.js";
export { embedPitch, loadPitch } from "./rank/pitch.js";
export { rankLeads } from "./rank/relevance.js";
export { applyRevalidate, planRevalidate } from "./revalidate.js";
export { explainMatch, hybridSearch, matchedSignals } from "./search.js";
export { createHandler, serve } from "./server.js";
export { renderDashboard } from "./view/dashboard.js";
export { buildDump, renderDumpMarkdown, writeDump } from "./view/dump.js";
export {
	buildViewData,
	renderGraphHtml,
	writeGraphHtml,
} from "./view/graph-html.js";
