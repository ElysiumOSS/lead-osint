/**
 * Live web dashboard (served by `src/server.ts`).
 *
 * Loads from the JSON API and writes changes back — stage moves, notes, and
 * reminders persist to SQLite instantly. Two views: a force-directed graph and a
 * drag-to-restage kanban board; a detail drawer per lead with CRM controls +
 * inline AI outreach drafting.
 *
 * Performance: the graph uses Barnes-Hut O(n log n) repulsion (mirrors
 * `core/quadtree.ts`), an idle render loop (no repaint when nothing moves), a
 * capped device-pixel-ratio, a precomputed draw order, and viewport-culled
 * labels. Search cancels in-flight requests.
 */

/** Render the dashboard HTML document (no embedded data — it fetches `/api/data`). */
export function renderDashboard(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>lead-osint · live CRM</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topbar">
	<div class="brand"><span class="dot"></span> lead-osint <span class="muted">live CRM</span></div>
	<div class="stats" id="stats"></div>
	<div class="seg" id="seg"><button data-view="graph" class="on">Graph</button><button data-view="clusters">Clusters</button><button data-view="vcs">VCs</button><button data-view="investors">Investors</button><button data-view="board">Board</button></div>
	<button id="duebtn" class="duebtn" type="button">Due <span id="duecount">0</span></button>
</header>
<main class="layout" id="graphview">
	<section class="graph-pane">
		<canvas id="graph"></canvas>
		<div class="gctl"><label><input type="checkbox" id="f-unlinked" /> show unlinked</label>
			<label><input type="checkbox" id="f-sim" /> <span id="simlbl">similar people</span></label></div>
		<div class="legend"><span><i class="sw lead"></i> person</span> <span><i class="sw org"></i> org</span> <span><i class="sw event"></i> event</span>
			<span id="rellegend"></span>
			<span class="hint">drag · scroll to zoom · click a node</span></div>
		<div class="tooltip" id="tip" hidden></div>
	</section>
	<aside class="side">
		<div class="controls"><input id="search" type="search" placeholder="Search (semantic + keyword)…" />
			<select id="stage"><option value="">all stages</option><option>new</option><option>contacted</option>
			<option>replied</option><option>meeting</option><option>passed</option></select>
			<select id="rel"><option value="">any relationship</option><option>investor</option><option>customer</option>
			<option>partner</option><option>connector</option><option>advisor</option><option>expert</option><option>hire</option><option>peer</option><option>other</option></select>
			<button id="exportBtn" class="ctlbtn" type="button" title="Download the current view as CSV">⬇ Export</button></div>
		<div class="rows" id="rows"></div>
	</aside>
</main>
<section class="board" id="board" hidden></section>
<section class="clusters" id="clusters" hidden></section>
<section class="clusters" id="vcs" hidden></section>
<section class="clusters" id="investors" hidden></section>
<div class="drawer" id="drawer" hidden></div>
<div class="duepanel" id="duepanel" hidden></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
:root{--bg:oklch(16% .02 265);--panel:oklch(21% .03 265);--line:oklch(30% .03 265);--text:oklch(96% .01 265);
--muted:oklch(70% .02 265);--lead:oklch(72% .17 250);--org:oklch(80% .15 150);--event:oklch(82% .15 80);--accent:oklch(72% .17 250);}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.topbar{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;display:flex;align-items:center;gap:8px}.brand .dot{width:10px;height:10px;border-radius:50%;
background:var(--accent);box-shadow:0 0 12px var(--accent)}.muted{color:var(--muted);font-weight:400}
.stats{color:var(--muted);font-variant-numeric:tabular-nums;flex:1}.stats b{color:var(--text)}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{background:transparent;color:var(--muted);border:0;padding:6px 14px;cursor:pointer;font:inherit}
.seg button.on{background:var(--accent);color:#10141e;font-weight:600}
.duebtn{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:6px 14px;cursor:pointer}
.duebtn span{background:var(--accent);color:#10141e;border-radius:999px;padding:0 7px;margin-left:4px;font-weight:700}
.layout{display:grid;grid-template-columns:1fr 400px;height:calc(100% - 53px)}
.graph-pane{position:relative;overflow:hidden;min-width:0}#graph{width:100%;height:100%;display:block;cursor:grab}
.legend{position:absolute;left:14px;bottom:12px;display:flex;gap:14px;color:var(--muted);font-size:12px;
background:oklch(16% .02 265/.6);padding:6px 10px;border:1px solid var(--line);border-radius:10px}
.sw{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.sw.lead{background:var(--lead)}.sw.org{background:var(--org)}.sw.event{background:var(--event)}
.gctl{position:absolute;left:14px;top:12px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;color:var(--muted);font-size:12px;
background:oklch(16% .02 265/.65);padding:6px 9px;border:1px solid var(--line);border-radius:8px}
.gctl label{display:flex;align-items:center;gap:6px;cursor:pointer}.gctl input{accent-color:var(--accent)}
.legend #rellegend i{margin-left:8px}
.tooltip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--line);padding:6px 9px;
border-radius:8px;font-size:12px;max-width:240px;box-shadow:0 8px 24px #0008}
.side{border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--panel)}
.controls{display:flex;flex-wrap:wrap;gap:8px;padding:12px;border-bottom:1px solid var(--line)}
.controls input,.controls select{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
.controls input{flex:1 1 100%;min-width:0}.controls select{flex:1 1 calc(50% - 4px);min-width:0}
.ctlbtn{flex:1 1 100%;background:var(--accent);color:#10141e;border:0;border-radius:8px;padding:8px 10px;font:inherit;font-weight:600;cursor:pointer}
.ctlbtn:hover{filter:brightness(1.08)}
.rows{overflow:auto;min-height:0;flex:1}
.empty{padding:18px 14px;color:var(--muted);font-size:13px}
.row{display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.row:hover{background:oklch(28% .04 265)}.row .fit{font-variant-numeric:tabular-nums;font-weight:700;width:36px;color:var(--accent)}
.row .mid{flex:1;min-width:0}.row .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .tl{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .rl{font-size:10px;padding:2px 7px;border-radius:999px;font-weight:700;text-transform:capitalize;color:#10141e}
.row .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.board{display:none;grid-auto-flow:column;grid-auto-columns:minmax(240px,1fr);gap:12px;height:calc(100% - 53px);
overflow-x:auto;padding:14px}.board.on{display:grid}
.clusters{display:none;height:calc(100% - 53px);overflow:auto;padding:16px;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;align-content:start}.clusters.on{display:grid}
.cl{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;border-top:3px solid var(--accent)}
.cl h3{margin:0 0 2px;font-size:15px;text-transform:capitalize}.cl .meta{color:var(--muted);font-size:12px;margin-bottom:8px}
.cl .mem{display:flex;gap:8px;align-items:center;padding:4px 0;cursor:pointer;font-size:13px}.cl .mem:hover{color:var(--accent)}
.cl .mem .f{font-variant-numeric:tabular-nums;color:var(--accent);width:32px;font-weight:700}.cl .mem .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl .relbar{display:flex;height:6px;border-radius:3px;overflow:hidden;margin-bottom:8px}
.col{background:var(--panel);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:0}
.col h3{margin:0;padding:12px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--panel)}.col h3 span{color:var(--text)}
.col .cards{overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px;min-height:40px}
.col.drop{outline:2px dashed var(--accent);outline-offset:-4px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:9px 11px;cursor:grab}
.card:hover{border-color:var(--accent)}.card .nm{font-weight:600}.card .tl{color:var(--muted);font-size:12px}
.card .fit{float:right;color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}
.drawer,.duepanel{position:fixed;top:0;right:0;height:100%;width:430px;background:var(--panel);border-left:1px solid var(--line);
box-shadow:-12px 0 40px #0006;overflow:auto;padding:20px;z-index:10}
.drawer h2{margin:0 0 2px}.drawer .sub{color:var(--muted);margin-bottom:14px}
.drawer label{display:block;font-size:12px;color:var(--muted);margin:14px 0 4px;text-transform:uppercase;letter-spacing:.05em}
.drawer select,.drawer textarea,.drawer input{width:100%;background:var(--bg);color:var(--text);border:1px solid var(--line);
border-radius:8px;padding:8px 10px;font:inherit}.drawer textarea{min-height:64px;resize:vertical}
.drawer .field{margin-bottom:6px}.drawer a{color:var(--accent)}
.assess{margin:10px 0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.assess b{text-transform:capitalize;color:var(--accent)}.assess div{margin-top:4px;color:var(--muted);font-size:13px}
.btn{background:var(--accent);color:#10141e;border:0;border-radius:8px;padding:8px 12px;font-weight:600;cursor:pointer;margin-top:8px}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.close{position:absolute;top:14px;right:16px;cursor:pointer;color:var(--muted);font-size:20px;background:none;border:0}
.log{margin-top:6px;font-size:12px;color:var(--muted)}.log div{padding:4px 0;border-bottom:1px solid var(--line)}
.rem{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;padding:5px 0}
.rem.overdue{color:#ffb4a8}.row.flash{animation:flash 1s}
.draftbox{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:8px;white-space:pre-wrap;font-size:13px}
@keyframes flash{from{background:oklch(40% .1 250)}to{background:transparent}}
`;

const SCRIPT = `
const $=id=>document.getElementById(id);
const COLORS={lead:css("--lead"),org:css("--org"),event:css("--event")};
const REL_COLORS={investor:"#e9c46a",customer:"#5ec6a8",partner:"#9b8cff",connector:"#f72585",advisor:"#f4a261",expert:"#e879b9",hire:"#4cc9f0",peer:"#90be6d",other:"#8a93a6"};
let fStage="",fRel="";
function filterActive(){return !!(fStage||fRel);}
function leadMatches(n){const l=leadsById.get(n.id);if(!l)return false;
	if(fStage&&l.stage!==fStage)return false;
	if(fRel&&l.relationship!==fRel)return false;return true;}
const DPR=Math.min(window.devicePixelRatio||1,2);
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()||"#7aa2ff";}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function api(url,opts){const r=await fetch(url,opts);return r.json();}
async function post(url,bodyObj){return api(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(bodyObj||{})});}

let DATA={nodes:[],edges:[],leads:[]}, leadsById=new Map();
let nodes=[],edges=[],byId=new Map(),adj=new Map(),degree=new Map(),topL=new Set(),drawOrder=[];
let view={x:0,y:0,k:1,set:false},alpha=1,focus=null,fitted=false;
let dirty=true,running=false,interacting=false,boardOn=false,graphActive=true;
const canvas=$("graph"),ctx=canvas.getContext("2d"),tip=$("tip");

function renderStats(s){$("stats").innerHTML="<b>"+s.people+"</b> people · <b>"+(s.assessed||0)+"</b> assessed · <b>"+s.orgs+"</b> orgs · <b>"+s.links+"</b> links";}
async function load(){
	DATA=await api("/api/data");
	leadsById=new Map(DATA.leads.map(l=>[l.id,l]));
	renderStats({people:DATA.leads.length,assessed:DATA.leads.filter(l=>l.relevance!=null).length,orgs:DATA.nodes.filter(n=>n.type==="org").length,links:DATA.edges.length});
	$("duecount").textContent=DATA.due||0;
	buildGraph(); renderRows();
	// VC-matcher case: a store with investors but no people would open on an empty
	// graph (people-only). Jump straight to the Investors tab so it's not blank.
	if(!DATA.leads.length){const b=document.querySelector('[data-view="investors"]');if(b)b.click();}
}
// Poll lightweight counts so the "assessed" tally climbs live during a background
// assess run (the full graph isn't refetched — just the stats bar + due badge).
async function refreshStats(){try{const s=await api("/api/stats");renderStats(s);$("duecount").textContent=s.due||0;}catch{}}
setInterval(refreshStats,8000);

let showUnlinked=false,showSim=false,simEdges=[],simLoaded=false;
function buildGraph(){
	const nodeById=new Map(DATA.nodes.map(n=>[n.id,n]));
	const sim=showSim?simEdges:[];
	// How many DISTINCT people each org/event connects — a real connector links ≥2.
	const peoplePerHub=new Map();
	const add=(h,p)=>{(peoplePerHub.get(h)||peoplePerHub.set(h,new Set()).get(h)).add(p);};
	for(const e of DATA.edges){const a=nodeById.get(e.source),b=nodeById.get(e.target);if(!a||!b)continue;
		if(a.type==="lead"&&a.type!==b.type)add(b.id,a.id);
		if(b.type==="lead"&&a.type!==b.type)add(a.id,b.id);}
	const connectors=new Set([...peoplePerHub].filter(([,set])=>set.size>=2).map(([h])=>h));
	const leadLinked=new Set();for(const h of connectors)for(const p of peoplePerHub.get(h))leadLinked.add(p);
	// Similarity edges link people directly (no hub), so both endpoints count as linked.
	for(const e of sim){if(nodeById.has(e.source)&&nodeById.has(e.target)){leadLinked.add(e.source);leadLinked.add(e.target);}}

	// Default view = the connected network: people who share a hub + those hubs.
	// "show unlinked" additionally keeps everyone (even isolated leads).
	const keepId=new Set();
	for(const n of DATA.nodes){
		if(n.type==="lead"){ if(showUnlinked||leadLinked.has(n.id))keepId.add(n.id); }
		else if(connectors.has(n.id))keepId.add(n.id);
	}
	const keep=DATA.nodes.filter(n=>keepId.has(n.id));
	const vis=keepId;
	nodes=keep.map((n,i)=>({...n,fit:n.pitchFit||0,x:Math.cos(i*2.4)*Math.sqrt(i)*22,y:Math.sin(i*2.4)*Math.sqrt(i)*22,vx:0,vy:0}));
	byId=new Map(nodes.map(n=>[n.id,n]));
	const simRendered=sim.map(e=>({source:e.source,target:e.target,rel:"similar"}));
	edges=DATA.edges.concat(simRendered).filter(e=>vis.has(e.source)&&vis.has(e.target));
	degree=new Map();adj=new Map(nodes.map(n=>[n.id,[]]));
	for(const e of edges){degree.set(e.source,(degree.get(e.source)||0)+1);degree.set(e.target,(degree.get(e.target)||0)+1);
		adj.get(e.source)?.push(e.target);adj.get(e.target)?.push(e.source);}
	topL=new Set(nodes.filter(n=>n.type==="lead").sort((a,b)=>b.fit-a.fit).slice(0,15).map(n=>n.id));
	drawOrder=[...nodes].sort((a,b)=>(a.type==="lead"?1:0)-(b.type==="lead"?1:0)); // orgs first, leads on top
	alpha=1;fitted=false;render();
}
function radius(n){return n.type==="lead"?3.5+(n.fit||0)*9+Math.min(4,Math.sqrt(degree.get(n.id)||0)):3+Math.min(7,Math.sqrt(degree.get(n.id)||0)*1.4);}
function resize(){const r=canvas.getBoundingClientRect();canvas.width=r.width*DPR;canvas.height=r.height*DPR;
	if(!view.set){view.x=canvas.width/(2*DPR);view.y=canvas.height/(2*DPR);view.set=true;}render();}
addEventListener("resize",resize);resize();

// --- Barnes-Hut O(n log n) repulsion (mirrors core/quadtree.ts) ---
function bhRepel(){
	const N=nodes.length;if(N<2)return;
	let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
	for(const n of nodes){if(n.x<minX)minX=n.x;if(n.y<minY)minY=n.y;if(n.x>maxX)maxX=n.x;if(n.y>maxY)maxY=n.y;}
	const size=Math.max(maxX-minX,maxY-minY,1)*1.01;
	const root={x:minX,y:minY,s:size,m:0,cx:0,cy:0,b:null,c:null};
	const place=(cell,b,d)=>{const mx=cell.x+cell.s/2,my=cell.y+cell.s/2,q=(b.x>=mx?1:0)+(b.y>=my?2:0);
		if(!cell.c[q]){const h=cell.s/2;cell.c[q]={x:cell.x+(q&1?h:0),y:cell.y+(q&2?h:0),s:h,m:0,cx:0,cy:0,b:null,c:null};}
		ins(cell.c[q],b,d+1);};
	const ins=(cell,b,d)=>{const m=cell.m+1;cell.cx=(cell.cx*cell.m+b.x)/m;cell.cy=(cell.cy*cell.m+b.y)/m;cell.m=m;
		if(cell.m===1){cell.b=b;return;}
		if(!cell.c){cell.c=[null,null,null,null];if(cell.b&&d<48){const e=cell.b;cell.b=null;place(cell,e,d);}}
		if(d>=48)return;place(cell,b,d);};
	for(const n of nodes)ins(root,n,0);
	const REP=520,theta2=0.49,eps=.5;
	for(const n of nodes){const stack=[root];
		while(stack.length){const cell=stack.pop();if(cell.m===0)continue;
			const dx=n.x-cell.cx,dy=n.y-cell.cy,d2=dx*dx+dy*dy+eps;
			if(cell.b&&cell.b!==n){const d=Math.sqrt(d2),f=REP/d2;n.vx+=f*dx/d*alpha;n.vy+=f*dy/d*alpha;continue;}
			if(cell.b)continue;
			if((cell.s*cell.s)/d2<theta2){const d=Math.sqrt(d2),f=REP*cell.m/d2;n.vx+=f*dx/d*alpha;n.vy+=f*dy/d*alpha;}
			else if(cell.c){for(const c of cell.c)if(c)stack.push(c);}}}
}
function step(){if(alpha<.02)return;
	bhRepel();
	for(const n of nodes){const g=(degree.get(n.id)||0)===0?.0096:.0016;n.vx-=n.x*g*alpha;n.vy-=n.y*g*alpha;}
	for(const e of edges){const a=byId.get(e.source),b=byId.get(e.target);let dx=b.x-a.x,dy=b.y-a.y;const d=Math.sqrt(dx*dx+dy*dy)||1,f=.03*(d-46)*alpha;
		a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;}
	for(const n of nodes){if(n.fixed)continue;n.vx*=.84;n.vy*=.84;n.x+=Math.max(-20,Math.min(20,n.vx));n.y+=Math.max(-20,Math.min(20,n.vy));}
	alpha*=.985;}

function draw(){const W=canvas.width/DPR,H=canvas.height/DPR;
	ctx.setTransform(DPR,0,0,DPR,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
	ctx.save();ctx.translate(view.x,view.y);ctx.scale(view.k,view.k);const near=focus?new Set(adj.get(focus)||[]):null;
	for(const e of edges){const a=byId.get(e.source),b=byId.get(e.target);const hot=focus&&(e.source===focus||e.target===focus);const isSim=e.rel==="similar";
		if(hot){ctx.strokeStyle=isSim?"rgba(232,121,185,.8)":"rgba(130,170,255,.85)";ctx.lineWidth=1.6/view.k;}
		else if(focus){continue;}
		else if(isSim){ctx.strokeStyle="rgba(180,130,200,.18)";ctx.lineWidth=Math.max(.5,0.6/view.k);}
		else{ctx.strokeStyle="rgba(140,165,220,.32)";ctx.lineWidth=Math.max(.6,0.8/view.k);}
		ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
	const fActive=filterActive();
	for(const n of drawOrder){const isLead=n.type==="lead";
		let dim=focus&&n.id!==focus&&!(near&&near.has(n.id));
		let hl=false;
		if(fActive){if(isLead&&leadMatches(n))hl=true;else dim=true;}
		ctx.globalAlpha=dim?.1:1;
		// When the similarity layer is on, color people by their cluster (themed
		// neighborhoods); otherwise by relationship, else the base node color.
		if(isLead&&showSim&&clusterColorById.has(n.id))ctx.fillStyle=clusterColorById.get(n.id);
		else{const rel=isLead?(leadsById.get(n.id)||{}).relationship:null;ctx.fillStyle=(rel&&REL_COLORS[rel])||COLORS[n.type]||"#999";}
		ctx.beginPath();ctx.arc(n.x,n.y,radius(n)*(hl?1.6:1),0,6.2832);ctx.fill();
		if(n.id===focus){ctx.lineWidth=2/view.k;ctx.strokeStyle="#fff";ctx.stroke();}
		else if(hl){ctx.lineWidth=2/view.k;ctx.strokeStyle="#fff";ctx.stroke();}}
	ctx.globalAlpha=1;ctx.font=(11/view.k)+"px ui-sans-serif,system-ui";ctx.textBaseline="middle";
	for(const n of nodes){const sh=n.id===focus||(near&&near.has(n.id))||topL.has(n.id)||view.k>1.8;if(!sh)continue;
		if(focus&&n.id!==focus&&!(near&&near.has(n.id)))continue;
		const sx=n.x*view.k+view.x,sy=n.y*view.k+view.y;if(sx<-60||sx>W+200||sy<-20||sy>H+20)continue; // cull off-screen labels
		const x=n.x+radius(n)+3/view.k;ctx.lineWidth=3/view.k;ctx.strokeStyle="rgba(12,14,20,.85)";ctx.strokeText(n.label,x,n.y);
		ctx.fillStyle=n.type==="lead"?"#eef2fb":"#aab2c5";ctx.fillText(n.label,x,n.y);}
	ctx.restore();}

// --- idle render loop: only paint while simulating or after an interaction ---
function render(){if(!graphActive)return;dirty=true;if(!running){running=true;requestAnimationFrame(frame);}}
function frame(){const sim=alpha>.02;if(sim){step();dirty=true;}if(dirty){draw();dirty=false;}
	if((sim||interacting)&&graphActive)requestAnimationFrame(frame);else running=false;}
function reheat(){alpha=Math.max(alpha,.35);render();}

function fitView(){if(!nodes.length)return;let a=1e9,b=1e9,c=-1e9,d=-1e9;
	const core=nodes.filter(n=>(degree.get(n.id)||0)>0||topL.has(n.id));const set=core.length>4?core:nodes;
	for(const n of set){a=Math.min(a,n.x);b=Math.min(b,n.y);c=Math.max(c,n.x);d=Math.max(d,n.y);}
	const w=canvas.width/DPR,h=canvas.height/DPR;view.k=Math.max(.15,Math.min(w/(c-a+120),h/(d-b+120),2.2));
	view.x=w/2-((a+c)/2)*view.k;view.y=h/2-((b+d)/2)*view.k;render();}
setInterval(()=>{if(!fitted&&alpha<.25&&nodes.length){fitView();fitted=true;}},250);

function toWorld(px,py){return{x:(px-view.x)/view.k,y:(py-view.y)/view.k};}
function hit(px,py){const w=toWorld(px,py);let best=null,bd=1e9;for(const n of nodes){const dx=n.x-w.x,dy=n.y-w.y,dd=dx*dx+dy*dy,r=radius(n)+5/view.k;if(dd<r*r&&dd<bd){bd=dd;best=n;}}return best;}
let drag=null,dn=null,moved=false;
canvas.addEventListener("mousedown",e=>{const n=hit(e.offsetX,e.offsetY);moved=false;interacting=true;
	if(n){dn=n;n.fixed=true;reheat();}else{drag={x:e.offsetX-view.x,y:e.offsetY-view.y};render();}});
addEventListener("mouseup",()=>{if(dn)dn.fixed=false;dn=null;drag=null;interacting=false;});
canvas.addEventListener("mousemove",e=>{moved=true;if(dn){const w=toWorld(e.offsetX,e.offsetY);dn.x=w.x;dn.y=w.y;dn.vx=dn.vy=0;render();}
	else if(drag){view.x=e.offsetX-drag.x;view.y=e.offsetY-drag.y;render();}
	const n=(!drag&&!dn)?hit(e.offsetX,e.offsetY):null;
	if(n){tip.hidden=false;tip.style.left=(e.offsetX+12)+"px";tip.style.top=(e.offsetY+12)+"px";
		const tl=n.type==="lead"?leadsById.get(n.id):null;
		tip.innerHTML="<b>"+esc(n.label)+"</b>"+(n.sub?"<br>"+esc(n.sub):"")+
			(tl&&tl.relationship?"<br>"+esc(tl.relationship)+(tl.relevance!=null?" · relevance "+tl.relevance.toFixed(2):""):"")+
			(n.type==="lead"&&n.pitchFit!=null?"<br>fit "+n.pitchFit.toFixed(2):"");}else tip.hidden=true;});
canvas.addEventListener("click",e=>{if(moved)return;const n=hit(e.offsetX,e.offsetY);focus=n?n.id:null;render();if(n&&n.type==="lead")openLead(n.id);});
canvas.addEventListener("wheel",e=>{e.preventDefault();const s=Math.exp(-e.deltaY*.0012),wx=(e.offsetX-view.x)/view.k,wy=(e.offsetY-view.y)/view.k;
	view.k=Math.max(.12,Math.min(6,view.k*s));view.x=e.offsetX-wx*view.k;view.y=e.offsetY-wy*view.k;render();},{passive:false});

// --- table (search cancels stale requests) ---
let _t,_ctl;
function debounce(fn,ms){return(...a)=>{clearTimeout(_t);_t=setTimeout(()=>fn(...a),ms);};}
// Virtualized list: render in chunks and append more as you scroll, so the DOM
// holds ~one screenful instead of all N rows (matters at thousands of leads).
const ROW_CHUNK=120;let _rowList=[],_rowCursor=0;
async function renderRows(){
	const q=$("search").value.trim(),st=$("stage").value,rel=$("rel").value;let list;
	if(q.length>=2){_ctl?.abort();_ctl=new AbortController();
		try{const r=await (await fetch("/api/search?k=40&q="+encodeURIComponent(q),{signal:_ctl.signal})).json();
			list=(r||[]).map(h=>leadsById.get(h.lead.id)||h.lead);}catch(e){if(e.name==="AbortError")return;list=[];}}
	else list=DATA.leads;
	if(st)list=list.filter(l=>l.stage===st);
	if(rel)list=list.filter(l=>l.relationship===rel);
	if(!list.length){_rowList=[];const why=rel?"No "+esc(rel)+" leads yet — run assess to tag relationships.":st?"No leads in stage \\""+esc(st)+"\\".":q.length>=2?"No matches for \\""+esc(q)+"\\".":"No leads.";
		$("rows").innerHTML="<div class='empty'>"+why+"</div>";return;}
	_rowList=list;paintRows(true);
}
function paintRows(reset){const box=$("rows");
	if(reset){_rowCursor=0;box.scrollTop=0;box.innerHTML="";}
	const slice=_rowList.slice(_rowCursor,_rowCursor+ROW_CHUNK);
	box.insertAdjacentHTML("beforeend",slice.map(rowHtml).join(""));
	_rowCursor+=slice.length;}
$("rows").addEventListener("scroll",()=>{const b=$("rows");
	if(_rowCursor<_rowList.length&&b.scrollTop+b.clientHeight>=b.scrollHeight-240)paintRows(false);});
$("rows").addEventListener("click",e=>{const r=e.target.closest?e.target.closest(".row"):null;if(r)openLead(r.dataset.id);});
function rowHtml(l){const fit=l.pitchFit==null?"—":l.pitchFit.toFixed(2);
	const rl=l.relationship?"<span class='rl' style='background:"+(REL_COLORS[l.relationship]||"#8a93a6")+"'>"+esc(l.relationship)+"</span>":"";
	return "<div class='row' data-id='"+esc(l.id)+"'><span class='fit'>"+fit+"</span><div class='mid'><div class='nm'>"+esc(l.name||l.fullName)+
	"</div><div class='tl'>"+esc(l.title||"")+"</div></div>"+rl+"<span class='pill'>"+esc(l.stage)+"</span></div>";}
$("search").addEventListener("input",debounce(renderRows,250));
$("stage").addEventListener("change",e=>{fStage=e.target.value;renderRows();render();});
$("rel").addEventListener("change",e=>{fRel=e.target.value;renderRows();render();});
$("exportBtn").addEventListener("click",()=>{const p=new URLSearchParams({format:"csv"});
	if($("stage").value)p.set("stage",$("stage").value);if($("rel").value)p.set("rel",$("rel").value);
	window.location.href="/api/export?"+p.toString();});
$("f-unlinked").addEventListener("change",e=>{showUnlinked=e.target.checked;buildGraph();});
let clusterColorById=new Map();
function clusterColor(i){return "hsl("+((i*137)%360)+",62%,62%)";}
$("f-sim").addEventListener("change",async e=>{showSim=e.target.checked;
	if(showSim&&!simLoaded){e.target.disabled=true;$("simlbl").textContent="computing… (~15s)";
		try{const [se,cl]=await Promise.all([api("/api/similar?k=4&min=0.65"),api("/api/clusters?k=36&minSize=4")]);
			simEdges=se.edges||[];
			(cl.clusters||[]).forEach((c,i)=>{for(const id of (c.memberIds||[]))clusterColorById.set(id,clusterColor(i));});
			simLoaded=true;}catch(err){}
		e.target.disabled=false;$("simlbl").textContent="similar people ("+simEdges.length+")";}
	buildGraph();});
function renderRelLegend(){$("rellegend").innerHTML=Object.keys(REL_COLORS).map(k=>"<i class='sw' style='background:"+REL_COLORS[k]+"'></i>"+k).join("");}
renderRelLegend();

// --- view toggle + kanban board ---
const STAGES=["new","contacted","replied","meeting","passed"];
$("seg").addEventListener("click",e=>{const v=e.target.dataset.view;if(!v)return;
	for(const b of $("seg").children)b.classList.toggle("on",b.dataset.view===v);
	boardOn=v==="board";graphActive=v==="graph";
	$("graphview").style.display=graphActive?"grid":"none";
	$("board").classList.toggle("on",boardOn);
	$("clusters").classList.toggle("on",v==="clusters");
	$("vcs").classList.toggle("on",v==="vcs");
	$("investors").classList.toggle("on",v==="investors");
	if(boardOn)renderBoard();else if(v==="clusters")renderClusters();else if(v==="vcs")renderVcs();else if(v==="investors")renderInvestors();else render();});
let investorsLoaded=false;
function fmtCheck(n){if(n==null)return "?";if(n>=1e6)return (n/1e6)+"M";if(n>=1e3)return (n/1e3)+"k";return ""+n;}
const FACTOR_COLORS={stage:"#e9c46a",sector:"#5ec6a8",geo:"#9b8cff",check:"#4cc9f0"};
async function renderInvestors(){
	if(!investorsLoaded){$("investors").innerHTML="<div class='empty'>loading investor matches…</div>";
		try{const r=await api("/api/investors");window.__investors=r.investors||[];investorsLoaded=true;}catch(e){$("investors").innerHTML="<div class='empty'>could not load investors</div>";return;}}
	const inv=window.__investors||[];
	if(!inv.length){$("investors").innerHTML="<div class='empty'>No investors yet — run <code>lead-osint ingest openvc &lt;file.csv&gt;</code> then <code>lead-osint match --profile startup.json</code>.</div>";return;}
	const scored=inv.filter(i=>i.matchScore!=null);
	if(!scored.length){$("investors").innerHTML="<div class='empty'>"+inv.length+" investors ingested but unscored — run <code>lead-osint match --profile startup.json</code>.</div>";return;}
	$("investors").innerHTML=scored.map(i=>{
		const b=i.matchBreakdown||{};
		const bar=["stage","sector","geo","check"].map(k=>"<span style='width:"+(25*(b[k]||0)*4/4)+"%;background:"+FACTOR_COLORS[k]+"' title='"+k+" "+((b[k]||0).toFixed(2))+"'></span>").join("");
		const meta=[i.stages&&i.stages.length?i.stages.join("/"):null,(i.sectors||[]).slice(0,3).join(", ")||null,
			(i.checkMin!=null||i.checkMax!=null)?"$"+fmtCheck(i.checkMin)+"–"+fmtCheck(i.checkMax):null].filter(Boolean).join(" · ");
		const warm=i.warm?"<div class='mem' data-id='"+esc(i.warm.id)+"'><span class='f' style='color:#5ec6a8'>warm</span><span class='nm'>via "+esc(i.warm.name)+"</span></div>":"";
		const partner=(i.partnerName||i.partnerEmail)?"<div class='meta'>"+esc(i.partnerName||"")+(i.partnerEmail?" &lt;"+esc(i.partnerEmail)+"&gt;":"")+"</div>":"";
		const site=i.website?"<a href='"+esc(i.website)+"' target=_blank onclick='event.stopPropagation()'>site</a>":(i.domain?"<a href='https://"+esc(i.domain)+"' target=_blank onclick='event.stopPropagation()'>site</a>":"");
		return "<div class='cl'><h3>"+(i.matchScore.toFixed(2))+" · "+esc(i.name)+" "+site+"</h3>"+
			"<div class='meta'>"+esc(meta||"—")+"</div><div class='relbar'>"+bar+"</div>"+
			"<div class='meta'>stage "+(b.stage||0).toFixed(2)+" · sector "+(b.sector||0).toFixed(2)+" · geo "+(b.geo||0).toFixed(2)+" · check "+(b.check||0).toFixed(2)+"</div>"+
			partner+warm+"</div>";
	}).join("");
	for(const m of $("investors").querySelectorAll(".mem"))m.onclick=()=>openLead(m.dataset.id);
}
let vcsLoaded=false;
async function renderVcs(){
	if(!vcsLoaded){$("vcs").innerHTML="<div class='empty'>loading VC firms…</div>";
		try{const r=await api("/api/vcs");window.__vcs=r.firms||[];vcsLoaded=true;}catch(e){$("vcs").innerHTML="<div class='empty'>could not load VC firms</div>";return;}}
	const firms=window.__vcs||[];
	if(!firms.length){$("vcs").innerHTML="<div class='empty'>No VC firms yet — run assess to tag investors.</div>";return;}
	$("vcs").innerHTML=firms.map(f=>{
		const mems=f.top.map(c=>"<div class='mem' data-id='"+esc(c.id)+"'><span class='f'>"+(c.fit==null?"—":c.fit.toFixed(2))+"</span><span class='nm'>"+esc(c.name)+(c.title?" — "+esc(c.title):"")+"</span>"+(c.linkedin?"<a href='"+esc(c.linkedin)+"' target=_blank onclick='event.stopPropagation()'>in</a>":"")+"</div>").join("");
		return "<div class='cl'><h3>"+esc(f.name)+"</h3><div class='meta'>"+f.investors+" investor"+(f.investors>1?"s":"")+" of "+f.contacts+" contacts"+(f.domain?" · "+esc(f.domain):"")+"</div>"+mems+"</div>";
	}).join("");
	for(const m of $("vcs").querySelectorAll(".mem"))m.onclick=()=>openLead(m.dataset.id);
}
let clustersLoaded=false;
async function renderClusters(){
	if(!clustersLoaded){$("clusters").innerHTML="<div class='empty'>finding communities… (~10s, one time)</div>";
		try{const r=await api("/api/clusters?k=36&minSize=4");window.__clusters=r.clusters||[];clustersLoaded=true;}catch(err){$("clusters").innerHTML="<div class='empty'>could not load clusters</div>";return;}}
	const cl=window.__clusters||[];
	if(!cl.length){$("clusters").innerHTML="<div class='empty'>No communities yet — assess + embed more leads, or lower the threshold.</div>";return;}
	$("clusters").innerHTML=cl.map(c=>{
		const total=Object.values(c.relationships).reduce((a,b)=>a+b,0)||1;
		const bar=Object.entries(c.relationships).sort((a,b)=>b[1]-a[1]).map(([k,n])=>"<span style='width:"+(100*n/total)+"%;background:"+(REL_COLORS[k]||"#8a93a6")+"' title='"+esc(k)+" "+n+"'></span>").join("");
		const mems=c.top.map(m=>"<div class='mem' data-id='"+esc(m.id)+"'><span class='f'>"+(m.fit==null?"—":m.fit.toFixed(2))+"</span><span class='nm'>"+esc(m.name)+"</span>"+(m.relationship?"<span class='rl' style='background:"+(REL_COLORS[m.relationship]||"#8a93a6")+"'>"+esc(m.relationship)+"</span>":"")+"</div>").join("");
		return "<div class='cl'><h3>"+esc(c.label)+"</h3><div class='meta'>"+c.size+" people</div><div class='relbar'>"+bar+"</div>"+mems+"</div>";
	}).join("");
	for(const m of $("clusters").querySelectorAll(".mem"))m.onclick=()=>openLead(m.dataset.id);
}
function renderBoard(){const by={};for(const s of STAGES)by[s]=[];
	for(const l of DATA.leads)(by[l.stage]||by.new).push(l);
	$("board").innerHTML=STAGES.map(s=>{const items=by[s].sort((a,b)=>(b.pitchFit||0)-(a.pitchFit||0));
		const cards=items.slice(0,120).map(l=>"<div class='card' draggable='true' data-id='"+esc(l.id)+"'>"+
			"<span class='fit'>"+(l.pitchFit==null?"":l.pitchFit.toFixed(2))+"</span><div class='nm'>"+esc(l.name||l.fullName)+
			"</div><div class='tl'>"+esc(l.title||"")+"</div></div>").join("")+
			(items.length>120?"<div class='tl' style='padding:6px'>+"+(items.length-120)+" more</div>":"");
		return "<div class='col' data-stage='"+s+"'><h3>"+s+" <span>"+items.length+"</span></h3><div class='cards'>"+cards+"</div></div>";}).join("");
	for(const card of $("board").querySelectorAll(".card")){
		card.addEventListener("dragstart",e=>{e.dataTransfer.setData("text/plain",card.dataset.id);e.dataTransfer.effectAllowed="move";});
		card.addEventListener("click",()=>openLead(card.dataset.id));}
	for(const col of $("board").querySelectorAll(".col")){
		col.addEventListener("dragover",e=>{e.preventDefault();col.classList.add("drop");});
		col.addEventListener("dragleave",()=>col.classList.remove("drop"));
		col.addEventListener("drop",async e=>{e.preventDefault();col.classList.remove("drop");
			const id=e.dataTransfer.getData("text/plain"),stage=col.dataset.stage;
			await post("/api/lead/"+encodeURIComponent(id)+"/stage",{stage});
			const l=DATA.leads.find(x=>x.id===id);if(l)l.stage=stage;renderBoard();});}
}

// --- drawer ---
async function openLead(id){
	const d=await api("/api/lead/"+encodeURIComponent(id));if(d.error)return;
	const l=d.lead,links=[l.linkedin&&"<a href='"+esc(l.linkedin)+"' target=_blank>LinkedIn</a>",
		l.twitter&&"<a href='"+esc(l.twitter)+"' target=_blank>Twitter</a>",l.website&&"<a href='"+esc(l.website)+"' target=_blank>Web</a>"].filter(Boolean).join(" · ");
	const today=new Date().toISOString().slice(0,10);
	$("drawer").innerHTML="<button class='close' onclick=\\"closeDrawer()\\">×</button>"+
		"<h2>"+esc(l.fullName)+"</h2><div class='sub'>"+esc(l.title||"")+(d.org?" · "+esc(d.org.name):"")+"</div>"+
		"<div class='field'>"+(l.email?"✉ <a href='mailto:"+esc(l.email)+"'>"+esc(l.email)+"</a>":"<span class='tl'>no email</span>")+"</div>"+
		(l.phones&&l.phones.length?"<div class='field'>☎ "+esc(l.phones.join(", "))+"</div>":"")+
		(links?"<div class='field'>"+links+"</div>":"")+
		(l.pitchFit!=null?"<div class='field tl'>pitch fit "+l.pitchFit.toFixed(2)+" · source "+esc(l.source)+"</div>":"")+
		((l.relevance!=null||l.relationship)?"<div class='assess'><b>"+(l.relationship?esc(l.relationship):"assessed")+"</b>"+(l.relevance!=null?" · relevance "+l.relevance.toFixed(2):"")+(l.rationale?"<div>"+esc(l.rationale)+"</div>":"")+"</div>":"")+
		"<label>Stage</label><select id='dstage'>"+STAGES.map(s=>"<option"+(s===l.stage?" selected":"")+">"+s+"</option>").join("")+"</select>"+
		"<button class='btn' onclick=\\"draftFor('"+esc(l.id)+"')\\">✦ Draft outreach</button><div id='draftout'></div>"+
		"<label>Add note</label><textarea id='dnote' placeholder='What happened…'></textarea><button class='btn' onclick=\\"saveNote('"+esc(l.id)+"')\\">Save note</button>"+
		"<label>Set reminder</label><div style='display:flex;gap:8px'><input id='dwhen' placeholder='3d / 2w / 2026-07-01' style='flex:1'/><button class='btn' onclick=\\"setRemind('"+esc(l.id)+"')\\">Remind</button></div>"+
		(d.reminders.length?"<label>Reminders</label>"+d.reminders.map(r=>"<div class='rem"+(!r.done&&r.dueAt.slice(0,10)<today?" overdue":"")+"'><span>"+r.dueAt.slice(0,10)+(r.done?" ✓":"")+" "+esc(r.note||"")+"</span>"+(r.done?"":"<button class='btn ghost' onclick=\\"doneRemind("+r.id+",'"+esc(l.id)+"')\\">done</button>")+"</div>").join(""):"")+
		(l.notes?"<label>Notes</label><div class='log'><div>"+esc(l.notes).replace(/\\n/g,"</div><div>")+"</div></div>":"")+
		"<label>Activity</label><div class='log'>"+d.interactions.slice(0,12).map(i=>"<div>"+i.at.slice(0,10)+" · "+esc(i.type)+": "+esc(i.content).slice(0,80)+"</div>").join("")+"</div>";
	$("drawer").hidden=false;
	$("dstage").onchange=async ev=>{await post("/api/lead/"+encodeURIComponent(l.id)+"/stage",{stage:ev.target.value});await refreshLead(l.id);};
}
window.closeDrawer=()=>{$("drawer").hidden=true;};
window.draftFor=async id=>{const out=$("draftout");out.innerHTML="<div class='tl' style='margin-top:8px'>drafting…</div>";
	const r=await post("/api/lead/"+encodeURIComponent(id)+"/draft",{});
	if(r.error){out.innerHTML="<div class='draftbox'>⚠ "+esc(r.error)+"</div>";return;}
	out.innerHTML="<div class='draftbox'><b>"+esc(r.subject)+"</b>\\n\\n"+esc(r.body)+"</div><button class='btn ghost' id='cpy'>Copy</button>";
	$("cpy").onclick=()=>navigator.clipboard?.writeText(r.subject+"\\n\\n"+r.body);};
window.saveNote=async id=>{const n=$("dnote").value.trim();if(!n)return;await post("/api/lead/"+encodeURIComponent(id)+"/note",{note:n});await refreshLead(id);openLead(id);};
window.setRemind=async id=>{const w=$("dwhen").value.trim();if(!w)return;const r=await post("/api/lead/"+encodeURIComponent(id)+"/remind",{when:w});if(r.error){alert(r.error);return;}await reloadDue();openLead(id);};
window.doneRemind=async(rid,id)=>{await post("/api/remind/"+rid+"/done");await reloadDue();openLead(id);};
async function refreshLead(id){const d=await api("/api/lead/"+encodeURIComponent(id));if(d.lead){
	DATA.leads=DATA.leads.map(x=>x.id===id?{...x,stage:d.lead.stage,pitchFit:d.lead.pitchFit}:x);
	leadsById.set(id,DATA.leads.find(x=>x.id===id));if(boardOn)renderBoard();else renderRows();
	const row=[...$("rows").children].find(r=>r.dataset.id===id);if(row){row.classList.add("flash");setTimeout(()=>row.classList.remove("flash"),1000);}}}
async function reloadDue(){const r=await api("/api/due");const n=Array.isArray(r)?r.length:0;$("duecount").textContent=n;DATA.due=n;}

$("duebtn").onclick=async()=>{const p=$("duepanel");if(!p.hidden){p.hidden=true;return;}
	const due=await api("/api/due");
	p.innerHTML="<button class='close' onclick=\\"document.getElementById('duepanel').hidden=true\\">×</button><h2>Follow-ups due</h2>"+
		(due.length?due.map(r=>"<div class='rem overdue'><span><b>"+esc(r.lead?r.lead.fullName:"?")+"</b><br>"+r.dueAt.slice(0,10)+" "+esc(r.note||"")+"</span><button class='btn ghost' onclick=\\"doneDue("+r.id+")\\">done</button></div>").join(""):"<p class='tl'>Nothing due. 🎉</p>");
	p.hidden=false;};
window.doneDue=async rid=>{await post("/api/remind/"+rid+"/done");await reloadDue();$("duepanel").hidden=true;};

load();
`;
