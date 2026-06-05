/**
 * Repository over the lead-osint SQLite store.
 *
 * Encapsulates all SQL behind a typed interface (the repository pattern), so
 * ingest/rank/outreach/view code never touches raw rows. Upserts are idempotent
 * and field-merging: re-ingesting a known person fills gaps without clobbering
 * data already on file.
 */
import type { Database } from "bun:sqlite";
import type { LeadDb } from "./db.js";
import { DbError } from "./errors.js";
import { eventId, leadId, linkedinKey, orgId } from "./ids.js";
import type {
	Edge,
	EventSource,
	Interaction,
	Lead,
	NodeType,
	OutreachDraft,
	OutreachStatus,
	Relation,
	Stage,
} from "./schema.js";
import {
	cosineSimilarity,
	deserializeVector,
	serializeVector,
	topKCosine,
} from "./vector.js";

export interface UpsertLeadInput {
	id: string;
	fullName: string;
	firstName?: string | null;
	lastName?: string | null;
	email?: string | null;
	title?: string | null;
	orgId?: string | null;
	phones?: string[];
	linkedin?: string | null;
	twitter?: string | null;
	facebook?: string | null;
	website?: string | null;
	source: string;
	sourceRef?: string | null;
	notes?: string | null;
	stage?: Stage;
}

export interface UpsertEventInput {
	name: string;
	date?: string | null;
	location?: string | null;
	lat?: number | null;
	lon?: number | null;
	url?: string | null;
	source: string;
	description?: string | null;
	priorityScore?: number | null;
	priorityMatches?: string[];
}

export interface GraphNode {
	id: string;
	type: NodeType;
	label: string;
	sub?: string;
	pitchFit?: number | null;
	stage?: Stage;
}

export interface LeadMatch {
	lead: Lead;
	score: number;
}

export interface InvestorFirm {
	id: string;
	name: string;
	domain: string | null;
	/** Total leads you have at this firm. */
	contacts: number;
	/** Of those, how many are tagged `investor`. */
	investors: number;
	/** Heuristic: looks like an actual VC/investment firm (vs a bank/other). */
	isVc: boolean;
	/** Best investor contacts to reach out through. */
	top: {
		id: string;
		name: string;
		title: string | null;
		fit: number | null;
		linkedin: string | null;
	}[];
}

export interface ClusterSummary {
	id: string;
	label: string;
	size: number;
	relationships: Record<string, number>;
	top: {
		id: string;
		name: string;
		title: string | null;
		relationship: string | null;
		fit: number | null;
	}[];
	/** All lead ids in this cluster (lets the graph color nodes by cluster). */
	memberIds: string[];
}

interface LeadRow {
	id: string;
	full_name: string;
	first_name: string | null;
	last_name: string | null;
	email: string | null;
	title: string | null;
	org_id: string | null;
	phones: string;
	linkedin: string | null;
	twitter: string | null;
	facebook: string | null;
	website: string | null;
	source: string;
	source_ref: string | null;
	stage: string;
	pitch_fit: number | null;
	notes: string | null;
	relevance: number | null;
	relationship: string | null;
	rationale: string | null;
	created_at: string;
	updated_at: string;
}

const NOW = (): string => new Date().toISOString();

function coalesce<T>(next: T | null | undefined, prev: T | null): T | null {
	return next ?? prev;
}

export class LeadRepository {
	private readonly db: Database;
	readonly hasVec: boolean;

	constructor(store: LeadDb) {
		this.db = store.db;
		this.hasVec = store.hasVec;
	}

	// --- orgs --------------------------------------------------------------

	/** Upsert an org by name/domain, returning its id. */
	upsertOrg(
		name: string,
		domain?: string | null,
		notes?: string | null,
	): string {
		const trimmed = name.trim();
		if (!trimmed) throw new DbError("Org name is required");
		const id = orgId(domain || trimmed);
		this.db
			.query(
				`INSERT INTO orgs(id, name, domain, notes) VALUES (?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					domain = COALESCE(excluded.domain, orgs.domain),
					notes = COALESCE(excluded.notes, orgs.notes)`,
			)
			.run(id, trimmed, domain ?? null, notes ?? null);
		return id;
	}

	// --- leads -------------------------------------------------------------

	/** Idempotent, field-merging upsert. Preserves embedding + created_at. */
	upsertLead(input: UpsertLeadInput): Lead {
		const existing = this.getLeadRow(input.id);
		const now = NOW();
		const mergedPhones = unionPhones(
			existing ? safeJsonArray(existing.phones) : [],
			input.phones ?? [],
		);

		const row: LeadRow = {
			id: input.id,
			full_name: input.fullName || existing?.full_name || "Unknown",
			first_name: coalesce(input.firstName, existing?.first_name ?? null),
			last_name: coalesce(input.lastName, existing?.last_name ?? null),
			email: coalesce(input.email, existing?.email ?? null),
			title: coalesce(input.title, existing?.title ?? null),
			org_id: coalesce(input.orgId, existing?.org_id ?? null),
			phones: JSON.stringify(mergedPhones),
			linkedin: coalesce(input.linkedin, existing?.linkedin ?? null),
			twitter: coalesce(input.twitter, existing?.twitter ?? null),
			facebook: coalesce(input.facebook, existing?.facebook ?? null),
			website: coalesce(input.website, existing?.website ?? null),
			source: existing?.source ?? input.source,
			source_ref: coalesce(input.sourceRef, existing?.source_ref ?? null),
			stage: input.stage ?? (existing?.stage as Stage) ?? "new",
			pitch_fit: existing?.pitch_fit ?? null,
			notes: coalesce(input.notes, existing?.notes ?? null),
			relevance: existing?.relevance ?? null,
			relationship: existing?.relationship ?? null,
			rationale: existing?.rationale ?? null,
			created_at: existing?.created_at ?? now,
			updated_at: now,
		};

		this.db
			.query(
				`INSERT INTO leads
					(id, full_name, first_name, last_name, email, title, org_id, phones,
					 linkedin, twitter, facebook, website, source, source_ref, stage,
					 pitch_fit, notes, created_at, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET
					full_name=excluded.full_name, first_name=excluded.first_name,
					last_name=excluded.last_name, email=excluded.email, title=excluded.title,
					org_id=excluded.org_id, phones=excluded.phones, linkedin=excluded.linkedin,
					twitter=excluded.twitter, facebook=excluded.facebook, website=excluded.website,
					source_ref=excluded.source_ref, stage=excluded.stage, notes=excluded.notes,
					updated_at=excluded.updated_at`,
			)
			.run(
				row.id,
				row.full_name,
				row.first_name,
				row.last_name,
				row.email,
				row.title,
				row.org_id,
				row.phones,
				row.linkedin,
				row.twitter,
				row.facebook,
				row.website,
				row.source,
				row.source_ref,
				row.stage,
				row.pitch_fit,
				row.notes,
				row.created_at,
				row.updated_at,
			);

		return rowToLead(row);
	}

