/**
 * Generate personalized outreach drafts with Gemini.
 *
 * Reworked from the original email script: instead of blasting emails, this writes drafts
 * into the store (`outreach` table, status=draft). Review and send them
 * deliberately via `outreach send`. Nothing is ever auto-sent here.
 */
import { getConfig, requireGeminiKey } from "../core/config.js";
import { errorMessage, OutreachError } from "../core/errors.js";
import { generateText, modelChain } from "../core/gemini.js";
import type { LeadRepository } from "../core/repository.js";
import type { Lead } from "../core/schema.js";

export interface SenderInfo {
	name: string;
	linkedin?: string;
	github?: string;
	portfolio?: string;
}

export interface DraftOptions {
	apiKey?: string;
	model?: string;
	/** Your startup pitch text — grounds the email in what you're building. */
	pitch?: string;
	sender?: SenderInfo;
	tone?: string;
	callToAction?: string;
}

export interface DraftContent {
	subject: string;
	body: string;
}

/** Generate a single subject+body for a lead (no persistence). */
export async function draftForLead(
	lead: Lead,
	options: DraftOptions = {},
): Promise<DraftContent> {
	const config = getConfig();
	const apiKey = options.apiKey ?? requireGeminiKey(config);
	const model = options.model ?? config.geminiTextModel;
	const sender = options.sender ?? { name: config.smtp?.fromName ?? "Me" };
	const firstName =
		lead.firstName?.trim() || lead.fullName.split(/\s+/)[0] || "there";

	const prompt = buildPrompt(lead, firstName, sender, options);

	let text: string;
	try {
		text = await generateText({
			apiKey,
			models: modelChain(model),
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			config: { responseMimeType: "application/json", temperature: 0.7 },
		});
	} catch (error) {
		throw new OutreachError(
			`Gemini draft request failed: ${errorMessage(error)}`,
			error,
		);
	}

	const parsed = parseDraft(text);
	if (!parsed)
		throw new OutreachError("Could not parse draft JSON from model response");
	return parsed;
}

export interface GenerateDraftsOptions extends DraftOptions {
	/** Only draft for the top-N leads by pitch_fit (default 10). */
	top?: number;
	channel?: string;
	onProgress?: (lead: Lead, draft: DraftContent) => void;
}

export interface DraftSummary {
	id: number;
	leadId: string;
	leadName: string;
	subject: string;
}

/** Draft outreach for the top leads and persist each as a draft row. */
export async function generateDrafts(
	repo: LeadRepository,
	options: GenerateDraftsOptions = {},
): Promise<DraftSummary[]> {
	const { top = 10, channel = "email", onProgress, ...draftOptions } = options;
	const leads = repo.listLeads({ orderByFit: true, limit: top });
	const summaries: DraftSummary[] = [];

	// Sequential: respects model rate limits and keeps ordering by fit.
	for (const lead of leads) {
		const draft = await draftForLead(lead, draftOptions);
		const id = repo.addDraft(lead.id, channel, draft.subject, draft.body);
		repo.addInteraction(lead.id, "draft", `Drafted: ${draft.subject}`);
		onProgress?.(lead, draft);
		summaries.push({
			id,
			leadId: lead.id,
			leadName: lead.fullName,
			subject: draft.subject,
		});
	}

	return summaries;
}

// --- internals -------------------------------------------------------------

function buildPrompt(
	lead: Lead,
	firstName: string,
	sender: SenderInfo,
	options: DraftOptions,
): string {
	const tone =
		options.tone ??
		"Warm, conversational, and authentic — like reaching out to a peer you want to stay connected with";
	const cta =
		options.callToAction ??
		"a low-pressure coffee chat, a quick call, or connecting on LinkedIn";

	return `Write a short, personalized networking email.

RECIPIENT:
- Name: ${lead.fullName}
- First name (use this in the greeting): ${firstName}
- Title: ${lead.title ?? "(unknown)"}
- Context: ${lead.notes ?? "(none)"}

SENDER:
- Name: ${sender.name}
- LinkedIn: ${sender.linkedin ?? ""}
- GitHub: ${sender.github ?? ""}
- Portfolio: ${sender.portfolio ?? ""}

WHAT THE SENDER IS BUILDING (their startup pitch):
${options.pitch ?? "(no pitch provided — keep it about genuine connection)"}

REQUIREMENTS:
- Start with "Hi ${firstName},"
- Tone: ${tone}
- Reference the recipient's work/role specifically and naturally.
- Briefly (1 sentence) connect what the sender is building to the recipient's world — only if relevant; do not be salesy.
- Primary goal: build a genuine connection. Call to action: ${cta}.
- 120-200 words. Do NOT include a signature, "Best regards", or the sender's name at the end.
- Do not confuse sender and recipient.

Return ONLY JSON: {"subject":"...","body":"..."}`;
}

/** Extract {subject, body} JSON from a model response. Exported for tests. */
export function parseDraft(text: string): DraftContent | null {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const obj = JSON.parse(match[0]) as Record<string, unknown>;
		if (typeof obj.subject === "string" && typeof obj.body === "string") {
			return { subject: obj.subject, body: obj.body };
		}
		return null;
	} catch {
		return null;
	}
}
