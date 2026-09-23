#!/usr/bin/env node
/**
 * Deterministic layered layout (Sugiyama-style), one diagram per flow.
 *
 * Drawing a whole module as one graph is what makes lines tangle: dozens of
 * screens, many-to-many edges, no ordering. This script:
 *
 *   1. Splits the graph into flows — one per nav graph file. A screen declared
 *      in several graphs joins the one whose `<action>`s touch it most; an
 *      Activity joins the flow it navigates into most (its host/entry).
 *      Screens no flow claims go into an "app" flow.
 *   2. Per flow: reverses back edges (cycles), assigns layers by longest path so
 *      every forward edge points right, inserts dummy nodes for edges spanning
 *      several layers, and orders each layer with barycenter sweeps to minimise
 *      crossings.
 *   3. Destinations outside the flow become "ghost" cards in a last column, so
 *      cross-flow edges all run the same way instead of across the diagram.
 *   4. Emits coordinates for every card and the bend points of every edge, so
 *      any renderer (the HTML preview here, `render-flow-wireframes.mjs`, a
 *      Figma plugin) draws the same picture without doing layout itself.
 *
 * Cards may differ in size (a wireframe with ten fields is taller than one with
 * two): pass `sizeOf` to `layoutFlows()`; each column is as wide as its widest
 * card. `crossings` per flow counts intersecting edge segments — the number
 * this layout exists to minimise.
 *
 * Usage:
 *   node layout-flows.mjs --nav-json <merged nav.json> --out <layout.json> [--preview <preview.html>]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const GAP_X = 120;
const GAP_Y = 28;
const DUMMY_H = 8;
const PAD = 40;
const SWEEPS = 12;
const LABEL_CARD = { minW: 220, h: 64, charW: 7.4 };

export const labelOf = (n) => (n.className ? n.className.split('.').pop() : n.label || n.id);
const defaultSize = (n) => ({ w: Math.max(LABEL_CARD.minW, Math.ceil(n.label.length * LABEL_CARD.charW) + 24), h: LABEL_CARD.h });

export function assignFlows(nav) {
  const flowOf = new Map();
  // A screen declared in several nav graphs belongs to the graph whose
  // `<action>`s touch it most — not merely the first file it was found in,
  // which would strand that graph's hub and leave its screens disconnected.
  const xmlVotes = new Map();
  for (const e of nav.edges || []) {
    if (!e.sourceFile || e.source === 'code') continue;
    const f = e.sourceFile.replace(/\.xml$/, '');
    for (const id of [e.from, e.to]) {
      const v = xmlVotes.get(id) || xmlVotes.set(id, new Map()).get(id);
      v.set(f, (v.get(f) || 0) + 1);
    }
  }
  const top = (votes) => [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  for (const n of nav.nodes) {
    if (n.kind === 'activity') continue;
    const best = xmlVotes.has(n.id) && top(xmlVotes.get(n.id));
    if (best) flowOf.set(n.id, best[0]);
    else if (n.sourceFile) flowOf.set(n.id, n.sourceFile.replace(/\.xml$/, ''));
  }
  // Activities and code-only screens join the flow they send the most edges into.
  for (const n of nav.nodes) {
    if (flowOf.has(n.id)) continue;
    const votes = new Map();
    for (const e of nav.edges || []) {
      if (e.from !== n.id || !flowOf.has(e.to)) continue;
      const f = flowOf.get(e.to);
      votes.set(f, (votes.get(f) || 0) + (e.rule === 'hosts-graph' ? 10 : 1));
    }
    const best = votes.size && top(votes);
    flowOf.set(n.id, best ? best[0] : 'app');
  }
  return flowOf;
}

function layoutFlow(flowId, nodeIds, nodeById, allEdges, flowOf, sizeOf) {
  // The catch-all flow only shows screens that connect to something in it;
  // the rest already appear as ghost targets in the flows that reach them.
  if (flowId === 'app') {
    nodeIds = nodeIds.filter((id) => allEdges.some((e) => e.from === id || (e.to === id && nodeIds.includes(e.from))));
  }
  const inFlow = new Set(nodeIds);
  const nodes = new Map();
  for (const id of nodeIds) nodes.set(id, { id, label: labelOf(nodeById.get(id)), kind: nodeById.get(id).kind, ghost: false });

  const edges = [];
  const seen = new Set();
  for (const e of allEdges) {
    if (!inFlow.has(e.from) || e.from === e.to) continue;
    let to = e.to;
    if (!inFlow.has(to)) {
      to = `ghost:${e.to}`;
      if (!nodes.has(to)) {
        const target = nodeById.get(e.to);
        nodes.set(to, {
          id: to,
          target: e.to,
          label: target ? labelOf(target) : e.to,
          kind: target?.kind,
          ghost: true,
          flow: flowOf.get(e.to) || null,
        });
      }
    }
    const key = `${e.from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: e.from, to, rule: e.rule || 'xml' });
  }
  const size = new Map([...nodes.values()].map((n) => [n.id, sizeOf(n)]));

  // 1. Cycle removal: DFS from sources (sorted for determinism); an edge back to
  //    a node still on the stack is a back edge and is laid out reversed.
  const out = new Map([...nodes.keys()].map((id) => [id, []]));
  const indeg = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (const e of edges) {
    out.get(e.from).push(e);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const state = new Map();
  const visit = (id) => {
    state.set(id, 1);
    for (const e of out.get(id)) {
      const s = state.get(e.to);
      if (s === 1) e.back = true;
      else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  const ids = [...nodes.keys()].sort();
  ids.filter((id) => indeg.get(id) === 0 && !nodes.get(id).ghost).forEach((id) => !state.get(id) && visit(id));
  ids.forEach((id) => !state.get(id) && visit(id));

  // 2. Layers by longest path over the forward (acyclic) edges.
  const fwd = edges.map((e) => (e.back ? { ...e, from: e.to, to: e.from } : e));
  const layer = new Map([...nodes.keys()].map((id) => [id, 0]));
  for (let changed = true, guard = 0; changed && guard < nodes.size + 1; guard++) {
    changed = false;
    for (const e of fwd) {
      if (layer.get(e.to) < layer.get(e.from) + 1) {
        layer.set(e.to, layer.get(e.from) + 1);
        changed = true;
      }
    }
  }
  // Ghosts all sit in one final column.
  const maxReal = Math.max(0, ...[...nodes.values()].filter((n) => !n.ghost).map((n) => layer.get(n.id)));
  for (const n of nodes.values()) if (n.ghost) layer.set(n.id, maxReal + 1);

  // 3. Dummy nodes so every laid-out segment joins adjacent layers.
  const chains = [];
  const layers = [];
  const put = (id, l) => {
    (layers[l] ||= []).push(id);
  };
  [...nodes.keys()].sort().forEach((id) => put(id, layer.get(id)));
  const isDummy = new Set();
  for (const [i, e] of fwd.entries()) {
    const a = layer.get(e.from);
    const b = layer.get(e.to);
    const chain = [e.from];
    for (let l = a + 1; l < b; l++) {
      const d = `dummy:${i}:${l}`;
      isDummy.add(d);
      layer.set(d, l);
      put(d, l);
      chain.push(d);
    }
    chain.push(e.to);
    chains.push({ edge: edges[i], chain });
  }

  // 4. Crossing minimisation: barycenter sweeps down and up the layers.
  const up = new Map();
  const down = new Map();
  for (const { chain } of chains) {
    for (let k = 0; k + 1 < chain.length; k++) {
      (down.get(chain[k]) || down.set(chain[k], []).get(chain[k])).push(chain[k + 1]);
      (up.get(chain[k + 1]) || up.set(chain[k + 1], []).get(chain[k + 1])).push(chain[k]);
    }
  }
  const pos = new Map();
  layers.forEach((L) => L?.forEach((id, i) => pos.set(id, i)));
  for (let s = 0; s < SWEEPS; s++) {
    const range = s % 2 === 0 ? [...layers.keys()].slice(1) : [...layers.keys()].reverse().slice(1);
    for (const l of range) {
      const L = layers[l];
      if (!L) continue;
      const nb = s % 2 === 0 ? up : down;
      const bary = (id) => {
        const ns = nb.get(id) || [];
        return ns.length ? ns.reduce((sum, n) => sum + pos.get(n), 0) / ns.length : pos.get(id);
      };
      const score = new Map(L.map((id) => [id, bary(id)]));
      L.sort((a, b) => score.get(a) - score.get(b) || pos.get(a) - pos.get(b));
      L.forEach((id, i) => pos.set(id, i));
    }
  }

  // 5. Coordinates: each column as wide as its widest card; stack cards in a
  //    column and centre every column on the tallest one.
  const w = (id) => (isDummy.has(id) ? 0 : size.get(id).w);
  const h = (id) => (isDummy.has(id) ? DUMMY_H : size.get(id).h);
  const colW = layers.map((L) => Math.max(0, ...(L || []).map(w)) || LABEL_CARD.minW);
  const colX = [];
  colW.forEach((cw, l) => colX.push(l === 0 ? PAD : colX[l - 1] + colW[l - 1] + GAP_X));
  const colH = layers.map((L) => (L || []).reduce((sum, id) => sum + h(id) + GAP_Y, -GAP_Y));
  const maxH = Math.max(LABEL_CARD.h, ...colH);
  const xy = new Map();
  layers.forEach((L, l) => {
    let y = PAD + (maxH - colH[l]) / 2;
    for (const id of L || []) {
      xy.set(id, { x: colX[l], y });
      y += h(id) + GAP_Y;
    }
  });

  // 6. Edge routes: right edge of the source → through each dummy's column →
  //    left edge of the target. Back edges loop under the flow, one lane each.
  const bottom = PAD + maxH;
  let backLane = 0;
  const routed = chains.map(({ edge, chain }) => {
    const path = edge.back ? [...chain].reverse() : chain;
    const [s, t] = [path[0], path.at(-1)];
    const [a, b] = [xy.get(s), xy.get(t)];
    if (edge.back) {
      const lane = bottom + 24 + backLane++ * 14;
      return {
        from: edge.from,
        to: edge.to,
        rule: edge.rule,
        back: true,
        points: [
          [a.x + w(s) / 2, a.y + h(s)],
          [a.x + w(s) / 2, lane],
          [b.x + w(t) / 2, lane],
          [b.x + w(t) / 2, b.y + h(t)],
        ],
      };
    }
    const pts = [[a.x + w(s), a.y + h(s) / 2]];
    for (const d of path.slice(1, -1)) {
      const p = xy.get(d);
      pts.push([p.x, p.y + DUMMY_H / 2], [p.x + colW[layer.get(d)], p.y + DUMMY_H / 2]);
    }
    pts.push([b.x, b.y + h(t) / 2]);
    return { from: edge.from, to: edge.to, rule: edge.rule, back: false, points: pts };
  });

  const outNodes = [...nodes.values()].map((n) => ({ ...n, ...xy.get(n.id), w: w(n.id), h: h(n.id) }));
  const width = colX.at(-1) + colW.at(-1) + PAD;
  const height = bottom + PAD + (backLane ? 24 + backLane * 14 : 0);
  return { id: flowId, title: flowId, width, height, crossings: countCrossings(routed), nodes: outNodes, edges: routed };
}

function segmentsCross([p1, p2], [p3, p4]) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const shared = [p1, p2].some((a) => [p3, p4].some((b) => a[0] === b[0] && a[1] === b[1]));
  if (shared) return false;
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function countCrossings(edges) {
  const segs = edges.map((e) => e.points.slice(1).map((p, i) => [e.points[i], p]));
  let n = 0;
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      for (const a of segs[i]) for (const b of segs[j]) if (segmentsCross(a, b)) n++;
  return n;
}

/** Smooth SVG path through a routed edge's points (straight where aligned). */
export function curvePath(pts) {
  return pts
    .map((p, i) => {
      if (i === 0) return `M ${p[0]} ${p[1]}`;
      const q = pts[i - 1];
      const mx = (q[0] + p[0]) / 2;
      return q[1] === p[1] || q[0] === p[0] ? `L ${p[0]} ${p[1]}` : `C ${mx} ${q[1]}, ${mx} ${p[1]}, ${p[0]} ${p[1]}`;
    })
    .join(' ');
}

