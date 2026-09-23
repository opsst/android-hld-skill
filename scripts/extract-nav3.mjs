#!/usr/bin/env node
/**
 * Deterministic Tier-1 extractor for Jetpack Navigation 3 (androidx.navigation3).
 *
 * Unlike the classic XML nav_graph (declarative markup), Navigation 3 wiring is
 * plain Kotlin — but it's still *conventional* Kotlin, which is what makes this
 * possible without an LLM:
 *
 *   1. Every screen is a `NavKey` object/class in a file matching
 *      `.../navigation/*NavKey.kt` — one screen, one node.
 *   2. Every screen's entry point is wired in a `*EntryProvider.kt` file via
 *      `entry<XNavKey> { Screen(onYClick = navigator::navigateToY, ...) }`
 *      — this file IS the navigation graph, just written as code instead of XML.
 *   3. `fun Navigator.navigateToY(...)` extension functions (co-located with the
 *      NavKey) map a callback name -> destination NavKey.
 *
 * This script:
 *   - collects every NavKey as a node (id, module, source file)
 *   - builds a `navigateToX -> XNavKey` lookup table from the extension functions
 *   - scans every EntryProvider's `entry<...>{...}` blocks for edges, resolved
 *     either via that lookup table (`navigator::navigateToTopic`) or an inline
 *     `navigator.navigate(XNavKey(...))` call.
 *
 * It will NOT catch every edge (conditional navigation buried in ViewModels,
 * navigation triggered from LaunchedEffect, etc.) — that's an intentional,
 * disclosed limitation of Tier-1 static extraction, not a bug.
 *
 * Usage:
 *   node skill/scripts/extract-nav3.mjs --dir <path-to-android-repo-root> --out <output.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** Fast recursive file finder scoped to *.kt, skipping build/test noise. */
function findKtFiles(root, patternSuffixTest) {
  // Use `find` via child_process for speed on large repos instead of a JS walk.
  const raw = execSync(
    `find "${root}" -type f -name "*.kt" -not -path "*/build/*" -not -path "*/test/*" -not -path "*/androidTest/*"`,
    { maxBuffer: 1024 * 1024 * 64 },
  ).toString();
  return raw
    .split('\n')
    .filter(Boolean)
    .filter((f) => (patternSuffixTest ? patternSuffixTest(f) : true));
}

/** Extract the feature module name from a path like `.../feature/foryou/api/...`. */
function moduleFromPath(root, file) {
  const rel = relative(root, file).split(sep);
  const idx = rel.indexOf('feature');
  if (idx !== -1 && rel[idx + 1]) return rel[idx + 1];
  const coreIdx = rel.indexOf('core');
  if (coreIdx !== -1 && rel[coreIdx + 1]) return `core/${rel[coreIdx + 1]}`;
  return rel[0] || 'app';
}