	getLead(id: string): Lead | null {
		const row = this.getLeadRow(id);
		return row ? rowToLead(row) : null;
	}

	private getLeadRow(id: string): LeadRow | null {
		return (
			(this.db.query("SELECT * FROM leads WHERE id = ?").get(id) as LeadRow) ??
			null
		);
	}

	listLeads(
		opts: {
			stage?: Stage;
			relationship?: string;
			limit?: number;
			orderByFit?: boolean;
		} = {},
	): Lead[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (opts.stage) {
			clauses.push("stage = ?");
			params.push(opts.stage);
		}
		if (opts.relationship) {
			clauses.push("relationship = ?");
			params.push(opts.relationship);
		}
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const order = opts.orderByFit
			? "ORDER BY pitch_fit DESC NULLS LAST, updated_at DESC"
			: "ORDER BY updated_at DESC";
		const limit = opts.limit
			? `LIMIT ${Math.max(1, Math.floor(opts.limit))}`
			: "";
		const sql = `SELECT * FROM leads ${where} ${order} ${limit}`;
		return (this.db.query(sql).all(...params) as LeadRow[]).map(rowToLead);
	}

	/**
	 * Leads that still need an AI assessment (no relevance score yet), best-fit
	 * first so a bounded `assess --only-new --limit N` covers the most promising.
	 */
	leadsUnassessed(): Lead[] {
		return (
			this.db
				.query(
					"SELECT * FROM leads WHERE relevance IS NULL ORDER BY pitch_fit DESC NULLS LAST",
				)
				.all() as LeadRow[]
		).map(rowToLead);
	}

	setStage(id: string, stage: Stage): void {
		this.db
			.query("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?")
			.run(stage, NOW(), id);
	}

	setPitchFit(id: string, fit: number): void {
		this.db.query("UPDATE leads SET pitch_fit = ? WHERE id = ?").run(fit, id);
	}

	/** Store an AI relevance assessment (and blend it into pitch_fit). */
	setAssessment(
		id: string,
		a: {
			relevance: number;
			relationship: string;
			rationale: string;
			pitchFit?: number;
		},
	): void {
		this.db
			.query(
				"UPDATE leads SET relevance = ?, relationship = ?, rationale = ?, pitch_fit = COALESCE(?, pitch_fit) WHERE id = ?",
			)
			.run(a.relevance, a.relationship, a.rationale, a.pitchFit ?? null, id);
	}

	addInteraction(leadId: string, type: string, content: string): void {
		this.db
			.query(
				"INSERT INTO interactions(lead_id, type, content, at) VALUES (?,?,?,?)",
			)
			.run(leadId, type, content, NOW());
	}

	listInteractions(leadId: string): Interaction[] {
		const rows = this.db
			.query("SELECT * FROM interactions WHERE lead_id = ? ORDER BY at DESC")
			.all(leadId) as Array<{
			id: number;
			lead_id: string;
			type: string;
			content: string;
			at: string;
		}>;
		return rows.map((r) => ({
			id: r.id,
			leadId: r.lead_id,
			type: r.type,
			content: r.content,
			at: r.at,
		}));
	}

	/** Free-text search across name/title/email/notes (substring, case-insensitive). */
	searchLeadsText(query: string, limit = 50): Lead[] {
		const like = `%${query.trim().toLowerCase()}%`;
		const rows = this.db
			.query(
				`SELECT * FROM leads
				 WHERE lower(full_name) LIKE ? OR lower(coalesce(title,'')) LIKE ?
					OR lower(coalesce(email,'')) LIKE ? OR lower(coalesce(notes,'')) LIKE ?
				 ORDER BY pitch_fit DESC NULLS LAST LIMIT ?`,
			)
			.all(like, like, like, like, limit) as LeadRow[];
		return rows.map(rowToLead);
	}

	/**
	 * Resolve a lead reference for CRM commands: an exact id, else a unique
	 * name/email substring match. Returns all candidates so the caller can
	 * report ambiguity.
	 */
	/**
	 * Resolve a lead for erasure from an id, LinkedIn URL, or email FIRST (exact,
	 * unique keys), only falling back to a name substring search if none hit. This
	 * keeps `forget` precise so it doesn't sweep up same-named people.
	 */
	findForErasure(ref: string): Lead[] {
		const ids = new Set<string>();
		const direct = this.getLead(ref);
		if (direct) ids.add(direct.id);
		if (linkedinKey(ref)) {
			const byLi = this.getLead(leadId({ linkedin: ref }));
			if (byLi) ids.add(byLi.id);
		}
		if (ref.includes("@")) {
			const byEmail = this.getLead(leadId({ email: ref }));
			if (byEmail) ids.add(byEmail.id);
		}
		if (ids.size > 0) {
			return [...ids]
				.map((id) => this.getLead(id))
				.filter((l): l is Lead => l !== null);
		}
		return this.findLeads(ref);
	}