/** Lay out every flow. `sizeOf(node)` → `{ w, h }`; node is `{ id, label, kind, ghost }`. */
export function layoutFlows(nav, sizeOf = defaultSize) {
  const nodeById = new Map(nav.nodes.map((n) => [n.id, n]));
  const flowOf = assignFlows(nav);
  const byFlow = new Map();
  for (const [id, f] of flowOf) (byFlow.get(f) || byFlow.set(f, []).get(f)).push(id);
  return [...byFlow.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([f, ids]) => layoutFlow(f, ids, nodeById, nav.edges || [], flowOf, sizeOf))
    .filter((f) => f.nodes.length);
}

function previewHtml(flows) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg = (f) => `
<section><h2>${esc(f.title)} <small>${f.nodes.filter((n) => !n.ghost).length} screens · ${f.edges.length} edges · ${f.crossings} crossings</small></h2>
<div class="wrap"><svg width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">
${f.edges.map((e) => `<path d="${curvePath(e.points)}" class="edge${e.back ? ' back' : ''}" marker-end="url(#arr)"/>`).join('\n')}
${f.nodes
  .map(
    (n) => `<g transform="translate(${n.x},${n.y})" class="card${n.ghost ? ' ghost' : ''}${n.kind === 'activity' ? ' activity' : ''}">
