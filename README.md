# Android HLD Skill

Generate a High-Level Design diagram for an Android module — deterministically.
No LLM reads your source code to build the map: a chain of small Node
scripts extracts the navigation graph, screen contents, and button logic via
regex/XML parsing, then renders it all as one interactive HTML file with
real screen wireframes, hover tooltips, and SVG/PNG export.

This is a [Claude Code Skill](https://docs.claude.com/en/docs/claude-code/skills) —
install it and Claude Code runs the pipeline for you when you ask for an HLD
of an Android app. The scripts also run standalone with plain `node`.

## Why deterministic, not agentic

Reading every file in a large Android module to reconstruct its navigation
graph burns context on files that turn out to be irrelevant — and an LLM
reading source to build a diagram will produce a *slightly* different answer
each time. Almost all of that structure already sits in a predictable,
conventional form (an XML nav graph, `NavKey`/`EntryProvider` wiring, Safe
Args `Directions` classes, view-ID naming), so it can be extracted with a
plain script: same input, same output, every time, at a fraction of the
cost. An LLM only ever gets called in for a narrowly-scoped, genuinely
ambiguous question a deterministic pass can't answer — never as the default
way to explore the repo. See `SKILL.md` for the full pipeline and
`ARCHITECTURE.md` for how each script works.

## Install

```bash
npx skills add opsst/android-hld-skill -g
```

Or clone it directly and run the scripts with plain Node (18+):

```bash
git clone https://github.com/opsst/android-hld-skill.git
cd android-hld-skill
npm install
```

## Quickstart

Point it at any public Android repo with a classic XML nav graph — for
example Google's own
[`architecture-components-samples`](https://github.com/android/architecture-components-samples):

```bash
git clone https://github.com/android/architecture-components-samples /tmp/samples
MODULE=/tmp/samples/NavigationBasicSample
SRC="$MODULE/app/src/main"

node scripts/detect-nav-framework.mjs --dir "$SRC"
# -> xml

node scripts/extract-nav-graph.mjs --dir "$SRC/res/navigation" --out /tmp/nav.json
node scripts/extract-code-nav.mjs --nav-json /tmp/nav.json --src "$SRC" --out /tmp/nav.json
node scripts/extract-xml-ui.mjs --dir "$SRC/res/layout" --out /tmp/ui.json
node scripts/resolve-button-actions.mjs --nav-json /tmp/nav.json --xml-ui-json /tmp/ui.json --dir "$MODULE" --out /tmp/buttons.json
node scripts/render-flow-wireframes.mjs --nav-json /tmp/nav.json --xml-ui-json /tmp/ui.json --buttons-json /tmp/buttons.json --title "Sample App HLD" --out /tmp/hld.html

open /tmp/hld.html   # or just double-click it
```

You get a single HTML file with one diagram per flow (nav graph). Screens are
laid out left to right in navigation order by a layered layout that keeps
lines from crossing; destinations in another flow appear as dashed cards at
the right. Each screen is drawn as its actual wireframe (not a placeholder
box), with arrows leaving the button that triggers them. Hover a
screen for its source file/class/element list; hover a button for its
target, trigger method, any guard condition found in source, and (if you
ran the optional API-chain resolver) the API it calls. Export the whole
canvas as SVG or PNG from the toolbar.

A pre-generated example output from Google's public
[Now in Android](https://github.com/android/nowinandroid) repo (Navigation 3
convention) is included at `examples/nowinandroid.nav3.json` — run it
through `render-flow-wireframes.mjs` yourself to see the render step alone.

### Figma board (shared with the iOS HLDGen)

The same data can be drawn in Figma by the
[HLDGen](https://github.com/Ntpstv/HLDGen) Figma plugin, built for iOS. Convert
the output to an HLDGen bundle:

```bash
node scripts/to-hldgen-bundle.mjs --nav-json /tmp/nav.json --xml-ui-json /tmp/ui.json --buttons-json /tmp/buttons.json --strings "$SRC/res/values/strings.xml" --module NavigationBasicSample --out /tmp/bundle.json
```

Fetch the plugin once (pinned to the HLDGen commit the bundle format matches,
checked out under `.cache/HLDGen`):

```bash
node scripts/get-hldgen-plugin.mjs
```

Then in the Figma desktop app: Plugins → Development → Import plugin from
manifest…, pick the `manifest.json` path it printed, run
**HLDGen — Scene Importer**, and paste `/tmp/bundle.json`. The plugin draws
some text light grey, so set the page background to a dark color first
(click an empty spot on the canvas → **Page** in the right panel). You get one journey
per nav graph, screens laid out left to right in flow order, decision diamonds
where a screen branches, and a GOES TO panel on each screen that links to its
destinations. The plugin has no API, notification or storage data for Android
screens; those panels stay empty. A ready-made bundle for NavigationBasicSample
is at `examples/navigationbasicsample.hldgen-bundle.json` if you just want to
try the plugin.

## Outputs, and how to ask for each

Every output is built from the same extracted JSON (`nav.json`, `ui.json`,
`buttons.json`), so they always agree with each other. With the skill
installed, ask Claude Code in plain words; it reads `SKILL.md`, runs the
scripts, and hands you the file. It does not read your source files to
"understand" the navigation; the scripts do that.

| Output | Ask Claude Code | Script (after the extraction steps in Quickstart) |
|---|---|---|
| **Interactive HLD canvas** (default): one diagram per flow, real wireframes, hover tooltips, SVG/PNG export | "Generate an HLD for this Android module" | `render-flow-wireframes.mjs --nav-json … --xml-ui-json … --buttons-json … --out hld.html` |
| **Figma board**, drawn by the iOS HLDGen plugin | "Make an HLD of this module for Figma" | `to-hldgen-bundle.mjs … --out bundle.json`, then `get-hldgen-plugin.mjs` (see [Figma board](#figma-board-shared-with-the-ios-hldgen)) |
| **Layout preview**: plain name cards per flow and a crossing count, no wireframes or hover; for checking the layout only | "Show me just the flow layout" | `layout-flows.mjs --nav-json nav.json --out layout.json --preview layout.html` |
| **Wireframe gallery**: every screen's wireframe on its own, no flow | "Show me the wireframe of every screen" | `render-wireframe.mjs --xml-ui-json ui.json --nav-json nav.json --buttons-json buttons.json --out wireframes.html` |
| **archify diagram**, validated by the separate [archify](https://github.com/tt-a1i/archify) skill | "Draw this flow with archify" | `to-archify.mjs --nav-json nav.json --buttons-json buttons.json --out draft.json`, then archify's `validate`/`deliver` |
| **API chain of a screen**: its ViewModel → UseCase → Repository → Service files, then the endpoint | "Which API does the X screen call?" | `resolve-api-chain-paths.mjs --nav-json nav.json --repo-root . --out api.json`; pass `--api-json api.json` to the canvas to show it on hover |
| **Answers, no diagram**: "what leads to X", "what does this button do", "which navigation couldn't be resolved" | Ask the question | Answered from `nav.json` / `buttons.json`; every code edge cites `file:line`, and `codeNav.unmatchedNavCalls` lists what no rule could resolve |

Useful additions to any request:

- **A whole app or one module**: name the module ("…for the `:feature:checkout` module").
- **Screen titles**: "use the strings file" → `--strings res/values/strings.xml` resolves `@string/…` labels.
- **Project without a nav graph** (Fragments swapped by `FragmentManager`):
  `extract-code-nav.mjs --src <module>/src/main --out nav.json` without
  `--nav-json` still finds the transactions.
- **Team-specific navigation helpers**: ask "review the navigation census". Claude
  reads only the call sites no rule resolved and proposes a `.hld-rules.json`
  for your repo (see `SKILL.md`, Step 0).

## Limitations

- XML/ViewBinding layouts only for the UI-element and button-resolution
  steps — Compose UI isn't regex-tractable deterministically (see
  `SKILL.md` for why). Navigation-graph extraction alone works for Compose
  apps using Navigation 3.
- The optional API-chain resolver assumes a
  `Fragment → ViewModel → UseCase → Repository → Service` naming convention.
  It degrades safely (empty output, no crash) on a repo that doesn't follow
  it.

## License

MIT — see `LICENSE`.
