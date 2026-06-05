/**
 * Domain schemas + types for the lead-osint store.
 *
 * Zod validates data at boundaries (ingest, OCR, config) and the inferred
 * types flow through the repository and views. Timestamps are ISO-8601 strings.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Pipeline stage for a lead (a lightweight CRM funnel). */
export const STAGES = [
	"new",
	"contacted",
	"replied",
	"meeting",
	"passed",
] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = (typeof STAGES)[number];

/** How two graph nodes relate. Drives the relationship view edges. */
export const RELATIONS = [
	"works_at",
	"speaks_at",
	"hosts",
	"attended",
	"knows",
] as const;
export const RelationSchema = z.enum(RELATIONS);
export type Relation = (typeof RELATIONS)[number];

export const NODE_TYPES = ["lead", "org", "event"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** How a lead could matter to your business (set by `assess`). */
export const RELATIONSHIPS = [
	"investor",
	"customer",
	"partner",
	"connector",
	"advisor",
	"expert",
	"hire",
	"peer",
	"other",
] as const;
export const RelationshipSchema = z.enum(RELATIONSHIPS);
export type Relationship = (typeof RELATIONSHIPS)[number];

// ---------------------------------------------------------------------------
// Raw ingest input — the normalized shape every source produces
// ---------------------------------------------------------------------------

export const RawEventSchema = z.object({
	name: z.string().min(1),
	date: z.string().nullish(),
	location: z.string().nullish(),
	url: z.string().nullish(),
	description: z.string().nullish(),
	source: z.string().nullish(),
	/** Organizations that host this event (company names) -> org↔event edges. */
	hostOrgs: z.array(z.string()).nullish(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const RawContactSchema = z.object({
	fullName: z.string().min(1),
	firstName: z.string().nullish(),
	lastName: z.string().nullish(),
	email: z.string().nullish(),
	title: z.string().nullish(),
	company: z.string().nullish(),
	phones: z.array(z.string()).default([]),
	linkedin: z.string().nullish(),
	twitter: z.string().nullish(),
	facebook: z.string().nullish(),
	website: z.string().nullish(),
	notes: z.string().nullish(),
	/** Provenance: which ingest produced this (sessions|partiful|event-listings|ocr|...). */
	source: z.string().min(1),
	sourceRef: z.string().nullish(),
	/** Optional event the contact was found at, and how they relate to it. */
	event: RawEventSchema.nullish(),
	relation: RelationSchema.nullish(),
});
export type RawContact = z.infer<typeof RawContactSchema>;

// ---------------------------------------------------------------------------
// Stored domain objects (as returned by the repository)
// ---------------------------------------------------------------------------

export const OrgSchema = z.object({
	id: z.string(),
	name: z.string(),
	domain: z.string().nullable(),
	notes: z.string().nullable(),
});
export type Org = z.infer<typeof OrgSchema>;

export const LeadSchema = z.object({
	id: z.string(),
	fullName: z.string(),
	firstName: z.string().nullable(),
	lastName: z.string().nullable(),
	email: z.string().nullable(),
	title: z.string().nullable(),
	orgId: z.string().nullable(),
	phones: z.array(z.string()),
	linkedin: z.string().nullable(),
	twitter: z.string().nullable(),
	facebook: z.string().nullable(),
	website: z.string().nullable(),
	source: z.string(),
	sourceRef: z.string().nullable(),
	stage: StageSchema,
	pitchFit: z.number().nullable(),
	notes: z.string().nullable(),
	/** AI business-relevance assessment (0–1), set by `assess`. */
	relevance: z.number().nullable(),
	relationship: RelationshipSchema.nullable(),
	rationale: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Lead = z.infer<typeof LeadSchema>;

export const EventSourceSchema = z.object({
	id: z.string(),
	name: z.string(),
	date: z.string().nullable(),
	location: z.string().nullable(),
	lat: z.number().nullable(),
	lon: z.number().nullable(),
	url: z.string().nullable(),
	source: z.string(),
	description: z.string().nullable(),
	priorityScore: z.number().nullable(),
	priorityMatches: z.array(z.string()),
});
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EdgeSchema = z.object({
	srcType: z.enum(NODE_TYPES),
	srcId: z.string(),
	dstType: z.enum(NODE_TYPES),
	dstId: z.string(),
	rel: RelationSchema,
	weight: z.number(),
});
export type Edge = z.infer<typeof EdgeSchema>;

export const InteractionSchema = z.object({
	id: z.number(),
	leadId: z.string(),
	type: z.string(),
	content: z.string(),
	at: z.string(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const OUTREACH_STATUS = ["draft", "sent", "skipped"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUS)[number];

export const OutreachDraftSchema = z.object({
	id: z.number(),
	leadId: z.string(),
	channel: z.string(),
	subject: z.string(),
	body: z.string(),
	status: z.enum(OUTREACH_STATUS),
	createdAt: z.string(),
});
export type OutreachDraft = z.infer<typeof OutreachDraftSchema>;