<rect width="${n.w}" height="${n.h}" rx="10"/><text x="12" y="26">${esc(n.label)}</text>
<text x="12" y="46" class="sub">${n.ghost ? `→ ${esc(n.flow || 'other flow')}` : esc(n.kind || '')}</text></g>`,
  )
  .join('\n')}
</svg></div></section>`;
  return `<meta charset="utf-8"><title>Flow Layout Preview</title>
<style>
body{background:#020617;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;margin:0;padding:24px}
h2{font:600 16px 'JetBrains Mono',monospace;margin:28px 0 10px} small{color:#64748b;font-weight:400;margin-left:8px}
.wrap{overflow:auto;border:1px solid #1e293b;border-radius:12px;background:#070c17}
.card rect{fill:#0b1220;stroke:#22d3ee;stroke-opacity:.6} .card text{fill:#e2e8f0;font:600 12px 'JetBrains Mono',monospace}
.card .sub{fill:#64748b;font-weight:400;font-size:10px} .activity rect{stroke:#a78bfa}
.ghost rect{stroke:#64748b;stroke-dasharray:5 4;fill:#070c17} .ghost text{fill:#94a3b8}
.edge{fill:none;stroke:#22d3ee;stroke-width:1.6;opacity:.8} .edge.back{stroke:#fbbf24;stroke-dasharray:6 5}
</style>
<svg width="0" height="0"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#22d3ee"/></marker></defs></svg>
${flows.map(svg).join('\n')}`;
}

function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  if (!args['nav-json'] || !args.out) {
    console.error('Usage: node layout-flows.mjs --nav-json <merged nav.json> --out <layout.json> [--preview <preview.html>]');
    process.exit(1);
  }
  const flows = layoutFlows(JSON.parse(readFileSync(args['nav-json'], 'utf-8')));
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ generatedBy: 'layout-flows.mjs (deterministic)', flows }, null, 2));
  if (args.preview) writeFileSync(args.preview, previewHtml(flows));
  const total = flows.reduce((s, f) => s + f.crossings, 0);
  console.log(`✓ ${flows.length} flows, ${total} edge crossings total → ${args.out}`);
  for (const f of flows)
    console.log(`  ${f.id.padEnd(36)} ${String(f.nodes.filter((n) => !n.ghost).length).padStart(3)} screens  ${String(f.edges.length).padStart(3)} edges  ${f.crossings} crossings`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
