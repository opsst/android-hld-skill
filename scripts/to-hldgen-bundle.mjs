#!/usr/bin/env node
/**
 * Converts this skill's output into an HLDGen bundle — the JSON the iOS
 * HLDGen Figma plugin (https://github.com/Ntpstv/HLDGen, `HLDFigmaPlugin/`)
 * imports. Android and iOS then share one Figma renderer: the same board,
 * journeys, flow layout, decision diamonds and GOES TO links, whichever
 * platform the screens came from.
 *
 * Mapping (Android → HLDGen):
 *   nav node                → scene (`viewControllers` holds the Fragment/Activity class)
 *   flow (nav graph file)   → `group`, the journey the plugin lays out
 *   android:label           → `navigationTitle` (`@string/x` resolved with --strings)
 *   outgoing edge           → `actionChains[]` entry; `action` is the button that
 *                             triggers it, else the `<action>` id, else the code rule
 *   layout elements         → `xibs[0].nodes`, stacked top to bottom on a 360-wide
 *                             canvas (Android layouts carry no absolute frames)
 *
 * Left empty rather than guessed: `apiEndpoints`, `notifications`, `localStorage`.
 *
 * Usage:
 *   node to-hldgen-bundle.mjs --nav-json <nav.json> [--xml-ui-json <ui.json>] [--buttons-json <buttons.json>] [--strings <strings.xml>] [--module <name>] --out <bundle.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assignFlows, labelOf } from './layout-flows.mjs';

const CANVAS_W = 360;
const MIN_CANVAS_H = 344; // the plugin's card body ratio, so width decides the scale
const MARGIN = 16;
const GAP = 12;

// Element height on the wireframe canvas and the HLDGen node type it maps to.
const SHAPES = {
  button: { type: 'button', h: 44, color: '#4D8FFF' },
  imagebutton: { type: 'button', h: 44, color: '#4D8FFF' },
  text: { type: 'label', h: 20, color: '#C7CEDE' },
  radiogroup: { type: 'label', h: 20, color: '#C7CEDE' },
  checkbox: { type: 'label', h: 24, color: '#C7CEDE' },
  radio: { type: 'label', h: 24, color: '#C7CEDE' },
  input: { type: 'view', h: 44, color: '#8B93A7' },
  numberpicker: { type: 'view', h: 44, color: '#8B93A7' },
  spinner: { type: 'view', h: 44, color: '#8B93A7' },
  progress: { type: 'view', h: 8, color: '#4D8FFF' },
  image: { type: 'image', h: 120, color: '#F5C518' },
  list: { type: 'list', h: 180, color: '#5C6B8A' },
};

const RULE_LABEL = {
  'hosts-graph': 'hosts nav graph',
  intent: 'startActivity',
  'activity-factory': 'Activity factory',
  'fragment-transaction': 'FragmentTransaction',
  'id-ref': 'navigate',
  'id-mention': 'navigate',
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function readStrings(path) {
  const map = new Map();
  if (!path) return map;
  const xml = readFileSync(path, 'utf-8');
  for (const m of xml.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) map.set(m[1], m[2].trim());
  return map;
}

/** An Android layout has no absolute frames, so elements are stacked in source order. */
function wireNodes(elements) {
  const nodes = [];
  let y = MARGIN;
  for (const el of elements) {
    const s = SHAPES[el.type];
    if (!s) continue;
    const label = el.label || el.id;
    const node = { type: s.type, color: s.color, label, x: MARGIN, y, w: CANVAS_W - MARGIN * 2, h: s.h, children: [] };
    // HLDGen draws a `view` as a bare box; an input keeps its hint/id readable as a child label.
    if (s.type === 'view' && s.h >= 20) {
      node.children.push({ type: 'label', color: '#8B93A7', label, x: MARGIN + 10, y: y + 12, w: 200, h: 20, children: [] });
    }
    nodes.push(node);
    y += s.h + GAP;
  }
  // The plugin scales the canvas to fit its card, so a short canvas keeps a
  // few-element screen at full card width instead of a thumbnail in one corner.
  return { nodes, height: Math.max(MIN_CANVAS_H, y + MARGIN) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args.out) {
    console.error(
      'Usage: node to-hldgen-bundle.mjs --nav-json <nav.json> [--xml-ui-json <ui.json>] [--buttons-json <buttons.json>] [--strings <strings.xml>] [--module <name>] --out <bundle.json>',
    );
    process.exit(1);
  }

  const nav = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const ui = args['xml-ui-json'] ? JSON.parse(readFileSync(args['xml-ui-json'], 'utf-8')) : { layouts: [] };
  const buttons = args['buttons-json'] ? JSON.parse(readFileSync(args['buttons-json'], 'utf-8')) : { screens: [] };
  const strings = readStrings(args.strings);
  const moduleName = args.module || 'app';

  const nodeById = new Map(nav.nodes.map((n) => [n.id, n]));
  const flowOf = assignFlows(nav);
  const buttonsByScreen = new Map((buttons.screens || []).map((s) => [s.screenId, s.buttons || []]));
  const layoutFor = (node) => node.layout && (ui.layouts || []).find((l) => l.layoutFile.endsWith(`/${node.layout}.xml`));

  // The plugin keys edges by scene name, so a class used under two destination ids needs two names.
  const classCount = new Map();
  for (const n of nav.nodes) classCount.set(labelOf(n), (classCount.get(labelOf(n)) || 0) + 1);
  const nameOf = (n) => (classCount.get(labelOf(n)) > 1 ? `${labelOf(n)} (${n.id})` : labelOf(n));

  const scenes = nav.nodes.map((node) => {
    const cls = labelOf(node);

    let navigationTitle = '';
    let navigationTitleKey = '';
    const rawLabel = node.label && node.label !== node.layout && node.label !== node.id ? node.label : '';
    const key = rawLabel.match(/^@string\/(\w+)$/);
    if (key) {
      navigationTitleKey = key[1];
      navigationTitle = strings.get(key[1]) || key[1];
    } else if (rawLabel && !rawLabel.startsWith('@')) {
      navigationTitle = rawLabel;
    }

    const actionChains = [];
    const seen = new Set();
    for (const e of nav.edges || []) {
      if (e.from !== node.id) continue;
      const target = nodeById.get(e.to);
      const dest = target ? labelOf(target) : e.to;
      const btn = (buttonsByScreen.get(node.id) || []).find(
        (b) => b.action?.type === 'navigate' && b.action.target === e.to && (!e.actionId || !b.action.via || b.action.via === e.actionId),
      );
      const action = btn ? btn.label || btn.id : e.actionId || RULE_LABEL[e.rule] || e.rule || 'navigate';
      const k = `${action}->${dest}`;
      if (seen.has(k)) continue;
      seen.add(k);
      actionChains.push({
        action,
        kind: btn ? 'button' : e.source === 'code' ? `code:${e.rule}` : 'nav-action',
        file: e.evidence || e.sourceFile || '',
        calls: [],
        vcRoutes: [],
        emittedCases: [],
        resolvedDestinations: [dest],
      });
    }

    const layout = layoutFor(node);
    const wf = layout ? wireNodes(layout.elements || []) : null;
    const xibs = [
      {
        source: 'layout',
        vcClass: cls,
        file: layout ? layout.layoutFile.split('/').slice(-3).join('/') : '',
        width: CANVAS_W,
        height: wf ? wf.height : MIN_CANVAS_H,
        nodes: wf
          ? wf.nodes
          : [{ type: 'label', color: '#8B93A7', label: node.layout ? `${node.layout}.xml not found` : 'no layout linked', x: MARGIN, y: MARGIN, w: 300, h: 20, children: [] }],
        outlets: [],
        actions: [],
      },
    ];

    return {
      id: node.id,
      name: nameOf(node),
      module: moduleName,
      group: flowOf.get(node.id) === 'app' ? moduleName : flowOf.get(node.id),
      navigationTitle,
      navigationTitleKey,
      navigationBarHidden: false,
      notifications: [],
      localStorage: [],
      viewControllers: [cls],
      interactors: [],
      presenters: [],
      routers: [],
      workers: [],
      routesTo: [],
      servicesUsed: [],
      actionChains,
      xibs,
      apiEndpoints: [],
    };
  });

  // The plugin resolves a destination to the first scene whose class name the destination
  // string contains; longest names first makes that the exact class, never a shorter suffix.
  scenes.sort((a, b) => b.viewControllers[0].length - a.viewControllers[0].length);

  const bundle = { module: moduleName, scenes };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(bundle, null, 2));
  const groups = new Set(scenes.map((s) => s.group));
  const chains = scenes.reduce((t, s) => t + s.actionChains.length, 0);
  console.log(`wrote ${scenes.length} scene(s) in ${groups.size} journey(s), ${chains} action chain(s) → ${args.out}`);
}

main();
