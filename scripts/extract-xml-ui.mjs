#!/usr/bin/env node
/**
 * Deterministic Tier-1 extractor — UI elements from Android layout XML.
 *
 * Classifies every `android:id="@+id/..."` view in a layout file in two
 * layers:
 *
 *   1. PRIMARY — the XML tag name itself (`Button`, `TextView`,
 *      `androidx.recyclerview.widget.RecyclerView`, ...). Every Android
 *      layout XML declares the widget class as its tag, so this works on
 *      any repo regardless of naming habits — universal, not convention-
 *      dependent.
 *   2. SECONDARY — the `featureDescriptiveNameViewType` ID-suffix
 *      convention (documented in this project's own CLAUDE.md, e.g.
 *      `submitConfirmBtn`). Used only when the tag itself didn't resolve to
 *      a known type (a generic container like ConstraintLayout carrying an
 *      id, or a custom app-specific View subclass).
 *
 * This ordering was corrected after testing against a second real repo
 * (architecture-components-samples/GithubBrowserSample): its layouts use
 * plain snake_case ids (`repo_list`, `error_msg`) with no suffix convention
 * at all — the original ID-suffix-only version classified 0 of 21 elements
 * there. Tag-based classification is what actually generalizes.
 *
 * Labels (`android:text`) are resolved in two steps, same pattern used
 * elsewhere in this skill: a literal string is used as-is; a
 * `@string/xxx` reference is resolved by a second, separate regex pass over
 * a provided `strings.xml` — never by guessing the English text.
 *
 * Usage:
 *   node extract-xml-ui.mjs --dir <res/layout dir> [--strings <res/values/strings.xml>] --out <output.json>
 *   node extract-xml-ui.mjs --file <one layout.xml> [--strings <...>] --out <output.json>
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

// Tag simple name (last segment after '.') -> type. Covers plain Android
// widgets and the common AndroidX/Material equivalents.
const TAG_TYPES = {
  Button: 'button',
  MaterialButton: 'button',
  AppCompatButton: 'button',
  ImageButton: 'imagebutton',
  AppCompatImageButton: 'imagebutton',
  FloatingActionButton: 'imagebutton',
  ExtendedFloatingActionButton: 'button',
  TextView: 'text',
  AppCompatTextView: 'text',
  MaterialTextView: 'text',
  EditText: 'input',
  AppCompatEditText: 'input',
  TextInputEditText: 'input',
  AutoCompleteTextView: 'input',
  ImageView: 'image',
  AppCompatImageView: 'image',
  ShapeableImageView: 'image',
  CheckBox: 'checkbox',
  AppCompatCheckBox: 'checkbox',
  MaterialCheckBox: 'checkbox',
  Switch: 'checkbox',
  SwitchCompat: 'checkbox',
  SwitchMaterial: 'checkbox',
  RadioButton: 'radio',
  AppCompatRadioButton: 'radio',
  RadioGroup: 'radiogroup',
  RecyclerView: 'list',
  ListView: 'list',
  GridView: 'list',
  NumberPicker: 'numberpicker',
  ProgressBar: 'progress',
  Spinner: 'spinner',
};

// Longest-suffix-first so no shorter code can accidentally shadow a longer one.
const SUFFIX_TYPES = [
  ['Rcv', 'list'],
  ['Rcl', 'list'],
  ['Imb', 'imagebutton'],
  ['Imv', 'image'],
  ['Edt', 'input'],
  ['Btn', 'button'],
  ['Cb', 'checkbox'],
  ['Rg', 'radiogroup'],
  ['Rb', 'radio'],
  ['Np', 'numberpicker'],
  ['Tv', 'text'],
].sort((a, b) => b[0].length - a[0].length);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function stripIdRef(v) {
  if (!v) return v;
  return String(v).replace(/^@\+?id\//, '');
}

function classifyByTag(tag) {
  const simple = tag.split('.').pop();
  return TAG_TYPES[simple] || null;
}

function classifyBySuffix(id) {
  for (const [suffix, type] of SUFFIX_TYPES) {
    if (id.endsWith(suffix)) return type;
  }
  return null;
}

/** Recursively walk a fast-xml-parser tree, tracking each node's own tag
 *  name (the object key it was found under) so classification can use it. */
function collectIdNodes(node, tag, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectIdNodes(item, tag, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const id = node['@_android:id'];
  if (id) {
    out.push({
      rawId: stripIdRef(id),
      tag,
      text: node['@_android:text'] ?? null,
    });
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith('@_')) continue;
    collectIdNodes(node[key], key, out);
  }
}

/** Resolve `@string/xxx` -> the literal value, by regex over strings.xml.
 *  Returns null (not a guess) if the key isn't found. */
function resolveStringRef(key, stringsXml) {
  if (!stringsXml) return null;
  const re = new RegExp(`<string\\s+name="${key}"[^>]*>([\\s\\S]*?)</string>`);
  const m = stringsXml.match(re);
  return m ? m[1].trim() : null;
}

function extractFromLayout(file, stringsXml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const xml = readFileSync(file, 'utf-8');
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (e) {
    return { layoutFile: file, error: `XML parse error — ${e.message}`, elements: [], unclassified: [] };
  }

  const idNodes = [];
  collectIdNodes(doc, null, idNodes);

  const elements = [];
  const unclassified = [];
  for (const { rawId, tag, text } of idNodes) {
    const type = classifyByTag(tag || '') || classifyBySuffix(rawId);
    const classifiedBy = classifyByTag(tag || '') ? 'tag' : type ? 'suffix' : null;

    let label = null;
    let labelSource = null;
    if (typeof text === 'string' && text.startsWith('@string/')) {
      const key = text.replace('@string/', '');
      const resolved = resolveStringRef(key, stringsXml);
      label = resolved;
      labelSource = 'resource';
    } else if (typeof text === 'string' && text.length > 0) {
      label = text;
      labelSource = 'literal';
    }

    const entry = { id: rawId, tag, type, classifiedBy, label, labelSource };
    if (type) elements.push(entry);
    else unclassified.push(entry);
  }

  return { layoutFile: file, elements, unclassified };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.dir && !args.file) || !args.out) {
    console.error('Usage: node extract-xml-ui.mjs (--dir <layout dir> | --file <layout.xml>) [--strings <strings.xml>] --out <output.json>');
    process.exit(1);
  }

  const stringsXml = args.strings ? readFileSync(args.strings, 'utf-8') : null;

  const files = args.file
    ? [args.file]
    : readdirSync(args.dir)
        .filter((f) => f.endsWith('.xml'))
        .map((f) => join(args.dir, f));

  const results = files.map((f) => extractFromLayout(f, stringsXml));

  const totalElements = results.reduce((n, r) => n + r.elements.length, 0);
  const totalUnclassified = results.reduce((n, r) => n + r.unclassified.length, 0);

  const output = {
    generatedBy: 'extract-xml-ui.mjs (deterministic, no LLM) — layout XML view classifier',
    layoutCount: files.length,
    elementCount: totalElements,
    unclassifiedCount: totalUnclassified,
    layouts: results,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(
    `✓ ${files.length} layout(s), ${totalElements} elements (${totalUnclassified} unclassified) → ${args.out}`,
  );
  if (totalUnclassified > 0) {
    console.warn(`⚠ ${totalUnclassified} view id(s) didn't match a known suffix — see "unclassified" in the output.`);
  }
}

main();
