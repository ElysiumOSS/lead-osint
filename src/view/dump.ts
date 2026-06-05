/**
 * Full information dump — a complete dossier for every lead.
 *
 * Pulls each person together with their org, the events that connect them, the
 * interaction log, and any outreach drafts, then writes it as machine-readable
 * JSON and/or a human-readable Markdown brief. Useful for review, sharing, or
 * feeding another tool.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LeadRepository } from "../core/repository.js";
import type {
	EventSource,
	Interaction,
	Lead,
	OutreachDraft,
} from "../core/schema.js";

export interface Dossier {
	lead: Lead;
	org: {
		id: string;
		name: string;
		domain: string | null;
		notes: string | null;
	} | null;
	events: EventSource[];
	interactions: Interaction[];
	drafts: OutreachDraft[];
}

export interface Dump {
	generatedAt: string;
	count: number;
	leads: Dossier[];
}

/** Assemble a full dossier per lead from the store. */
export function buildDump(repo: LeadRepository, generatedAt: string): Dump {
	const leads = repo.listLeads({ orderByFit: true });
	const eventsById = new Map(repo.listEvents().map((e) => [e.id, e]));
	// Snapshot orgs once instead of a getOrg query per lead (N+1).
	const orgsById = new Map(repo.listOrgs().map((o) => [o.id, o]));
	const drafts = repo.listDrafts();
	const edges = repo.listEdges();

	const eventIdsByLead = new Map<string, string[]>();
	for (const e of edges) {
		if (e.srcType === "lead" && e.dstType === "event") {
			const arr = eventIdsByLead.get(e.srcId) ?? [];
			arr.push(e.dstId);
			eventIdsByLead.set(e.srcId, arr);
		}
	}

	const leadsOut: Dossier[] = leads.map((lead) => ({
		lead,
		org: lead.orgId ? (orgsById.get(lead.orgId) ?? null) : null,
		events: (eventIdsByLead.get(lead.id) ?? [])
			.map((id) => eventsById.get(id))
			.filter((e): e is EventSource => !!e),
		interactions: repo.listInteractions(lead.id),
		drafts: drafts.filter((d) => d.leadId === lead.id),
	}));

	return { generatedAt, count: leadsOut.length, leads: leadsOut };
}

/** Render a dump as a readable Markdown brief. */
export function renderDumpMarkdown(dump: Dump): string {
	const lines: string[] = [
		"# Lead-OSINT — Information Dump",
		"",
		`Generated ${dump.generatedAt} · ${dump.count} leads`,
		"",
	];

	for (const d of dump.leads) {
		const l = d.lead;
		lines.push(`## ${l.fullName}${l.title ? ` — ${l.title}` : ""}`);
		const fit = l.pitchFit == null ? "—" : l.pitchFit.toFixed(2);
		lines.push("");
		lines.push(
			`- **Pitch fit:** ${fit}  ·  **Stage:** ${l.stage}  ·  **Source:** ${l.source}`,
		);
		if (l.relevance != null || l.relationship) {
			const rel = l.relevance == null ? "—" : l.relevance.toFixed(2);
			lines.push(
				`- **Relevance:** ${rel}${l.relationship ? `  ·  **Relationship:** ${l.relationship}` : ""}`,
			);
		}
		if (l.rationale) lines.push(`- **Why:** ${l.rationale}`);
		if (d.org)
			lines.push(
				`- **Org:** ${d.org.name}${d.org.domain ? ` (${d.org.domain})` : ""}`,
			);
		if (l.email) lines.push(`- **Email:** ${l.email}`);
		if (l.phones.length) lines.push(`- **Phones:** ${l.phones.join(", ")}`);
		const socials = [
			l.linkedin && `[LinkedIn](${l.linkedin})`,
			l.twitter && `[Twitter](${l.twitter})`,
			l.facebook && `[Facebook](${l.facebook})`,
			l.website && `[Web](${l.website})`,
		].filter(Boolean);
		if (socials.length) lines.push(`- **Links:** ${socials.join(" · ")}`);
		if (d.events.length) {
			lines.push(`- **Events:** ${d.events.map((e) => e.name).join("; ")}`);
		}
		if (l.notes) {
			lines.push("", `> ${l.notes.replace(/\n/g, "\n> ")}`);
		}
		if (d.drafts.length) {
			lines.push("", "**Outreach drafts:**");
			for (const dr of d.drafts) lines.push(`- [${dr.status}] ${dr.subject}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

/** Write the dump to `outBase` (`.json` and/or `.md`). Returns paths written. */
export async function writeDump(
	repo: LeadRepository,
	outBase: string,
	generatedAt: string,
	format: "json" | "md" | "both" = "both",
): Promise<string[]> {
	const dump = buildDump(repo, generatedAt);
	const dir = dirname(outBase);
	if (dir && dir !== ".") await mkdir(dir, { recursive: true });
	const written: string[] = [];

	if (format === "json" || format === "both") {
		const path = outBase.endsWith(".json") ? outBase : `${outBase}.json`;
		await writeFile(path, JSON.stringify(dump, null, 2), "utf-8");
		written.push(path);
	}
	if (format === "md" || format === "both") {
		const path = outBase.endsWith(".md") ? outBase : `${outBase}.md`;
		await writeFile(path, renderDumpMarkdown(dump), "utf-8");
		written.push(path);
	}
	return written;
}
