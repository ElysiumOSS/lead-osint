/**
 * Warm-intro path finder.
 *
 * Treats the CRM as an undirected graph (people ↔ orgs ↔ events) and finds the
 * shortest connection chain between two nodes — "how am I connected to someone
 * at Brex?" The path surfaces the shared org / event / person that links you.
 */
import type { LeadRepository } from "./core/repository.js";
import type { NodeType } from "./core/schema.js";

export interface PathNode {
	id: string;
	type: NodeType;
	label: string;
}

export interface FoundPath {
	nodes: PathNode[];
	/** rels[i] is the relationship between nodes[i] and nodes[i+1]. */
	rels: string[];
}

interface Adj {
	nodes: Map<string, PathNode>;
	edges: Map<string, { to: string; rel: string }[]>;
}

function buildAdjacency(repo: LeadRepository): Adj {
	const { nodes, edges } = repo.graph();
	const nodeMap = new Map<string, PathNode>(
		nodes.map((n) => [n.id, { id: n.id, type: n.type, label: n.label }]),
	);
	const adj = new Map<string, { to: string; rel: string }[]>();
	const link = (a: string, b: string, rel: string) => {
		(adj.get(a) ?? adj.set(a, []).get(a))?.push({ to: b, rel });
	};
	for (const e of edges) {
		if (!nodeMap.has(e.srcId) || !nodeMap.has(e.dstId)) continue;
		link(e.srcId, e.dstId, e.rel);
		link(e.dstId, e.srcId, e.rel);
	}
	return { nodes: nodeMap, edges: adj };
}

/** Resolve a free-text ref to candidate graph nodes (lead, org, or event). */
export function findNodes(repo: LeadRepository, ref: string): PathNode[] {
	const out: PathNode[] = [];
	const seen = new Set<string>();
	const add = (n: PathNode) => {
		if (!seen.has(n.id)) {
			seen.add(n.id);
			out.push(n);
		}
	};
	for (const l of repo.findLeads(ref))
		add({ id: l.id, type: "lead", label: l.fullName });
	const q = ref.trim().toLowerCase();
	for (const o of repo.listOrgs())
		if (o.id === ref || o.name.toLowerCase().includes(q))
			add({ id: o.id, type: "org", label: o.name });
	for (const e of repo.listEvents())
		if (e.id === ref || e.name.toLowerCase().includes(q))
			add({ id: e.id, type: "event", label: e.name });
	return out;
}

/** Breadth-first shortest path between two node ids. Null if disconnected. */
export function shortestPath(
	repo: LeadRepository,
	srcId: string,
	dstId: string,
): FoundPath | null {
	const { nodes, edges } = buildAdjacency(repo);
	if (!nodes.has(srcId) || !nodes.has(dstId)) return null;
	if (srcId === dstId) {
		const n = nodes.get(srcId);
		return n ? { nodes: [n], rels: [] } : null;
	}

	const prev = new Map<string, { from: string; rel: string }>();
	const queue: string[] = [srcId];
	const visited = new Set<string>([srcId]);

	while (queue.length) {
		const cur = queue.shift() as string;
		if (cur === dstId) break;
		for (const { to, rel } of edges.get(cur) ?? []) {
			if (visited.has(to)) continue;
			visited.add(to);
			prev.set(to, { from: cur, rel });
			queue.push(to);
		}
	}

	if (!prev.has(dstId)) return null;
	const chain: string[] = [];
	const rels: string[] = [];
	let at = dstId;
	while (at !== srcId) {
		chain.push(at);
		const step = prev.get(at);
		if (!step) return null;
		rels.push(step.rel);
		at = step.from;
	}
	chain.push(srcId);
	chain.reverse();
	rels.reverse();
	return {
		nodes: chain.map((id) => nodes.get(id) as PathNode),
		rels,
	};
}
