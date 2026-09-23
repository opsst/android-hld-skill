#!/usr/bin/env node
/**
 * Renders a "fake UI" wireframe per screen from data already extracted —
 * no new source reading happens here, this is purely visualizing facts
 * `extract-xml-ui.mjs` (element type/label/order) and
 * `resolve-button-actions.mjs` (what each button actually does, including
 * any `guard` condition found) already produced.
 *
 * Layout is a straight top-to-bottom stack in document order, not real x/y
 * positions — XML layouts (esp. ConstraintLayout) declare position via
 * constraints, not simple coordinates, so exact placement isn't something
 * this deterministic pass extracts. Disclosed as an approximation, not
 * presented as pixel-accurate.
 *
 * Usage:
 *   node render-wireframe.mjs --xml-ui-json <ui.json> --nav-json <nav.json> [--buttons-json <buttons.json>] --out <gallery.html>
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

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TYPE_STYLE = {
  button: { fill: 'rgba(88,166,255,0.15)', stroke: '#58a6ff', textColor: '#58a6ff', shape: 'button' },
  imagebutton: { fill: 'rgba(88,166,255,0.15)', stroke: '#58a6ff', textColor: '#58a6ff', shape: 'button' },
  text: { fill: 'none', stroke: 'none', textColor: '#c9d1d9', shape: 'text' },
  input: { fill: 'rgba(255,255,255,0.03)', stroke: '#3d4451', textColor: '#6e7681', shape: 'box' },
  image: { fill: 'rgba(188,140,255,0.08)', stroke: '#8250df', textColor: '#8250df', shape: 'dashedBox' },
  list: { fill: 'rgba(255,255,255,0.02)', stroke: '#30363d', textColor: '#8b949e', shape: 'list' },
  checkbox: { fill: 'none', stroke: '#3d4451', textColor: '#c9d1d9', shape: 'checkbox' },
  radio: { fill: 'none', stroke: '#3d4451', textColor: '#c9d1d9', shape: 'checkbox' },
  radiogroup: { fill: 'none', stroke: 'none', textColor: '#8b949e', shape: 'text' },
  numberpicker: { fill: 'rgba(255,255,255,0.03)', stroke: '#3d4451', textColor: '#c9d1d9', shape: 'box' },
  progress: { fill: '#58a6ff', stroke: 'none', textColor: '#8b949e', shape: 'bar' },
  spinner: { fill: 'rgba(255,255,255,0.03)', stroke: '#3d4451', textColor: '#c9d1d9', shape: 'box' },
};

const PHONE_W = 260;
const ROW_H = 44;
const PAD = 14;

function buildScreenSvg(screenId, elements, buttonInfoById) {
  const rows = elements.filter((e) => e.type); // skip unclassified structural containers
  const contentH = rows.length * (ROW_H + 8) + PAD * 2 || 60;
  const svgH = contentH + 40; // + status-bar-ish header strip

  let y = 40 + PAD;
  const parts = [];
  parts.push(`<rect x="0" y="0" width="${PHONE_W}" height="${svgH}" rx="18" fill="#0d1117" stroke="#30363d"/>`);
  parts.push(`<rect x="0" y="0" width="${PHONE_W}" height="34" rx="18" fill="#161b22"/>`);
  parts.push(`<rect x="0" y="18" width="${PHONE_W}" height="16" fill="#161b22"/>`);
  parts.push(
    `<text x="${PHONE_W / 2}" y="22" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="10" fill="#8b949e">${esc(screenId)}</text>`,
  );

  for (const el of rows) {
    const style = TYPE_STYLE[el.type] || TYPE_STYLE.text;
    const label = el.label || el.id;
    const rowW = PHONE_W - PAD * 2;

    if (style.shape === 'text') {
      parts.push(
        `<text x="${PAD}" y="${y + 16}" font-family="Inter, sans-serif" font-size="11" fill="${style.textColor}">${esc(truncate(label, 30))}</text>`,
      );
    } else if (style.shape === 'button') {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${rowW}" height="30" rx="6" fill="${style.fill}" stroke="${style.stroke}"/>`,
      );
      parts.push(
        `<text x="${PHONE_W / 2}" y="${y + 20}" text-anchor="middle" font-family="Inter, sans-serif" font-size="11" font-weight="600" fill="${style.textColor}">${esc(truncate(label, 24))}</text>`,
      );
      const info = buttonInfoById?.[el.id];
      if (info) {
        parts.push(
          `<text x="${PAD}" y="${y + 44}" font-family="IBM Plex Mono, monospace" font-size="9" fill="${info.color}">${esc(info.caption)}</text>`,
        );
        y += 16; // extra room for the caption line
      }
    } else if (style.shape === 'dashedBox') {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${rowW}" height="30" rx="4" fill="${style.fill}" stroke="${style.stroke}" stroke-dasharray="4 3"/>`,
      );
      parts.push(
        `<text x="${PAD + 8}" y="${y + 19}" font-family="Inter, sans-serif" font-size="9" fill="${style.textColor}">🖼 ${esc(truncate(label, 22))}</text>`,
      );
    } else if (style.shape === 'list') {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${rowW}" height="30" rx="4" fill="${style.fill}" stroke="${style.stroke}"/>`,
      );
      parts.push(`<line x1="${PAD + 6}" y1="${y + 10}" x2="${PAD + rowW - 6}" y2="${y + 10}" stroke="${style.stroke}"/>`);
      parts.push(`<line x1="${PAD + 6}" y1="${y + 20}" x2="${PAD + rowW - 6}" y2="${y + 20}" stroke="${style.stroke}"/>`);
      parts.push(
        `<text x="${PAD + 8}" y="${y - 3}" font-family="IBM Plex Mono, monospace" font-size="8" fill="${style.textColor}">list: ${esc(el.id)}</text>`,
      );
    } else if (style.shape === 'bar') {
      parts.push(`<rect x="${PAD}" y="${y + 12}" width="${rowW}" height="4" rx="2" fill="${style.fill}" opacity="0.5"/>`);
    } else if (style.shape === 'checkbox') {
      parts.push(`<rect x="${PAD}" y="${y + 6}" width="16" height="16" rx="3" fill="none" stroke="${style.stroke}"/>`);
      parts.push(
        `<text x="${PAD + 24}" y="${y + 18}" font-family="Inter, sans-serif" font-size="10" fill="${style.textColor}">${esc(truncate(label, 24))}</text>`,
      );
    } else {
      // box (input, numberpicker, spinner)
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${rowW}" height="30" rx="6" fill="${style.fill}" stroke="${style.stroke}"/>`,
      );
      parts.push(
        `<text x="${PAD + 8}" y="${y + 19}" font-family="Inter, sans-serif" font-size="10" fill="${style.textColor}">${esc(truncate(label || el.id, 26))}</text>`,
      );
    }
    y += ROW_H;
  }

  return { svg: `<svg width="${PHONE_W}" height="${svgH}" viewBox="0 0 ${PHONE_W} ${svgH}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`, height: svgH };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['xml-ui-json'] || !args['nav-json'] || !args.out) {
    console.error(
      'Usage: node render-wireframe.mjs --xml-ui-json <ui.json> --nav-json <nav.json> [--buttons-json <buttons.json>] --out <gallery.html>',
    );
    process.exit(1);
  }

  const xmlUi = JSON.parse(readFileSync(args['xml-ui-json'], 'utf-8'));
  const nav = JSON.parse(readFileSync(args['nav-json'], 'utf-8'));
  const buttonsData = args['buttons-json'] ? JSON.parse(readFileSync(args['buttons-json'], 'utf-8')) : null;

  const elementsByLayout = new Map();
  for (const l of xmlUi.layouts || []) elementsByLayout.set(l.layoutFile, l.elements || []);

  const buttonsByScreen = new Map();
  for (const s of buttonsData?.screens || []) buttonsByScreen.set(s.screenId, s.buttons || []);

  const cards = [];
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
          caption: b.action.guard ? `🔒 if (${truncate(b.action.guard, 26)}) → ${b.action.target}` : `→ ${b.action.target}`,
          color: b.action.guard ? '#d29922' : '#3fb950',
        };
      } else if (b.action?.type === 'unresolved') {
        buttonInfoById[b.id] = { caption: `⚠ ${truncate(b.action.reason, 30)}`, color: '#d29922' };
      }
    }
    const { svg } = buildScreenSvg(node.id, elements, buttonInfoById);
    cards.push(`<div class="phone-card">${svg}</div>`);
  }

  const html = `<meta charset="utf-8">
<title>Screen Wireframes</title>
<style>
  :root { --bg:#0d1117; --text:#e6edf3; --text-dim:#8b949e; }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: Inter, sans-serif; padding: 32px 20px; }
  h1 { font-family: "IBM Plex Mono", monospace; font-size: 22px; margin: 0 0 8px; }
  p.sub { color: var(--text-dim); font-size: 13px; max-width: 70ch; margin: 0 0 28px; line-height: 1.6; }
  .gallery { display: flex; flex-wrap: wrap; gap: 24px; }
  .phone-card { filter: drop-shadow(0 4px 14px rgba(0,0,0,0.4)); }
  .legend { margin-top: 32px; font-size: 12px; color: var(--text-dim); display: flex; gap: 16px; flex-wrap: wrap; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap">
<h1>Screen Wireframes (approximate)</h1>
<p class="sub">
  Rebuilt from extracted UI elements, stacked in document order — not real
  x/y coordinates (ConstraintLayout uses constraints, not simple positions).
  Green caption = resolved navigate target. Amber = a guard condition was
  found (raw, unquoted from source) or the action is unresolved.
</p>
<div class="gallery">
${cards.join('\n')}
</div>
<div class="legend">
  <span>🟢 → resolved navigate</span>
  <span>🟡 🔒 guarded navigate</span>
  <span>🟡 ⚠ unresolved</span>
</div>
`;

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html);
  console.log(`✓ ${cards.length} screen(s) → ${args.out}`);
}

main();