	findLeads(ref: string): Lead[] {
		const exact = this.getLead(ref);
		if (exact) return [exact];
		const like = `%${ref.trim().toLowerCase()}%`;
		const rows = this.db
			.query(
				`SELECT * FROM leads
				 WHERE lower(full_name) LIKE ? OR lower(coalesce(email,'')) LIKE ? OR id = ?
				 ORDER BY pitch_fit DESC NULLS LAST LIMIT 25`,
			)
			.all(like, like, ref) as LeadRow[];
		return rows.map(rowToLead);
	}

	/**
	 * Merge `dropId` into `keepId`: fill keep's empty fields from drop, union
	 * phones, append notes, repoint all edges/interactions/outreach, then delete
	 * the duplicate. Keep's embedding is cleared so it re-vectorizes.
	 */
	mergeLeads(keepId: string, dropId: string): boolean {
		if (keepId === dropId) return false;
		const keep = this.getLeadRow(keepId);
		const drop = this.getLeadRow(dropId);
		if (!keep || !drop) return false;

		const fill = (a: string | null, b: string | null) => a ?? b;
		const phones = unionPhones(
			safeJsonArray(keep.phones),
			safeJsonArray(drop.phones),
		);
		const notes = [keep.notes, drop.notes].filter(Boolean).join("\n") || null;

		const tx = this.db.transaction(() => {
			this.db
				.query(
					`UPDATE leads SET first_name=?, last_name=?, email=?, title=?, org_id=?,
						phones=?, linkedin=?, twitter=?, facebook=?, website=?, source_ref=?,
						notes=?, embedding=NULL, updated_at=? WHERE id=?`,
				)
				.run(
					fill(keep.first_name, drop.first_name),
					fill(keep.last_name, drop.last_name),
					fill(keep.email, drop.email),
					fill(keep.title, drop.title),
					fill(keep.org_id, drop.org_id),
					JSON.stringify(phones),
					fill(keep.linkedin, drop.linkedin),
					fill(keep.twitter, drop.twitter),
					fill(keep.facebook, drop.facebook),
					fill(keep.website, drop.website),
					fill(keep.source_ref, drop.source_ref),
					notes,
					NOW(),
					keepId,
				);
			// Repoint relationships, then drop self-edges + duplicates.
			this.db
				.query(
					"UPDATE OR IGNORE edges SET src_id=? WHERE src_type='lead' AND src_id=?",
				)
				.run(keepId, dropId);
			this.db
				.query(
					"UPDATE OR IGNORE edges SET dst_id=? WHERE dst_type='lead' AND dst_id=?",
				)
				.run(keepId, dropId);
			this.db
				.query(
					"DELETE FROM edges WHERE src_id=? AND src_type='lead' AND dst_id=? AND dst_type='lead'",
				)
				.run(dropId, dropId);
			this.db
				.query(
					"DELETE FROM edges WHERE (src_type='lead' AND src_id=?) OR (dst_type='lead' AND dst_id=?)",
				)
				.run(dropId, dropId);
			this.db
				.query("UPDATE interactions SET lead_id=? WHERE lead_id=?")
				.run(keepId, dropId);
			this.db
				.query("UPDATE outreach SET lead_id=? WHERE lead_id=?")
				.run(keepId, dropId);
			if (this.hasVec) {
				const r = this.db
					.query("SELECT rowid FROM leads WHERE id=?")
					.get(dropId) as { rowid: number } | undefined;
				if (r) this.db.query("DELETE FROM lead_vec WHERE rowid=?").run(r.rowid);
			}
			this.db.query("DELETE FROM leads WHERE id=?").run(dropId);
		});
		tx();
		return true;
	}

	// --- enrichment --------------------------------------------------------

	/**
	 * Fill only currently-empty lead fields from `patch` (existing data wins),
	 * union phones, and append a provenance note. Returns true if anything
	 * changed (so the caller can re-embed). Clears the embedding when changed.
	 */
	enrichLead(
		id: string,
		patch: {
			firstName?: string | null;
			lastName?: string | null;
			email?: string | null;
			title?: string | null;
			linkedin?: string | null;
			twitter?: string | null;
			facebook?: string | null;
			website?: string | null;
			phones?: string[];
			note?: string | null;
		},
	): boolean {
		const row = this.getLeadRow(id);
		if (!row) return false;
		const fill = (cur: string | null, next?: string | null) =>
			cur ?? next ?? null;
		const phones = unionPhones(safeJsonArray(row.phones), patch.phones ?? []);
		const note = patch.note?.trim();
		const notes = note
			? row.notes
				? `${row.notes}\n${note}`
				: note
			: row.notes;

		const next: LeadRow = {
			...row,
			first_name: fill(row.first_name, patch.firstName),
			last_name: fill(row.last_name, patch.lastName),
			email: fill(row.email, patch.email),
			title: fill(row.title, patch.title),
			linkedin: fill(row.linkedin, patch.linkedin),
			twitter: fill(row.twitter, patch.twitter),
			facebook: fill(row.facebook, patch.facebook),
			website: fill(row.website, patch.website),
			phones: JSON.stringify(phones),
			notes,
			updated_at: NOW(),
		};

		const changed =
			next.first_name !== row.first_name ||
			next.last_name !== row.last_name ||
			next.email !== row.email ||
			next.title !== row.title ||
			next.linkedin !== row.linkedin ||
			next.twitter !== row.twitter ||
			next.facebook !== row.facebook ||
			next.website !== row.website ||
			next.phones !== row.phones ||
			next.notes !== row.notes;
		if (!changed) return false;

		this.db
			.query(
				`UPDATE leads SET first_name=?, last_name=?, email=?, title=?, linkedin=?,
					twitter=?, facebook=?, website=?, phones=?, notes=?, updated_at=?,
					embedding=NULL WHERE id=?`,
			)
			.run(
				next.first_name,
				next.last_name,
				next.email,
				next.title,
				next.linkedin,
				next.twitter,
				next.facebook,
				next.website,
				next.phones,
				next.notes,
				next.updated_at,
				id,
			);
		// Drop stale vector so `embed` re-vectorizes the enriched text.
		if (this.hasVec) {
			const r = this.db.query("SELECT rowid FROM leads WHERE id = ?").get(id) as
				| { rowid: number }
				| undefined;
			if (r) this.db.query("DELETE FROM lead_vec WHERE rowid = ?").run(r.rowid);
		}
		return true;
	}

