/**
 * Send a single stored outreach draft over SMTP.
 *
 * Deliberately one-at-a-time and explicit: the caller passes a draft id, we look
 * up the recipient, send, then mark the draft `sent`. SMTP config is required
 * and validated up front. There is no bulk auto-send.
 */
import nodemailer from "nodemailer";
import { requireSmtp } from "../core/config.js";
import { errorMessage, OutreachError } from "../core/errors.js";
import type { LeadRepository } from "../core/repository.js";

export interface SendResult {
	messageId: string;
	to: string;
}

/** Send the draft with id `draftId` to its lead's email. */
export async function sendDraft(
	repo: LeadRepository,
	draftId: number,
): Promise<SendResult> {
	const draft = repo.getDraft(draftId);
	if (!draft) throw new OutreachError(`No draft with id ${draftId}`);
	if (draft.status === "sent")
		throw new OutreachError(`Draft ${draftId} was already sent`);

	const lead = repo.getLead(draft.leadId);
	if (!lead)
		throw new OutreachError(
			`Draft ${draftId} references unknown lead ${draft.leadId}`,
		);
	if (!lead.email) {
		throw new OutreachError(
			`${lead.fullName} has no email on file — cannot send draft ${draftId}`,
		);
	}

	const smtp = requireSmtp();
	const transporter = nodemailer.createTransport({
		host: smtp.host,
		port: smtp.port,
		secure: smtp.port === 465,
		auth: { user: smtp.user, pass: smtp.password },
	});

	const fullBody = `${draft.body}\n\nBest regards,\n${smtp.fromName}`;

	try {
		const info = await transporter.sendMail({
			from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
			to: lead.email,
			bcc: smtp.fromEmail,
			subject: draft.subject,
			text: fullBody,
			html: fullBody.replace(/\n/g, "<br>"),
		});
		repo.setOutreachStatus(draftId, "sent");
		repo.setStage(lead.id, "contacted");
		repo.addInteraction(lead.id, "email_sent", `Sent: ${draft.subject}`);
		return { messageId: info.messageId, to: lead.email };
	} catch (error) {
		throw new OutreachError(
			`Failed to send draft ${draftId}: ${errorMessage(error)}`,
			error,
		);
	}
}
