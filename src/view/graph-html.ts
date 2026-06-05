/**
 * Self-contained interactive relationship view.
 *
 * Renders the CRM into a single offline HTML file: a force-directed graph of
 * people <-> orgs <-> events plus a searchable, stage-filterable lead table
 * sorted by pitch-fit. No CDN, no server — open the file in any browser.
 *
 * Designed to stay legible at thousands of nodes: events are off by default,
 * repulsion uses a spatial grid (so it spreads instead of clumping), the layout
 * cools and settles, and labels are shown only for top leads / hover / focus.
 */
import { writeFile } from "node:fs/promises";
import type { LeadRepository } from "../core/repository.js";

interface ViewData {
	generatedAt: string;
	nodes: {
		id: string;
		type: string;
		label: string;
		sub: string | null;
		pitchFit: number | null;
		stage: string | null;
	}[];
	edges: { source: string; target: string; rel: string }[];
	leads: {
		id: string;
		name: string;
		title: string | null;
		email: string | null;
		linkedin: string | null;
		stage: string;
		pitchFit: number | null;
		source: string;
	}[];
}

/** Collect everything the view needs from the repository. */
export function buildViewData(
	repo: LeadRepository,
	generatedAt: string,
): ViewData {
	const { nodes, edges } = repo.graph();
	const leads = repo.listLeads({ orderByFit: true });
	return {
		generatedAt,
		nodes: nodes.map((n) => ({
			id: n.id,
			type: n.type,
			label: n.label,
			sub: n.sub ?? null,
			pitchFit: n.pitchFit ?? null,
			stage: n.stage ?? null,
		})),
		edges: edges.map((e) => ({ source: e.srcId, target: e.dstId, rel: e.rel })),
		leads: leads.map((l) => ({
			id: l.id,
			name: l.fullName,
			title: l.title,
			email: l.email,
			linkedin: l.linkedin,
			stage: l.stage,
			pitchFit: l.pitchFit,
			source: l.source,
		})),
	};
}

