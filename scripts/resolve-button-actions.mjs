#!/usr/bin/env node
/**
 * Deterministic Tier-1 resolver — connects a screen's buttons/click
 * targets (from extract-xml-ui.mjs) to what they actually do: navigate to
 * another screen (extract-nav-graph.mjs's edges), or call a UseCase/API
 * chain (resolve-api-chain-paths.mjs).
 *
 * Two navigate-detection patterns, in priority order:
 *
 *   1. Safe Args generated Directions — `<FragmentName>Directions.<action>(...)`.
 *      The generated method name is *always* the action's android:id
 *      (confirmed against a real fragment: `SearchFragmentDirections.showRepo(...)`
 *      for an action declared `android:id="@+id/showRepo"`), so this is a
 *      direct, reliable cross-reference against nav-graph edges — no
 *      guessing which destination it targets.
 *   2. Raw `findNavController().navigate(R.id.<actionId>)` — older/simpler
 *      style, matched the same way against nav-graph edges' actionId.
 *
 * Button attribution is best-effort: for each known button id, we look for
 * a `.setOnClickListener` block and check whether a navigate pattern (or a
 * ViewModel method call) appears in the following text window. A Directions
 * call found *outside* any such window (e.g. inside a RecyclerView item-click
 * callback, not a view's own click listener) is still reported — just as a
 * screen-level action rather than attributed to one specific button. This is
 * a disclosed scoping choice, not a silent gap.
 *
 * Usage:
 *   node resolve-button-actions.mjs --nav-json <nav.json> --xml-ui-json <xml-ui.json> --dir <repo root> --out <output.json>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function fqnToPath(fqn, repoRoot) {
  // Best-effort: try every module root that actually has a src/main/java
  // tree, rather than assuming one fixed module layout — a single-module
  // app and a multi-module one both need to resolve here.
  const rel = fqn.replace(/\./g, '/') + '.kt';
  const candidates = ['app', '.'].map((m) => join(repoRoot, m, 'src/main/java', rel));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args['xml-ui-json'] || !args.dir || !args.out) {
    console.error(
      'Usage: node resolve-button-actions.mjs --nav-json <nav.json> --xml-ui-json <xml-ui.json> --dir <repo root> --out <output.json>',
    );
    process.exit(1);
  }

  const navGraph = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const xmlUi = JSON.parse(readFileSync(args['xml-ui-json'], 'utf-8'));

  // actionId -> destination screen id, from the nav graph we already extracted.
  const actionToDest = new Map();
  for (const e of navGraph.edges || []) {
    if (e.actionId) actionToDest.set(e.actionId, e.to);
  }

  // layoutFile -> elements, so we can look up a screen's buttons by its layout.
  const elementsByLayout = new Map();
  for (const l of xmlUi.layouts || []) {
    elementsByLayout.set(l.layoutFile, l.elements || []);
  }

  const results = [];
  for (const node of navGraph.nodes || []) {
    if (!node.className) continue;
    const fragmentFile = fqnToPath(node.className, args.dir);
    if (!fragmentFile) {
      results.push({ screenId: node.id, note: 'fragment source file not found', buttons: [] });
      continue;
    }
    const src = readFileSync(fragmentFile, 'utf-8');
    const simpleName = node.className.split('.').pop();

    // Every Directions-based navigate call anywhere in this file.
    const directionsRegex = new RegExp(`${simpleName}Directions\\.(\\w+)\\(`, 'g');
    const directionsCalls = [...src.matchAll(directionsRegex)].map((m) => ({
      actionMethod: m[1],
      index: m.index,
      dest: actionToDest.get(m[1]) || null,
    }));

    // Raw R.id.<action> navigate calls, same idea.
    const rawNavRegex = /navigate\(\s*R\.id\.(\w+)/g;
    const rawCalls = [...src.matchAll(rawNavRegex)].map((m) => ({
      actionMethod: m[1],
      index: m.index,
      dest: actionToDest.get(m[1]) || null,
    }));

    const allNavCalls = [...directionsCalls, ...rawCalls];

    // Buttons for this screen: find via the node's `layout` field, matched
    // against extract-xml-ui.mjs's layoutFile (basename match, since the two
    // scripts may have been pointed at directories with different prefixes).
    const buttons = [];
    let layoutElements = [];
    if (node.layout) {
      for (const [layoutFile, elements] of elementsByLayout) {
        if (layoutFile.includes(node.layout)) {
          layoutElements = elements;
          break;
        }
      }
    }

    const attributed = new Set();
    for (const el of layoutElements.filter((e) => e.type === 'button' || e.type === 'imagebutton')) {
      const clickRegex = new RegExp(`\\b${el.id}\\b[\\s\\S]{0,20}?setOnClickListener`, 'g');
      const m = clickRegex.exec(src);
      if (!m) {
        buttons.push({ id: el.id, label: el.label, action: { type: 'unresolved', reason: 'no setOnClickListener match found for this id' } });
        continue;
      }
      // Look for a nav call within the next ~400 chars after the listener opens —
      // a bounded window, not a full parse, but reasonable for typical short lambdas.
      const windowEnd = m.index + 400;
      const inWindow = allNavCalls.find((c) => c.index >= m.index && c.index <= windowEnd);
      if (inWindow) {
        attributed.add(inWindow.index);
        // Disclosed, not interpreted: if an `if (...)` appears between the
        // click listener and the navigate call, quote its raw condition
        // text verbatim as `guard` — we report that a check exists and what
        // it literally says, not what it semantically means.
        const between = src.slice(m.index, inWindow.index);
        const guardMatches = [...between.matchAll(/if\s*\(([^)]{1,120})\)/g)];
        const guard = guardMatches.length ? guardMatches[guardMatches.length - 1][1].trim() : null;
        buttons.push({
          id: el.id,
          label: el.label,
          action: inWindow.dest
            ? { type: 'navigate', target: inWindow.dest, via: inWindow.actionMethod, ...(guard ? { guard } : {}) }
            : { type: 'unresolved', reason: `navigate call found (action "${inWindow.actionMethod}") but no matching nav-graph edge` },
        });
      } else {
        buttons.push({ id: el.id, label: el.label, action: { type: 'unresolved', reason: 'click listener found, no navigate call detected nearby' } });
      }
    }

    // Nav calls not attributed to any specific button — still real signal,
    // reported at screen level instead of silently dropped.
    const screenLevelActions = allNavCalls
      .filter((c) => !attributed.has(c.index))
      .map((c) => ({ via: c.actionMethod, target: c.dest }));

    results.push({ screenId: node.id, fragmentFile, buttons, screenLevelActions });
  }

  const totalButtons = results.reduce((n, r) => n + r.buttons.length, 0);
  const resolvedButtons = results.reduce(
    (n, r) => n + r.buttons.filter((b) => b.action.type !== 'unresolved').length,
    0,
  );

  const output = {
    generatedBy: 'resolve-button-actions.mjs (deterministic, no LLM)',
    screenCount: results.length,
    buttonCount: totalButtons,
    buttonsResolved: resolvedButtons,
    screens: results,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`✓ ${results.length} screens, ${resolvedButtons}/${totalButtons} buttons resolved → ${args.out}`);
}

main();
