#!/usr/bin/env node
/**
 * Tier-1 draft assembler — turns our own extractor output (nav-graph +
 * button-actions) into a DRAFT archify `workflow` diagram spec. This script
 * only arranges data we already have; it does not touch archify's
 * validator. That's a separate, deliberately manual (agentic) step:
 *
 *   node to-archify.mjs ... --out draft.json
 *   node <archify>/bin/archify.mjs validate workflow draft.json --quality showcase --json
 *   # fix flagged geometry, re-validate, then:
 *   node <archify>/bin/archify.mjs deliver workflow draft.json out.html --quality showcase
 *
 * Column placement is BFS depth from the nav graph's start destination —
 * deterministic, not hand-placed; archify's own validator is what may still
 * reject fine-grained spacing/label-clearance issues, which is the bounded
 * Tier-2 fixing step above, not something this script tries to guess.
 *
 * Usage:
 *   node to-archify.mjs --nav-json <nav.json> --buttons-json <buttons.json> --title "<title>" --out <draft.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** archify node/lane ids must match ^[a-zA-Z][a-zA-Z0-9_-]*$ */
function safeId(id) {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return /^[a-zA-Z]/.test(s) ? s : `n_${s}`;
}

function cleanLabel(str) {
  return String(str)
    .replace(/^fragment_/, '')
    .replace(/_/g, ' ')
    .trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args['buttons-json'] || !args.out) {
    console.error(
      'Usage: node to-archify.mjs --nav-json <nav.json> --buttons-json <buttons.json> [--title "<title>"] --out <draft.json>',
    );
    process.exit(1);
  }

  const nav = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const buttons = JSON.parse(readFileSync(args['buttons-json'], 'utf-8'));

  const startId = nav.files?.[0]?.startDestination || nav.nodes[0]?.id;

  // BFS depth from the start screen -> archify `col` (0-5 max per schema).
  const adjacency = new Map();
  for (const e of nav.edges) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e.to);
  }
  const depth = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) || []) {
      if (!depth.has(next)) {
        depth.set(next, depth.get(cur) + 1);
        queue.push(next);
      }
    }
  }
  // Any node BFS didn't reach (shouldn't happen given 0 orphans, but stay honest) -> last column.
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nav.nodes) {
    if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
  }
  const finalMaxDepth = Math.max(...depth.values());
  if (finalMaxDepth > 5) {
    console.warn(`⚠ flow is ${finalMaxDepth + 1} columns deep — archify's schema caps at 6 (col 0-5). Split into smaller flows.`);
  }

  // NOTE: archify's `workflow` schema has no `sources` field on nodes (that's
  // `architecture`-only) — found by running `validate` against a real draft.
  // Use `tag` instead, which workflow nodes do support, to keep the
  // traceable-to-source spirit within what this diagram type actually offers.
  // A lane is a ROW, not just a label — two nodes sharing both lane and col
  // collide (found by running `validate`: two same-column nodes placed at
  // the identical rect). Assign each node a lane by its position within its
  // own column, so parallel branches (e.g. two screens both one hop from
  // the start) land in different rows instead of stacking on each other.
  const byCol = new Map();
  for (const n of nav.nodes) {
    const c = Math.min(depth.get(n.id), 5);
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(n.id);
  }
  const laneOf = new Map();
  for (const ids of byCol.values()) {
    ids.forEach((id, row) => laneOf.set(id, `lane${row}`));
  }
  const laneCount = Math.max(...[...byCol.values()].map((ids) => ids.length));
  const lanes = Array.from({ length: laneCount }, (_, i) => ({ id: `lane${i}`, label: `Row ${i + 1}` }));

  const nodes = nav.nodes.map((n) => ({
    id: safeId(n.id),
    lane: laneOf.get(n.id),
    col: Math.min(depth.get(n.id), 5),
    type: 'frontend',
    label: cleanLabel(n.label || n.id),
    ...(n.sourceFile ? { tag: n.sourceFile } : {}),
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = [];
  const unresolvedNotes = [];

  for (const screen of buttons.screens || []) {
    for (const b of screen.buttons || []) {
      if (b.action?.type === 'navigate' && nodeIds.has(safeId(screen.screenId)) && nodeIds.has(safeId(b.action.target))) {
        edges.push({
          id: safeId(`${screen.screenId}_${b.id}`),
          from: safeId(screen.screenId),
          to: safeId(b.action.target),
          label: b.label || b.id,
        });
      } else if (b.action?.type === 'unresolved') {
        unresolvedNotes.push(`${screen.screenId} → "${b.label || b.id}" (${b.action.reason})`);
      }
    }
    for (const a of screen.screenLevelActions || []) {
      if (a.target && nodeIds.has(safeId(screen.screenId)) && nodeIds.has(safeId(a.target))) {
        edges.push({
          id: safeId(`${screen.screenId}_${a.via}`),
          from: safeId(screen.screenId),
          to: safeId(a.target),
          label: cleanLabel(a.via.replace(/^action_/, '')),
          variant: 'dashed', // not tied to one specific button widget — disclosed via style, not hidden
        });
      }
    }
  }

  const draft = {
    // v2's layout contract handles column spacing itself — v1 needs exact
    // fixed pixel geometry per column, which is what caused a real
    // "columns overlap" validation error when this was schema_version 1.
    schema_version: 2,
    diagram_type: 'workflow',
    meta: {
      title: args.title || 'Screen Flow',
      quality_profile: 'showcase',
    },
    lanes,
    nodes,
    edges,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(draft, null, 2));
  console.log(`✓ ${nodes.length} nodes, ${edges.length} edges → ${args.out}`);
  if (unresolvedNotes.length) {
    console.warn(`⚠ ${unresolvedNotes.length} button action(s) not drawn (unresolved, not guessed):`);
    for (const n of unresolvedNotes) console.warn(`  - ${n}`);
  }
}

main();
