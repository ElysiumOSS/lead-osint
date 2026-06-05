/**
 * Shared ingest result shape.
 *
 * Every source parser produces `RawContact`s (people) and optionally standalone
 * `RawEvent`s (so events with no known hosts still become graph nodes).
 */
import type { RawContact, RawEvent } from "../core/schema.js";

export interface IngestResult {
	contacts: RawContact[];
	events: RawEvent[];
}

/** Convenience: wrap a bare contact list as an `IngestResult`. */
export function fromContacts(contacts: RawContact[]): IngestResult {
	return { contacts, events: [] };
}
