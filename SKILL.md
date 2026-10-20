---
name: android-hld-skill
description: Generate a High-Level Design (HLD) diagram for an Android module — deterministic Tier-1 extraction of screens, UI elements, and navigation/button logic, rendered as a single interactive HTML canvas (real screen wireframes, hover tooltips, SVG/PNG export). Use when the user asks to map, diagram, or visualize an Android app/module's screen flow, navigation graph, or "what does this button do", or asks for an "HLD" of an Android codebase.
---

# Android HLD Skill

Produces a structural map of an Android module's screens, UI, and navigation
logic — **without reading full source files through the model**. Every step
below is Tier-1 deterministic extraction (regex/XML parsing executed by
plain Node scripts), not LLM inference. The model's job is to run the right
scripts in order and hand the result to the user — not to read the codebase
itself to "understand" it.

## Why this exists

Reading through every file in a large Android module to reconstruct its
navigation graph and screen contents wastes context on files that turn out
to be irrelevant. Nearly all of that structure already sits in a
predictable, conventional form — an XML nav graph, a `NavKey`/`EntryProvider`
convention, view-ID naming, Safe Args `Directions` classes — and can be
extracted with a plain script, faster and more reliably than by having the
model read and infer it. Tier 2 (an LLM actually reading source) only ever
gets used for genuinely ambiguous, narrowly-scoped questions this Tier-1
pass can't answer deterministically — never as the default way to explore
the repo.

## When to use this skill

- The user asks for an HLD, screen map, or navigation diagram of an Android
  module or app.
- The user wants to know what a specific screen or button does (navigates
  where, under what condition, calling what API) without manually tracing
  `NavHost`/`nav_graph`/`setOnClickListener` wiring themselves.

## Choosing the output

Steps 1–4 (extraction) always run first; the request decides what you render
from their JSON. When the user doesn't say, produce the canvas (step 6).

| The user asks for… | Produce |
|---|---|
| an HLD, screen map, flow diagram (default) | step 6, `render-flow-wireframes.mjs` → `hld.html` |
| the HLD in Figma, "same as iOS", a Figma board | step 9, `to-hldgen-bundle.mjs` + `get-hldgen-plugin.mjs` |
| just the flow layout, a layout check | `layout-flows.mjs --nav-json nav.json --out layout.json --preview layout.html` (name cards only, no wireframes, no hover; say so) |
| every screen's wireframe, no flow | step 7, `render-wireframe.mjs` |
| an archify diagram | step 8, `to-archify.mjs` + archify's own `validate`/`deliver` |
| which API a screen calls | step 5, then read only the files it lists |
| a question ("what leads to X", "what does this button do") | answer from `nav.json` / `buttons.json`, citing each edge's `evidence`; no render |

## Pipeline

Run these in order. Every script takes `--out <path>` and writes JSON (the
render step writes HTML); chain the outputs together as shown.

1. **Detect the navigation framework**
   ```bash
   node scripts/detect-nav-framework.mjs --dir <path to module or repo>
   ```
   Prints `nav3`, `xml`, or `unknown` to stdout (plus a one-line signal count
   on stderr, so you can tell the user *why* it picked what it picked).

