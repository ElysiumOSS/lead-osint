/**
 * SQLite store (Bun built-in) + sqlite-vec.
 *
 * One embedded file doubles as the CRM relational store and the vector index.
 * If the sqlite-vec extension cannot be loaded, the store still works — the
 * repository falls back to a pure-JS cosine scan over the BLOB column.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { getConfig } from "./config.js";
import { EMBED_DIM } from "./embeddings.js";
import { DbError, errorMessage } from "./errors.js";

const SCHEMA_VERSION = "3";

export interface LeadDb {
	db: Database;
	/** True when the sqlite-vec extension loaded and the vec table exists. */
	hasVec: boolean;
	path: string;
	close(): void;
}

/** Open (or create) the store at `path`, run migrations, and load sqlite-vec. */
export function openDatabase(path: string = getConfig().dbPath): LeadDb {
	if (path !== ":memory:") {
		try {
			mkdirSync(dirname(path), { recursive: true });
		} catch {
			// dirname may be "." — ignore; open will surface real errors.
		}
	}

	let db: Database;
	try {
		db = new Database(path, { create: true });
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA foreign_keys = ON;");
	} catch (error) {
		throw new DbError(
			`Could not open database at ${path}: ${errorMessage(error)}`,
			error,
		);
	}

	const hasVec = tryLoadVec(db);
	migrate(db, hasVec);

	return {
		db,
		hasVec,
		path,
		close: () => db.close(),
	};
}

function tryLoadVec(db: Database): boolean {
	try {
		db.loadExtension(sqliteVec.getLoadablePath());
		db.query("select vec_version()").get();
		return true;
	} catch {
		return false;
	}
}

function migrate(db: Database, hasVec: boolean): void {
	try {
		db.exec(`
			CREATE TABLE IF NOT EXISTS meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS orgs (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				domain TEXT,
				notes TEXT
			);

			CREATE TABLE IF NOT EXISTS leads (
				id TEXT PRIMARY KEY,
				full_name TEXT NOT NULL,
				first_name TEXT,
				last_name TEXT,
				email TEXT,
				title TEXT,
				org_id TEXT REFERENCES orgs(id),
				phones TEXT NOT NULL DEFAULT '[]',
				linkedin TEXT,
				twitter TEXT,
				facebook TEXT,
				website TEXT,
				source TEXT NOT NULL,
				source_ref TEXT,
				stage TEXT NOT NULL DEFAULT 'new',
				pitch_fit REAL,
				notes TEXT,
				relevance REAL,
				relationship TEXT,
				rationale TEXT,
				embedding BLOB,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS events (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				date TEXT,
				location TEXT,
				lat REAL,
				lon REAL,
				url TEXT,
				source TEXT NOT NULL,
				description TEXT,
				priority_score INTEGER,
				priority_matches TEXT NOT NULL DEFAULT '[]'
			);

			CREATE TABLE IF NOT EXISTS edges (
				src_type TEXT NOT NULL,
				src_id TEXT NOT NULL,
				dst_type TEXT NOT NULL,
				dst_id TEXT NOT NULL,
				rel TEXT NOT NULL,
				weight REAL NOT NULL DEFAULT 1,
				PRIMARY KEY (src_type, src_id, dst_type, dst_id, rel)
			);

			CREATE TABLE IF NOT EXISTS interactions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				lead_id TEXT NOT NULL REFERENCES leads(id),
				type TEXT NOT NULL,
				content TEXT NOT NULL,
				at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS outreach (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				lead_id TEXT NOT NULL REFERENCES leads(id),
				channel TEXT NOT NULL,
				subject TEXT NOT NULL,
				body TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'draft',
				created_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS reminders (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				lead_id TEXT NOT NULL REFERENCES leads(id),
				due_at TEXT NOT NULL,
				note TEXT,
				done INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_leads_org ON leads(org_id);
			CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
			CREATE INDEX IF NOT EXISTS idx_leads_fit ON leads(pitch_fit);
			CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_type, dst_id);
			CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_type, src_id);
			CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach(lead_id);
			CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(done, due_at);
		`);

		// Add columns introduced after a store was first created (idempotent).
		const leadCols = new Set(
			(db.query("PRAGMA table_info(leads)").all() as { name: string }[]).map(
				(c) => c.name,
			),
		);
		for (const [col, type] of [
			["relevance", "REAL"],
			["relationship", "TEXT"],
			["rationale", "TEXT"],
		] as const) {
			if (!leadCols.has(col))
				db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type};`);
		}

		// Index the relationship filter (dashboard list + `next --relationship`).
		// Created after the ALTER above so the column is guaranteed to exist.
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_leads_relationship ON leads(relationship);",
		);

		if (hasVec) {
			db.exec(
				`CREATE VIRTUAL TABLE IF NOT EXISTS lead_vec USING vec0(embedding float[${EMBED_DIM}]);`,
			);
		}

		db.query(
			"INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)",
		).run(SCHEMA_VERSION);
	} catch (error) {
		throw new DbError(`Migration failed: ${errorMessage(error)}`, error);
	}
}
