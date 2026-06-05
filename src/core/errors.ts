/**
 * Typed domain errors for the lead-osint pipeline.
 *
 * Plain `Error` subclasses (no Effect dependency in the core) so callers can
 * `instanceof`-narrow and surface user-friendly messages while keeping the
 * original `cause` for logs.
 */

/** Base class for every error this codebase throws on purpose. */
export class LeadOsintError extends Error {
	override readonly name: string = "LeadOsintError";
	override readonly cause?: unknown;

	constructor(message: string, cause?: unknown) {
		super(message);
		this.cause = cause;
		// Restore prototype chain for reliable `instanceof` after transpilation.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/** Missing/invalid configuration or environment (e.g. absent API key). */
export class ConfigError extends LeadOsintError {
	override readonly name = "ConfigError";
}

/** Database open / migration / query failure. */
export class DbError extends LeadOsintError {
	override readonly name = "DbError";
}

/** A source could not be read, parsed, or normalized. */
export class IngestError extends LeadOsintError {
	override readonly name = "IngestError";

	constructor(
		message: string,
		readonly source?: string,
		cause?: unknown,
	) {
		super(message, cause);
	}
}

/** Vision OCR failed for an image. */
export class OcrError extends LeadOsintError {
	override readonly name = "OcrError";

	constructor(
		message: string,
		readonly imagePath?: string,
		cause?: unknown,
	) {
		super(message, cause);
	}
}

/** Embedding model load or inference failure. */
export class EmbedError extends LeadOsintError {
	override readonly name = "EmbedError";
}

/** Outreach generation or delivery failure. */
export class OutreachError extends LeadOsintError {
	override readonly name = "OutreachError";
}

/** Best-effort extraction of a human-readable message from any thrown value. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
