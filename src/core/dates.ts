/**
 * Lightweight date parsing shared by the CLI and the server.
 */

/**
 * Parse a relative ("3d", "2w", "1m", "1y") or absolute (ISO / parseable date)
 * spec into an ISO-8601 timestamp. Throws on anything it can't read.
 */
export function parseWhen(when: string, now: Date = new Date()): string {
	const rel = when.trim().match(/^(\d+)\s*([dwmy])$/i);
	if (rel) {
		const n = Number(rel[1]);
		const unit = (rel[2] as string).toLowerCase();
		const d = new Date(now);
		if (unit === "d") d.setDate(d.getDate() + n);
		else if (unit === "w") d.setDate(d.getDate() + n * 7);
		else if (unit === "m") d.setMonth(d.getMonth() + n);
		else d.setFullYear(d.getFullYear() + n);
		return d.toISOString();
	}
	const ts = Date.parse(when);
	if (!Number.isNaN(ts)) return new Date(ts).toISOString();
	throw new Error(
		`Can't parse "${when}". Use 3d / 2w / 1m / 1y or a date like 2026-07-01.`,
	);
}
