/**
 * Export leads to portable formats.
 *
 * CSV for spreadsheets / Gmail / HubSpot / Notion import, and vCard 3.0 (.vcf)
 * to drop straight into your phone or address book. Pure string builders — the
 * command layer resolves org names and writes the file.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LeadRepository } from "./core/repository.js";
import type { Stage } from "./core/schema.js";

export interface ExportRow {
	name: string;
	firstName: string | null;
	lastName: string | null;
	email: string | null;
	title: string | null;
	company: string | null;
	phones: string[];
	linkedin: string | null;
	twitter: string | null;
	website: string | null;
	stage: string;
	pitchFit: number | null;
	source: string;
	notes: string | null;
}

const CSV_COLUMNS: { key: keyof ExportRow; header: string }[] = [
	{ key: "name", header: "Name" },
	{ key: "firstName", header: "First Name" },
	{ key: "lastName", header: "Last Name" },
	{ key: "email", header: "Email" },
	{ key: "title", header: "Title" },
	{ key: "company", header: "Company" },
	{ key: "phones", header: "Phones" },
	{ key: "linkedin", header: "LinkedIn" },
	{ key: "twitter", header: "Twitter" },
	{ key: "website", header: "Website" },
	{ key: "stage", header: "Stage" },
	{ key: "pitchFit", header: "Pitch Fit" },
	{ key: "source", header: "Source" },
	{ key: "notes", header: "Notes" },
];

function csvCell(value: unknown): string {
	let s: string;
	if (value == null) s = "";
	else if (Array.isArray(value)) s = value.join("; ");
	else s = String(value);
	// Quote when the cell contains a comma, quote, or newline.
	if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
	return s;
}

/** Render rows as RFC-4180 CSV. */
export function toCsv(rows: ExportRow[]): string {
	const head = CSV_COLUMNS.map((c) => c.header).join(",");
	const body = rows.map((r) =>
		CSV_COLUMNS.map((c) => csvCell(r[c.key])).join(","),
	);
	return [head, ...body].join("\r\n");
}

function vcardEscape(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/,/g, "\\,")
		.replace(/;/g, "\\;")
		.replace(/\n/g, "\\n");
}

/** Render rows as vCard 3.0 (.vcf). */
export function toVcard(rows: ExportRow[]): string {
	const cards = rows.map((r) => {
		const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vcardEscape(r.name)}`];
		if (r.lastName || r.firstName) {
			lines.push(
				`N:${vcardEscape(r.lastName ?? "")};${vcardEscape(r.firstName ?? "")};;;`,
			);
		}
		if (r.title) lines.push(`TITLE:${vcardEscape(r.title)}`);
		if (r.company) lines.push(`ORG:${vcardEscape(r.company)}`);
		if (r.email) lines.push(`EMAIL;TYPE=INTERNET:${vcardEscape(r.email)}`);
		for (const p of r.phones) lines.push(`TEL:${vcardEscape(p)}`);
		if (r.website) lines.push(`URL:${vcardEscape(r.website)}`);
		if (r.linkedin)
			lines.push(`X-SOCIALPROFILE;TYPE=linkedin:${vcardEscape(r.linkedin)}`);
		if (r.twitter)
			lines.push(`X-SOCIALPROFILE;TYPE=twitter:${vcardEscape(r.twitter)}`);
		const note = [
			r.notes,
			r.pitchFit != null ? `pitch-fit ${r.pitchFit.toFixed(2)}` : null,
		]
			.filter(Boolean)
			.join(" — ");
		if (note) lines.push(`NOTE:${vcardEscape(note)}`);
		lines.push("END:VCARD");
		return lines.join("\r\n");
	});
	return cards.join("\r\n");
}

export interface ExportFilter {
	stage?: string;
	relationship?: string;
	minFit?: number;
}

/**
 * Build export rows from the store, filtered + best-fit first. Shared by the CLI
 * `export` command and the dashboard's `/api/export` download so both stay in
 * sync. Org names are resolved once (no per-lead query).
 */
export function buildExportRows(
	repo: LeadRepository,
	filter: ExportFilter = {},
): ExportRow[] {
	const orgsById = new Map(repo.listOrgs().map((o) => [o.id, o.name]));
	return repo
		.listLeads({
			stage: filter.stage as Stage | undefined,
			relationship: filter.relationship,
			orderByFit: true,
		})
		.filter(
			(l) => filter.minFit === undefined || (l.pitchFit ?? 0) >= filter.minFit,
		)
		.map((l) => ({
			name: l.fullName,
			firstName: l.firstName,
			lastName: l.lastName,
			email: l.email,
			title: l.title,
			company: l.orgId ? (orgsById.get(l.orgId) ?? null) : null,
			phones: l.phones,
			linkedin: l.linkedin,
			twitter: l.twitter,
			website: l.website,
			stage: l.stage,
			pitchFit: l.pitchFit,
			source: l.source,
			notes: l.notes,
		}));
}

/** Write rows to `outPath` in the chosen format. Returns the path. */
export async function writeExport(
	rows: ExportRow[],
	outPath: string,
	format: "csv" | "vcard",
): Promise<string> {
	const content = format === "csv" ? toCsv(rows) : toVcard(rows);
	const dir = dirname(outPath);
	if (dir && dir !== ".") await mkdir(dir, { recursive: true });
	await writeFile(outPath, content, "utf-8");
	return outPath;
}
