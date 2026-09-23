#!/usr/bin/env node
/**
 * Deterministic Tier-1 extractor — navigation that lives in Kotlin/Java code
 * rather than in `<action>` tags. Run it after `extract-nav-graph.mjs`; it
 * merges the code-level edges into the same nav-graph JSON shape so every
 * downstream script (`resolve-button-actions`, `render-flow-wireframes`,
 * `to-archify`) keeps working unchanged.
 *
 * Built-in rules (standard Android patterns — no per-team configuration):
 *
 *   1. id-ref       The nav graph already declares which ids are navigation:
 *                   every `<action>` id and every destination id. So any call
 *                   whose first argument is `R.id.<one of those>` is a
 *                   navigation edge, whatever the call is named — this is what
 *                   catches team-specific wrappers (`next(R.id.action_x)`,
 *                   `goTo(R.id.x)`) without anyone writing a rule for them.
 *                   `pop*`/`findFragmentById`-style calls are excluded.
 *   2. intent       `Intent(ctx, XActivity::class.java)` → edge to Activity X.
 *   3. hosts-graph  An Activity that inflates `R.navigation.<g>` (code) or whose
 *                   layout declares `app:navGraph="@navigation/<g>"` hosts that
 *                   graph → edge Activity → the graph's startDestination.
 *
 * Team conventions the built-ins can't see go in an optional rules file
 * (`--rules .hld-rules.json`), kept in the analyzed repo, not in this skill:
 *   { "navigate": [ { "name": "...", "pattern": "<regex, 1 capture group>",
 *                     "capture": "actionId" | "destinationId" | "className" } ] }
 *
 * Edge ownership: a call belongs to the screen whose class name is the file's
 * name; `XViewModel.kt` belongs to `XFragment`/`XActivity`. A navigation call
 * in any other file (adapters, base classes) is counted as `unattributed`, not
 * guessed. A target passed as a runtime value (`navigate(state.destId)`) can't
 * be resolved statically and is simply not matched by any rule.
 *
 * Usage:
 *   node extract-code-nav.mjs --nav-json <nav.json> --src <module>/src/main [--rules .hld-rules.json] --out <merged.json>
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, relative, join } from 'node:path';
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => (l.trim().startsWith('//') ? '' : l))
    .join('\n');
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;
const simpleName = (fqn) => (fqn || '').split('.').pop();
const NON_NAV_CALL = /^(pop\w*|popBackStack|findFragmentById|findViewById|getItemId|setId|contains)$/;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args.src || !args.out) {
    console.error(
      'Usage: node extract-code-nav.mjs --nav-json <nav.json> --src <module>/src/main [--rules .hld-rules.json] --out <merged.json>',
    );
    process.exit(1);
  }

  const nav = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const customRules = args.rules ? JSON.parse(readFileSync(args.rules, 'utf-8')).navigate || [] : [];

  const actionMap = new Map((nav.edges || []).filter((e) => e.actionId).map((e) => [e.actionId, e]));
  const nodeById = new Map(nav.nodes.map((n) => [n.id, n]));
  const nodeByClass = new Map(nav.nodes.filter((n) => n.className).map((n) => [simpleName(n.className), n]));
  const graphStart = new Map(
    (nav.files || []).filter((f) => f.startDestination).map((f) => [f.file.replace(/\.xml$/, ''), f.startDestination]),
  );

  const files = execSync(
    `find "${args.src}" -type f \\( -name "*.kt" -o -name "*.java" \\) -not -path "*/build/*" -not -path "*/test/*" -not -path "*/androidTest/*"`,
    { maxBuffer: 1024 * 1024 * 64 },
  )
    .toString()
    .split('\n')
    .filter(Boolean);

  // Functions defined inside the module get their bodies scanned by the rules
  // below, so a call to one isn't a gap — only calls into code we can't see are.
  const definedFns = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf-8').matchAll(/\bfun\s+(?:<[^>]+>\s*)?(?:\w+\.)?(\w+)\s*\(/g)) definedFns.add(m[1]);
  }

  const moduleActivities = new Set(
    files.map((f) => basename(f).replace(/\.(kt|java)$/, '')).filter((c) => /Activity$/.test(c)),
  );

  const activityNodes = new Map();
  const ensureActivity = (cls, fqn) => {
    if (nodeByClass.has(cls)) return nodeByClass.get(cls).id;
    if (!activityNodes.has(cls)) {
      activityNodes.set(cls, { id: cls, kind: 'activity', className: fqn || cls, label: cls, layout: null, sourceFile: null });
    } else if (fqn && activityNodes.get(cls).className === cls) {
      activityNodes.get(cls).className = fqn;
    }
    return cls;
  };

  const ownerOf = (cls, fqn) => {
    if (nodeByClass.has(cls)) return nodeByClass.get(cls).id;
    if (/Activity$/.test(cls)) return ensureActivity(cls, fqn);
    const base = cls.replace(/ViewModel$/, '');
    if (base !== cls) {
      for (const suffix of ['Fragment', 'Activity']) {
        if (nodeByClass.has(base + suffix)) return nodeByClass.get(base + suffix).id;
      }
      if (moduleActivities.has(base + 'Activity')) return ensureActivity(base + 'Activity');
    }
    return null;
  };

  const codeEdges = [];
  const perRule = {};
  const unmatched = new Map();
  let unattributed = 0;
  const addEdge = (from, to, rule, file, src, index) => {
    if (!from || !to || from === to) return;
    perRule[rule] = (perRule[rule] || 0) + 1;
    codeEdges.push({ from, to, rule, source: 'code', evidence: `${relative(args.src, file)}:${lineOf(src, index)}` });
  };
  const resolveCapture = (capture, value) => {
    if (capture === 'actionId') return actionMap.get(value)?.to || null;
    if (capture === 'destinationId') return nodeById.has(value) ? value : null;
    if (capture === 'className') return nodeByClass.get(value)?.id || (/Activity$/.test(value) ? ensureActivity(value) : null);
    return null;
  };

  const layoutGraphs = (layoutName) => {
    const f = join(args.src, 'res', 'layout', `${layoutName}.xml`);
    if (!existsSync(f)) return [];
    return [...readFileSync(f, 'utf-8').matchAll(/app:navGraph="@navigation\/(\w+)"/g)].map((m) => m[1]);
  };

  for (const file of files) {
    const cls = basename(file).replace(/\.(kt|java)$/, '');
    const src = stripComments(readFileSync(file, 'utf-8'));
    const pkg = src.match(/^\s*package\s+([\w.]+)/m)?.[1];
    const fqn = pkg ? `${pkg}.${cls}` : cls;
    // An abstract/open base class isn't a screen, and which subclass inherits
    // a navigation call can't be told statically — count it, don't attribute it.
    const isBaseClass = new RegExp(`\\b(abstract|open)\\s+class\\s+${cls}\\b`).test(src);
    const owner = isBaseClass ? null : ownerOf(cls, fqn);

    // 1. id-ref / id-mention — a known navigation id referenced in code.
    //    As a call's first argument it's a navigation call (id-ref); anywhere
    //    else it's a state→destination mapping (`when (s) { X -> R.id.foo }`)
    //    whose value is navigated to later (id-mention). Comparisons and
    //    pop/find calls are not navigation and are skipped.
    for (const m of src.matchAll(/R\.id\.(\w+)/g)) {
      const id = m[1];
      if (!actionMap.has(id) && !nodeById.has(id)) continue;
      const prefix = src.slice(Math.max(0, m.index - 80), m.index);
      if (/(==|!=)\s*$/.test(prefix)) continue;
      const call = prefix.match(/(\w+)\s*\(\s*$/)?.[1];
      if (call && NON_NAV_CALL.test(call)) continue;
      if (!owner) {
        unattributed++;
        continue;
      }
      addEdge(owner, actionMap.has(id) ? actionMap.get(id).to : id, call ? 'id-ref' : 'id-mention', file, src, m.index);
    }

    // 2. intent — explicit Activity launch.
    for (const m of src.matchAll(/Intent\s*\([^;]*?(\w+Activity)::class\.java/g)) {
      if (!owner) {
        unattributed++;
        continue;
      }
      addEdge(owner, ensureActivity(m[1]), 'intent', file, src, m.index);
    }

    // 2b. activity-factory — `XActivity.start(ctx)` / `.newIntent(` / `.openFrom(`:
    //     the Intent lives in X's own companion, so the launch site is the call.
    for (const m of src.matchAll(/\b(\w+Activity)\s*\.\s*(\w*(?:start|[Ii]ntent|open|launch|show)\w*)\s*\(/g)) {
      if (m[1] === cls) continue;
      if (!owner) {
        unattributed++;
        continue;
      }
      addEdge(owner, ensureActivity(m[1]), 'activity-factory', file, src, m.index);
    }

    // 3. hosts-graph — Activity → start destination of each graph it hosts.
    if (/Activity$/.test(cls)) {
      const graphs = new Set([...src.matchAll(/R\.navigation\.(\w+)/g)].map((m) => m[1]));
      const layoutRef = src.match(/R\.layout\.(\w+)/)?.[1];
      const bindingRef = src.match(/\b(Activity\w+)Binding\b/)?.[1];
      const layoutName =
        layoutRef || (bindingRef ? bindingRef.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : null);
      if (layoutName) layoutGraphs(layoutName).forEach((g) => graphs.add(g));
      for (const g of graphs) {
        const start = graphStart.get(g);
        if (start) addEdge(ensureActivity(cls, fqn), start, 'hosts-graph', file, src, 0);
      }
    }

    // Census for Step 0: navigation-looking calls whose arguments carry no
    // statically resolvable target (no nav id, Activity class, or Directions).
    // These are exactly what a team rule — or an honest `unresolved` — is for.
    for (const m of src.matchAll(/(?<!fun\s)\b(\w*[Nn]avigat\w*|startActivit\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      if (/R\.id\.|::class\.java|Activity\s*\.|Directions\./.test(m[2])) continue;
      if (!m[2].trim() || definedFns.has(m[1])) continue;
      if (/^startActivit/.test(m[1]) && /^\s*\w+\s*(,|$)/.test(m[2])) continue;
      const key = m[1].replace(/^(navigateTo|checkNavigateTo)[A-Z]\w*/, '$1*');
      if (!unmatched.has(key)) unmatched.set(key, { call: key, count: 0, examples: [] });
      const u = unmatched.get(key);
      u.count++;
      if (u.examples.length < 3) u.examples.push(`${relative(args.src, file)}:${lineOf(src, m.index)}`);
    }

    // 4. team rules from .hld-rules.json.
    for (const rule of customRules) {
      for (const m of src.matchAll(new RegExp(rule.pattern, 'g'))) {
        const to = resolveCapture(rule.capture, m[1]);
        if (!to) continue;
        if (!owner) {
          unattributed++;
          continue;
        }
        addEdge(owner, to, `rule:${rule.name}`, file, src, m.index);
      }
    }
  }

  const seen = new Set((nav.edges || []).map((e) => `${e.from}|${e.to}`));
  const merged = [...(nav.edges || []).map((e) => ({ ...e, source: e.source || 'xml' }))];
  for (const e of codeEdges) {
    const key = `${e.from}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }

  const touched = new Set(merged.flatMap((e) => [e.from, e.to]));
  // An Activity only becomes a screen when some edge reaches or leaves it —
  // otherwise every `*Activity` file (base classes included) would show up.
  const usedActivities = [...activityNodes.values()].filter((a) => touched.has(a.id));
  const nodes = [...nav.nodes, ...usedActivities];
  const orphanNodes = nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);

  const output = {
    ...nav,
    generatedBy: 'extract-nav-graph.mjs + extract-code-nav.mjs (deterministic, no LLM)',
    screenCount: nodes.length,
    edgeCount: merged.length,
    orphanCount: orphanNodes.length,
    nodes,
    edges: merged,
    orphanNodes,
    codeNav: {
      rulesApplied: ['id-ref', 'intent', 'hosts-graph', ...customRules.map((r) => `rule:${r.name}`)],
      matchesPerRule: perRule,
      newEdges: merged.length - (nav.edges || []).length,
      unattributedMatches: unattributed,
      unmatchedNavCalls: [...unmatched.values()].sort((a, b) => b.count - a.count),
    },
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(
    `✓ ${nodes.length} screens (+${usedActivities.length} activities), ${merged.length} edges (+${output.codeNav.newEdges} from code), ${orphanNodes.length} orphan → ${args.out}`,
  );
  console.log(`  matches per rule: ${JSON.stringify(perRule)}${unattributed ? `, unattributed: ${unattributed}` : ''}`);
}

main();
