import { describe, expect, it } from "vitest";
import { parseWhen } from "./dates.js";

describe("parseWhen", () => {
	const now = new Date("2026-06-02T12:00:00.000Z");

	it("handles relative day/week/month/year", () => {
		expect(parseWhen("3d", now).slice(0, 10)).toBe("2026-06-05");
		expect(parseWhen("2w", now).slice(0, 10)).toBe("2026-06-16");
		expect(parseWhen("1m", now).slice(0, 10)).toBe("2026-07-02");
		expect(parseWhen("1y", now).slice(0, 10)).toBe("2027-06-02");
	});

	it("accepts absolute dates", () => {
		expect(parseWhen("2026-07-01", now).slice(0, 10)).toBe("2026-07-01");
	});

	it("throws on garbage", () => {
		expect(() => parseWhen("soon", now)).toThrow();
	});
});
