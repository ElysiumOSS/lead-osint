/**
 * Strict ingest validation — keeps junk from polluting the graph.
 *
 * Most "disconnected node" noise comes from bad org identity: a personal email
 * domain (gmail.com) masquerading as a company, generic placeholders ("Self",
 * "Freelance"), or a company field that's really the person's own name. This
 * module rejects non-people and cleans company/domain so real shared employers
 * actually merge into shared hubs.
 */
import { normalizeName } from "../core/ids.js";
import { domainOf } from "../core/text.js";

/** Free / personal email providers — never treated as a company domain. */
export const FREE_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"ymail.com",
	"hotmail.com",
	"outlook.com",
	"live.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"msn.com",
	"gmx.com",
	"mail.com",
	"fastmail.com",
	"hey.com",
	"zoho.com",
	"yandex.com",
	"qq.com",
	"163.com",
]);

const GENERIC_COMPANY = new Set([
	"independent",
	"self",
	"self employed",
	"self-employed",
	"freelance",
	"freelancer",
	"unemployed",
	"student",
	"none",
	"myself",
	"home",
	"personal",
	"private",
	"individual",
	"n a",
	"na",
]);

export function isFreeEmailDomain(domain: string | null | undefined): boolean {
	return !!domain && FREE_EMAIL_DOMAINS.has(domain.trim().toLowerCase());
}

/**
 * Best company domain for org identity: the website's domain, else the email's
 * domain — but never a free-email provider (which would merge unrelated people).
 */
export function orgDomain(
	website: string | null | undefined,
	email: string | null | undefined,
): string | null {
	const web = domainOf(website);
	if (web && !isFreeEmailDomain(web)) return web;
	const mail = domainOf(email);
	if (mail && !isFreeEmailDomain(mail)) return mail;
	return null;
}

/**
 * Clean a company string into a real org name, or null. Drops generic
 * placeholders, single-character noise, email/URL-looking values, and a company
 * that's just the person's own name.
 */
export function cleanCompany(
	company: string | null | undefined,
	personName?: string | null,
): string | null {
	const c = company?.trim();
	if (!c || c.length < 2) return null;
	const lower = c.toLowerCase();
	if (
		GENERIC_COMPANY.has(
			lower
				.replace(/[^a-z ]/g, " ")
				.replace(/\s+/g, " ")
				.trim(),
		)
	)
		return null;
	if (/@|https?:\/\//i.test(c)) return null; // an email/URL, not a company
	if (!/[a-z0-9]/i.test(c)) return null; // no real characters
	if (personName && normalizeName(c) === normalizeName(personName)) return null; // company == person
	return c;
}

export interface NameCheck {
	ok: boolean;
	reason?: string;
}

/** A value that's plausibly a real person's name. */
export function validatePersonName(
	fullName: string | null | undefined,
): NameCheck {
	const n = fullName?.trim();
	if (!n || n.length < 2) return { ok: false, reason: "empty/short" };
	if (/@|https?:\/\//i.test(n)) return { ok: false, reason: "email/url" };
	if (!/[a-z]/i.test(n)) return { ok: false, reason: "no letters" };
	if (/^(unknown|n\/?a|none|tbd|guest|attendee|speaker|test)$/i.test(n))
		return { ok: false, reason: "placeholder" };
	return { ok: true };
}
