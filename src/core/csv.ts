/**
 * Minimal, dependency-free RFC-4180 CSV parser.
 *
 * Needed because the investor exports (OpenVC theses, Airtable "Fund Focus"
 * cells) contain quoted fields with embedded commas AND newlines — a naive
 * `split(",")` / `split("\n")` mangles them. This is a streaming character
 * scanner: it tracks whether it is inside a quoted field and only treats commas
 * and newlines as delimiters when it is not.
 */

/** Parse CSV text into rows of string cells (no header interpretation). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	// Strip a UTF-8 BOM if present (Google Sheets / Excel exports add one).
	const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];

		if (inQuotes) {
			if (ch === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i++; // consume the escaped quote
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			// Normalize CRLF / CR / LF to a single record boundary.
			if (ch === "\r" && src[i + 1] === "\n") i++;
			row.push(field);
			field = "";
			rows.push(row);
			row = [];
		} else {
			field += ch;
		}
	}

	// Flush the final field/row unless the input ended on a clean newline.
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

/**
 * Parse CSV text into objects keyed by the header row. Header cells are trimmed;
 * duplicate/blank headers are kept as-is (last one wins on collision). Rows with
 * fewer cells than headers get empty strings for the missing trailing columns.
 */
export function parseCsvRecords(text: string): Record<string, string>[] {
	const rows = parseCsv(text);
	if (rows.length === 0) return [];
	const headers = rows[0].map((h) => h.trim());
	const out: Record<string, string>[] = [];
	for (let r = 1; r < rows.length; r++) {
		const cells = rows[r];
		// Skip fully-empty trailing rows (a common export artifact).
		if (cells.length === 1 && cells[0].trim() === "") continue;
		const rec: Record<string, string> = {};
		for (let c = 0; c < headers.length; c++) {
			rec[headers[c]] = (cells[c] ?? "").trim();
		}
		out.push(rec);
	}
	return out;
}

/**
 * Look up a value from a record by trying several candidate header names
 * (case-insensitive, whitespace-insensitive). Sources label the same concept
 * differently ("Investor name" vs "Investor Name"), so callers pass all variants.
 */
export function pick(
	record: Record<string, string>,
	...candidates: string[]
): string {
	const norm = (s: string): string =>
		s.toLowerCase().replace(/\s+/g, " ").trim();
	const map = new Map<string, string>();
	for (const [k, v] of Object.entries(record)) map.set(norm(k), v);
	for (const cand of candidates) {
		const hit = map.get(norm(cand));
		if (hit !== undefined && hit !== "") return hit;
	}
	return "";
}