/**
 * Strip comments before any pattern runs against the source, so a
 * commented-out `navigator.navigate(...)` doesn't get counted as a real
 * edge. Deliberately conservative: block comments are removed outright,
 * but a line comment is only stripped when the *entire* line (after
 * trimming) starts with `//` — never a trailing `// note` after real code
 * on the same line — so a string literal like "http://..." sitting next to
 * real code is never touched.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.out) {
    console.error('Usage: node extract-nav3.mjs --dir <repo root> --out <output.json>');
    process.exit(1);
  }
  const root = args.dir;

  // --- 1. Nodes: every *NavKey.kt file -----------------------------------
  const navKeyFiles = findKtFiles(root, (f) => /navigation\/\w+NavKey\.kt$/.test(f));
  const nodes = [];
  for (const file of navKeyFiles) {
    const src = stripComments(readFileSync(file, 'utf-8'));
    const m = src.match(/(?:class|object)\s+(\w+NavKey)\b[^{]*\bNavKey\b/);
    if (!m) continue;
    nodes.push({
      id: m[1],
      module: moduleFromPath(root, file),
      sourceFile: relative(root, file),
    });
  }
  const nodeIds = new Set(nodes.map((n) => n.id));

  // --- 2. Lookup table: navigateToX() -> XNavKey --------------------------
  // These extension functions typically live right next to the NavKey, e.g.
  //   fun Navigator.navigateToTopic(topicId: String) = navigate(TopicNavKey(topicId))
  const navFnFiles = findKtFiles(root, (f) => /navigation\/\w+\.kt$/.test(f));
  const fnToTarget = {};
  for (const file of navFnFiles) {
    const src = stripComments(readFileSync(file, 'utf-8'));
    const fnRegex = /fun\s+Navigator\.(navigateTo\w+)\s*\([^)]*\)[^{=]*[{=][^]*?navigate\(\s*(\w+NavKey)/g;
    let m;
    while ((m = fnRegex.exec(src))) {
      fnToTarget[m[1]] = m[2];
    }
  }

  // --- 3. Edges: entry<XNavKey>{ ... } blocks in *EntryProvider.kt -------
  const entryFiles = findKtFiles(root, (f) => /EntryProvider\.kt$/.test(f));
  const edges = [];
  const unresolved = [];
  for (const file of entryFiles) {
    const src = stripComments(readFileSync(file, 'utf-8'));
    // Split on `entry<XNavKey>` to get one block per screen registration.
    const parts = src.split(/entry<(\w+NavKey)>/).slice(1); // [key, body, key, body, ...]
    for (let i = 0; i < parts.length; i += 2) {
      const from = parts[i];
      const body = parts[i + 1] ?? '';
      // Truncate body at the next sibling `entry<` boundary already handled by split.
      // Callback-ref edges: onXClick = navigator::navigateToY
      // (receiver name is not assumed to literally be "navigator" — teams
      // may alias it, e.g. `nav`, `router`)
      const refRegex = /(\w+)\s*=\s*\w+::(navigateTo\w+)/g;
      let m;
      while ((m = refRegex.exec(body))) {
        const [, callback, fnName] = m;
        const to = fnToTarget[fnName];
        if (to && nodeIds.has(to)) {
          edges.push({ from, to, via: callback, sourceFile: relative(root, file) });
        } else {
          unresolved.push({ from, via: callback, fnName, sourceFile: relative(root, file) });
        }
      }
      // Inline edges: onXClick = { navigator.navigate(YNavKey(...)) }
      // (same receiver-aliasing tolerance as refRegex above)
      const inlineRegex = /(\w+)\s*=\s*\{\s*\w+\.navigate\(\s*(\w+NavKey)/g;
      while ((m = inlineRegex.exec(body))) {
        const [, callback, to] = m;
        if (nodeIds.has(to)) {
          edges.push({ from, to, via: callback, sourceFile: relative(root, file) });
        }
      }
    }
  }

  // --- Orphan nodes: zero in-edges AND zero out-edges -----------------------
  // A leaf screen with in-edges but no out-edges is normal (e.g. a success
  // screen). A node with NO edges at all in either direction is the
  // strongest static signal that extraction missed something connecting
  // it to the rest of the graph — surface it, don't hide it.
  const connected = new Set();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  const orphanNodes = nodes.map((n) => n.id).filter((id) => !connected.has(id));

  const result = {
    generatedBy: 'extract-nav3.mjs (deterministic, no LLM) — Navigation 3 convention parser',
    sourceDir: root,
    screenCount: nodes.length,
    edgeCount: edges.length,
    unresolvedCount: unresolved.length,
    orphanCount: orphanNodes.length,
    nodes,
    edges,
    unresolved, // disclosed gaps: callback refs we couldn't resolve to a known NavKey
    orphanNodes, // disclosed gaps: screens with no detected edges in or out
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 2));
  console.log(
    `✓ ${nodes.length} screens, ${edges.length} edges (${unresolved.length} unresolved, ${orphanNodes.length} orphan) → ${args.out}`,
  );
  if (orphanNodes.length > 0) {
    console.warn(`⚠ ${orphanNodes.length} screen(s) with no detected edges: ${orphanNodes.join(', ')}`);
  }
}

main();
