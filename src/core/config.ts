/**
 * Environment configuration: load `.env`, validate, expose typed accessors.
 *
 * Secrets are read from the environment only — never hardcoded. Commands that
 * need a particular secret call the matching `require*` accessor, which fails
 * fast with a clear `ConfigError` when it is missing.
 */
import dotenv from "dotenv";
import { z } from "zod";
import { ConfigError } from "./errors.js";

dotenv.config({ quiet: true });

const EnvSchema = z.object({
	GEMINI_API_KEY: z.string().optional(),
	GOOGLE_API_KEY: z.string().optional(),
	GEMINI_OCR_MODEL: z.string().default("gemini-2.5-flash"),
	GEMINI_TEXT_MODEL: z.string().default("gemini-2.5-flash"),
	SMTP_HOST: z.string().optional(),
	SMTP_PORT: z.coerce.number().int().positive().default(587),
	SMTP_USER: z.string().optional(),
	SMTP_PASSWORD: z.string().optional(),
	OUTREACH_FROM_NAME: z.string().optional(),
	OUTREACH_FROM_EMAIL: z.string().optional(),
	LEAD_OSINT_DB: z.string().default("data/leads.db"),
	/** Privacy guard: when truthy, commands that send lead data to a third party
	 * (ocr, enrich, assess, outreach) refuse unless run with --allow-external. */
	LEAD_OSINT_LOCAL_ONLY: z.string().optional(),
});

/** True when an env var is set to a truthy value (1/true/yes/on). */
function envFlag(value: string | undefined): boolean {
	return !!value && /^(1|true|yes|on)$/i.test(value.trim());
}

export interface SmtpConfig {
	host: string;
	port: number;
	user: string;
	password: string;
	fromName: string;
	fromEmail: string;
}

export interface AppConfig {
	geminiApiKey: string | undefined;
	geminiOcrModel: string;
	geminiTextModel: string;
	dbPath: string;
	smtp: SmtpConfig | null;
	/** When true, external-data commands are blocked unless explicitly allowed. */
	localOnly: boolean;
}

let cached: AppConfig | null = null;

/** Parse + cache the environment. Throws `ConfigError` on malformed values. */
export function getConfig(): AppConfig {
	if (cached) return cached;
	const parsed = EnvSchema.safeParse(process.env);
	if (!parsed.success) {
		throw new ConfigError(
			`Invalid environment: ${parsed.error.issues
				.map((i) => `${i.path.join(".")} ${i.message}`)
				.join("; ")}`,
		);
	}
	const env = parsed.data;
	const smtpReady =
		env.SMTP_HOST &&
		env.SMTP_USER &&
		env.SMTP_PASSWORD &&
		env.OUTREACH_FROM_EMAIL;

	cached = {
		geminiApiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
		geminiOcrModel: env.GEMINI_OCR_MODEL,
		geminiTextModel: env.GEMINI_TEXT_MODEL,
		dbPath: env.LEAD_OSINT_DB,
		localOnly: envFlag(env.LEAD_OSINT_LOCAL_ONLY),
		smtp: smtpReady
			? {
					host: env.SMTP_HOST as string,
					port: env.SMTP_PORT,
					user: env.SMTP_USER as string,
					password: env.SMTP_PASSWORD as string,
					fromName:
						env.OUTREACH_FROM_NAME ?? (env.OUTREACH_FROM_EMAIL as string),
					fromEmail: env.OUTREACH_FROM_EMAIL as string,
				}
			: null,
	};
	return cached;
}

/** Gemini API key or a `ConfigError` explaining how to set it. */
export function requireGeminiKey(config: AppConfig = getConfig()): string {
	if (!config.geminiApiKey) {
		throw new ConfigError(
			"GEMINI_API_KEY is not set. Add it to .env (or export GOOGLE_API_KEY). " +
				"Get a key at https://aistudio.google.com/apikey",
		);
	}
	return config.geminiApiKey;
}

/** SMTP config or a `ConfigError` listing what is missing. */
export function requireSmtp(config: AppConfig = getConfig()): SmtpConfig {
	if (!config.smtp) {
		throw new ConfigError(
			"SMTP is not fully configured. Set SMTP_HOST, SMTP_USER, SMTP_PASSWORD, " +
				"and OUTREACH_FROM_EMAIL in .env to enable `outreach send`.",
		);
	}
	return config.smtp;
}

/** Test/CLI hook to reset the memoized config (e.g. after mutating env). */
export function resetConfigCache(): void {
	cached = null;
}