/** Render the full HTML document as a string. */
export function renderGraphHtml(data: ViewData): string {
	const json = JSON.stringify(data).replace(/</g, "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lead-OSINT — Relationship Graph</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
	<div class="brand"><span class="dot"></span> lead-osint <span class="muted">relationship graph</span></div>
	<div class="stats" id="stats"></div>
</header>
<main class="layout">
	<section class="graph-pane">
		<canvas id="graph"></canvas>
		<div class="panel">
			<div class="filters">
				<label><input type="checkbox" id="f-people" checked /> People</label>
				<label><input type="checkbox" id="f-orgs" checked /> Orgs</label>
				<label><input type="checkbox" id="f-events" /> Events</label>
			</div>
			<label class="oneline"><input type="checkbox" id="f-iso" checked /> Hide unlinked orgs/events</label>
			<label class="oneline">Scope <select id="f-scope"><option value="ego">Top leads + links</option><option value="all">Everyone</option></select></label>
			<label class="slider">Min fit <input type="range" id="f-fit" min="0" max="1" step="0.05" value="0" /> <span id="fitval">0.00</span></label>
			<div class="panel-actions">
				<button id="fitbtn" type="button">Fit view</button>
				<button id="pathbtn" type="button">Trace path</button>
			</div>
			<span class="shown" id="shown"></span>
			<span class="shown" id="pathmsg"></span>
		</div>
		<div class="legend">
			<span><i class="swatch lead"></i> person</span>
			<span><i class="swatch org"></i> org</span>
			<span><i class="swatch event"></i> event</span>
			<span class="hint">drag to pan · scroll to zoom · click a node to focus</span>
		</div>
		<div class="tooltip" id="tooltip" hidden></div>
	</section>
	<aside class="table-pane">
		<div class="controls">
			<input id="search" type="search" placeholder="Search people, titles, email…" />
			<select id="stage">
				<option value="">all stages</option>
				<option value="new">new</option>
				<option value="contacted">contacted</option>
				<option value="replied">replied</option>
				<option value="meeting">meeting</option>
				<option value="passed">passed</option>
			</select>
		</div>
		<div class="table-wrap"><table id="leads"><thead>
			<tr><th>Fit</th><th>Name</th><th>Title</th><th>Stage</th></tr>
		</thead><tbody></tbody></table></div>
	</aside>
</main>
<script>${SCRIPT.replace("__DATA__", json)}</script>
</body>
</html>`;
}

/** Build + write the HTML view to `outPath`. Returns the path written. */
export async function writeGraphHtml(
	repo: LeadRepository,
	outPath: string,
	generatedAt: string,
): Promise<string> {
	const data = buildViewData(repo, generatedAt);
	await writeFile(outPath, renderGraphHtml(data), "utf-8");
	return outPath;
}

const STYLE = `
:root {
	--bg: oklch(16% 0.02 265); --panel: oklch(21% 0.03 265); --line: oklch(30% 0.03 265);
	--text: oklch(96% 0.01 265); --muted: oklch(70% 0.02 265);
	--lead: oklch(72% 0.17 250); --org: oklch(80% 0.15 150); --event: oklch(82% 0.15 80);
	--accent: oklch(72% 0.17 250);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
	font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.topbar { display: flex; justify-content: space-between; align-items: center;
	padding: 12px 20px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; letter-spacing: .02em; display: flex; align-items: center; gap: 8px; }
.brand .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent);
	box-shadow: 0 0 12px var(--accent); }
.muted { color: var(--muted); font-weight: 400; }
.stats { color: var(--muted); font-variant-numeric: tabular-nums; }
.stats b { color: var(--text); }
.layout { display: grid; grid-template-columns: 1fr 380px; height: calc(100% - 53px); }
.graph-pane { position: relative; overflow: hidden; }
#graph { width: 100%; height: 100%; display: block; cursor: grab; }
#graph:active { cursor: grabbing; }
.panel { position: absolute; left: 16px; top: 14px; display: flex; flex-direction: column; gap: 8px;
	background: oklch(18% 0.02 265 / .82); border: 1px solid var(--line); border-radius: 12px;
	padding: 12px 14px; backdrop-filter: blur(8px); font-size: 13px; width: 230px; }
.panel .filters { display: flex; gap: 12px; }
.panel label { display: flex; align-items: center; gap: 6px; cursor: pointer; color: var(--muted); }
.panel input[type=checkbox] { accent-color: var(--accent); }
.panel .slider { gap: 8px; font-variant-numeric: tabular-nums; }
.panel .slider input { flex: 1; accent-color: var(--accent); }
.panel-actions { display: flex; align-items: center; justify-content: space-between; }
.panel button { background: var(--accent); color: oklch(20% 0.02 265); border: 0; font-weight: 600;
	border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; }
.panel button:hover { filter: brightness(1.08); }
.panel .shown { color: var(--muted); font-size: 12px; }
.panel .oneline { justify-content: space-between; }
.panel select { background: var(--bg); color: var(--text); border: 1px solid var(--line);
	border-radius: 6px; padding: 3px 6px; font: inherit; }
.legend { position: absolute; left: 16px; bottom: 14px; display: flex; gap: 16px; align-items: center;
	color: var(--muted); font-size: 12px; background: oklch(16% 0.02 265 / .6); padding: 6px 10px;
	border: 1px solid var(--line); border-radius: 10px; backdrop-filter: blur(6px); }
.legend .hint { opacity: .7; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.swatch.lead { background: var(--lead); } .swatch.org { background: var(--org); } .swatch.event { background: var(--event); }
.tooltip { position: absolute; pointer-events: none; background: var(--panel); border: 1px solid var(--line);
	padding: 8px 10px; border-radius: 8px; font-size: 12px; max-width: 260px; box-shadow: 0 8px 24px #0008; z-index: 5; }
.tooltip b { color: var(--text); } .tooltip .t { color: var(--muted); }
.table-pane { border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; background: var(--panel); }
.controls { display: flex; gap: 8px; padding: 12px; border-bottom: 1px solid var(--line); }
.controls input, .controls select { background: var(--bg); color: var(--text); border: 1px solid var(--line);
	border-radius: 8px; padding: 8px 10px; font: inherit; }
.controls input { flex: 1; }
.controls input:focus, .controls select:focus { outline: 2px solid var(--accent); outline-offset: 0; }
.table-wrap { overflow: auto; min-height: 0; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-weight: 600;
	font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
tbody tr { cursor: pointer; transition: background .12s; }
tbody tr:hover { background: oklch(28% 0.04 265); }
tbody tr.active { background: oklch(32% 0.08 250); }
.fit { font-variant-numeric: tabular-nums; font-weight: 700; }
.bar { display: inline-block; height: 6px; border-radius: 3px; background: var(--accent); vertical-align: middle; margin-left: 6px; }
.pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.name { font-weight: 600; } .sub { color: var(--muted); font-size: 12px; }
`;

const SCRIPT = `
const DATA = __DATA__;
const canvas = document.getElementById("graph");
const ctx = canvas.getContext("2d");
const tooltip = document.getElementById("tooltip");
const COLORS = { lead: css("--lead"), org: css("--org"), event: css("--event") };
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#7aa2ff"; }
function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

document.getElementById("stats").innerHTML =
	"<b>"+DATA.leads.length+"</b> people · <b>"+DATA.nodes.filter(n=>n.type==="org").length+
	"</b> orgs · <b>"+DATA.nodes.filter(n=>n.type==="event").length+"</b> events · <b>"+DATA.edges.length+"</b> links";

// --- model ---
const ALL = DATA.nodes.map((n,i)=>({ ...n, fit: n.pitchFit==null?0:n.pitchFit,
	x: Math.cos(i*2.399)*Math.sqrt(i)*22, y: Math.sin(i*2.399)*Math.sqrt(i)*22, vx:0, vy:0 }));
const byId = new Map(ALL.map(n=>[n.id,n]));
const degree = new Map();
for (const e of DATA.edges){ if(byId.has(e.source)&&byId.has(e.target)){
	degree.set(e.source,(degree.get(e.source)||0)+1); degree.set(e.target,(degree.get(e.target)||0)+1);} }
const adj = new Map(ALL.map(n=>[n.id,new Set()]));
for (const e of DATA.edges){ if(byId.has(e.source)&&byId.has(e.target)){ adj.get(e.source).add(e.target); adj.get(e.target).add(e.source);} }

const SEEDS = 30;
const filters = { lead:true, org:true, event:false, minFit:0, hideIso:true, scope:"ego" };
let nodes = [], edges = [], topLabels = new Set();
let expanded = new Set();           // nodes the user clicked to reveal in ego mode
let view = { x:0, y:0, k:1, set:false };
let alpha = 1, focusId = null, fitted = false;
let pathMode = false, pathA = null, pathNodeSet = new Set(), pathEdgeSet = new Set();
const ekey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

// Shortest path over the FULL graph (works even for nodes not currently drawn).
function bfsPath(srcId, dstId){
	if (srcId === dstId) return [srcId];
	const prev = new Map(), seen = new Set([srcId]), q = [srcId];
	while (q.length){ const cur = q.shift();
		for (const nb of (adj.get(cur)||[])){ if(seen.has(nb)) continue; seen.add(nb); prev.set(nb, cur); if(nb===dstId){ q.length=0; break;} q.push(nb); } }
	if (!prev.has(dstId)) return null;
	const chain=[]; let at=dstId; while(at!==srcId){ chain.push(at); at=prev.get(at);} chain.push(srcId); return chain.reverse();
}
function setPath(chain){
	pathNodeSet = new Set(chain); pathEdgeSet = new Set();
	for (let i=0;i<chain.length-1;i++) pathEdgeSet.add(ekey(chain[i], chain[i+1]));
	// reveal path nodes if a scope/filter is hiding them
	let needRebuild = false;
	for (const id of chain){ if(!byId.has(id)) continue; if(!nodes.includes(byId.get(id))){ expanded.add(id); needRebuild=true; } }
	if (needRebuild) rebuild();
}
function clearPath(){ pathMode=false; pathA=null; pathNodeSet=new Set(); pathEdgeSet=new Set();
	document.getElementById("pathmsg").textContent=""; document.getElementById("pathbtn").textContent="Trace path"; }

function rebuild(){
	let pool = ALL.filter(n => filters[n.type] && (n.type!=="lead" || n.fit>=filters.minFit));
	let vis = new Set(pool.map(n=>n.id));

	// Ego scope: seed with the top leads by fit, then include their neighbours and
	// anything the user has expanded (1 hop). Keeps big graphs readable.
	if (filters.scope === "ego"){
		const seeds = pool.filter(n=>n.type==="lead").sort((a,b)=>b.fit-a.fit).slice(0,SEEDS).map(n=>n.id);
		const keep = new Set([...seeds, ...expanded]);
		for (const id of [...keep]) for (const nb of (adj.get(id)||[])) keep.add(nb);
		pool = pool.filter(n => keep.has(n.id));
		vis = new Set(pool.map(n=>n.id));
	}

	// visible degree among the current pool
	const vdeg = new Map();
	for (const e of DATA.edges){ if(vis.has(e.source)&&vis.has(e.target)){
		vdeg.set(e.source,(vdeg.get(e.source)||0)+1); vdeg.set(e.target,(vdeg.get(e.target)||0)+1); } }
	// drop orphan orgs/events (their only links were to hidden node types); always keep people
	if (filters.hideIso) pool = pool.filter(n => n.type==="lead" || (vdeg.get(n.id)||0) > 0);
	nodes = pool; vis = new Set(nodes.map(n=>n.id));
	edges = DATA.edges.filter(e=>vis.has(e.source)&&vis.has(e.target));
	const people = nodes.filter(n=>n.type==="lead").sort((a,b)=>b.fit-a.fit);
	topLabels = new Set(people.slice(0,18).map(n=>n.id));
	const scopeNote = filters.scope==="ego" ? " · click a node to expand" : "";
	document.getElementById("shown").textContent = nodes.length+" nodes · "+edges.length+" links"+scopeNote;
	alpha = Math.max(alpha, 0.85); fitted = false;
}

function radius(n){
	if (n.type==="lead") return 3.5 + (n.fit||0)*9 + Math.min(4, Math.sqrt(degree.get(n.id)||0));
	if (n.type==="org") return 3 + Math.min(7, Math.sqrt(degree.get(n.id)||0)*1.4);
	return 2.4 + Math.min(4, Math.sqrt(degree.get(n.id)||0));
}

function resize(){ const r=canvas.getBoundingClientRect();
	canvas.width=r.width*devicePixelRatio; canvas.height=r.height*devicePixelRatio;
	if(!view.set){ view.x=canvas.width/(2*devicePixelRatio); view.y=canvas.height/(2*devicePixelRatio); view.set=true; } }
window.addEventListener("resize", resize); resize();

// --- physics: spring + spatial-grid repulsion + gravity, with cooling ---
const REP_R = 64, REP = 520, SPRING = 0.03, LEN = 46, GRAVITY = 0.0016;
// unlinked nodes get extra pull to center so they stay a tidy halo, not a sprawl
function gravityFor(n){ return (degree.get(n.id)||0) === 0 ? GRAVITY*6 : GRAVITY; }
function step(){
	if (alpha < 0.03) return;
	const grid = new Map(); const cs = REP_R;
	const key = (x,y)=> ((x/cs)|0)+","+((y/cs)|0);
	for (const n of nodes){ const k=key(n.x,n.y); (grid.get(k)||grid.set(k,[]).get(k)).push(n); }
	for (const n of nodes){
		const cx=(n.x/cs)|0, cy=(n.y/cs)|0;
		for (let gx=cx-1; gx<=cx+1; gx++) for (let gy=cy-1; gy<=cy+1; gy++){
			const cell=grid.get(gx+","+gy); if(!cell) continue;
			for (const m of cell){ if(m===n) continue;
				let dx=n.x-m.x, dy=n.y-m.y; let d2=dx*dx+dy*dy; if(d2>REP_R*REP_R||d2===0) continue;
				const d=Math.sqrt(d2)||1; const f=REP/d2; n.vx+=f*dx/d*alpha; n.vy+=f*dy/d*alpha; }
		}
		const g = gravityFor(n); n.vx -= n.x*g*alpha; n.vy -= n.y*g*alpha;
	}
	for (const e of edges){ const a=byId.get(e.source), b=byId.get(e.target);
		let dx=b.x-a.x, dy=b.y-a.y; const d=Math.sqrt(dx*dx+dy*dy)||1; const f=SPRING*(d-LEN)*alpha;
		a.vx+=f*dx/d; a.vy+=f*dy/d; b.vx-=f*dx/d; b.vy-=f*dy/d; }
	for (const n of nodes){ if(n.fixed) continue; n.vx*=0.84; n.vy*=0.84;
		n.x+=Math.max(-20,Math.min(20,n.vx)); n.y+=Math.max(-20,Math.min(20,n.vy)); }
	alpha *= 0.985;
}

function draw(){
	ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
	ctx.clearRect(0,0,canvas.width,canvas.height);
	ctx.save(); ctx.translate(view.x,view.y); ctx.scale(view.k,view.k);
	const near = focusId ? adj.get(focusId) : null;
	const hasPath = pathNodeSet.size > 0;
	const GOLD = "rgb(245,200,90)";

	for (const e of edges){ const a=byId.get(e.source), b=byId.get(e.target);
		const onPath = hasPath && pathEdgeSet.has(ekey(e.source, e.target));
		const hot = !hasPath && focusId && (e.source===focusId||e.target===focusId);
		if (onPath){ ctx.strokeStyle="rgba(245,200,90,0.95)"; ctx.lineWidth=2.6/view.k; }
		else if (hot){ ctx.strokeStyle="rgba(120,162,255,0.7)"; ctx.lineWidth=1.4/view.k; }
		else if (focusId || hasPath){ continue; }
		else { ctx.strokeStyle="rgba(150,162,200,0.16)"; ctx.lineWidth=0.5/view.k; }
		ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); }

	// draw orgs + events first, people last so leads stay on top
	const order = { event:0, org:1, lead:2 };
	for (const n of [...nodes].sort((a,b)=>order[a.type]-order[b.type])){
		const onPath = hasPath && pathNodeSet.has(n.id);
		const dim = (focusId && n.id!==focusId && !(near&&near.has(n.id))) || (hasPath && !onPath);
		ctx.globalAlpha = dim?0.08:1; ctx.fillStyle = COLORS[n.type]||"#999";
		ctx.beginPath(); ctx.arc(n.x,n.y,radius(n),0,6.2832); ctx.fill();
		if (onPath){ ctx.lineWidth=2.5/view.k; ctx.strokeStyle=GOLD; ctx.stroke(); }
		else if (n.type==="lead" && !dim){ ctx.lineWidth=1/view.k; ctx.strokeStyle="rgba(10,12,18,0.7)"; ctx.stroke(); }
		if (n.id===focusId && !hasPath){ ctx.lineWidth=2/view.k; ctx.strokeStyle="#fff"; ctx.stroke(); }
	}
	ctx.globalAlpha=1;

	// labels: path nodes, top leads, focused node + neighbors, or when zoomed in
	const show = (n)=> (hasPath ? pathNodeSet.has(n.id)
		: n.id===focusId || (near&&near.has(n.id)) || topLabels.has(n.id) || (view.k>1.8 && n.type!=="event") || (view.k>2.6));
	ctx.font = (11/view.k)+"px ui-sans-serif, system-ui"; ctx.textBaseline="middle";
	for (const n of nodes){ if(!show(n)) continue;
		const x=n.x+radius(n)+3/view.k, y=n.y;
		ctx.lineWidth=3/view.k; ctx.strokeStyle="rgba(12,14,20,0.85)"; ctx.strokeText(n.label, x, y);
		ctx.fillStyle = (hasPath&&pathNodeSet.has(n.id)) ? "#ffe9a8" : n.type==="lead" ? "#eef2fb" : "#aab2c5";
		ctx.fillText(n.label, x, y); }
	ctx.restore();
}

function loop(){ step(); step(); draw(); requestAnimationFrame(loop); } rebuild(); loop();

// fit view to the meaningful core (linked + top-labelled), ignoring the
// scatter of unlinked people so the useful part fills the screen.
function fitView(){ if(!nodes.length) return;
	const vdeg = new Map();
	for (const e of edges){ vdeg.set(e.source,(vdeg.get(e.source)||0)+1); vdeg.set(e.target,(vdeg.get(e.target)||0)+1); }
	let core = nodes.filter(n => (vdeg.get(n.id)||0) > 0 || topLabels.has(n.id));
	if (core.length < 5) core = nodes;
	let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9;
	for(const n of core){ minx=Math.min(minx,n.x); miny=Math.min(miny,n.y); maxx=Math.max(maxx,n.x); maxy=Math.max(maxy,n.y); }
	const w=canvas.width/devicePixelRatio, h=canvas.height/devicePixelRatio;
	const k=Math.min(w/(maxx-minx+120), h/(maxy-miny+120), 2.2);
	view.k=Math.max(0.15,k); view.x=w/2-((minx+maxx)/2)*view.k; view.y=h/2-((miny+maxy)/2)*view.k; }
setInterval(()=>{ if(!fitted && alpha<0.25){ fitView(); fitted=true; } }, 250);
document.getElementById("fitbtn").onclick = fitView;

const pathBtn = document.getElementById("pathbtn");
const pathMsg = document.getElementById("pathmsg");
pathBtn.onclick = ()=>{ if (pathMode || pathNodeSet.size){ clearPath(); }
	else { pathMode=true; pathA=null; pathBtn.textContent="Cancel path"; pathMsg.textContent="click the first node…"; } };
function handlePathClick(n){
	if (!pathA){ pathA=n.id; focusId=n.id; pathMsg.textContent="now click the target…"; return; }
	const chain = bfsPath(pathA, n.id);
	pathMode=false; pathBtn.textContent="Clear path";
	if (!chain){ pathMsg.textContent="no connection between those two."; pathNodeSet=new Set(); return; }
	setPath(chain); focusId=null;
	pathMsg.textContent = (chain.length-1)+" hop"+(chain.length-1===1?"":"s")+" — "+(byId.get(chain[0])?.label||"")+" → "+(byId.get(chain[chain.length-1])?.label||"");
}

// --- interaction ---
function toWorld(px,py){ return { x:(px-view.x)/view.k, y:(py-view.y)/view.k }; }
function hit(px,py){ const w=toWorld(px,py); let best=null,bd=1e9;
	for(const n of nodes){ const dx=n.x-w.x,dy=n.y-w.y,d=dx*dx+dy*dy,r=radius(n)+5/view.k; if(d<r*r&&d<bd){bd=d;best=n;} } return best; }
let drag=null, dragNode=null, moved=false;
canvas.addEventListener("mousedown", e=>{ const n=hit(e.offsetX,e.offsetY); moved=false;
	if(n){ dragNode=n; n.fixed=true; alpha=Math.max(alpha,0.3); } else drag={x:e.offsetX-view.x,y:e.offsetY-view.y}; });
window.addEventListener("mouseup", ()=>{ if(dragNode)dragNode.fixed=false; dragNode=null; drag=null; });
canvas.addEventListener("mousemove", e=>{ moved=true;
	if(dragNode){ const w=toWorld(e.offsetX,e.offsetY); dragNode.x=w.x; dragNode.y=w.y; dragNode.vx=dragNode.vy=0; }
	else if(drag){ view.x=e.offsetX-drag.x; view.y=e.offsetY-drag.y; }
	const n=(!drag&&!dragNode)?hit(e.offsetX,e.offsetY):null;
	if(n){ tooltip.hidden=false; tooltip.style.left=(e.offsetX+14)+"px"; tooltip.style.top=(e.offsetY+14)+"px";
		tooltip.innerHTML="<b>"+esc(n.label)+"</b>"+(n.sub?"<br><span class='t'>"+esc(n.sub)+"</span>":"")+
			(n.type==="lead"&&n.pitchFit!=null?"<br><span class='t'>fit "+n.pitchFit.toFixed(2)+"</span>":"")+
			"<br><span class='t'>"+n.type+" · "+(degree.get(n.id)||0)+" links</span>"; }
	else tooltip.hidden=true; });
canvas.addEventListener("click", e=>{ if(moved) return; const n=hit(e.offsetX,e.offsetY);
	if(pathMode){ if(n) handlePathClick(n); return; }
	focusId=n?n.id:null;
	if(n && filters.scope==="ego" && !expanded.has(n.id)){ expanded.add(n.id); rebuild(); }
	syncActive(); });
canvas.addEventListener("wheel", e=>{ e.preventDefault(); const s=Math.exp(-e.deltaY*0.0012);
	const wx=(e.offsetX-view.x)/view.k, wy=(e.offsetY-view.y)/view.k; view.k=Math.max(0.12,Math.min(6,view.k*s));
	view.x=e.offsetX-wx*view.k; view.y=e.offsetY-wy*view.k; }, {passive:false});

// --- filters ---
function bindFilter(id, key){ const el=document.getElementById(id);
	el.onchange=()=>{ filters[key]=el.checked; rebuild(); fitted=false; }; }
bindFilter("f-people","lead"); bindFilter("f-orgs","org"); bindFilter("f-events","event");
bindFilter("f-iso","hideIso");
const scopeSel=document.getElementById("f-scope");
scopeSel.onchange=()=>{ filters.scope=scopeSel.value; expanded=new Set(); rebuild(); };
const fitSlider=document.getElementById("f-fit");
fitSlider.oninput=()=>{ filters.minFit=parseFloat(fitSlider.value); document.getElementById("fitval").textContent=filters.minFit.toFixed(2); rebuild(); };

// --- table ---
const tbody=document.querySelector("#leads tbody");
const search=document.getElementById("search"), stageSel=document.getElementById("stage");
function renderTable(){ const q=search.value.trim().toLowerCase(), st=stageSel.value; tbody.innerHTML="";
	for(const l of DATA.leads){ if(st&&l.stage!==st) continue;
		if(q&&!((l.name+" "+(l.title||"")+" "+(l.email||"")).toLowerCase().includes(q))) continue;
		const fit=l.pitchFit==null?"—":l.pitchFit.toFixed(2);
		const bar=l.pitchFit==null?"":"<i class='bar' style='width:"+Math.round(l.pitchFit*36)+"px'></i>";
		const tr=document.createElement("tr"); tr.dataset.id=l.id;
		tr.innerHTML="<td class='fit'>"+fit+bar+"</td><td><div class='name'>"+esc(l.name)+"</div>"+
			(l.email?"<div class='sub'>"+esc(l.email)+"</div>":"")+"</td><td class='sub'>"+esc(l.title||"")+
			"</td><td><span class='pill'>"+esc(l.stage)+"</span></td>";
		tr.onclick=()=>{ focusId=l.id; const n=byId.get(l.id); if(!n) return;
			// reveal the lead if filters/scope are hiding it
			if(!nodes.includes(n)){ filters.lead=true; filters.minFit=0; fitSlider.value="0";
				document.getElementById("fitval").textContent="0.00"; document.getElementById("f-people").checked=true;
				expanded.add(l.id); rebuild(); }
			else if(filters.scope==="ego" && !expanded.has(l.id)){ expanded.add(l.id); rebuild(); }
			view.k=2; const w=canvas.width/devicePixelRatio,h=canvas.height/devicePixelRatio;
			view.x=w/2-n.x*view.k; view.y=h/2-n.y*view.k; alpha=Math.max(alpha,0.2);
			syncActive(); };
		tbody.appendChild(tr); } }
function syncActive(){ for(const tr of tbody.children) tr.classList.toggle("active", tr.dataset.id===focusId); }
search.oninput=renderTable; stageSel.onchange=renderTable; renderTable();
`;