	getOrg(id: string): {
		id: string;
		name: string;
		domain: string | null;
		notes: string | null;
	} | null {
		return (
			(this.db
				.query("SELECT id, name, domain, notes FROM orgs WHERE id = ?")
				.get(id) as {
				id: string;
				name: string;
				domain: string | null;
				notes: string | null;
			}) ?? null
		);
	}

	listOrgs(): {
		id: string;
		name: string;
		domain: string | null;
		notes: string | null;
	}[] {
		return this.db
			.query("SELECT id, name, domain, notes FROM orgs ORDER BY name")
			.all() as {
			id: string;
			name: string;
			domain: string | null;
			notes: string | null;
		}[];
	}

	/** Fill org gaps (existing wins for domain; note is appended). */
	updateOrg(
		id: string,
		patch: { domain?: string | null; note?: string | null },
	): boolean {
		const org = this.getOrg(id);
		if (!org) return false;
		const domain = org.domain ?? patch.domain ?? null;
		const note = patch.note?.trim();
		const notes = note
			? org.notes
				? `${org.notes}\n${note}`
				: note
			: org.notes;
		if (domain === org.domain && notes === org.notes) return false;
		this.db
			.query("UPDATE orgs SET domain = ?, notes = ? WHERE id = ?")
			.run(domain, notes, id);
		return true;
	}

	/**
	 * Merge org `dropId` into `keepId`: fill keep's domain/notes, repoint every
	 * lead and edge that referenced the duplicate, then delete it.
	 */
	mergeOrgs(keepId: string, dropId: string): boolean {
		if (keepId === dropId) return false;
		const keep = this.getOrg(keepId);
		const drop = this.getOrg(dropId);
		if (!keep || !drop) return false;
		const domain = keep.domain ?? drop.domain ?? null;
		const notes = [keep.notes, drop.notes].filter(Boolean).join("\n") || null;

		const tx = this.db.transaction(() => {
			this.db
				.query("UPDATE orgs SET domain=?, notes=? WHERE id=?")
				.run(domain, notes, keepId);
			this.db
				.query("UPDATE leads SET org_id=? WHERE org_id=?")
				.run(keepId, dropId);
			this.db
				.query(
					"UPDATE OR IGNORE edges SET src_id=? WHERE src_type='org' AND src_id=?",
				)
				.run(keepId, dropId);
			this.db
				.query(
					"UPDATE OR IGNORE edges SET dst_id=? WHERE dst_type='org' AND dst_id=?",
				)
				.run(keepId, dropId);
			this.db
				.query(
					"DELETE FROM edges WHERE (src_type='org' AND src_id=?) OR (dst_type='org' AND dst_id=?)",
				)
				.run(dropId, dropId);
			this.db.query("DELETE FROM orgs WHERE id=?").run(dropId);
		});
		tx();
		return true;
	}

	/** Delete an org: detach its leads, drop its edges, remove the row. */
	deleteOrg(id: string): boolean {
		if (!this.getOrg(id)) return false;
		const tx = this.db.transaction(() => {
			this.db.query("UPDATE leads SET org_id=NULL WHERE org_id=?").run(id);
			this.db
				.query(
					"DELETE FROM edges WHERE (src_type='org' AND src_id=?) OR (dst_type='org' AND dst_id=?)",
				)
				.run(id, id);
			this.db.query("DELETE FROM orgs WHERE id=?").run(id);
		});
		tx();
		return true;
	}

	/** Delete a lead and everything that references it (edges, log, drafts, vec). */
	deleteLead(id: string): boolean {
		if (!this.getLead(id)) return false;
		const tx = this.db.transaction(() => {
			if (this.hasVec) {
				const r = this.db.query("SELECT rowid FROM leads WHERE id=?").get(id) as
					| { rowid: number }
					| undefined;
				if (r) this.db.query("DELETE FROM lead_vec WHERE rowid=?").run(r.rowid);
			}
			this.db
				.query(
					"DELETE FROM edges WHERE (src_type='lead' AND src_id=?) OR (dst_type='lead' AND dst_id=?)",
				)
				.run(id, id);
			this.db.query("DELETE FROM interactions WHERE lead_id=?").run(id);
			this.db.query("DELETE FROM outreach WHERE lead_id=?").run(id);
			this.db.query("DELETE FROM reminders WHERE lead_id=?").run(id);
			this.db.query("DELETE FROM leads WHERE id=?").run(id);
		});
		tx();
		return true;
	}

	// --- vectors -----------------------------------------------------------

	/** Persist a lead's embedding to the BLOB column and the vec index. */
	setLeadVector(id: string, vector: Float32Array): void {
		const blob = serializeVector(vector);
		this.db.query("UPDATE leads SET embedding = ? WHERE id = ?").run(blob, id);
		if (!this.hasVec) return;
		const r = this.db.query("SELECT rowid FROM leads WHERE id = ?").get(id) as
			| { rowid: number }
			| undefined;
		if (!r) return;
		this.db.query("DELETE FROM lead_vec WHERE rowid = ?").run(r.rowid);
		this.db
			.query("INSERT INTO lead_vec(rowid, embedding) VALUES (?, ?)")
			.run(r.rowid, blob);
	}

