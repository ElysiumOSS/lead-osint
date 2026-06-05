/**
 * Barnes-Hut quadtree repulsion — O(n log n) instead of O(n²).
 *
 * Used by the graph layout: instead of every node pushing on every other node,
 * distant clusters are approximated by their center of mass when they're far
 * enough away (the `theta` criterion). This is the reference TS implementation,
 * unit-tested against brute force; the dashboard inlines a JS port of the same
 * algorithm (the browser can't import this module at runtime).
 */

export interface Body {
	x: number;
	y: number;
}

export interface Force {
	fx: number;
	fy: number;
}

interface Cell {
	x: number;
	y: number;
	size: number;
	mass: number;
	cx: number; // center of mass
	cy: number;
	body: Body | null; // present only for a leaf holding exactly one body
	children: (Cell | null)[] | null;
}

function newCell(x: number, y: number, size: number): Cell {
	return { x, y, size, mass: 0, cx: 0, cy: 0, body: null, children: null };
}

function quadrant(cell: Cell, x: number, y: number): number {
	const mx = cell.x + cell.size / 2;
	const my = cell.y + cell.size / 2;
	return (x >= mx ? 1 : 0) + (y >= my ? 2 : 0);
}

function childBounds(cell: Cell, q: number): { x: number; y: number } {
	const half = cell.size / 2;
	return { x: cell.x + (q & 1 ? half : 0), y: cell.y + (q & 2 ? half : 0) };
}

function placeInChild(cell: Cell, b: Body, depth: number): void {
	const q = quadrant(cell, b.x, b.y);
	const kids = cell.children as (Cell | null)[];
	if (!kids[q]) {
		const { x, y } = childBounds(cell, q);
		kids[q] = newCell(x, y, cell.size / 2);
	}
	insert(kids[q] as Cell, b, depth + 1);
}

function insert(cell: Cell, b: Body, depth = 0): void {
	// Update aggregate mass + center of mass incrementally.
	const m = cell.mass + 1;
	cell.cx = (cell.cx * cell.mass + b.x) / m;
	cell.cy = (cell.cy * cell.mass + b.y) / m;
	cell.mass = m;

	if (cell.mass === 1) {
		cell.body = b;
		return;
	}
	// Subdivide on first collision; depth cap guards coincident points.
	if (!cell.children) {
		cell.children = [null, null, null, null];
		if (cell.body && depth < 48) {
			const ex = cell.body;
			cell.body = null;
			placeInChild(cell, ex, depth);
		}
	}
	if (depth >= 48) return;
	placeInChild(cell, b, depth);
}

/**
 * Repulsive force per body. `theta` is the accuracy/speed knob (0 = exact /
 * brute force, ~0.8 = fast). `strength` scales the inverse-square push.
 */
export function barnesHutForces(
	bodies: Body[],
	opts: { theta?: number; strength?: number; epsilon?: number } = {},
): Force[] {
	const theta = opts.theta ?? 0.8;
	const strength = opts.strength ?? 520;
	const eps = opts.epsilon ?? 0.5;
	const n = bodies.length;
	const out: Force[] = bodies.map(() => ({ fx: 0, fy: 0 }));
	if (n < 2) return out;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of bodies) {
		if (b.x < minX) minX = b.x;
		if (b.y < minY) minY = b.y;
		if (b.x > maxX) maxX = b.x;
		if (b.y > maxY) maxY = b.y;
	}
	const size = Math.max(maxX - minX, maxY - minY, 1) * 1.01;
	const root = newCell(minX, minY, size);
	for (const b of bodies) insert(root, b);

	const theta2 = theta * theta;
	for (let i = 0; i < n; i++) {
		const b = bodies[i] as Body;
		const f = out[i] as Force;
		const stack: Cell[] = [root];
		while (stack.length) {
			const cell = stack.pop() as Cell;
			if (cell.mass === 0) continue;
			const dx = b.x - cell.cx;
			const dy = b.y - cell.cy;
			const d2 = dx * dx + dy * dy + eps;
			if (cell.body && cell.body !== b) {
				const d = Math.sqrt(d2);
				const inv = strength / d2;
				f.fx += (inv * dx) / d;
				f.fy += (inv * dy) / d;
				continue;
			}
			if (cell.body) continue; // it's the body itself
			// Far enough away → treat the whole cell as one mass.
			if ((cell.size * cell.size) / d2 < theta2) {
				const d = Math.sqrt(d2);
				const inv = (strength * cell.mass) / d2;
				f.fx += (inv * dx) / d;
				f.fy += (inv * dy) / d;
			} else if (cell.children) {
				for (const c of cell.children) if (c) stack.push(c);
			}
		}
	}
	return out;
}

/** Brute-force O(n²) repulsion — exported for tests / fallback. */
export function bruteForces(
	bodies: Body[],
	opts: { strength?: number; epsilon?: number } = {},
): Force[] {
	const strength = opts.strength ?? 520;
	const eps = opts.epsilon ?? 0.5;
	const out: Force[] = bodies.map(() => ({ fx: 0, fy: 0 }));
	for (let i = 0; i < bodies.length; i++) {
		const a = bodies[i] as Body;
		for (let j = 0; j < bodies.length; j++) {
			if (i === j) continue;
			const b = bodies[j] as Body;
			const dx = a.x - b.x;
			const dy = a.y - b.y;
			const d2 = dx * dx + dy * dy + eps;
			const d = Math.sqrt(d2);
			const inv = strength / d2;
			(out[i] as Force).fx += (inv * dx) / d;
			(out[i] as Force).fy += (inv * dy) / d;
		}
	}
	return out;
}