2. **Extract the navigation graph** — pick the extractor that matches step 1:
   - `nav3` (Jetpack Navigation 3 — `NavKey`/`EntryProvider` convention):
     ```bash
     node scripts/extract-nav3.mjs --dir <repo root> --out nav.json
     ```
   - `xml` (classic Navigation Component — `res/navigation/*.xml`):
     ```bash
     node scripts/extract-nav-graph.mjs --dir <path to res/navigation> --out nav.json
     ```
   - `unknown`: say so plainly. Don't guess a framework and don't fall back
     to reading every source file — ask the user what navigation approach
     the project uses, or look at a couple of representative screens
     together with them.

   **Then, for `xml`, add the navigation that lives in code** — most real apps
   navigate from Kotlin too (Activity launches, state-driven hosts, wrapper
   helpers), which `<action>` tags never show:
   ```bash
   node scripts/extract-code-nav.mjs --nav-json nav.json --src <module>/src/main [--rules <repo>/.hld-rules.json] --out nav.json
   ```
   Built-in rules cover standard Android patterns with no configuration: any
   code reference to an id the nav graph declares (so team wrappers like
   `next(R.id.action_x)` are caught automatically), `Intent(…, X::class.java)`,
   `XActivity.start(…)`-style factories, Activities hosting a nav graph, and
   FragmentManager transactions (`replace`/`add`). The last one needs no nav
   graph, so for an `unknown` project that swaps Fragments manually, run this
   script without `--nav-json` instead of stopping.
   Every added edge carries `rule` and `evidence` (`file:line`). Use this merged
   `nav.json` for every step below.

   **Step 0 — review the census, once per repo.** The output's
   `codeNav.unmatchedNavCalls` lists navigation-looking calls no rule could
   resolve, grouped and counted with example locations. Read **only those
   example lines** — never the module at large — and classify each group:
   - target decided at runtime (`navigate(state.destId)`) → leave it; report
     it as unresolved.
   - a repeated team convention the built-ins don't know → propose a rule for
     the analyzed repo's `.hld-rules.json` (`{"navigate": [{"name", "pattern"
     (one capture group), "capture": "actionId" | "destinationId" |
     "className"}]}`), show it to the user, and rerun with `--rules` once they
     accept. The rules file belongs in the analyzed repo, never in this skill.
   - not navigation at all (a name that merely contains "navigate") → ignore.
   After that, answer flow questions from the JSON; don't reopen source files
   to "double-check" edges the extractor already cites.

3. **Extract UI elements per screen** (XML/ViewBinding layouts only — see
   Limitations below for Compose):
   ```bash
   node scripts/extract-xml-ui.mjs --dir <res/layout dir> [--strings <res/values/strings.xml>] --out ui.json
   ```
   Classifies every element primarily by its XML **tag name** (`Button`,
   `TextView`, `EditText`, `RecyclerView`, AndroidX/Material variants, …) —
   this works on any repo regardless of its ID-naming habits. A repo that
   also follows a consistent ID-suffix convention (e.g. `submitBtn`,
   `emailEdt`) gets those as a secondary classification signal too.

4. **Resolve what each button does**:
   ```bash
   node scripts/resolve-button-actions.mjs --nav-json nav.json --xml-ui-json ui.json --dir <repo root> --out buttons.json
   ```
   For each button, finds its `setOnClickListener` and classifies the
   navigate call inside it: Safe Args `Directions.<action>(...)` (primary
   pattern — the generated method name is always the action's
   `android:id`) or a raw `navigate(R.id.<action>)`. If an `if (...)` guard
   appears between the click listener and the navigate call, its raw
   condition text is quoted verbatim as `guard` — reported, never
   paraphrased or interpreted. Anything that doesn't match either pattern is
   `unresolved`, with a stated reason — never guessed.

5. **(Optional) Resolve the API chain behind a screen** — only useful for a
   repo following a `Fragment → ViewModel → UseCase → Repository → Service`
   naming convention (Clean Architecture-style Android):
   ```bash
   node scripts/resolve-api-chain-paths.mjs --nav-json nav.json --repo-root <repo root> --out api.json
   ```
   This is Tier 1 only as far as **locating** the candidate files (it
   computes expected paths from the naming convention, then checks they
   exist — no content search). Actually naming the `@GET`/`@POST` endpoint a
   screen ultimately calls is a Tier 2 step: read just the 3-5 candidate
   files this script hands you, nothing else in the module.

6. **Render the final HLD canvas** — the recommended default output:
   ```bash
   node scripts/render-flow-wireframes.mjs --nav-json nav.json --xml-ui-json ui.json --buttons-json buttons.json [--api-json api.json] --title "<title>" --out hld.html
   ```
   One self-contained HTML file with one diagram per flow (nav graph), laid
   out by `layout-flows.mjs`: layered left to right in navigation order,
   crossings minimised, destinations in another flow as dashed cards in a
   last column, loops drawn as dashed lines under the flow. Each node is the
   screen's real wireframe (not a placeholder box); arrows leave the button
   that triggers them. Hovering a screen shows its class/layout/incoming edges/element
   list; hovering a button highlights its one arrow and shows the target,
   trigger method, any guard condition (or an honest "no guard condition
   found"), and the resolved API chain when step 5 was run (left blank
   otherwise — never guessed). Includes pan/zoom and SVG/PNG export
   buttons. Open the file directly in a browser — no server needed.

7. **(Optional) `render-wireframe.mjs`** produces just the per-screen
   wireframe gallery (no flow layout) if that's all the user wants:
   ```bash
   node scripts/render-wireframe.mjs --xml-ui-json ui.json --nav-json nav.json [--buttons-json buttons.json] --out wireframes.html
   ```

8. **(Optional) `to-archify.mjs`** produces a companion diagram styled and
   validated by the [archify skill](https://github.com/tt-a1i/archify) (if
   installed separately) instead of this repo's own canvas — useful when the
   user specifically wants archify's own polished, geometry-validated
   export:
   ```bash
   node scripts/to-archify.mjs --nav-json nav.json --buttons-json buttons.json --title "<title>" --out draft.json
   # then, with archify installed:
   node <archify>/bin/archify.mjs validate workflow draft.json --quality showcase
   node <archify>/bin/archify.mjs deliver workflow draft.json out.html --quality showcase
   ```

9. **(Optional) Figma board** via the iOS team's
   [HLDGen](https://github.com/Ntpstv/HLDGen) Figma plugin, when the user
   wants the HLD in Figma:
   ```bash
   node scripts/to-hldgen-bundle.mjs --nav-json nav.json --xml-ui-json ui.json --buttons-json buttons.json [--strings <res/values/strings.xml>] --module <name> --out bundle.json
   ```
   Then `node scripts/get-hldgen-plugin.mjs` fetches the plugin (pinned commit,
   into `.cache/HLDGen`) and prints its manifest path. The user imports that
   manifest in the Figma desktop app (Plugins → Development → Import plugin
   from manifest…), sets the page background dark (some plugin text is light
   grey), and pastes `bundle.json`. You can't run Figma, so hand over the paths
   and the steps; don't claim what the board looks like.

10. **Report the result honestly.** Always surface screen/edge counts, and
   any `unresolved` entries — these are real signal about navigation the
   static pass couldn't resolve (e.g. conditional/dynamic navigation), not
   something to hide. Also surface `orphanNodes` (screens with zero detected
   edges in or out) — a normal leaf screen has in-edges but no out-edges, so
   a *fully* disconnected screen is a signal extraction likely missed
   something connecting it, not proof the screen is unreachable.

## Limitations (disclosed, not silent)

- **Jetpack Compose UI**: step 3 (`extract-xml-ui.mjs`) only extracts from
  XML layouts. Compose screens (button labels, click targets) are not
  regex-tractable deterministically — `stringResource(...)` is the dominant
  convention but not the only one, and building on it would mean shipping a
  heuristic, not a deterministic extractor. Step 2's nav-graph extraction
  (`extract-nav3.mjs`) does work for Compose apps using Navigation 3; steps
  3+ won't produce output for a Compose-only repo.
- **`resolve-api-chain-paths.mjs`** assumes a specific layered naming
  convention. It degrades safely (empty/near-empty output, no crash) on a
  repo that doesn't follow it — it does not guess a different convention.
- Dynamic/conditional navigation not expressed via the detected convention
  (e.g. navigate calls built from runtime state in ways these regexes don't
  match) shows up as `unresolved`/`orphanNodes`, not as a false graph.

## What this deliberately does NOT do

- Does not read module source files into the model's context to "understand"
  the navigation graph — that's the exact anti-pattern this skill exists to
  avoid.
- Does not paraphrase or interpret guard conditions, API endpoints, or
  screen purpose — every field in the output JSON is either a literal value
  read from source or explicitly marked `unresolved`/`unknown`.