	/**
	 * Lead ids + embeddable text for leads that still need a vector. The text is
	 * enriched with the lead's org and the events they're connected to, so the
	 * vector captures *context* (where they work, what they spoke at) not just a
	 * bare title — which sharpens ranking + semantic search.
	 */
	leadsMissingVectors(force = false): { id: string; text: string }[] {
		// `force` re-embeds every lead (use after enrichment changes their text);
		// otherwise only leads without a vector are returned.
		const rows = this.db
			.query(`
				SELECT l.id, l.full_name, l.title, l.notes,
					o.name AS org_name,
					(SELECT group_concat(ev.name, '. ')
					 FROM edges e JOIN events ev ON ev.id = e.dst_id
					 WHERE e.src_type='lead' AND e.src_id=l.id AND e.dst_type='event') AS events
				FROM leads l LEFT JOIN orgs o ON o.id = l.org_id
				${force ? "" : "WHERE l.embedding IS NULL"}
			`)
			.all() as Array<{
			id: string;
			full_name: string;
			title: string | null;
			notes: string | null;
			org_name: string | null;
			events: string | null;
		}>;
		return rows.map((r) => ({ id: r.id, text: leadEmbedText(r) }));
	}

	/** Semantic top-k by cosine. Uses sqlite-vec to shortlist, else scans all. */
	searchSimilar(query: Float32Array, k = 20): LeadMatch[] {
		const candidateIds = this.hasVec
			? this.vecShortlist(query, k)
			: this.allLeadIdsWithVectors();
		const scored: { id: string; score: number }[] = [];
		const getVec = this.db.query("SELECT embedding FROM leads WHERE id = ?");
		for (const id of candidateIds) {
			const row = getVec.get(id) as
				| { embedding: Uint8Array | null }
				| undefined;
			const vec = deserializeVector(row?.embedding ?? null);
			if (!vec) continue;
			scored.push({ id, score: cosineSimilarity(query, vec) });
		}
		scored.sort((a, b) => b.score - a.score);
		return scored
			.slice(0, k)
			.map((s) => {
				const lead = this.getLead(s.id);
				return lead ? { lead, score: s.score } : null;
			})
			.filter((m): m is LeadMatch => m !== null);
	}

	/**
	 * Cosine score for EVERY lead that has a vector (full BLOB scan, no KNN cap).
	 * Used by ranking, which needs a score for all leads — sqlite-vec's KNN caps
	 * `k` at 4096, so we don't route this through the vec index.
	 */
	scoreAllByVector(query: Float32Array): Map<string, number> {
		const out = new Map<string, number>();
		const rows = this.db
			.query("SELECT id, embedding FROM leads WHERE embedding IS NOT NULL")
			.all() as { id: string; embedding: Uint8Array | null }[];
		for (const r of rows) {
			const vec = deserializeVector(r.embedding ?? null);
			if (vec) out.set(r.id, cosineSimilarity(query, vec));
		}
		return out;
	}

	/**
	 * kNN similarity edges between leads (undirected, deduped). For each lead with
	 * a vector, shortlist its nearest neighbors via the vec index, then keep pairs
	 * whose cosine ≥ `minSim`. Lets the graph link people by what they *do* (their
	 * embedding), not only by shared employer — so otherwise-isolated leads cluster.
	 */
	similarityEdges(
		opts: { k?: number; minSim?: number } = {},
	): { source: string; target: string; sim: number }[] {
		const k = Math.max(1, opts.k ?? 4);
		const minSim = opts.minSim ?? 0.6;
		// Brute-force kNN over normalized vectors (cosine = dot). At ~7k leads this
		// beats 7k separate vec-index queries (~10s vs ~22s); callers should cache.
		const rows = this.db
			.query("SELECT id, embedding FROM leads WHERE embedding IS NOT NULL")
			.all() as { id: string; embedding: Uint8Array | null }[];
		const ids: string[] = [];
		const vecs: Float32Array[] = [];
		for (const r of rows) {
			const v = deserializeVector(r.embedding ?? null);
			if (!v) continue;
			let s = 0;
			for (let d = 0; d < v.length; d++) s += v[d] * v[d];
			const inv = 1 / Math.sqrt(s || 1);
			for (let d = 0; d < v.length; d++) v[d] *= inv;
			ids.push(r.id);
			vecs.push(v);
		}
		const n = vecs.length;
		if (n < 2) return [];
		const dim = vecs[0].length;

		const seen = new Set<string>();
		const edges: { source: string; target: string; sim: number }[] = [];
		const best = new Float64Array(k);
		const bestJ = new Int32Array(k);
		for (let i = 0; i < n; i++) {
			const vi = vecs[i];
			best.fill(-1);
			bestJ.fill(-1);
			for (let j = 0; j < n; j++) {
				if (i === j) continue;
				const vj = vecs[j];
				let dot = 0;
				for (let d = 0; d < dim; d++) dot += vi[d] * vj[d];
				if (dot < minSim) continue;
				let m = 0;
				for (let s = 1; s < k; s++) if (best[s] < best[m]) m = s;
				if (dot > best[m]) {
					best[m] = dot;
					bestJ[m] = j;
				}
			}
			for (let s = 0; s < k; s++) {
				const j = bestJ[s];
				if (j < 0) continue;
				const a = ids[i];
				const b = ids[j];
				const key = a < b ? `${a}|${b}` : `${b}|${a}`;
				if (seen.has(key)) continue;
				seen.add(key);
				edges.push({
					source: a,
					target: b,
					sim: Math.round(best[s] * 1000) / 1000,
				});
			}
		}
		return edges;
	}

