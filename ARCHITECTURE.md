# Architecture

Technical reference for each script — what it reads, what it computes, and
what it honestly refuses to guess. See `SKILL.md` for the recommended run
order; this file is the "how" behind each step.

## Design principles

1. **Tier 1 (deterministic) does all the heavy lifting.** Every script here
   is regex/XML parsing over source text — no LLM call, no embeddings, no
   RAG. Given the same input files, every script produces byte-identical
   output every time.
2. **Tier 2 (agentic/LLM) is opt-in and narrowly scoped.** The only place
   this pipeline calls for a model to actually read source is resolving an
   API endpoint from a 3-5-file candidate list `resolve-api-chain-paths.mjs`
   hands over — never a repo-wide search.
3. **Disclosed gaps, not guesses.** Every script that can fail to resolve
   something reports it explicitly (`unresolved`, `orphanNodes`,
   `moduleUnknown`, a `reason` string) instead of silently dropping it or
   inventing a plausible-looking answer.

## Status table

| Script | Input convention | Output | Status |
|---|---|---|---|
| `detect-nav-framework.mjs` | file-count heuristic (`*NavKey.kt` vs `res/navigation/*.xml`) | `nav3` \| `xml` \| `unknown` (stdout) | stable |
| `extract-nav3.mjs` | Jetpack Navigation 3 (`NavKey`, `EntryProvider`, `entry<X>{}`) | nav graph JSON | stable |
| `extract-nav-graph.mjs` | classic Navigation Component XML | nav graph JSON | stable |
| `extract-code-nav.mjs` | nav ids referenced in code, `Intent`/Activity factories, Activity→graph hosting, optional `.hld-rules.json` | same nav graph JSON + code edges with `rule`/`evidence`, plus a census of unresolved nav-like calls | new |
| `extract-xml-ui.mjs` | XML layout tag names (primary), ID-suffix convention (secondary) | per-screen UI element JSON | stable |
| `resolve-button-actions.mjs` | `setOnClickListener` + Safe Args `Directions`/raw `navigate(R.id...)` | per-screen button→action JSON | stable |
| `resolve-api-chain-paths.mjs` | `Fragment → ViewModel → UseCase → Repository → Service` naming convention | per-screen candidate file paths | convention-dependent, degrades safely otherwise |
| `render-flow-wireframes.mjs` | (consumes the above) | single interactive HTML canvas | stable, **recommended default output** |
| `render-wireframe.mjs` | (consumes the above) | per-screen wireframe gallery HTML | stable, standalone alternative |
| `to-archify.mjs` | (consumes nav + buttons) | archify `workflow` schema draft JSON | stable; requires the separate `archify` skill to actually render |

## Per-script notes

### `detect-nav-framework.mjs`

Counts `*NavKey.kt` files vs `res/navigation/*.xml` files under `--dir`.
Whichever count is non-zero and higher wins; both-zero is `unknown`. This is
a cheap heuristic, not a build-system inspection — it's meant to pick the
right extractor, not to be a general Android-project classifier.

### `extract-nav3.mjs`

Three passes over Kotlin source: (1) find every `*NavKey` type declaration
as a node, (2) build a `navigateTo<X>` function → `<X>NavKey` lookup table,
(3) scan `EntryProvider`/`entry<X>{}` blocks for navigate-call sites and
match them against the lookup table to form edges. Comments are stripped
before any regex runs (`stripComments` — conservative: only removes a line
when the *entire trimmed line* starts with `//`, so a string literal like
`"http://..."` sitting next to real code is untouched). The navigate-call
regexes accept any receiver identifier (`navigator`, `nav`, `router`, …),
not a hardcoded name. Reports `unresolved` (a navigate call that couldn't be
matched to a known `NavKey`) and `orphanNodes` (a `NavKey` with zero edges
in or out — the strongest signal of a missed connection, since a normal
leaf screen still has an in-edge).

### `extract-nav-graph.mjs`

Parses every `res/navigation/*.xml` file (via `fast-xml-parser`) under
`--dir`. Emits one node per `<fragment>`/`<activity>` (id, class, layout,
label) and one edge per `<action>` (from, to, actionId), grouped by source
file, plus `startDestination` per file. De-dupes nodes by `id` across files
(not `file::id` — a real cross-file duplicate screen reference is still a
duplicate, not a distinct node). Reports `orphanNodes` the same way as
`extract-nav3.mjs`.

### `extract-code-nav.mjs`

`<action>` tags only show navigation declared in XML. Real apps also navigate
from Kotlin: host Activities that switch fragments on a state value, wrapper
helpers around `navigate()`, and Activity launches. This script adds those
edges to the XML graph with standard Android rules that need no configuration:

- **id-ref / id-mention**: the nav graph already says which ids are
  navigation (every action id and destination id), so any code reference to
  one is an edge from the screen that owns the file. This is what catches
  team-specific wrappers such as `next(R.id.action_x)`. Comparisons (`== R.id.x`)
  and `pop*`/`find*` calls are skipped.
