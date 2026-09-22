# Options for a real UI

Loupe has five output surfaces today and three of them are already a UI of some
kind. The question is not "does loupe need a UI" — it is which of the things a
*real* UI does that none of the three currently does, and what shell those
capabilities want to live in.

This document names the gap, then the options, then a recommendation.

> **Status.** Stages 1 and 2 are built — `loupe ui` (option A) and the DevTools
> extension in `integrations/devtools/` (option E). Everything else here is still a
> decision document. What landed, against what this document asked for:
>
> | | |
> |---|---|
> | liveness | **done** — a watcher over the directories the analysis read, pushed over SSE |
> | navigation | **done** — every location links into the reader's editor, `--editor` templated |
> | write-back | **done** — `fix`, `mute` and `accept as baseline` from the page |
> | triage state | **partial** — the baseline is still the only memory. Nothing records what a reader has looked at, deferred, or seen arrive since yesterday |
> | DOM correlation without the bookmarklet | **done** — a DevTools panel that survives navigation, plus the Elements pane this document did not anticipate |
>
> Of the shared prerequisites, the write endpoints and the watcher landed, and
> the payload discipline held: `report-view.ts` is now the one renderer, and
> `--format html` and `loupe ui` cannot disagree about a number. **Incremental
> analysis did not** — re-analysis is still whole-tree, which is instant on an
> ordinary project and not on a large one. That remains the cost ceiling on
> everything below.
>
> Two things the build taught, which this document did not anticipate:
>
> - **A writing server is a different server.** `serve` answers any origin
>   because a bookmarklet must reach it. A surface that rewrites source files
>   cannot be that, so `ui` is a separate command with a loopback bind, no CORS,
>   a per-run secret and a revision on every write. Folding them together would
>   have put a writer behind `access-control-allow-origin: *`.
> - **The UI can ask, which changes what it should write.** The quick fix leaves
>   a suppression's reason blank because it has nowhere to put the question. A
>   page has somewhere, so it asks and refuses a blank answer — the two surfaces
>   write different bytes from the same principle.
>
> Stage 2 added one thing this document did not ask for and should have: the
> Elements sidebar. The panel was framed here as the overlay made permanent, but
> the interesting half turned out to be the inversion — select a node, see what
> styles it. It is also the only loupe surface that cannot exist as a bookmarklet,
> because it needs the inspector's selection.
>
> And one piece of shared machinery came out of it: `engine/src/dom-match.ts`,
> the single answer to "does this rule reach anything on screen", which the
> overlay splices in and the extension vendors. Same discipline as
> `report-view.ts` in Stage 1, and the same reason — two copies would be two
> answers and the disagreement would be invisible.
>
> Design notes: [design/report.md](design/report.md#loupe-ui) and
> [#resolving-a-finding-to-elements](design/report.md#resolving-a-finding-to-elements).

## What exists now

| surface | what it is | reader |
|---|---|---|
| `check --format agent` | the nested text report, context-bounded | an agent |
| `check --format json` / `sarif` | the payload, and the CI/code-scanning channel | a machine |
| `check --format html` | a self-contained page: KPIs, rule bars, directory rollup, composite clusters, findings table | a person triaging |
| `loupe lsp` | diagnostics on save, guidance on hover, the fix as a quick fix | a person (or agent) editing |
| `loupe serve` | a shadow-DOM panel injected by bookmarklet; resolves stylesheet findings to the live elements they style | a person in the running app |

Two of these are genuinely good and under-appreciated.

**The LSP is the strongest surface loupe has.** It is editor-agnostic by
construction — `engine/src/lsp.ts` is the whole implementation, the VS Code
extension is a 96-line launcher, and Zed, Neovim and Helix need no extension at
all. It reports repo-wide, not per open file, which is the only correct choice
for rules that correlate across files. It advertises exactly three capabilities:
full text sync, `quickfix` code actions, hover.

**`loupe serve` is the only thing loupe does that no other conformance tool
can.** A stylesheet finding carries the `selector` of the rule it sits in, and a
selector is a DOM query. That is what lets the panel say *which rendered
elements* a declaration is wrong on — and `Finding.media` lets it distinguish
"these three elements are wrong" from "would be wrong at a width you are not
at". This is the seed of a product, and today it is delivered by a bookmarklet.

**The HTML report is the weak one, and it is weak by design.** It renders
client-side from the `--format json` payload embedded verbatim, so it cannot
disagree with the JSON. It deliberately renders no timestamp, so re-running the
same check produces a byte-identical file. Both are correct for an *artifact*.
Both are exactly wrong for a UI: an artifact is a photograph, and what a person
triaging wants is a window.

## What "real UI" means

Five capabilities, in rough order of how much they change the experience. None
of them is a rendering problem.

1. **Liveness.** The report is a snapshot. A UI re-runs — on save, on a watch
   event, on a button. Everything downstream depends on this one.
2. **Navigation.** A finding names `file` and `line` and the reader has to
   retype it. A UI opens it.
3. **Write-back.** `loupe fix` exists, and the pieces are already factored for
   reuse: the LSP quick fix and the CLI writer both come out of `autofix.ts`
   (`substituteOnLine` and `tokenFixes` for the editor, `applyTokenFixes` and
   `applyKeeps` for the CLI). A UI applies a fix, accepts a baseline, writes a
   suppression — per finding, from the list, without a terminal.
4. **Triage state.** Which findings has somebody looked at, which are deferred,
   which arrived since yesterday. The baseline is the only memory loupe has, and
   it is binary: accepted or not.
5. **Live DOM correlation, without the bookmarklet.** What `serve` does, in
   something that starts with the project open rather than with a drag to the
   bookmarks bar.

Note what is *not* on this list: prettier charts, a component gallery, a
token browser. Those are nice; they are not the gap.

## Shared prerequisites

Every option below needs most of the same engine work, and it is worth costing
separately because it is the majority of the real effort and it is reusable
across all of them.

**An HTTP surface with write endpoints.** `serve.ts` already has the shape: a
stdlib server, permissive CORS, `/findings.json` re-analyzed per request, and
`/overlay.js`. What it lacks is everything that writes. Roughly:

```
GET  /findings.json        exists
GET  /source?file=&line=   a range, for an in-UI source view
GET  /config               the effective config `status` prints
GET  /profiles             which profile matched, and why
POST /fix                  one finding, or a set — via applyTokenFixes
POST /baseline             accept the current set, or one finding
POST /suppress             write a directive (with a reason — blank is an error by design)
GET  /events               SSE: re-analysis finished, here is the new payload
```

**A watcher, and the decision to have one.** `serve.ts` re-analyzes per request
on purpose: "no watcher, no cache, no invalidation rules to get wrong." That is
the right call for a bookmarklet. A live UI needs the opposite, and the cost is
real — a watcher is the classic source of a tool that reports on a tree that no
longer exists.

**Incremental analysis, eventually.** The numbers are already measured. A warm
LSP re-runs a 613-file project in ~115ms and Gutenberg's 9,531 in ~2.4s, against
380ms and 5.9s cold through the CLI. 115ms is instant; 2.4s is not, and a UI
that re-renders on every save makes that felt. `lsp.ts` already names the fix in
its own ponytail: split `analyze` into index and check phases and keep the index
warm. A live UI is what makes that worth pulling.

**Payload discipline.** The design notes' recurring rule is one predicate per
fact — `status` against the gate, the JSON payload against the HTML page. Any
new UI consumes `reportPayload()` verbatim, exactly as the HTML report and
`serve` already do. A UI that computes its own summary numbers will eventually
disagree with the CLI, and that is the specific failure the architecture is
organised to prevent.

**Then, and only then, the shell question.** Which is what the rest of this is
about.

## The options

### A. Grow the report into a live local web app — `loupe ui`

Serve the existing report UI from the existing server, and give it the write
endpoints.

The mechanical cost here is genuinely small, and worth being precise about: the
HTML report's client is one line from being live. It opens with

```js
var data = JSON.parse(document.getElementById('loupe-data').textContent);
```

Replace that with a fetch against `/findings.json` and call `render()` on the
result, and the same page is live. Every view it already has — KPIs, rule bars,
directory rollup, composite clusters, the findings table, the severity chips and
the filter — works unchanged, because they all read `data` and re-render from it.
`--format html` keeps the embedded payload and stays a self-contained artifact;
`loupe ui` serves the same views over the socket.

Navigation is nearly free too: `vscode://file/{path}:{line}` (and the `cursor://`,
`zed://`, `idea://` equivalents) opens the reader's editor at the line from a
plain anchor.

- **Unlocks** liveness, navigation, write-back, and a home for triage state.
- **Costs** the shared prerequisites, plus a modest view layer. No new language,
  no packaging, no signing, no store. Runs on any machine that already has loupe.
- **Forecloses** nothing. Every later option consumes this server.
- **Doesn't give you** anything that feels like an app: no window of its own, no
  menu bar, no notification when drift appears, no project switcher.

### B. Tauri desktop app, engine as a sidecar

A Rust shell around a web frontend, with the compiled loupe binary shipped as a
Tauri `externalBin` sidecar.

The distribution story is *already solved* for this, which is the interesting
part. `engine/scripts/build-binary.mjs` already cross-compiles single-file
executables for seven targets (linux x64/arm64, both glibc and musl, darwin
x64/arm64, windows x64) from one machine. That is exactly the artifact a sidecar
wants.

- **Unlocks** a real window, native file watching, a tray/menu-bar presence,
  native notifications, multi-project switching, auto-update, and — see H — a
  controlled webview.
- **Costs** Rust in the repo, seven more CI targets, code signing and Apple
  notarization (a paid developer account and a notarization step per release),
  Windows signing, and an update channel to keep alive. Bundle size is dominated
  by the sidecar: the binaries are 60–100 MB each, so the shell's own few MB are
  a rounding error.
- **Forecloses** nothing, but it is the option that adds the most permanent
  operational surface. A release pipeline with signing in it is a thing you own
  forever.

### C. Electron desktop app

Same shape as B, with one real technical advantage and one real cost.

The advantage: Electron ships Node, so there is no sidecar and no stdio
protocol. The engine has no native modules — `@babel/parser`, `picomatch` and
`postcss` are all it needs, and `build.mjs` already inlines them into a single
ESM file, leaving only node builtins and the two optional Sass/Less syntax
packages (deliberately left as unresolvable dynamic imports for the host to
provide). So the main process can call `analyze` in-process.

The one piece of plumbing it does need: `dist/loupe.mjs` is bundled from
`src/cli.ts` and is an executable entry, not a library — it exports nothing. A
library entry point is a second `entryPoints` line in `build.mjs` exposing
`analyze` and `reportPayload`, which is still far less than a stdio protocol.

The cost is size and weight: Electron's own runtime is heavier than Tauri's
before any of loupe ships, and a conformance checker that should feel like a
linter is the wrong place to spend a hundred-plus megabytes of resident browser.

- **Unlocks** the same as B.
- **Costs** less plumbing than B, more bytes and more memory. Signing and
  notarization are identical.

### D. VS Code webview panel

Grow the extension from launcher to host: put the report views in a webview
beside the code they are about.

Navigation becomes exact rather than best-effort — `showTextDocument` with a
range, not a URL scheme. Fixes are already there as quick fixes. The payload can
arrive over the LSP connection as a custom request, so there is no second
analysis path.

- **Unlocks** navigation and liveness *inside the editor*, which is where a
  person fixing findings already is. Lowest friction of any option for the
  reader who is mid-task.
- **Costs** a webview app, a custom LSP request, and extension packaging.
- **Forecloses** — and this is the objection — it spends effort on a surface that
  is explicitly not privileged today. The current design's selling point is that
  the extension is a 96-line launcher and every other editor reaches the same
  server with no extension at all. A rich VS Code panel makes VS Code the good
  experience and everything else the thin one, and nothing in loupe would say so.
  Worth doing *after* A, as a client of the same server, not instead of it.

### E. Browser DevTools extension

Promote the `serve` overlay from bookmarklet to a real DevTools panel, plus an
Elements-panel sidebar pane: select an element, see the findings that land on it.

This is the option that deepens the thing only loupe can do. `Finding.selector`
and `Finding.media` already exist for exactly this, and the panel logic in
`serve.ts` — selector sanitising, the state-pseudo-class stripping, the
match/mark/pin loop — is already written and already handles the awkward cases.

- **Unlocks** element-first inspection, which inverts the whole interaction:
  instead of "here are 200 findings, where are they", it is "what is wrong with
  *this*". Survives navigation and reloads, which the bookmarklet does not.
- **Costs** an extension per browser, manifest v3, and store review. No signing
  or notarization pain.
- **Forecloses** nothing. Independent of A–D.

### F. Menu-bar drift indicator

A tray process that watches the project and shows a count; clicking it opens the
web UI from A.

This is the cheapest way to get "it feels like an app" without building one, and
it is the only option that makes loupe *ambient* — drift you did not go looking
for. Buildable on Tauri's tray with no window at all, which is a much smaller
commitment than B.

- **Unlocks** ambient awareness, and a launcher.
- **Costs** the shell question in miniature — still signing, still an update
  channel, still a platform matrix.

### G. Hosted dashboard

Skip it, at least for now. SARIF already exists and GitHub code scanning is
already the team surface; a hosted dashboard means CI upload, storage, auth and
a service to run. And it cuts against the property the judge design notes are
careful to protect — the gate stays deterministic and offline. This is a product
decision, not a UI one.

### H. The differentiated bet: loupe as a browser for your own UI

Worth naming separately because it is the only option that *needs* a native
shell rather than merely enjoying one.

A window with three things in it: a webview pointed at the project's dev server,
loupe's overlay injected automatically into it (no bookmarklet, because the app
controls the webview), and the findings panel beside it. Click a finding, the
elements outline. Click an element, the findings for it. Click through to the
source line in the editor. Change the viewport and watch which `@media`-bound
findings come alive — which `Finding.media` already supports and nothing today
exposes.

That is not a findings list. It is a live inspection surface for design-system
conformance, and it is a thing that does not exist. It is also the most
expensive item here, and it should be reached by building A and E first, because
both are strictly on the path to it.

## Recommendation

Staged, cheapest-first, nothing thrown away.

**Stage 1 — `loupe ui`, option A. Built.** Do the shared prerequisites and serve
the existing views live from the existing server. This is where essentially all
of the user-visible gain per unit of effort is: liveness, navigation, write-back
and triage, with no new language, no packaging and no signing. It is also the
honest test of whether the gap is a shell problem at all — if a live local web
app with write endpoints satisfies the need, stop here and save the release
pipeline. That test is now runnable rather than hypothetical, which is the point
of having done it first.

**Stage 2 — option E, the DevTools panel. Built.** Deepens the capability that is
actually unique, reuses panel logic that is already written and already handles
the hard cases, and costs a store listing rather than a notarization pipeline.
(It is currently loaded unpacked; no store listing has been made.)

**Stage 3 — option D, the VS Code webview, as a second client of the Stage 1
server.** Only once the server is the single source of the payload, so the panel
cannot become a third place that computes the same facts.

**Stage 4 — the shell, if it is still wanted.** Prefer Tauri (B) over Electron
(C) on weight, and take the sidecar plumbing cost, because the seven-target
binary build already exists and a dev tool should stay light. Start with the tray
(F) rather than a window: it is the same platform work at a fraction of the
surface, and it answers "does ambient drift awareness matter" before committing
to H.

**What would change this.** Three things, in the order they would move me:

- If the intended reader is not the person who ran `npm install` — a designer
  auditing a system they do not build, a lead reviewing a team's drift — then
  Stage 1's "runs on a machine that already has loupe" assumption collapses, and
  the shell moves up, because installation *is* the product for that reader.
- If viewport-dependent findings turn out to be where the real value is, H stops
  being stage 4 and becomes the thesis.
- If incremental analysis proves harder than the ponytail in `lsp.ts` suggests,
  every option gets worse at once and the live-on-save premise needs rethinking
  before any shell is built.