	/**
	 * Partition leads into themed communities with k-means over their embeddings,
	 * then summarize each: a label from the most common title tokens, its
	 * relationship mix, and top members by fit. k-means (not connected-components)
	 * because a similarity graph of a tech-heavy network is one giant component —
	 * k-means forces a balanced split into navigable themes instead of a blob.
	 */
	clusters(opts: { k?: number; minSize?: number } = {}): ClusterSummary[] {
		const minSize = Math.max(2, opts.minSize ?? 4);
		// Load + L2-normalize vectors so cosine similarity == dot product.
		const rows = this.db
			.query("SELECT id, embedding FROM leads WHERE embedding IS NOT NULL")
			.all() as { id: string; embedding: Uint8Array | null }[];
		const ids: string[] = [];
		const vecs: Float32Array[] = [];
		for (const r of rows) {
			const v = deserializeVector(r.embedding ?? null);
			if (!v) continue;
			let s = 0;
			for (let d = 0; d < v.length; d++) s += v[d] * v[d];
			const inv = 1 / Math.sqrt(s || 1);
			for (let d = 0; d < v.length; d++) v[d] *= inv;
			ids.push(r.id);
			vecs.push(v);
		}
		const n = vecs.length;
		const groups = new Map<string, string[]>();
		if (n >= 2) {
			const dim = vecs[0].length;
			const K = Math.max(2, Math.min(opts.k ?? 36, n));
			// Deterministic init: evenly-spaced picks across the id order (no RNG).
			const cent = Array.from({ length: K }, (_, c) =>
				Float32Array.from(vecs[Math.floor((c * n) / K)]),
			);
			const assign = new Int32Array(n).fill(-1);
			for (let iter = 0; iter < 15; iter++) {
				let changed = false;
				for (let i = 0; i < n; i++) {
					const vi = vecs[i];
					let bj = 0;
					let bs = -Infinity;
					for (let c = 0; c < K; c++) {
						const cc = cent[c];
						let dot = 0;
						for (let d = 0; d < dim; d++) dot += vi[d] * cc[d];
						if (dot > bs) {
							bs = dot;
							bj = c;
						}
					}
					if (assign[i] !== bj) {
						assign[i] = bj;
						changed = true;
					}
				}
				if (!changed && iter > 0) break;
				for (const cc of cent) cc.fill(0);
				const counts = new Int32Array(K);
				for (let i = 0; i < n; i++) {
					const c = assign[i];
					counts[c]++;
					const cc = cent[c];
					const vi = vecs[i];
					for (let d = 0; d < dim; d++) cc[d] += vi[d];
				}
				for (let c = 0; c < K; c++) {
					if (counts[c] === 0) continue;
					const cc = cent[c];
					let s = 0;
					for (let d = 0; d < dim; d++) s += cc[d] * cc[d];
					const inv = 1 / Math.sqrt(s || 1);
					for (let d = 0; d < dim; d++) cc[d] *= inv;
				}
			}
			for (let i = 0; i < n; i++) {
				const key = String(assign[i]);
				(groups.get(key) ?? groups.set(key, []).get(key))?.push(ids[i]);
			}
		}

		const leadById = new Map(this.listLeads().map((l) => [l.id, l]));
		const STOP = new Set([
			"the",
			"of",
			"and",
			"for",
			"with",
			"amp",
			"senior",
			"sr",
			"jr",
			"lead",
			"at",
			"in",
			"to",
			"co",
			"inc",
			"llc",
			"ii",
			"iii",
		]);
		// Pass 1: gather members + per-cluster title-token frequencies + doc freq.
		const prelim: {
			root: string;
			leads: Lead[];
			freq: Map<string, number>;
		}[] = [];
		const docFreq = new Map<string, number>();
		for (const [root, ids] of groups) {
			if (ids.length < minSize) continue;
			const leads = ids
				.map((id) => leadById.get(id))
				.filter((l): l is Lead => !!l);
			const freq = new Map<string, number>();
			for (const l of leads) {
				for (const tok of (l.title ?? "").toLowerCase().split(/[^a-z0-9+]+/)) {
					if (tok.length < 3 || STOP.has(tok)) continue;
					freq.set(tok, (freq.get(tok) ?? 0) + 1);
				}
			}
			for (const tok of freq.keys())
				docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
			prelim.push({ root, leads, freq });
		}

		// Pass 2: label by the most DISTINCTIVE tokens (tf-idf), so a word common
		// to every cluster ("engineer") doesn't drown out what makes one unique.
		const C = prelim.length || 1;
		const out: ClusterSummary[] = prelim.map(({ root, leads, freq }) => {
			const label =
				[...freq.entries()]
					.map(
						([tok, f]) =>
							[
								tok,
								f * Math.log((C + 1) / ((docFreq.get(tok) ?? 1) + 1) + 1),
							] as const,
					)
					.sort((a, b) => b[1] - a[1])
					.slice(0, 2)
					.map((e) => e[0])
					.join(" · ") || "cluster";
			const relationships: Record<string, number> = {};
			for (const l of leads)
				if (l.relationship)
					relationships[l.relationship] =
						(relationships[l.relationship] ?? 0) + 1;
			const top = leads
				.slice()
				.sort((a, b) => (b.pitchFit ?? 0) - (a.pitchFit ?? 0))
				.slice(0, 6)
				.map((l) => ({
					id: l.id,
					name: l.fullName,
					title: l.title,
					relationship: l.relationship,
					fit: l.pitchFit,
				}));
			return {
				id: root,
				label,
				size: leads.length,
				relationships,
				top,
				memberIds: leads.map((l) => l.id),
			};
		});
		out.sort((a, b) => b.size - a.size);
		return out;
	}

