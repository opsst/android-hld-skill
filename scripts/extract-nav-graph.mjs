#!/usr/bin/env node
/**
 * Deterministic Tier-1 extractor — no LLM involved.
 *
 * Parses every Android Navigation Component `nav_graph` XML under a feature
 * module's `res/navigation/` folder and emits a structural JSON: every
 * screen (fragment/activity — id, class, layout, label) and every
 * navigation edge (action id + destination), grouped by which nav_graph
 * file they came from.
 *
 * This proves the screen-flow *shape* can be extracted with zero LLM calls —
 * regex/AST-level static analysis, not an LLM reading source files. An LLM
 * (or a human) is only needed afterwards to add the semantic layer (purpose
 * text, API calls, button-copy) on top of this scaffold.
 *
 * Usage:
 *   node scripts/extract-nav-graph.mjs --dir <path-to-res/navigation> --out <output.json>
 *
 * Example (against a sample XML/ViewBinding Android repo):
 *   node scripts/extract-nav-graph.mjs \
 *     --dir ../your-android-repo/app/src/main/res/navigation \
 *     --out examples/your-app.nav.json
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function stripRef(v) {
  // "@+id/foo" | "@id/foo" -> "foo"; "@layout/foo" -> "foo"
  if (!v) return v;
  return String(v).replace(/^@\+?id\//, '').replace(/^@layout\//, '');
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Walk a <navigation> tree (nav_graph root or a nested <navigation>) and
 *  collect screen nodes + action edges, tagging each with the source file. */
function walkGraph(graphEl, sourceFile, nodes, edges) {
  const screenTags = ['fragment', 'activity'];
  for (const tag of screenTags) {
    for (const el of asArray(graphEl[tag])) {
      const attrs = el;
      const id = stripRef(attrs['@_android:id']);
      if (!id) continue;
      nodes.push({
        id,
        kind: tag,
        className: attrs['@_android:name'] || null,
        label: attrs['@_android:label'] || null,
        layout: stripRef(attrs['@_tools:layout']) || null,
        sourceFile,
      });
      for (const action of asArray(el.action)) {
        const to = stripRef(action['@_app:destination']);
        if (!to) continue; // pop-up-only / no-op actions
        edges.push({
          from: id,
          to,
          actionId: stripRef(action['@_android:id']),
          sourceFile,
        });
      }
    }
  }
  // Nested <navigation> blocks (sub-graphs) — recurse.
  for (const nested of asArray(graphEl.navigation)) {
    walkGraph(nested, sourceFile, nodes, edges);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.out) {
    console.error('Usage: node scripts/extract-nav-graph.mjs --dir <res/navigation dir> --out <output.json>');
    process.exit(1);
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const files = readdirSync(args.dir).filter((f) => f.endsWith('.xml'));

  const nodes = [];
  const edges = [];
  const files_processed = [];

  for (const file of files) {
    const xml = readFileSync(join(args.dir, file), 'utf-8');
    let doc;
    try {
      doc = parser.parse(xml);
    } catch (e) {
      console.warn(`⚠ skipped ${file}: XML parse error — ${e.message}`);
      continue;
    }
    if (!doc.navigation) {
      console.warn(`⚠ skipped ${file}: no <navigation> root`);
      continue;
    }
    const startDestination = stripRef(doc.navigation['@_app:startDestination']);
    files_processed.push({ file, startDestination });
    walkGraph(doc.navigation, file, nodes, edges);
  }

  // De-dupe nodes by id across ALL files — a screen commonly appears as a
  // destination stub in more than one nav_graph file in a multi-graph app.
  // (Previously keyed on `sourceFile::id`, which only caught a duplicate
  // within the same file and left real cross-file duplicates in the output
  // — found by running this against a real 9-file, 43-screen module.)
  const seen = new Set();
  const dedupedNodes = nodes.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  // Orphan nodes: zero in-edges AND zero out-edges — see extract-nav3.mjs
  // for why this (not just a missing out-edge) is the meaningful signal.
  const connected = new Set();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  const orphanNodes = dedupedNodes.map((n) => n.id).filter((id) => !connected.has(id));

  const result = {
    generatedBy: 'extract-nav-graph.mjs (deterministic, no LLM)',
    sourceDir: args.dir,
    files: files_processed,
    screenCount: dedupedNodes.length,
    edgeCount: edges.length,
    orphanCount: orphanNodes.length,
    nodes: dedupedNodes,
    edges,
    orphanNodes, // disclosed gaps: screens with no detected edges in or out
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(
    `✓ ${dedupedNodes.length} screens, ${edges.length} edges (${orphanNodes.length} orphan) from ${files_processed.length} nav_graph file(s) → ${args.out}`,
  );
  if (orphanNodes.length > 0) {
    console.warn(`⚠ ${orphanNodes.length} screen(s) with no detected edges: ${orphanNodes.join(', ')}`);
  }
}

main();
