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
npx skills add <your-username>/android-hld-skill -g
```

Or clone it directly and run the scripts with plain Node (18+):

```bash
git clone https://github.com/<your-username>/android-hld-skill.git
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
node scripts/extract-xml-ui.mjs --dir "$SRC/res/layout" --out /tmp/ui.json
node scripts/resolve-button-actions.mjs --nav-json /tmp/nav.json --xml-ui-json /tmp/ui.json --dir "$MODULE" --out /tmp/buttons.json
node scripts/render-flow-wireframes.mjs --nav-json /tmp/nav.json --xml-ui-json /tmp/ui.json --buttons-json /tmp/buttons.json --title "Sample App HLD" --out /tmp/hld.html

open /tmp/hld.html   # or just double-click it
```

You get a single HTML file: every screen positioned by its place in the
navigation flow, drawn as its actual wireframe (not a placeholder box),
connected by arrows labeled with the button that triggers each one. Hover a
screen for its source file/class/element list; hover a button for its
target, trigger method, any guard condition found in source, and (if you
ran the optional API-chain resolver) the API it calls. Export the whole
canvas as SVG or PNG from the toolbar.

A pre-generated example output from Google's public
[Now in Android](https://github.com/android/nowinandroid) repo (Navigation 3
convention) is included at `examples/nowinandroid.nav3.json` — run it
through `render-flow-wireframes.mjs` yourself to see the render step alone.

## Using it via Claude Code

With the skill installed, just ask Claude Code:

> "Generate an HLD for this Android module's navigation flow"

Claude Code reads `SKILL.md`, runs the pipeline itself, and hands you the
finished HTML — it does not read your source files to "understand" the
navigation graph; the scripts do that deterministically.

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