	/**
	 * A live list of VC firms in your network: every org with at least one
	 * `investor`-tagged member, plus the warm contacts to reach out through.
	 * Derived on demand, so it grows as you ingest + assess more.
	 */
	investorFirms(): InvestorFirm[] {
		const totals = this.db
			.query(
				"SELECT org_id, COUNT(*) AS c FROM leads WHERE org_id IS NOT NULL GROUP BY org_id",
			)
			.all() as { org_id: string; c: number }[];
		const totalByOrg = new Map(totals.map((t) => [t.org_id, t.c]));

		const rows = this.db
			.query(
				`SELECT l.id, l.full_name, l.title, l.pitch_fit, l.linkedin,
						o.id AS org_id, o.name AS org_name, o.domain
				 FROM leads l JOIN orgs o ON o.id = l.org_id
				 WHERE l.relationship = 'investor'
				 ORDER BY l.pitch_fit DESC NULLS LAST`,
			)
			.all() as {
			id: string;
			full_name: string;
			title: string | null;
			pitch_fit: number | null;
			linkedin: string | null;
			org_id: string;
			org_name: string;
			domain: string | null;
		}[];

		// VC heuristic: a fund-y firm name, or a contact with a strong VC title.
		// Deliberately excludes banks (Citi, Morgan Stanley, …) whose names don't
		// match and whose "Analyst/VP" titles aren't VC-specific.
		const VC_NAME =
			/\b(ventures?|capital|partners?|vc|fund|funds|equity|angels?|\bvp of\b)\b/i;
		const VC_TITLE =
			/\b(venture|ventures|general partner|managing partner|gp\b|venture partner|angel investor|venture capital)\b/i;

		const byOrg = new Map<string, InvestorFirm>();
		for (const r of rows) {
			let firm = byOrg.get(r.org_id);
			if (!firm) {
				firm = {
					id: r.org_id,
					name: r.org_name,
					domain: r.domain,
					contacts: totalByOrg.get(r.org_id) ?? 0,
					investors: 0,
					isVc: VC_NAME.test(r.org_name),
					top: [],
				};
				byOrg.set(r.org_id, firm);
			}
			firm.investors += 1;
			if (!firm.isVc && r.title && VC_TITLE.test(r.title)) firm.isVc = true;
			if (firm.top.length < 5)
				firm.top.push({
					id: r.id,
					name: r.full_name,
					title: r.title,
					fit: r.pitch_fit,
					linkedin: r.linkedin,
				});
		}

		return [...byOrg.values()].sort(
			(a, b) => b.investors - a.investors || b.contacts - a.contacts,
		);
	}

	private vecShortlist(query: Float32Array, k: number): string[] {
		// sqlite-vec KNN requires a literal/`k = ?` constraint, and the JOIN form
		// drops it — so match on the vec table directly, then resolve rowids.
		const rows = this.db
			.query(
				"SELECT rowid FROM lead_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
			)
			.all(serializeVector(query), k) as { rowid: number }[];
		const byRowid = this.db.query("SELECT id FROM leads WHERE rowid = ?");
		const ids: string[] = [];
		for (const r of rows) {
			const lead = byRowid.get(r.rowid) as { id: string } | undefined;
			if (lead) ids.push(lead.id);
		}
		return ids;
	}

	private allLeadIdsWithVectors(): string[] {
		const rows = this.db
			.query("SELECT id FROM leads WHERE embedding IS NOT NULL")
			.all() as { id: string }[];
		return rows.map((r) => r.id);
	}

	// --- events ------------------------------------------------------------

	upsertEvent(input: UpsertEventInput): string {
		const id = eventId(input.source, input.name, input.date ?? undefined);
		this.db
			.query(
				`INSERT INTO events
					(id, name, date, location, lat, lon, url, source, description,
					 priority_score, priority_matches)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(id) DO UPDATE SET
					date=COALESCE(excluded.date, events.date),
					location=COALESCE(excluded.location, events.location),
					lat=COALESCE(excluded.lat, events.lat),
					lon=COALESCE(excluded.lon, events.lon),
					url=COALESCE(excluded.url, events.url),
					description=COALESCE(excluded.description, events.description),
					priority_score=COALESCE(excluded.priority_score, events.priority_score),
					priority_matches=excluded.priority_matches`,
			)
			.run(
				id,
				input.name,
				input.date ?? null,
				input.location ?? null,
				input.lat ?? null,
				input.lon ?? null,
				input.url ?? null,
				input.source,
				input.description ?? null,
				input.priorityScore ?? null,
				JSON.stringify(input.priorityMatches ?? []),
			);
		return id;
	}

