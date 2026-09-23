#!/usr/bin/env node
/**
 * The HLD canvas: one section per flow, laid out by `layout-flows.mjs`
 * (layered, crossing-minimised, destinations outside the flow as ghost cards),
 * where each node is the screen's actual wireframe (render-wireframe.mjs style)
 * and arrows are labeled with the button that triggers each transition.
 *
 * This bypasses archify entirely — archify's node schema has no room for an
 * embedded custom graphic per node (label/sublabel/tag only), so the merged
 * view has to be its own plain SVG canvas — but it borrows archify's actual
 * *visual design tokens* (colors, glow shadows, corner radii, mono type)
 * read directly out of a real `deliver`-ed archify HTML, so the result reads
 * like an archify diagram even though it isn't rendered by archify's engine.
 *
 * Usage:
 *   node render-flow-wireframes.mjs --nav-json <nav.json> --xml-ui-json <ui.json> --buttons-json <buttons.json> --title "<title>" --out <canvas.html>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { layoutFlows, curvePath } from './layout-flows.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** DOM-id-safe token — hover wiring needs stable ids to look up tooltip data,
 *  not just visual labels, so any character outside [a-zA-Z0-9_-] is dropped. */
function safeAttr(s) {
  return String(s ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Palette lifted from a real archify `deliver` output (navbasic-delivered.html):
// --bg:#020617, --frontend-stroke:#22d3ee/#0891b2, --database-stroke:#a78bfa,
// glow via box-shadow/drop-shadow with color-mix(... 40-70%, transparent),
// node corner radius rx="10", JetBrains Mono for chrome text.
const PALETTE = {
  bg: '#020617',
  panel: '#070c17',
  border: 'rgba(148,163,184,0.14)',
  text: '#e6edf3',
  textDim: '#94a3b8',
  textFaint: '#64748b',
  frontend: '#22d3ee',
  frontendDim: '#0891b2',
  database: '#a78bfa',
  ok: '#2dd4bf',
  warn: '#fbbf24',
  danger: '#f87171',
};

const TYPE_STYLE = {
  button: { fill: 'rgba(34,211,238,0.10)', stroke: PALETTE.frontend, textColor: '#8be9f7', shape: 'button' },
  imagebutton: { fill: 'rgba(34,211,238,0.10)', stroke: PALETTE.frontend, textColor: '#8be9f7', shape: 'button' },
  text: { fill: 'none', stroke: 'none', textColor: PALETTE.textDim, shape: 'text' },
  input: { fill: 'rgba(148,163,184,0.05)', stroke: '#334155', textColor: PALETTE.textFaint, shape: 'box' },
  image: { fill: 'rgba(167,139,250,0.08)', stroke: PALETTE.database, textColor: '#c4b5fd', shape: 'dashedBox' },
  list: { fill: 'rgba(148,163,184,0.04)', stroke: '#293548', textColor: PALETTE.textDim, shape: 'list' },
  checkbox: { fill: 'none', stroke: '#334155', textColor: '#cbd5e1', shape: 'checkbox' },
  radio: { fill: 'none', stroke: '#334155', textColor: '#cbd5e1', shape: 'checkbox' },
  radiogroup: { fill: 'none', stroke: 'none', textColor: PALETTE.textDim, shape: 'text' },
  numberpicker: { fill: 'rgba(148,163,184,0.05)', stroke: '#334155', textColor: '#cbd5e1', shape: 'box' },
  progress: { fill: PALETTE.frontend, stroke: 'none', textColor: PALETTE.textDim, shape: 'bar' },
  spinner: { fill: 'rgba(148,163,184,0.05)', stroke: '#334155', textColor: '#cbd5e1', shape: 'box' },
};

const PHONE_W = 240;
const ROW_H = 42;
const PAD = 12;
const GHOST_W = 240;
const GHOST_H = 64;
const FLOW_TITLE_H = 44;
const FLOW_GAP = 36;

/** Build a phone's inner markup (no outer <svg>, so it can be embedded in a
 *  <g transform="translate(...)"> at an arbitrary canvas position) plus its
 *  own height, so the caller can compute arrow anchor points and row spacing. */
function buildPhoneGroup(screenId, elements, buttonInfoById) {
  const rows = elements.filter((e) => e.type);
  let y = 40 + PAD;
  const parts = [];
  const anchors = {}; // buttonId -> y of its centre, where its arrow leaves the card
  const svgH = rows.length * (ROW_H + 8) + PAD * 2 + 40 || 100;

  // Card body — archify's node glow: soft cyan drop-shadow behind a dark
  // rounded rect (rx 10-16, matching archify's own node corner radius).
  parts.push(
    `<rect x="-1" y="-1" width="${PHONE_W + 2}" height="${svgH + 2}" rx="15" fill="none" stroke="${PALETTE.frontend}" stroke-opacity="0.22" stroke-width="6" filter="url(#cardGlow)"/>`,
  );
  parts.push(`<rect x="0" y="0" width="${PHONE_W}" height="${svgH}" rx="14" fill="${PALETTE.panel}" stroke="rgba(34,211,238,0.35)" stroke-width="1.2"/>`);
  parts.push(`<rect x="0" y="0" width="${PHONE_W}" height="32" rx="14" fill="#0b1220"/>`);
  parts.push(`<rect x="0" y="16" width="${PHONE_W}" height="16" fill="#0b1220"/>`);
  parts.push(`<rect x="0" y="31" width="${PHONE_W}" height="1" fill="rgba(34,211,238,0.22)"/>`);
  parts.push(`<circle cx="14" cy="16" r="3" fill="${PALETTE.frontend}"/>`);
  parts.push(
    `<text x="24" y="20" text-anchor="start" font-family="'JetBrains Mono', ui-monospace, monospace" font-size="10" letter-spacing="0.3" fill="${PALETTE.text}" font-weight="600">${esc(screenId)}</text>`,
  );

  for (const el of rows) {
    const style = TYPE_STYLE[el.type] || TYPE_STYLE.text;
    const label = el.label || el.id;
    const rowW = PHONE_W - PAD * 2;

    if (style.shape === 'text') {
      parts.push(`<text x="${PAD}" y="${y + 15}" font-family="Inter, sans-serif" font-size="10" fill="${style.textColor}">${esc(truncate(label, 26))}</text>`);
    } else if (style.shape === 'button') {
      const info = buttonInfoById?.[el.id];
      anchors[el.id] = y + 14;
      const btnParts = [];
      btnParts.push(`<rect x="${PAD}" y="${y}" width="${rowW}" height="28" rx="7" fill="${style.fill}" stroke="${style.stroke}" stroke-width="1.2"/>`);
      btnParts.push(`<text x="${PHONE_W / 2}" y="${y + 18}" text-anchor="middle" font-family="Inter, sans-serif" font-size="10" font-weight="600" fill="${style.textColor}">${esc(truncate(label, 22))}</text>`);
      if (info) {
        btnParts.push(
          `<rect x="${PAD}" y="${y + 32}" width="${rowW}" height="15" rx="6" fill="rgba(2,6,23,0.6)" stroke="${info.color}" stroke-opacity="0.4"/>`,
        );
        btnParts.push(`<text x="${PAD + 6}" y="${y + 42}" font-family="'JetBrains Mono', monospace" font-size="8" fill="${info.color}">${esc(info.caption)}</text>`);
        y += 20;
      }
      // Hoverable hit-region: a transparent rect covering the button (+
      // caption line, when present) so hover works anywhere over either,
      // tagged with the screen/button ids the JS payload is keyed by.
      const hitH = 28 + (info ? 20 : 0);
      parts.push(
        `<g class="hoverable-btn" data-screen="${esc(screenId)}" data-button="${esc(el.id)}">` +
          `${btnParts.join('')}` +
          `<rect x="${PAD}" y="${y - (info ? 20 : 0)}" width="${rowW}" height="${hitH}" fill="transparent"/>` +
          `</g>`,
      );
    } else if (style.shape === 'dashedBox') {
      parts.push(`<rect x="${PAD}" y="${y}" width="${rowW}" height="28" rx="5" fill="${style.fill}" stroke="${style.stroke}" stroke-dasharray="4 3"/>`);
      parts.push(`<text x="${PAD + 6}" y="${y + 18}" font-family="Inter, sans-serif" font-size="8" fill="${style.textColor}">🖼 ${esc(truncate(label, 20))}</text>`);
    } else if (style.shape === 'list') {
      parts.push(`<rect x="${PAD}" y="${y}" width="${rowW}" height="28" rx="5" fill="${style.fill}" stroke="${style.stroke}"/>`);
      parts.push(`<line x1="${PAD + 6}" y1="${y + 9}" x2="${PAD + rowW - 6}" y2="${y + 9}" stroke="${style.stroke}"/>`);
      parts.push(`<line x1="${PAD + 6}" y1="${y + 18}" x2="${PAD + rowW - 6}" y2="${y + 18}" stroke="${style.stroke}"/>`);
    } else if (style.shape === 'bar') {
      parts.push(`<rect x="${PAD}" y="${y + 11}" width="${rowW}" height="4" rx="2" fill="${style.fill}" opacity="0.6"/>`);
    } else if (style.shape === 'checkbox') {
      parts.push(`<rect x="${PAD}" y="${y + 5}" width="14" height="14" rx="4" fill="none" stroke="${style.stroke}"/>`);
      parts.push(`<text x="${PAD + 20}" y="${y + 16}" font-family="Inter, sans-serif" font-size="9" fill="${style.textColor}">${esc(truncate(label, 20))}</text>`);
    } else {
      parts.push(`<rect x="${PAD}" y="${y}" width="${rowW}" height="28" rx="7" fill="${style.fill}" stroke="${style.stroke}"/>`);
      parts.push(`<text x="${PAD + 6}" y="${y + 18}" font-family="Inter, sans-serif" font-size="9" fill="${style.textColor}">${esc(truncate(label || el.id, 22))}</text>`);
    }
    y += ROW_H;
  }

  return { inner: parts.join(''), width: PHONE_W, height: svgH, anchors };
}

/** A screen that lives in another flow: a dashed card naming it and its flow. */
function buildGhostCard(label, flow) {
  return (
    `<rect x="0" y="0" width="${GHOST_W}" height="${GHOST_H}" rx="12" fill="${PALETTE.bg}" stroke="${PALETTE.textFaint}" stroke-dasharray="5 4"/>` +
    `<text x="14" y="27" font-family="'JetBrains Mono', monospace" font-size="10" font-weight="600" fill="${PALETTE.textDim}">${esc(truncate(label, 32))}</text>` +
    `<text x="14" y="46" font-family="'JetBrains Mono', monospace" font-size="9" fill="${PALETTE.textFaint}">→ ${esc(flow || 'other flow')}</text>`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['nav-json'] || !args['xml-ui-json'] || !args['buttons-json'] || !args.out) {
    console.error(
      'Usage: node render-flow-wireframes.mjs --nav-json <nav.json> --xml-ui-json <ui.json> --buttons-json <buttons.json> [--api-json <api-chain.json>] [--title "<title>"] --out <canvas.html>',
    );
    process.exit(1);
  }

  const nav = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const xmlUi = JSON.parse(readFileSync(args['xml-ui-json'], 'utf-8'));
  const buttonsData = JSON.parse(readFileSync(args['buttons-json'], 'utf-8'));

  const elementsByLayout = new Map();
  for (const l of xmlUi.layouts || []) elementsByLayout.set(l.layoutFile, l.elements || []);
  const buttonsByScreen = new Map();
  for (const s of buttonsData.screens || []) buttonsByScreen.set(s.screenId, s.buttons || []);

  // Build every wireframe first: its real height (a screen with ten fields is
  // taller than one with two) is what the layered layout stacks columns with.
  const built = new Map(); // id -> { inner, width, height }
  for (const node of nav.nodes) {
    let elements = [];
    if (node.layout) {
      for (const [layoutFile, els] of elementsByLayout) {
        if (layoutFile.includes(node.layout)) {
          elements = els;
          break;
        }
      }
    }
    const buttonInfoById = {};
    for (const b of buttonsByScreen.get(node.id) || []) {
      if (b.action?.type === 'navigate') {
        buttonInfoById[b.id] = {
          caption: b.action.guard ? `🔒 if (${truncate(b.action.guard, 22)}) → ${b.action.target}` : `→ ${b.action.target}`,
          color: b.action.guard ? PALETTE.warn : PALETTE.ok,
        };
      } else if (b.action?.type === 'unresolved') {
        buttonInfoById[b.id] = { caption: `⚠ ${truncate(b.action.reason, 26)}`, color: PALETTE.danger };
      }
    }
    built.set(node.id, buildPhoneGroup(node.kind === 'activity' ? node.label || node.id : node.id, elements, buttonInfoById));
  }

  const flows = layoutFlows(nav, (n) => (n.ghost ? { w: GHOST_W, h: GHOST_H } : { w: PHONE_W, h: built.get(n.id).height }));

  // One section per flow, stacked top to bottom, each under its own title.
  const cards = [];
  const placed = []; // { flow, dy }
  let offsetY = 16;
  for (const f of flows) {
    const screens = f.nodes.filter((n) => !n.ghost).length;
    cards.push(
      `<text x="40" y="${offsetY + 26}" font-family="'JetBrains Mono', monospace" font-size="15" font-weight="600" fill="${PALETTE.text}">${esc(f.title)}</text>` +
        `<text x="40" y="${offsetY + 42}" font-family="'JetBrains Mono', monospace" font-size="10" fill="${PALETTE.textFaint}">${screens} screens · ${f.edges.length} connections</text>`,
    );
    const dy = offsetY + FLOW_TITLE_H;
    for (const n of f.nodes) {
      const t = `translate(${n.x},${n.y + dy})`;
      cards.push(
        n.ghost
          ? `<g class="node-card ghost-card" data-screen="${esc(n.target)}" transform="${t}">${buildGhostCard(n.label, n.flow)}</g>`
          : `<g class="node-card" data-screen="${esc(n.id)}" transform="${t}">${built.get(n.id).inner}</g>`,
      );
    }
    placed.push({ flow: f, dy });
    offsetY = dy + f.height + FLOW_GAP;
  }
  const groups = cards.join('\n');

  // Optional Tier-1 API-chain resolution (resolve-api-chain-paths.mjs output,
  // only meaningful for repos following its UseCase/Repository/Service
  // naming convention) — most demo repos won't have this file, so the
  // tooltip's API line is left blank rather than guessed, per the same
  // disclosed-gap discipline as everything else in this skill).
  const apiByScreen = new Map();
  if (args['api-json']) {
    const apiData = JSON.parse(readFileSync(args['api-json'], 'utf-8'));
    for (const s of apiData.screens || apiData || []) {
      if (s.screenId) apiByScreen.set(s.screenId, s);
    }
  }

  const arrows = [];
  const arrowLabels = [];
  const buttonMeta = {}; // "screen::button" -> tooltip payload
  const screenMeta = {}; // screenId -> tooltip payload

  for (const node of nav.nodes) {
    const incoming = (nav.edges || [])
      .filter((e) => e.to === node.id)
      .map((e) => ({ from: e.from, via: e.actionId }));
    let elements = [];
    if (node.layout) {
      for (const [layoutFile, els] of elementsByLayout) {
        if (layoutFile.includes(node.layout)) {
          elements = els;
          break;
        }
      }
    }
    screenMeta[node.id] = {
      className: node.className || null,
      layout: node.layout || null,
      sourceFile: node.sourceFile || null,
      incoming,
      elements: elements.filter((e) => e.type).map((e) => ({ id: e.id, type: e.type, label: e.label || null })),
    };
  }

  for (const screen of buttonsData.screens || []) {
    const outgoingSummary = [];
    for (const btn of screen.buttons || []) {
      const key = `${screen.screenId}::${btn.id}`;
      const api = apiByScreen.get(screen.screenId);
      buttonMeta[key] = {
        label: btn.label || btn.id,
        type: btn.action?.type || 'unresolved',
        target: btn.action?.target || null,
        via: btn.action?.via || null,
        guard: btn.action?.guard || null,
        reason: btn.action?.reason || null,
        api: api ? { resolved: !!api.resolved, files: api.candidateFiles || [] } : null,
      };
      outgoingSummary.push({
        button: btn.label || btn.id,
        type: btn.action?.type || 'unresolved',
        target: btn.action?.target || null,
        guard: btn.action?.guard || null,
      });
    }
    if (screenMeta[screen.screenId]) {
      screenMeta[screen.screenId].outgoingButtons = outgoingSummary;
      screenMeta[screen.screenId].screenLevelActions = (screen.screenLevelActions || []).map((a) => ({
        via: a.via,
        target: a.target,
      }));
    }

  }

  // Arrows: every edge of every flow, drawn along the route the layout
  // computed. A button that triggers an edge labels it and owns it for hover.
  const buttonsOnEdge = new Map(); // "from|to" -> [{ id, label, guard }]
  for (const s of buttonsData.screens || []) {
    for (const b of s.buttons || []) {
      if (b.action?.type !== 'navigate' || !b.action.target) continue;
      const k = `${s.screenId}|${b.action.target}`;
      (buttonsOnEdge.get(k) || buttonsOnEdge.set(k, []).get(k)).push({ id: b.id, label: b.label || b.id, guard: b.action.guard });
    }
  }
  for (const { flow, dy } of placed) {
    const nodeAt = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const e of flow.edges) {
      const to = e.to.startsWith('ghost:') ? e.to.slice('ghost:'.length) : e.to;
      const btns = buttonsOnEdge.get(`${e.from}|${to}`) || [];
      const guarded = btns.some((b) => b.guard);
      const stroke = e.back ? PALETTE.textDim : guarded ? PALETTE.warn : PALETTE.frontend;
      const edgeId = `edge__${safeAttr(flow.id)}__${safeAttr(e.from)}__${safeAttr(e.to)}`;
      const pts = e.points.map(([x, y]) => [x, y + dy]);
      // Like a sticky note per action: a button-triggered arrow leaves the
      // card from that button, so sibling arrows don't share one start point.
      const anchorY = !e.back && btns.length && built.get(e.from)?.anchors?.[btns[0].id];
      if (anchorY) pts[0] = [pts[0][0], nodeAt.get(e.from).y + dy + anchorY];
      arrows.push(
        `<path id="${edgeId}" class="flow-edge" data-from="${esc(e.from)}" data-to="${esc(to)}" ` +
          `d="${curvePath(pts)}" fill="none" stroke="${stroke}" stroke-width="2" marker-end="url(${guarded ? '#arrowWarn' : '#arrow'})" filter="url(#lineGlow)" ${guarded || e.back ? 'stroke-dasharray="6 5"' : ''}/>`,
      );
      for (const b of btns) {
        const key = `${e.from}::${b.id}`;
        if (buttonMeta[key]) buttonMeta[key].edgeId = edgeId;
      }
      // An arrow leaving a button needs no label — the button and its
      // "→ target" caption already say it. Only unanchored ones get one.
      if (!btns.length || anchorY) continue;
      const text = truncate(btns.map((b) => b.label).join(' / '), 16);
      const w = Math.max(46, text.length * 5.6 + 16);
      const [x, y] = pts[0];
      arrowLabels.push(
        `<g class="edge-label" data-edge="${edgeId}" transform="translate(${x + 8},${y - 22})">` +
          `<rect width="${w}" height="18" rx="9" fill="${PALETTE.panel}" stroke="${stroke}" stroke-opacity="0.5"/>` +
          `<text x="${w / 2}" y="12.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="9" fill="${guarded ? '#fde68a' : '#a5f3fc'}">${esc(text)}</text>` +
          `</g>`,
      );
    }
  }

  const canvasW = Math.max(600, ...flows.map((f) => f.width));
  const canvasH = offsetY;
  const fileSlug = (args.title || 'screen-flow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'screen-flow';

  const resolvedCount = (buttonsData.screens || []).reduce(
    (n, s) => n + (s.buttons || []).filter((b) => b.action?.type === 'navigate' && !b.action.guard).length,
    0,
  );
  const guardedCount = (buttonsData.screens || []).reduce(
    (n, s) => n + (s.buttons || []).filter((b) => b.action?.type === 'navigate' && b.action.guard).length,
    0,
  );
  const unresolvedCount = (buttonsData.screens || []).reduce(
    (n, s) => n + (s.buttons || []).filter((b) => b.action?.type === 'unresolved').length,
    0,
  );

  const html = `<meta charset="utf-8">
<title>${esc(args.title || 'Screen Flow + Wireframes')}</title>
<style>
  :root {
    --bg: ${PALETTE.bg}; --panel: ${PALETTE.panel}; --border: ${PALETTE.border};
    --text: ${PALETTE.text}; --text-dim: ${PALETTE.textDim}; --text-faint: ${PALETTE.textFaint};
    --frontend: ${PALETTE.frontend}; --ok: ${PALETTE.ok}; --warn: ${PALETTE.warn}; --danger: ${PALETTE.danger};
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); margin: 0; }
  body {
    color: var(--text); font-family: Inter, sans-serif; padding: 32px 28px 40px;
    background-image: radial-gradient(circle at 15% 0%, rgba(34,211,238,0.08), transparent 45%),
                       radial-gradient(circle at 85% 100%, rgba(167,139,250,0.06), transparent 45%);
  }
  header { max-width: 980px; margin: 0 0 22px; }
  h1 {
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 22px; font-weight: 600;
    margin: 0 0 8px; letter-spacing: 0.2px; color: var(--text);
  }
  p.sub { color: var(--text-dim); font-size: 13px; max-width: 74ch; margin: 0 0 16px; line-height: 1.6; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; font-family: 'JetBrains Mono', monospace;
    font-size: 11px; color: var(--text-dim); padding: 5px 11px; border-radius: 999px;
    background: rgba(148,163,184,0.06); border: 1px solid var(--border);
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 6px currentColor; }
  .chip.ok .dot { background: var(--ok); color: var(--ok); }
  .chip.warn .dot { background: var(--warn); color: var(--warn); }
  .chip.danger .dot { background: var(--danger); color: var(--danger); }
  .chip b { color: var(--text); font-weight: 600; }
  .toolbar { display: flex; gap: 6px; margin: 16px 0; }
  .toolbar button {
    font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-dim);
    background: rgba(148,163,184,0.06); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 12px; cursor: pointer;
  }
  .toolbar button:hover { color: var(--text); border-color: var(--frontend); }
  .toolbar-sep { width: 1px; background: var(--border); margin: 2px 4px; }
  .canvas-wrap {
    overflow: auto; border: 1px solid var(--border); border-radius: 16px;
    background:
      radial-gradient(circle, rgba(148,163,184,0.10) 1px, transparent 1px) 0 0/22px 22px,
      var(--panel);
    box-shadow: 0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.02);
    cursor: grab; height: 78vh;
  }
  .canvas-wrap.dragging { cursor: grabbing; }
  #stage { transform-origin: 0 0; }

  .node-card, .flow-edge, .edge-label { transition: opacity 0.15s ease; }
  .node-card.dim, .flow-edge.dim, .edge-label.dim { opacity: 0.22; }
  .flow-edge.active { stroke-width: 3.5 !important; }
  .hoverable-btn { cursor: pointer; }

  #tooltip {
    position: fixed; z-index: 50; max-width: 300px; pointer-events: none;
    background: #0b1220; border: 1px solid rgba(34,211,238,0.4); border-radius: 10px;
    padding: 10px 12px; box-shadow: 0 16px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02);
    font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-dim);
    line-height: 1.55; opacity: 0; transform: translateY(4px); transition: opacity 0.1s ease;
  }
  #tooltip.show { opacity: 1; }
  #tooltip .tt-title { color: var(--text); font-weight: 600; font-size: 12px; margin-bottom: 4px; display: block; }
  #tooltip .tt-row { display: flex; gap: 6px; margin-top: 3px; }
  #tooltip .tt-row .k { color: var(--text-faint); flex: 0 0 auto; }
  #tooltip .tt-row .v { color: var(--text-dim); word-break: break-word; }
  #tooltip .tt-ok { color: var(--ok); }
  #tooltip .tt-warn { color: var(--warn); }
  #tooltip .tt-danger { color: var(--danger); }
  #tooltip ul { margin: 4px 0 0; padding-left: 14px; }
  #tooltip li { margin: 1px 0; }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap">
<header>
  <h1>${esc(args.title || 'Screen Flow + Wireframes')}</h1>
  <p class="sub">
    One diagram per flow, left to right in navigation order. Each card is the
    screen's real wireframe; dashed cards on the right live in another flow.
    Arrows are labeled with the button that triggers them — hover a screen or
    a button for details.
  </p>
  <div class="legend">
    <span class="chip ok"><span class="dot"></span>Resolved navigate <b>${resolvedCount}</b></span>
    <span class="chip warn"><span class="dot"></span>Guarded (condition found) <b>${guardedCount}</b></span>
    <span class="chip danger"><span class="dot"></span>Unresolved <b>${unresolvedCount}</b></span>
  </div>
</header>
<div class="toolbar">
  <button id="zoomIn">+ Zoom in</button>
  <button id="zoomOut">– Zoom out</button>
  <button id="zoomReset">Reset</button>
  <span class="toolbar-sep"></span>
  <button id="exportSvg">⭳ Export SVG</button>
  <button id="exportPng">⭳ Export PNG</button>
</div>
<div class="canvas-wrap" id="wrap">
<svg id="stage" width="${canvasW}" height="${canvasH}" viewBox="0 0 ${canvasW} ${canvasH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="cardGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="6" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <!-- userSpaceOnUse: a perfectly straight edge has a zero-height bounding
         box, and a bbox-relative filter region would make it vanish. -->
    <filter id="lineGlow" filterUnits="userSpaceOnUse" x="0" y="0" width="${canvasW}" height="${canvasH}">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="${PALETTE.frontend}"/>
    </marker>
    <marker id="arrowWarn" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="${PALETTE.warn}"/>
    </marker>
  </defs>
  ${arrows.join('\n  ')}
  ${groups}
  ${arrowLabels.join('\n  ')}
</svg>
</div>
<div id="tooltip"></div>
<script>
window.__META__ = ${JSON.stringify({ screens: screenMeta, buttons: buttonMeta })};
</script>
<script>
(function(){
  var wrap = document.getElementById('wrap');
  var stage = document.getElementById('stage');
  var scale = 1, tx = 0, ty = 0, dragging = false, lastX = 0, lastY = 0;
  function apply(){ stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')'; }
  document.getElementById('zoomIn').onclick = function(){ scale = Math.min(2.5, scale + 0.15); apply(); };
  document.getElementById('zoomOut').onclick = function(){ scale = Math.max(0.25, scale - 0.15); apply(); };
  document.getElementById('zoomReset').onclick = function(){ scale = 1; tx = 0; ty = 0; apply(); };
  wrap.addEventListener('mousedown', function(e){ dragging = true; lastX = e.clientX; lastY = e.clientY; wrap.classList.add('dragging'); });
  window.addEventListener('mouseup', function(){ dragging = false; wrap.classList.remove('dragging'); });
  window.addEventListener('mousemove', function(e){
    if (!dragging) return;
    tx += (e.clientX - lastX); ty += (e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY; apply();
  });
  wrap.addEventListener('wheel', function(e){
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    scale = Math.min(2.5, Math.max(0.25, scale + (e.deltaY < 0 ? 0.1 : -0.1)));
    apply();
  }, { passive: false });
})();

// Hover: screen card -> what this screen is (extracted deterministically,
// not a guessed description); button -> what it navigates to, any guard
// condition found in source, and any resolved API chain (left blank when
// resolve-api-chain-paths.mjs wasn't run for this repo — not guessed).
(function(){
  var META = window.__META__;
  var stage = document.getElementById('stage');
  var tooltip = document.getElementById('tooltip');
  var allCards = stage.querySelectorAll('.node-card');
  var allEdges = stage.querySelectorAll('.flow-edge');
  var allLabels = stage.querySelectorAll('.edge-label');

  function clearFocus(){
    allCards.forEach(function(el){ el.classList.remove('dim'); });
    allEdges.forEach(function(el){ el.classList.remove('dim'); el.classList.remove('active'); });
    allLabels.forEach(function(el){ el.classList.remove('dim'); });
  }

  function focusScreen(screenId){
    var touching = {};
    touching[screenId] = true;
    allEdges.forEach(function(el){
      var on = el.dataset.from === screenId || el.dataset.to === screenId;
      el.classList.toggle('dim', !on);
      if (on) { touching[el.dataset.from] = true; touching[el.dataset.to] = true; }
    });
    allCards.forEach(function(el){ el.classList.toggle('dim', !touching[el.dataset.screen]); });
    allLabels.forEach(function(el){
      var edge = document.getElementById(el.dataset.edge);
      el.classList.toggle('dim', !(edge && !edge.classList.contains('dim')));
    });
  }

  function focusButton(screenId, buttonId, edgeId){
    var touching = {}; touching[screenId] = true;
    allEdges.forEach(function(el){
      var on = el.id === edgeId;
      el.classList.toggle('dim', !on);
      el.classList.toggle('active', on);
      if (on) { touching[el.dataset.from] = true; touching[el.dataset.to] = true; }
    });
    allCards.forEach(function(el){ el.classList.toggle('dim', !touching[el.dataset.screen]); });
    allLabels.forEach(function(el){ el.classList.toggle('dim', el.dataset.edge !== edgeId); });
  }

  function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function screenTooltip(screenId){
    var s = META.screens[screenId];
    if (!s) return '';
    var html = '<span class="tt-title">' + esc(screenId) + '</span>';
    html += '<div class="tt-row"><span class="k">class</span><span class="v">' + esc(s.className || '—') + '</span></div>';
    html += '<div class="tt-row"><span class="k">layout</span><span class="v">' + esc(s.layout || '—') + '</span></div>';
    if (s.incoming && s.incoming.length) {
      html += '<div class="tt-row"><span class="k">from</span><span class="v">' + s.incoming.map(function(i){ return esc(i.from); }).join(', ') + '</span></div>';
    }
    if (s.elements && s.elements.length) {
      html += '<ul>' + s.elements.slice(0, 8).map(function(e){
        return '<li>' + esc(e.type) + (e.label ? ': ' + esc(e.label) : '') + '</li>';
      }).join('') + (s.elements.length > 8 ? '<li>+' + (s.elements.length - 8) + ' more…</li>' : '') + '</ul>';
    }
    return html;
  }

  function buttonTooltip(screenId, buttonId){
    var b = META.buttons[screenId + '::' + buttonId];
    if (!b) return '';
    var html = '<span class="tt-title">Button: ' + esc(b.label) + '</span>';
    if (b.type === 'navigate') {
      html += '<div class="tt-row"><span class="k">→</span><span class="v tt-ok">' + esc(b.target) + '</span></div>';
      if (b.via) html += '<div class="tt-row"><span class="k">via</span><span class="v">' + esc(b.via) + '</span></div>';
      html += '<div class="tt-row"><span class="k">logic</span><span class="v ' + (b.guard ? 'tt-warn' : '') + '">' +
        (b.guard ? 'if (' + esc(b.guard) + ')' : 'no guard condition found in source') + '</span></div>';
    } else {
      html += '<div class="tt-row"><span class="k">status</span><span class="v tt-danger">unresolved</span></div>';
      html += '<div class="tt-row"><span class="k">why</span><span class="v">' + esc(b.reason || '—') + '</span></div>';
    }
    html += '<div class="tt-row"><span class="k">api</span><span class="v">' +
      (b.api ? (b.api.resolved ? esc((b.api.files || []).join(' → ')) : 'candidate path not found') : '') + '</span></div>';
    return html;
  }

  function showTooltip(html, x, y){
    tooltip.innerHTML = html;
    tooltip.classList.add('show');
    var pad = 16, tw = 300, th = tooltip.offsetHeight || 80;
    var left = x + pad, top = y + pad;
    if (left + tw > window.innerWidth) left = x - tw - pad;
    if (top + th > window.innerHeight) top = y - th - pad;
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }
  function hideTooltip(){ tooltip.classList.remove('show'); }

  stage.addEventListener('mousemove', function(e){
    var btnEl = e.target.closest('.hoverable-btn');
    var cardEl = e.target.closest('.node-card');
    if (btnEl) {
      var screenId = btnEl.dataset.screen, buttonId = btnEl.dataset.button;
      var key = screenId + '::' + buttonId;
      var meta = META.buttons[key];
      focusButton(screenId, buttonId, meta && meta.edgeId);
      showTooltip(buttonTooltip(screenId, buttonId), e.clientX, e.clientY);
    } else if (cardEl) {
      var sid = cardEl.dataset.screen;
      focusScreen(sid);
      showTooltip(screenTooltip(sid), e.clientX, e.clientY);
    } else {
      clearFocus();
      hideTooltip();
    }
  });
  stage.addEventListener('mouseleave', function(){ clearFocus(); hideTooltip(); });

  // Export — archify's viewer offers PNG/SVG export of the delivered
  // diagram; this canvas isn't rendered by archify's engine, but it's a
  // plain SVG so the same two formats are straightforward to offer here.
  var CANVAS_W = ${canvasW}, CANVAS_H = ${canvasH}, FILE_SLUG = ${JSON.stringify(fileSlug)};
  var FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');";

  function cleanClone(){
    clearFocus(); hideTooltip();
    var clone = stage.cloneNode(true);
    clone.removeAttribute('style');
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0');
    bg.setAttribute('width', String(CANVAS_W)); bg.setAttribute('height', String(CANVAS_H));
    bg.setAttribute('fill', '${PALETTE.bg}');
    clone.insertBefore(bg, clone.firstChild);
    var style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = FONT_IMPORT;
    clone.insertBefore(style, clone.firstChild);
    return clone;
  }

  function downloadBlob(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  document.getElementById('exportSvg').onclick = function(){
    var xml = new XMLSerializer().serializeToString(cleanClone());
    downloadBlob(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }), FILE_SLUG + '.svg');
  };

  document.getElementById('exportPng').onclick = function(){
    var btn = document.getElementById('exportPng');
    var originalText = btn.textContent;
    btn.textContent = 'Rendering…';
    var xml = new XMLSerializer().serializeToString(cleanClone());
    var svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    var img = new Image();
    img.onload = function(){
      var scale = 2;
      var canvas = document.createElement('canvas');
      canvas.width = CANVAS_W * scale;
      canvas.height = CANVAS_H * scale;
      var ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(svgUrl);
      btn.textContent = originalText;
      canvas.toBlob(function(blob){
        if (!blob) { alert('PNG export failed — try Export SVG instead.'); return; }
        downloadBlob(blob, FILE_SLUG + '.png');
      });
    };
    img.onerror = function(){
      URL.revokeObjectURL(svgUrl);
      btn.textContent = originalText;
      alert('PNG export failed (browser blocked rendering the SVG) — use Export SVG instead.');
    };
    img.src = svgUrl;
  };
})();
</script>
`;

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html);
  console.log(`✓ ${built.size} screens, ${arrows.length} arrows → ${args.out}`);
}

main();
