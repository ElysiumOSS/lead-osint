import { describe, expect, it } from "vitest";
import { type Body, barnesHutForces, bruteForces } from "./quadtree.js";

function grid(n: number): Body[] {
	const out: Body[] = [];
	for (let i = 0; i < n; i++)
		out.push({ x: (i % 10) * 7 - 35, y: Math.floor(i / 10) * 7 - 35 });
	return out;
}

describe("barnesHutForces", () => {
	it("matches brute force closely at theta=0 (exact)", () => {
		const bodies = grid(40);
		const bh = barnesHutForces(bodies, { theta: 0, strength: 500 });
		const bf = bruteForces(bodies, { strength: 500 });
		for (let i = 0; i < bodies.length; i++) {
			expect(bh[i]?.fx).toBeCloseTo(bf[i]?.fx ?? 0, 4);
			expect(bh[i]?.fy).toBeCloseTo(bf[i]?.fy ?? 0, 4);
		}
	});

	it("approximates brute force within tolerance at theta=0.5", () => {
		const bodies = grid(60);
		const bh = barnesHutForces(bodies, { theta: 0.5, strength: 500 });
		const bf = bruteForces(bodies, { strength: 500 });
		let maxErr = 0;
		for (let i = 0; i < bodies.length; i++) {
			const ex = bf[i] as { fx: number; fy: number };
			const ap = bh[i] as { fx: number; fy: number };
			const mag = Math.hypot(ex.fx, ex.fy) || 1;
			maxErr = Math.max(maxErr, Math.hypot(ap.fx - ex.fx, ap.fy - ex.fy) / mag);
		}
		expect(maxErr).toBeLessThan(0.2);
	});

	it("pushes two separated points apart (sign correctness)", () => {
		const f = barnesHutForces(
			[
				{ x: -10, y: 0 },
				{ x: 10, y: 0 },
			],
			{ theta: 0.5 },
		);
		expect((f[0] as { fx: number }).fx).toBeLessThan(0); // left point pushed left
		expect((f[1] as { fx: number }).fx).toBeGreaterThan(0); // right point pushed right
	});

	it("handles tiny inputs", () => {
		expect(barnesHutForces([])).toEqual([]);
		expect(barnesHutForces([{ x: 1, y: 1 }])).toEqual([{ fx: 0, fy: 0 }]);
	});
});