- **intent / activity-factory**: `Intent(…, X::class.java)` and
  `XActivity.start(…)`/`.newIntent(…)`-style companion factories.
- **hosts-graph**: an Activity that inflates `R.navigation.g` or whose layout
  declares `app:navGraph` gets an edge to that graph's start destination.

A file's owner is the screen named like the file; `XViewModel` belongs to
`XFragment` or `XActivity`. Calls in abstract/open base classes or other
non-screen files are counted as `unattributedMatches`, not guessed.

`codeNav.unmatchedNavCalls` is the Step 0 census: navigation-looking calls
into code outside the module whose arguments carry no static target, grouped
and counted with example locations. On a real 45K-line feature module this
came to 4 call sites, and those are the only lines an LLM needs to read to
decide whether a team rule (`--rules .hld-rules.json`) is worth adding.

### `extract-xml-ui.mjs`

Classifies every `android:id="@+id/..."` element two ways: **primary** —
the XML tag name itself, via a fixed map (`Button`/`MaterialButton`/
`AppCompatButton` → `button`, `TextView` family → `text`, `EditText` family
→ `input`, `ImageView` family → `image`, `RecyclerView`/`ListView`/
`GridView` → `list`, checkbox/radio/switch variants → `checkbox`/`radio`,
etc.) — this works on *any* repo regardless of naming habits, because it
doesn't depend on a convention the team has to have followed. **Secondary**
— an ID-suffix convention (`...Btn`, `...Tv`, `...Edt`, …), used only as a
fallback signal when present; each element's output carries which method
classified it (`classifiedBy: 'tag' | 'suffix'`). `android:text` resolves
literal strings directly; `@string/xxx` references resolve via a second
regex pass against `--strings`, when provided. Unclassified elements are
listed, not silently dropped.

### `resolve-button-actions.mjs`

For each screen with a resolvable Fragment source file: finds every
`<ButtonId>Directions.<action>(...)` call (Safe Args — the generated method
name is always the action's `android:id`, confirmed against real generated
code) and every raw `navigate(R.id.<action>)` call, cross-referenced against
the nav graph's edges by `actionId`. For each known button element, finds
its `setOnClickListener` assignment and looks for a navigate call inside a
bounded ~400-character window after it — a heuristic window, not a full
parser, but reasonable for typical short click-listener lambdas. If an
`if (...)` appears between the click listener and the navigate call inside
that window, its raw condition text is quoted verbatim as `guard` — this is
disclosed, not interpreted: the script reports *that* a check exists and
what it literally says, never what it means. A navigate call found outside
any button's click-listener window (e.g. inside a RecyclerView item-click
callback) is still reported, at screen level (`screenLevelActions`) rather
than attributed to a specific button.

### `resolve-api-chain-paths.mjs`

Given a Fragment's fully-qualified class name, computes (never searches
for) the expected sibling `ViewModel` file path from the
`Fragment → ViewModel` co-location convention, reads just its constructor to
find the injected `UseCase` type name, then computes the expected
`Repository`/`RepositoryImpl`/`Service` paths the same way — every path is a
string-concat from names already known, confirmed only by checking the file
exists on disk. This only works for a codebase that actually follows this
layered naming convention; on any other repo it reports `moduleUnknown`/
`resolved: false` rather than guessing a different shape. Naming the actual
`@GET`/`@POST` endpoint from the resolved file list is a Tier 2 step (a
targeted, few-file read) — deliberately not automated further, since that
would mean guessing at semantics this script has no deterministic way to
verify.

### `render-flow-wireframes.mjs`

Lays out screens by BFS depth from the nav graph's `startDestination` (same
column logic as `to-archify.mjs`), but instead of a plain labeled node,
renders each screen's actual wireframe (built from `extract-xml-ui.mjs`
element data) using a palette and type styling deliberately modeled on a
real archify `deliver`-ed HTML's design tokens (slate background, cyan glow
cards, JetBrains Mono chrome type, pill edge labels) — not archify's own
render engine, since archify's node schema has no slot for a custom
per-node graphic. Adds: pan/zoom (drag + buttons + ctrl/cmd-wheel), hover
(screen → structural facts + spotlight on connected edges/cards; button →
target/trigger/guard/API tooltip + single-edge spotlight, all built from an
embedded `window.__META__` JSON payload, never invented text), and SVG/PNG
export (clones the `<svg>` canvas, strips the pan/zoom transform, and either
serializes it directly or rasterizes it via an offscreen `<canvas>` at 2x
scale).

### `to-archify.mjs`

Assembles a `workflow`-schema **draft** JSON for the separate `archify`
skill: BFS-depth → `col`, one `lane` per row-within-column (a lane is a row,
not just a label — same-column same-lane nodes collide), edges labeled with
the triggering button's caption. `schema_version: 2` (archify's readable
auto-layout contract). This script only produces the draft — running
archify's own `validate`/`deliver` loop against it is a separate, agentic
step (see `SKILL.md` step 8), since archify's own validator is the source
of truth for its geometry rules, not something worth re-implementing here.