	listEvents(): EventSource[] {
		const rows = this.db
			.query("SELECT * FROM events ORDER BY date")
			.all() as Array<{
			id: string;
			name: string;
			date: string | null;
			location: string | null;
			lat: number | null;
			lon: number | null;
			url: string | null;
			source: string;
			description: string | null;
			priority_score: number | null;
			priority_matches: string;
		}>;
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			date: r.date,
			location: r.location,
			lat: r.lat,
			lon: r.lon,
			url: r.url,
			source: r.source,
			description: r.description,
			priorityScore: r.priority_score,
			priorityMatches: safeJsonArray(r.priority_matches),
		}));
	}

	// --- edges -------------------------------------------------------------

	addEdge(edge: Edge): void {
		this.db
			.query(
				`INSERT INTO edges(src_type, src_id, dst_type, dst_id, rel, weight)
				 VALUES (?,?,?,?,?,?)
				 ON CONFLICT(src_type, src_id, dst_type, dst_id, rel)
				 DO UPDATE SET weight = excluded.weight`,
			)
			.run(
				edge.srcType,
				edge.srcId,
				edge.dstType,
				edge.dstId,
				edge.rel,
				edge.weight,
			);
	}

	link(
		srcType: NodeType,
		srcId: string,
		dstType: NodeType,
		dstId: string,
		rel: Relation,
		weight = 1,
	): void {
		this.addEdge({ srcType, srcId, dstType, dstId, rel, weight });
	}

	listEdges(): Edge[] {
		const rows = this.db.query("SELECT * FROM edges").all() as Array<{
			src_type: NodeType;
			src_id: string;
			dst_type: NodeType;
			dst_id: string;
			rel: Relation;
			weight: number;
		}>;
		return rows.map((r) => ({
			srcType: r.src_type,
			srcId: r.src_id,
			dstType: r.dst_type,
			dstId: r.dst_id,
			rel: r.rel,
			weight: r.weight,
		}));
	}

	// --- graph -------------------------------------------------------------

	/** Nodes + edges for the relationship view. */
	graph(): { nodes: GraphNode[]; edges: Edge[] } {
		const leads = this.listLeads();
		const orgs = this.db
			.query("SELECT id, name, domain FROM orgs")
			.all() as Array<{
			id: string;
			name: string;
			domain: string | null;
		}>;
		const events = this.listEvents();

		const nodes: GraphNode[] = [
			...leads.map((l) => ({
				id: l.id,
				type: "lead" as const,
				label: l.fullName,
				sub: l.title ?? undefined,
				pitchFit: l.pitchFit,
				stage: l.stage,
			})),
			...orgs.map((o) => ({
				id: o.id,
				type: "org" as const,
				label: o.name,
				sub: o.domain ?? undefined,
			})),
			...events.map((e) => ({
				id: e.id,
				type: "event" as const,
				label: e.name,
				sub: e.date ?? undefined,
			})),
		];
		return { nodes, edges: this.listEdges() };
	}

	// --- outreach ----------------------------------------------------------

	addDraft(
		leadId: string,
		channel: string,
		subject: string,
		body: string,
	): number {
		const res = this.db
			.query(
				"INSERT INTO outreach(lead_id, channel, subject, body, status, created_at) VALUES (?,?,?,?, 'draft', ?)",
			)
			.run(leadId, channel, subject, body, NOW());
		return Number(res.lastInsertRowid);
	}

	getDraft(id: number): OutreachDraft | null {
		const r = this.db.query("SELECT * FROM outreach WHERE id = ?").get(id) as
			| {
					id: number;
					lead_id: string;
					channel: string;
					subject: string;
					body: string;
					status: OutreachStatus;
					created_at: string;
			  }
			| undefined;
		if (!r) return null;
		return {
			id: r.id,
			leadId: r.lead_id,
			channel: r.channel,
			subject: r.subject,
			body: r.body,
			status: r.status,
			createdAt: r.created_at,
		};
	}

	listDrafts(status?: OutreachStatus): OutreachDraft[] {
		const rows = (
			status
				? this.db
						.query(
							"SELECT * FROM outreach WHERE status = ? ORDER BY created_at DESC",
						)
						.all(status)
				: this.db.query("SELECT * FROM outreach ORDER BY created_at DESC").all()
		) as Array<{
			id: number;
			lead_id: string;
			channel: string;
			subject: string;
			body: string;
			status: OutreachStatus;
			created_at: string;
		}>;
		return rows.map((r) => ({
			id: r.id,
			leadId: r.lead_id,
			channel: r.channel,
			subject: r.subject,
			body: r.body,
			status: r.status,
			createdAt: r.created_at,
		}));
	}

	setOutreachStatus(id: number, status: OutreachStatus): void {
		this.db
			.query("UPDATE outreach SET status = ? WHERE id = ?")
			.run(status, id);
	}

	// --- reminders ---------------------------------------------------------

	addReminder(leadId: string, dueAt: string, note: string | null): number {
		const res = this.db
			.query(
				"INSERT INTO reminders(lead_id, due_at, note, done, created_at) VALUES (?,?,?,0,?)",
			)
			.run(leadId, dueAt, note, NOW());
		return Number(res.lastInsertRowid);
	}

	/** Reminders, optionally only those due on/before `dueBefore` and not done. */
	listReminders(opts: { dueBefore?: string; includeDone?: boolean } = {}): {
		id: number;
		leadId: string;
		dueAt: string;
		note: string | null;
		done: boolean;
	}[] {
		const where: string[] = [];
		const params: string[] = [];
		if (!opts.includeDone) where.push("done = 0");
		if (opts.dueBefore) {
			where.push("due_at <= ?");
			params.push(opts.dueBefore);
		}
		const sql = `SELECT * FROM reminders ${
			where.length ? `WHERE ${where.join(" AND ")}` : ""
		} ORDER BY due_at`;
		const rows = this.db.query(sql).all(...params) as Array<{
			id: number;
			lead_id: string;
			due_at: string;
			note: string | null;
			done: number;
		}>;
		return rows.map((r) => ({
			id: r.id,
			leadId: r.lead_id,
			dueAt: r.due_at,
			note: r.note,
			done: r.done === 1,
		}));
	}

	completeReminder(id: number): boolean {
		const res = this.db
			.query("UPDATE reminders SET done = 1 WHERE id = ?")
			.run(id);
		return res.changes > 0;
	}

	// --- stats -------------------------------------------------------------

	counts(): Record<string, number> {
		const one = (sql: string): number =>
			(this.db.query(sql).get() as { c: number }).c;
		return {
			leads: one("SELECT COUNT(*) AS c FROM leads"),
			orgs: one("SELECT COUNT(*) AS c FROM orgs"),
			events: one("SELECT COUNT(*) AS c FROM events"),
			edges: one("SELECT COUNT(*) AS c FROM edges"),
			embedded: one(
				"SELECT COUNT(*) AS c FROM leads WHERE embedding IS NOT NULL",
			),
			assessed: one(
				"SELECT COUNT(*) AS c FROM leads WHERE relevance IS NOT NULL",
			),
			drafts: one("SELECT COUNT(*) AS c FROM outreach"),
		};
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build the text used to embed a lead (identity + role + org + events + notes). */
export function leadEmbedText(row: {
	full_name: string;
	title: string | null;
	notes: string | null;
	org_name?: string | null;
	events?: string | null;
}): string {
	return [row.full_name, row.title, row.org_name, row.events, row.notes]
		.filter(Boolean)
		.join(". ");
}

function rowToLead(r: LeadRow): Lead {
	return {
		id: r.id,
		fullName: r.full_name,
		firstName: r.first_name,
		lastName: r.last_name,
		email: r.email,
		title: r.title,
		orgId: r.org_id,
		phones: safeJsonArray(r.phones),
		linkedin: r.linkedin,
		twitter: r.twitter,
		facebook: r.facebook,
		website: r.website,
		source: r.source,
		sourceRef: r.source_ref,
		stage: (["new", "contacted", "replied", "meeting", "passed"].includes(
			r.stage,
		)
			? r.stage
			: "new") as Stage,
		pitchFit: r.pitch_fit,
		notes: r.notes,
		relevance: r.relevance,
		relationship: (r.relationship ?? null) as Lead["relationship"],
		rationale: r.rationale,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

function safeJsonArray(text: string): string[] {
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed)
			? parsed.filter((x) => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

function unionPhones(a: string[], b: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of [...a, ...b]) {
		const t = p.trim();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

// Re-export so callers can do brute-force scoring in tests if needed.
export { topKCosine };
