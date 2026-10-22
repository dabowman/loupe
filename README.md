# Loupe

Keeps agent-written UI on its design system.

A loupe is what a printer holds over a proof before the run: close enough to
see the dot, early enough that fixing it costs nothing. Same idea here — the
drift is caught on the file just written, not in review.

An agent writing UI produces code that compiles, renders correctly, passes
review, and quietly reimplements things the design system already provides: a
hand-rolled flex row beside the layout primitive, a `font-size` beside a
component's own styling prop, a `margin-bottom` where the parent has a `gap`.
None of it is an error. All of it is drift, and it is expensive to unwind once
the pattern is load-bearing — because by then every argument for keeping it is
locally true.

Three design systems ship with it — the WordPress Design System,
[Archer](#profiles), a Base UI–based system, and the
[VIP Design System](#profiles), built on Theme UI — and a fourth is a directory
rather than a fork: nothing about any of them is compiled into the engine.

This plugin works at two moments: **before** the code is written (skills that
set the rules and the sanctioned compositions) and **as** it is written (hooks
that report drift on the file just touched, not forty tool calls later).

## Install

```
/plugin marketplace add dabowman/loupe
/plugin install loupe@loupe
```

The hooks are off until a project opts in. In each project you want gated, add
this to `.claude/settings.local.json` and start a new session:

```json
{ "env": { "LOUPE": "on" } }
```

The skills, the commands and `loupe` typed by hand work everywhere without it.
`loupe status` prints a `hook: OFF` line in a project that hasn't opted in.

Nothing else to run. The engine ships pre-bundled with its dependencies, so a
fresh install is a working install on any machine with Node 18 or newer — no
`npm install`, no toolchain, no build step. See
[Working on the engine](#working-on-the-engine) if you are changing it rather
than using it.

## What's in it

| | |
| --- | --- |
| `skills/loupe-authoring` | The authoring rules — order of resort, gap over margin, props over CSS, tokens by role. Load before writing UI. |
| `skills/loupe-patterns` | How the composite registry works, and the discipline of checking it. Load before assembling a header, modal, action bar, sidebar. |
| `skills/loupe-remediation` | Per-rule remedies, and the checks that stop a "fix" from silently changing rendering. |
| `agents/loupe-fixer` | Per-file remediation agent. `/loupe-fix` fans it out once the work spans enough files to be worth it. |
| `commands/` | `/loupe-init`, `/loupe-audit`, `/loupe-fix`, `/loupe-baseline`, `/loupe-report` |
| `hooks/hooks.json` | `PostToolUse` on what the edit just introduced, `Stop` across changed files |
| `hooks/register.tsx` | The Loupe pane — the report drawn beside the transcript, re-run after each edit, with a status-line tally; `/loupe-pane` opens it by hand |
| `profiles/wpds/` | The WPDS profile — the packages that identify it, its preset, its two registries and its three authoring docs |
| `profiles/archer/` | The Archer profile — the same, for a styled system built on Base UI, with its own layout and text components |
| `profiles/vip/` | The VIP Design System profile — the same, for `@automattic/vip-design-system` on Theme UI |
| `profiles/*/patterns/index.json` | The composite registry |
| `profiles/*/components/index.json` | The component currency registry — recommended/legacy/locked/experimental per component+package, and the styling surface each verified component owns |
| `engine/` | `loupe` — the conformance engine |
| `editors/vscode/` | The VS Code / Cursor launcher for `loupe lsp`. Other editors need no extension |
| `integrations/wordpress/` | A dev mu-plugin that loads the `serve` overlay itself, so wp-admin is not a bookmarklet click per screen |
| `integrations/devtools/` | A Chrome DevTools extension: a panel listing every finding resolved against the page, and an Elements sidebar saying what is wrong with the selected node |
| `docs/design/` | Design notes: why the engine is built the way it is, and the measurements behind its tuned numbers |

The three skills are design-system agnostic: each one starts at `loupe status`
to learn which system is in play, then reads that system's own notes —
`authoring.md`, `patterns.md`, `remediation.md` — out of the active profile.
The rules are the same everywhere; the component names, token families and
suppression keyword are not, and guessing them is what produces code that looks
conformant and imports nothing real.

## The engine

Linters see one file at a time. This correlates the two sides no single linter
holds at once: the JSX that binds a class to a component, and the CSS that
styles that class. That correlation is what lets it say *"this `font-size` is on
a `<Text>` — use its `size` prop"* rather than *"this `font-size` isn't a
token."*

Three channels are checked, all through one classifier so they cannot drift into
different verdicts: stylesheets, `style={{ … }}` object expressions, and
CSS-in-JS template literals — emotion's ``css` ` `` and styled-components'
``styled.div` ` ``, which is what `@wordpress/components` is itself built on.
`style={{ marginBottom: 16 }}`, ``styled.div`margin-bottom: 16px` `` and
`margin-bottom: 16px` in a stylesheet are one violation with one remedy.

``styled(Button)` ` `` resolves to the same verdict a class bound to `Button`
gets in a stylesheet. On a design-system component one attribute-level finding
supersedes the per-declaration ones, because the remedy there is the component's
props, not a better value.

An interpolation is opaque — `${({ theme }) => …}` could emit anything — so a
value that depends on one produces no finding, and a template whose *structure*
depends on one is recorded as a parse diagnostic rather than guessed at.

```bash
loupe check --all
loupe check --all --group-by file
loupe check --all --concise
loupe check --all --format html > report.html
loupe explain layout/margin-on-child
```

The report is a nesting, so neither the rule nor the path is repeated line by
line. `--group-by` picks which of the two heads a block — the other becomes the
sub-heading, and the findings under it are bare line numbers:

```
• tokens/hardcoded-value (4 in 2 files, 3 distinct) advisory — hardcoded value — replace with a --wpds-* token
  styles/card.css (3)
       2  color: #1e1e1e → --wpds-color-foreground-content-neutral
       3  border-radius: 4px → --wpds-border-radius-md
      14  padding: 16px → --wpds-dimension-padding-md
  styles/row.css (1)
       4  color: #1e1e1e → --wpds-color-foreground-content-neutral
```

`--group-by rule` (the default) is the triage order: the remedy is stated once
and every site of it sits underneath, richest rule first. `--group-by file`
swaps the two — path at the margin, rule indented under it, files that block
the gate first — which is the shape of the work when you are already in an
editor rather than auditing a repo. Nothing else about the report changes, and
`--max-findings` spreads its budget across whichever axis you grouped on.

Identical findings — the same rule, file and text — print once, with a count
and every line they stand for, and a rule's heading says how its findings
concentrate:

```
✗ layout/margin-on-child (25 in 9 files, 11 distinct) blocking — margin — move spacing to the parent layout primitive's gap prop
  src/components/step-row.scss (8)
      31  margin-bottom: 8px  ×7 (lines 31, 44, 58, 77, 91, 104, 118)
      62  margin-top: 12px
```

`×7` in one file says write a script; eleven singletons say read each one. The
budget counts printed lines, so duplicates stretch it rather than spend it.
`--rule <id>` scopes `check` or `fix` to one rule — repeat it for more — so
`loupe check --rule layout/margin-on-child --format json` is the whole batch.

`--concise` keeps the tally and the headings of whichever axis you grouped on,
and drops the findings underneath them — the shape of the report when the
question is how much and where, not what to edit:

```
loupe: 12 blocking, 31 advisory (tokens/hardcoded-value, layout/margin-on-child). 84 file(s) scanned.

styles/card.css (18)
styles/row.css (14)
src/App.jsx (11)
```

Parse errors and a token set that came back empty still print — a run that
quietly skipped half the CSS reads as a clean one at either verbosity.

`bin/loupe` is on PATH inside any Claude Code session — Claude Code adds each
enabled plugin's `bin/` to the environment it runs commands in, and only
there. A plain terminal reports `command not found` until you symlink it
somewhere on your `PATH`:

```bash
ln -s ~/.claude/plugins/marketplaces/loupe/bin/loupe ~/.local/bin/loupe
```

Link the marketplace clone, not the copy Claude Code runs: that one sits under
`~/.claude/plugins/cache/loupe/loupe/<commit>/`, and the commit changes on every
update. The clone moves with `/plugin marketplace update`, so it can be a
commit ahead of the installed plugin between updates. From a checkout of this
repository, link its `bin/loupe` the same way. Loupe is not on npm yet, so a
`lint:loupe` script in a project's `package.json` works only for people who
have made this link.

A terminal sees none of the plugin's settings (blocking, preset, API key) —
Claude Code passes them to hooks only. `loupe status` says where it found its
settings, and a hand-run `loupe check` exits 1 on errors either way.

It runs against the project you are in — the directory holding the
`loupe.config.json` that governs your cwd, so a command typed in
`packages/app` and the gate running over the whole repo agree on what the
project is and read the same baseline. Pass `--root` when you mean the
subdirectory itself. It needs nothing added to that project: the engine carries its own dependencies, so there is no config file to
commit and nothing to install. Nothing appears unless you run the thing that
writes it: `loupe baseline` records `.loupe-baseline.json`, and `loupe fix` rewrites the
declarations — and the misspelled token names — whose findings it can settle
without judgment. It also passes the
shipped pattern and component registries unless you name your own with
`--patterns`/`--components`.

`check`, `status` and the gate are pure analysis — they never edit. `loupe fix`
is the one command that does, and only for substitutions with a single right
answer; everything needing judgment is `loupe-remediation`'s job.

### Rules

| Rule | Detects | wpds preset |
| --- | --- | --- |
| `stylesheet/unparsed` | A stylesheet nothing could read — a hole in coverage | error |
| `suppression/malformed` | A blanket disable, or one missing a rule id or reason | error |
| `layout/margin-on-child` | Spacing margin, which belongs on the parent's `gap` | error |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own | error |
| `typography/in-css` | A text component typed in CSS instead of via props | error |
| `system/override` | CSS setting a property a design-system component owns (per its registry `surface`), or reaching into a library's internals | error |
| `system/inline-style` | `style={{ … }}` on a design-system component — it overrides the props | error |
| `system/locked-component` | A private API the design system does not recommend outside its own core | error |
| `layout/negative-margin` | A bleed — confirm it is deliberate | warn |
| `typography/untokenized` | Raw type styling with no token and no text component | warn |
| `system/raw-element` | A raw element that has a design-system analog | warn |
| `system/superseded-component` | A current, recommended component now covers this job | warn |
| `tokens/hardcoded-value` | A literal colour or length where a token exists | warn |
| `css/dead-class` | A namespaced class referenced in no markup or reference file | warn |
| `tokens/unknown-token` | A `var()` naming no token the design system defines | warn |
| `tokens/misapplied-token` | A real token used outside its declared scope — a `surface` background on a button | warn |
| `tokens/undelivered` | Tokens used, and nothing shows the stylesheet defining them reaches the page | warn |
| `patterns/duplicate-composite` | A registered composite reassembled by hand in more than one file | warn |
| `patterns/superseded-composite` | A shape a registered pattern exists to replace, in the one file that built it | warn |
| `patterns/unregistered-composite` | The same composite built in three or more files, registered in none | warn |
| `patterns/judged-redirect` | `--judge` only: a control read as standing for something its pattern redirects elsewhere | warn |

Rules disable themselves when the config cannot support them — a block theme
with no component layer leaves the component rules inert rather than firing on
nothing.

`system/raw-element` says what the conversion would cost: where a declaration
on the element's classes would block once the class sits on the component, the
message names it — `<h4> → <Text render={ <h4 /> }> (@wordpress/ui) —
converted, would block: font-size (.acme-title)` — so the change is weighed
before it is made, not discovered after.

`system/raw-element` skips the element a text or layout component's
substitution prop is handed: `<Text variant="heading-md" render={ <h4 /> }>` is
how you keep a heading's semantics under WPDS, not a raw `<h4>`. The prop list is
config — see [`designSystem.substitutionProps`](engine/README.md#config)
for the bounds and the default.

### Tokens

`tokenPrefixes` used to be cosmetic — it shaped a message and validated nothing.
So a finding said *"13px is hardcoded — use a `--wpds-*` token"*, and the agent,
having no list to choose from, invented `--wpds-font-size-13`. A finding that
names a namespace instead of a value manufactures its own next bug.

`designSystem.tokenSources` points at the stylesheets that *define* the tokens —
for `wpds` that is `@wordpress/theme`, 190 of them in one file — and anything the
project defines itself is added to the set. Findings then name the token:

```
• tokens/hardcoded-value (1) advisory — hardcoded value — replace with a --wpds-* token
  styles/card.scss (1)
      12  padding: 12px → --wpds-dimension-padding-md
```

Only an on-role token is offered. `1px` is both `--wpds-border-radius-xs` and
`--wpds-border-width-xs`; suggesting the wrong one gives the right pixels and the
wrong meaning, which survives review precisely because it looks correct. When
nothing on-role matches, the finding names no token rather than a plausible one.

`tokens/unknown-token` catches the other direction — a `var()` naming nothing the
design system defines.

`tokens/undelivered` asks whether the tokens arrive at all. An undefined custom
property makes its whole declaration invalid, so `background:
var(--wpds-color-…)` on a page that never loads `wp-theme` does not fall back —
it drops. How a sheet is delivered is the design system's fact, so the profile's
`delivery.json` declares the evidence (for WPDS: a `wp_enqueue_style` whose
dependency array lists `wp-theme` or a style that depends on it, a `block.json`
naming `wp-theme`, or an import of the sheet — `wp-components` and the editor
handles do not count, since they depend on `wp-theme` only on some cores, and a
build that writes fallbacks is not delivery either: the finding says it found
one, because those values render but never follow the theme) and the
engine runs it with a bounded, literal read — no PHP parser. It reports once per
project, at the first token use, and only when it found enqueues, read every one,
and none qualifies. It stays silent when no definitions were found at all,
because an empty token set proves nothing. A name that is one keystroke from
exactly one real token is a misspelling the engine can settle, and `loupe fix`
renames it wherever the file writes it. With `--judge`, a name an agent made up
in another system's vocabulary, like `--wpds-color-text-muted`, is renamed to the
token it meant when the answer is confident enough.

Because the engine resolved that substitution itself, it can also apply it:

```bash
loupe fix   # --dry-run to see it first
```

Only where exactly one on-role token carries the value — or, for a misspelled
name, where exactly one known token is a single keystroke away and that
keystroke is not a digit, since `--wpds-dimension-space-20` and
`--wpds-dimension-space-30` are one edit apart and mean different amounts. Two
candidates is a semantic choice, so it is left alone — and so is one the profile
scopes to another kind of element, below. All three channels are
rewritten: a
stylesheet and a CSS-in-JS template are matched as the CSS they are, and a
`style={{ padding: 13 }}` object is spliced at the literal the scan recorded,
since `padding-bottom: 13px` is a translation of what the file says rather than
a copy of it. Paying a model to read a file back and retype an answer nothing
had to reason about is the expensive way to apply a substitution, and this is
usually the highest-volume rule in a report.

### Token scopes

A token's type says what kind of value it is, not what it is *for*. The WPDS
radius scale is role-based — xs nested inside controls, sm standalone buttons
and inputs, md menus and popovers, lg cards and dialogs, xl the page shell — so
`border-radius: 4px` is `md` by value on a dialog and on a button alike, and
wrong on both. Matching by value alone applied it to both, unattended.

So a profile declares its system's naming grammar and what each segment means
(`profiles/wpds/token-scopes.json`, from WPDS's own published grammar,
`--wpds-color-<property>-<target>-<tone>…`), plus an explicit list for a scale
whose role is not in the name. A single suggested token scoped to a kind of
element is now applied only where the markup shows the declaration styles that
kind; otherwise it is held for review, with the reason:

```
$ loupe fix --dry-run
review src/a.scss:2  border-radius: 4px → --wpds-border-radius-md — for overlay; what this styles is not known
review src/a.scss:4  border-radius: 4px → --wpds-border-radius-md — for overlay; this styles <button>
```

And `tokens/misapplied-token` (advisory) catches a real token used off its
scope — the case only a reader of the token docs caught before:

```
• tokens/misapplied-token (2) advisory — misapplied token — it exists, but WordPress scopes it to another property or another kind of element; use the token whose role matches
  src/preflight-card.scss (2)
      63  background: --wpds-color-background-surface-neutral-strong — not for interactive; this styles <input>
      71  color: --wpds-color-background-interactive-neutral — a background token sets background, background-color, background-image
```

A profile that declares no scopes behaves exactly as before, and so does every
token its grammar does not place. See
[token scopes](engine/README.md#token-scopes) for the schema. Archer and VIP
declare their colour roles (`--color-text-*`, `--theme-ui-colors-texts-*`); their
other families carry no role in the name and stay on the generic table.

### Judged variants

`<p> → <Text>` names the component, not the variant, and sometimes the
component is wrong too: a `<span>` that is a colour swatch, or a `<p>` that
only wraps a button. `loupe check --judge` sends each of those elements to
[TypeSafe](https://docs.typesafe.ai) in a request of its own. It picks from the
`variants` the profile's component registry declares for the analog, or says
the element is not text at all:

```
• system/raw-element (3 in 2 files, 3 distinct) advisory — raw element — use its design-system analog
  src/components/build-summary.tsx (2)
      131  <h3> → <Text variant="heading-lg" render={ <h3 /> }> (@wordpress/ui) (judged 0.66)
      142  <p> → <Text variant="body-sm"> (judged 0.80)
  src/components/brand-picker.tsx (1)
      101  <span> → no analog, not Text content (judged 1.00)
```

The answer is written into the suggestion, confidence last, and what the model
supplied is green in a terminal. Below 0.5 confidence the finding is left as it
was, and no judgement changes a verdict. `--format json` carries the answer as
data, `judged: { answer, confidence, spans }`, so a tool can act on a judgement
without parsing the sentence. It needs `TYPESAFE_API_KEY`, found in this order:
the environment, the plugin's *TypeSafe API key* option (hooks only), a `.env`
beside the checkout, then `~/.config/loupe/.env` (see `.env.example`). As a
plugin, the option covers the hooks and the user-level `.env` covers everything
else; the checkout's `.env` is inside the plugin cache, which updates replace.

The hook passes `--judge` too, so the advice an agent is handed at write time is
the same advice `loupe check --judge` gives. Without a key it judges nothing and
reports as it always did — the verdicts were never the judged part. See
[Judging in the hook](#judging-in-the-hook).

### Judged values

Most flagged values are not exactly a token. A plugin written against the
wp-admin palette uses `#1d2327` and `#646970`, which WPDS never ships, so the
exact-match fix above settles almost none of them. `--judge` settles the rest,
for `tokens/hardcoded-value` and for the type properties of
`typography/untokenized`:

```
• tokens/hardcoded-value (4 in 3 files, 4 distinct) advisory — hardcoded value — replace with a --wpds-* token
  assets/css/admin-panels.css (2)
       33  color: #1d2327 → --wpds-color-foreground-content-neutral (judged 0.77)
       85  background: #fcf0f1 → --wpds-color-background-surface-error-weak (judged 0.81)
  assets/css/bulk-edit.css (1)
       30  background: rgba(0, 0, 0, 0.55) → deliberate, no token fits (judged 0.99)
  assets/css/report-page.css (1)
       70  box-shadow: 0 1px 2px rgba( 0, 0, 0, 0.04 ) → no box-shadow token in the design system

• typography/untokenized (1) advisory — raw type styling — use <Text>/<Heading>, or a --wpds-* type token if it cannot be used
  assets/css/admin-panels.css (1)
      209  font-weight: 700 → --wpds-typography-font-weight-emphasis (judged 0.85)
```

Code does the arithmetic and the model does the reading. The property picks the
token family (`color` gets foreground tokens, `padding` gets padding tokens), a
length is narrowed to the scale steps either side of it, and a shorthand is
settled part by part. Then TypeSafe gets each literal in context along with its
candidate tokens, each described in the design system's own words. It picks
the token the rule should have used, or says the value is deliberate: a scrim,
a pill, a brand colour the system has no token for. A property with no tokens
at all needs no model.

Then apply it:

```bash
loupe fix --judge --dry-run   # review what it would write
loupe fix --judge             # rewrite the settled values, suppress the tokenless ones
```

Only picks at 0.5 confidence or above are applied. The exception is spacing
(padding, gap, `top`/`left`/…) that falls between two steps of the scale:
it always snaps to one of them, and is never judged deliberate. Settled values
are rewritten in place. A value whose property has no token in the design
system at all gets a `wpds-allow` directive naming the rule it was reported
under, with that as its reason. One the model judged deliberate is left for
review, since what it actually is — a scrim, a pill — is a reason only a reader
can write. Everything else is left for review too. See `engine/README.md` for
how the judgement scores on the literals of an un-remediated WPDS plugin.

### Judged redirects

The same flag reads what a control stands for — a value, a command or a
destination — off every `Button`, menu item, toolbar button and `SelectControl`
the profile names, and runs the pattern language's `resolve` table on the
answer. A button that navigates is a link however it is styled, so:

```
• patterns/judged-redirect (1) advisory — a model read what this control stands for, and the
  pattern it was built as redirects that reading elsewhere; confirm before changing it
  widgets/site-preview/render.tsx (1)
      116  <Button> (represents: destination) → `navigate-hierarchy` (judged 1.00)
```

That is `patterns/judged-redirect`, reported only at 0.90 confidence or above,
advisory and never baselined. A control that already carries `href` is not
asked. See `engine/README.md` for how it decides and how
it scored.

### Mapping one token set onto another

Experimental, and off to one side of everything above: the rest of loupe asks
whether code conforms to *its* design system, and this asks a question with two
systems in it. Given two DTCG token sets it answers, for every token in the
first, which token in the second is the same decision — which is what makes two
systems comparable at all.

```bash
loupe map ./wpds/tokens ./primer/tokens --out map.json
loupe map ./a ./b --dry-run            # the shortlists, asking nothing
```

Both sides are assumed to be standard DTCG and three-tiered; nothing else about
them has to agree, and nothing is configured per system. `$type` is a hard gate;
every token of a compatible type is then offered, and only where there are more
of them than a question can carry is the list ranked down — colour distance in
OKLab, names as word sets with the organising words dropped. The model picks
among them or says the second system has no counterpart. Where several tokens
land on one counterpart the report says so rather than reading like a bijection
— which is often the finding: nine WPDS tokens map onto Primer's single
`bgColor.disabled`. `--dry-run` shows the shortlists for free, which is the first
thing to run on a new pair.

Some of it is measured. `engine/evals/counterparts` builds labelled pairs by
renaming a real set, and says what the question needs (the `$description`
carries the meaning; a name alone declines 41% of the time when a counterpart
exists) and where the confidence floor goes (0.70, the one point where precision
steps — 97% above it, about 75% anywhere below). The ranking weights are still
arguments rather than numbers. `docs/design/map.md` says which is which, and
`engine/README.md` documents the flags.

### Composites

The expensive drift is compositional: six page headers, four modal footers, each
individually defensible. No per-file linter can see it — every instance looks
fine on its own, and the finding only exists across files.

A signature is the design-system component tree with everything else dropped, so
an intervening `<div>` never hides a match and a prop change never invents one.
Matching is containment: `edit-record.dialog` records its footer as a sibling
of the body, real code nests it inside, and both are the same composition. A node may
name alternatives with `|` (`Stack|VStack|HStack|Flex`), because one shape
usually has more than one spelling and an entry that knows only the newest one
reports every file still writing the old one.

- `patterns/duplicate-composite` — a registered pattern reassembled by hand in
  two or more files.
- `patterns/superseded-composite` — a shape a pattern's `instead_of_signature`
  records as the thing it replaces, or a hit from one of the registry's AST
  rules (a select with four short static options; a modal holding only a
  consent pair). One file is enough: a wrong choice is a defect where it is
  made, not only across a set.
- `patterns/unregistered-composite` — the same shape in three or more files and
  in no registry. Two is a coincidence; three is house style.

Signatures below four nodes are documentation, not checks. `Stack(Button,Button)`
is a true description of an action bar and a useless finding — it matched 48
files in one repo, and *"you have 48 action bars"* is not a defect anyone can act
on. The wrong choice is usually one control, under that floor, which is what
an entry's `detector` rules are for: the registry names the component and the
limits, the engine ships the rule.

The `wpds` registry keys its entries by user need, not component name —
`confirm`, `choose.segmented`, `navigate-hierarchy#descend` — against an
abstract pattern language in the top-level `patterns/index.json`, which it
names in `extends`. The reach-for table in `profiles/wpds/patterns.md` is
generated from the two files (`npm run patterns-doc` in `engine/`), so the
prose an agent reads and the registry the engine checks cannot drift apart.
The reasoning is in `docs/patterns-v2.md`.

`wpds` is the only profile that realizes the abstract language so far. The
`archer` and `vip` registries are v1: a flat list of entries keyed by `id`
(`dialog-anatomy`, `confirmation-dialog`), with no `extends`. The engine still
reads them, but their `patterns.md` is written by hand, and
`patterns-doc --check` covers only the generated tables, so nothing checks
those two against their registries.

The registry reaches the engine through the `wpds` profile, which the hooks and
commands pass automatically and which applies only to projects importing
`@wordpress/components` or `@wordpress/ui` — see [Profiles](#profiles). A
project's own registry is merged over the shipped one, winning on `id`.

### Component currency

Components and patterns are the same drift at two altitudes: a pattern is a
shape rebuilt when a composite already exists; component currency is a name
used when a *different* name is now the right one. WPDS runs two live
packages at once — `@wordpress/components` and `@wordpress/ui` — and the same
name can mean a stable component in one and an early one in the other
(`Button` is stable in `@wordpress/components` today; the newer `Button` in
`@wordpress/ui` is real but explicitly not yet safe to mix with it).

`profiles/wpds/components/index.json` is the verified-once answer: every known component,
its package, and whether it is `recommended`, `legacy` (works, but a
recommended replacement covers the job), `locked` (a private API WPDS does
not recommend outside Gutenberg core — can break without notice), or
`experimental` (real and documented, but WPDS's own metadata flags it not yet
safe to recommend broadly — informational only, never enforced).

- `system/locked-component` — importing a `locked` entry. `error`, because
  this is a real risk, not a style preference.
- `system/superseded-component` — importing a `legacy` entry whose
  replacement is itself `recommended`. `warn`.

`experimental` entries never fire either rule — WPDS's own Storybook metadata
says those aren't yet safe to recommend for most codebases, so pushing
migration would be wrong, not just premature. That call stays in
`loupe-authoring`, as prose, for an agent to reason about contextually.

Neither rule offers a fix. Eight `legacy` entries name a replacement carrying
the same exported name in `@wordpress/ui`, which is what makes an automatic
import swap look available — and all eight, read against Gutenberg trunk, turn
out not to be one: `Card` and `Tooltip` are namespaces there, `Text` reuses the
name `variant` for a different set of values, `Spinner` loses a margin at every
call site. The registry records that verdict in a `dropIn` field, and today
carries it on nothing.

An entry can also carry a styling `surface`: the CSS properties the component
styles itself on the element its `className` reaches, each mapped to the prop
that controls it, or to `null` where no prop does. `system/override` blocks only
on a property a surface lists, and names the prop — `<Text> ← font-size — set
via its variant prop` — or says there is none. A class setting anything else is
`className` doing its job, and gets the verdict it would get on a plain
element. An entry with no `surface` has not been read for one, so it fails safe
to that advisory verdict too — in a registry that records surfaces at all.
Where none the component could come from records one (the VIP and Archer
registries, a run with no profile, a project's own registry), the rule keeps
its earlier reading: any appearance property on a class bound to the component
blocks, with "restyle via its props/tokens, not CSS"; the registry's `scope` field says which component
families the file covers at all, so a missing entry reads as unreviewed rather
than fine.

The MCP has no maturity signal at all — it presents an `experimental`
component with the same confidence as a `recommended` one, and it's
measurably behind trunk for several `@wordpress/ui` additions besides. Use it
for prop/usage detail on a component already chosen; use this registry to
decide which component that should be.

Same delivery as patterns: carried by the `wpds` profile, merged over a
project's own registry, and keyed on `package::name` so a `Button` from another
design system is never mistaken for one of these.

### Profiles

Everything above that is specific to WPDS — the two registries, the preset that
configures them, the packages that identify it — lives in `profiles/wpds/`. The
engine takes `--profiles`, which the hooks, commands and `bin/loupe` all pass,
and applies a profile only to a project importing its packages. A project's own
profiles are read as well — see [Your own profile](#your-own-profile).

```jsonc
// profiles/wpds/profile.json
{
  "id": "wpds",
  "name": "WordPress Design System",
  "preset": "wpds",
  "packages": ["@wordpress/components", "@wordpress/ui"],
  "patterns": "./patterns/index.json",
  "components": "./components/index.json"
}
```

This matters because composite signatures match on component *names*, and
`Stack`, `Text`, `Button` and `Modal` are names nearly every design system uses.
`Stack(Stack(Text,Text),Stack(Button))` is a WPDS page header and a Chakra one,
so before profiles the hook reported a React repo as rebuilding a WordPress
pattern it had never heard of. Now the same code is reported on a WordPress
project and silent on a Chakra one.

`loupe status` names the active profile and the directory it lives in.

A profile also carries its design system's **authoring prose**, beside its
registries:

```
profiles/
  wpds/
    profile.json
    patterns/index.json      components/index.json
    authoring.md             # which component, token grammar, the escape-hatch keyword
    patterns.md              # which shape to reach for, and what already ships
    remediation.md           # the design-system half of each rule's remedy
  archer/
    …the same
```

The three skills carry the rules — order of resort, gap over margin, tokens by
role — and nothing else. Each starts at `loupe status`, reads which system is in
play and where its profile is, and loads the matching `.md`. So the same skill
that keeps a WordPress admin screen on `Stack` and `--wpds-dimension-gap-*`
keeps an Archer screen on `Stack` and `--space-*`, without either set of names
being baked into it.

The second profile shipped is **Archer**: a personal design system built on Base
UI, with layout and text components Base UI does not have, flat part exports
instead of `Dialog.Root`, and unprefixed tokens in seventeen families. It exists partly to be used and partly as the proof —
every place the plugin still assumed WordPress showed up as something Archer
could not express.

The third is the **VIP Design System** (`@automattic/vip-design-system`), and
it is the first on Theme UI. Its components are styled through an `sx` prop of
theme keys, which the engine does not read — so on a VIP codebase the value
rules see only stylesheets, `style` and CSS-in-JS, and the profile earns its
keep on component currency (`Dialog`, `ConfirmationDialog` and `Tooltip` are
deprecated), raw elements and composites. Its `authoring.md` carries the theme
scales so an agent holds the `sx` half by hand.

Adding a fourth is adding a directory here plus a preset in `engine/presets/` —
see **Adding a design system** in the
[engine README](engine/README.md#adding-a-design-system).

#### Your own profile

A design system that ships its own profile, in its own repo, does not need a
fork of this one. Put the profile directory in `.loupe/profiles/`, or list
wherever it lives under `profiles` in `loupe.config.json` (relative to the
config file):

```jsonc
{
  "extends": "generic",
  "profiles": "./loupe/profiles",
  "designSystem": { "name": "VIP v3", "packages": ["@automattic/vip-design-system"] }
}
```

Both are read on every run — the hooks, the commands and a typed `loupe` alike
— alongside the shipped profiles, not instead of them. A project profile wins
over a shipped one with the same `id`, and over one claiming the same package,
which is what a design system rebuilt under its old package name needs: the
shipped `vip` profile describes VIP's Theme UI system, not the v3 rebuild. The
shadowed profile is still there to name with `--profile`.

`"profile"` pins the choice outright: an id, or `"none"` for no profile, while
`designSystem.packages` — and every rule that needs it — stays as it is.

`loupe status` prints the chosen profile's directory, and the skills read its
`authoring.md`, `patterns.md` and `remediation.md` from there.

### Config

`loupe.config.json` at the repo root, discovered by walking up:

```jsonc
{
  "extends": "wpds",
  "namespaces": {
    "project": ["acme-"],        // classes you own; only these can be "dead"
    "external": ["components-"], // third-party internals; styling them is an override
    // An unprefixed system has no prefix to list: point `designSystem.styleSources`
    // at its stylesheets instead, and every class they define counts as internal.
    "neverDead": ["has-*"]       // generated at runtime, never in source
  }
}
```

Presets: `wpds` (WPDS tokens + a severity policy that actually blocks),
`wordpress-components` (the older admin surface), `wordpress-block-theme`,
`archer` (a styled system on Base UI, with its own layout and text components),
`vip` (the VIP Design System, on Theme UI),
`base-ui` (a starting point for any system built on Base UI), `generic`.

`base-ui` is a parent, the way `wordpress-components` is: Base UI is headless,
so it has no tokens, no layout primitive and no text component of its own, and
styling its parts with a class is the documented way to use it rather than
drift. What it does give you is the packages — so the compositional rules see
`Dialog.Root(Dialog.Trigger,Dialog.Portal(…))` as a shape, and the same anatomy
reassembled across files reports — plus `system/override` and
`system/inline-style` off, because on an unstyled library they are wrong by
construction. Your own layer goes on top:

```jsonc
{
  "extends": "base-ui",
  "designSystem": {
    "packages": ["@base-ui/react", "@acme/ui"],
    "tokenPrefixes": ["--acme-"],
    "components": { "layout": ["Stack", "Row"], "text": ["Text", "Heading"] }
  }
}
```

Naming your own layout and text components switches the correlation rules back
on. Leave `system/override` off unless your wrappers are the only thing anyone
imports: `known` is per-package-set, not per-package, so re-enabling it reports
the Base UI parts underneath as well.

Without a config file, one is inferred: `@wordpress/components` or
`@wordpress/ui` in **any** `package.json` within three levels selects `wpds`
(a WordPress repo is usually a monorepo, and the manifest that imports the
component library is rarely the root one); `theme.json` plus `templates/`
selects `wordpress-block-theme`; `@base-ui/react` selects `base-ui`; and the class prefixes you own are read off the
classes appearing in **both** your CSS and your markup, minus any a dependency
defines — `rbc-` looks exactly like a namespace you own until you notice
react-big-calendar ships the stylesheet that declares it.

Inference is bounded, because it is a guess and a guess does not earn an
unbounded walk inside a hook timeout: it stops after 50,000 directory entries,
drops the namespaces it inferred to low confidence, and says so — in `detect`,
in `status`, on stderr, and in the hook's own one-line message. A tree that big
is a home directory or a monorepo root, not a project. The preset is unaffected
either way: it is read off manifests and top-level markers rather than the walk.
Dot-directories are not walked at all unless a glob names one, because nothing
inside `.venv`, `.cache` or a pnpm store can match a `**` glob anyway — they
were spending the ceiling on entries that could not have answered it.

The hook also stands aside outright where there is no project to gate. It is
the one caller that gets pointed at a directory nobody chose — with
`CLAUDE_PROJECT_DIR` unset it falls back to the working directory — so before
walking anything it asks whether this is a project at all: a `package.json` or
a `composer.json`, a `.git` anywhere above it, git recognising a worktree, or
the markers a preset recognises, which is how a block theme with none of the
others still counts. Where none of that is there, a `PostToolUse` hook that
previously indexed the whole tree — and reported findings against it — now says
only that it skipped, in one line. Typed by hand nothing changes: `loupe check`,
`--all` and `--files` name their own scope and still run anywhere.

Token sources follow the winning manifest, so the design system is found where
it is actually installed rather than only at the root. The
alternative is falling through to `generic`, which declares no component layer —
and a config with no component layer silently switches off every rule that
correlates the two sides, leaving the gate green on exactly the drift it exists
to catch.

```bash
node engine/bin/loupe.mjs detect   # what would be inferred, and why
node engine/bin/loupe.mjs init     # write it down as loupe.config.json
node engine/bin/loupe.mjs status   # effective rules, severities, what blocks
```

A guess is held to a lower bar than a decision: with an inferred config,
`css/dead-class` is advisory (its remedy is deleting code) and the hook won't
block at all unless you turn blocking on. Run `status` when a gate isn't
behaving — it names the preset, the namespaces and the blocking switch, which is
the whole space of reasons a gate misbehaves.

`status` reads the plugin settings from `~/.claude` and says where it got each
one, because Claude Code exports plugin options to hook processes only — a
terminal sees none of them, and a diagnostic that silently guesses at the switch
it is diagnosing is worse than no diagnostic. The two are merged key by key, the
environment over the file, so an option the hook was handed does not hide the
rest of the file from it. When `~/.claude/settings.json` has `pluginConfigs` but
none of them is keyed `loupe` or `loupe@…`, `status` names the keys it found
rather than reporting no options at all.

### Sass, Less

Parsed through `postcss-scss` / `postcss-less`, both folded into the shipped
bundle — Sass works out of the box on a plain install. `postcss-sass` and
`postcss-styl` are not shipped; they are resolved from the host if it happens to
have them.

When a syntax is missing the file reports as `stylesheet/unparsed` rather than
being skipped in silence — a clean run should mean *checked and clean*, never
*couldn't read it*.

### Suppression

```css
/* wpds-allow system/override -- Stack exposes no padding prop at this size */
.acme-panel { padding: var(--wpds-dimension-padding-lg); }
```

Rule id and reason are both mandatory; anything looser is its own finding. That
inversion keeps the escape hatch available and legible. Audit with
`loupe suppressions`, which also lists every rule turned off in config, with
the reason its setting gives (`"<rule>": { "severity": "off", "reason": "..." }`)
or `no reason given`; `loupe suppressions --stale` lists only the directives
naming a rule that muted nothing on the run — the finding fixed, the rule off,
or an id that is not a rule — and exits 1 if there are any, so CI can keep them
from piling up.

The keyword comes from the preset — `generic` asks for `ds-allow`, `wpds` for
`wpds-allow`, `archer` for `archer-allow`, `vip` for `vip-allow`; `loupe status` prints the active one
under `suppress:` — and every preset's keyword is *read* whichever one is active, so
switching preset never orphans the directives already written.
`loupe suppressions` names the keyword such a directive was written with. It is
symmetric on purpose: `generic`, the preset a project with nothing to detect
falls back to, honours a `wpds-allow` directive the same way. The active keyword
is still the only one you are told to *write* — but any of them, plus the
blanket forms the preset names, reports as `suppression/malformed` when it
carries a directive's shape and breaks it. A comment that merely mentions
another preset's keyword in passing is prose, and stays prose.

### Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
./bin/loupe baseline --dry-run   # by rule: what would be recorded, +new / -fixed
./bin/loupe baseline
```

Use the `bin/loupe` shim (or pass `--profiles` yourself). The hooks always run
with the shipped design-system profiles, and rules that need a registry —
`system/locked-component`, `system/superseded-component` — only fire when the
profiles are loaded. Recording a backlog without them reports `baselined 0
finding(s)` and leaves the gate blocking on findings the baseline never saw.

Entries key on rule + file + normalized code, not line number, so reformatting
does not resurrect the whole file.

The baseline is written to `.loupe-baseline.json` in the project and is meant to
be committed: it is a statement about this repo, and the CLI and the hook are
different processes that have to read the same file. Set `baseline` in the
config, or pass `--baseline <path>`, to move it. The hook's retry counter is the
one piece of state that does not live in the project: it goes in the plugin's
data directory, or a temp directory of your own, keyed by project, and expires
after six hours. `loupe status` prints where, on its `state:` line.

One fallback is read, and `status` says when it answered: a committed
`.loupe-baseline.json` in a project whose config has since pointed `baseline`
somewhere that does not exist yet. That file is
already in the project, so there is nothing to move: `status` names it as the
default-name file and says which configured path is missing. Without this
fallback, a config change and the file move landing in separate commits would
put every accepted finding back in between them.

### When the gate stands down

An agent that cannot fix a finding should not be stopped forever. After
`maxAttempts` blocked turns on the same file in the same session the gate
stands down, says so once, and stays quiet for the rest of that session —
until the finding is actually fixed, which releases it. Standing down is a
truce, not an off switch: the next regression in that session is reported
again.

### Turning it on, and off for a session

The hook is off until a project opts in with `"env": { "LOUPE": "on" }` in
`.claude/settings.local.json` (see [Install](#install)). A gate that runs in
every repo the plugin is installed for puts findings into sessions that are
about something else. Claude Code passes that setting to the hook as an
environment variable, so `LOUPE=on claude` turns it on for one session as well.

To silence a project that has opted in, for one session:

```bash
LOUPE_OFF=1 claude
```

Or for one project, mid-session — the hook reads this file on every run:

```jsonc
// .claude/settings.local.json
{ "env": { "LOUPE": "on", "LOUPE_OFF": "1" } }
```

Or everywhere, with the plugin's *Silence the hook* option. All three set the
same switch, and `loupe status` names which one did it on its `options:` line.

The hook checks nothing — not advisory, silent to the agent; the user sees one
`loupe: skipped — silenced by …` line. Advisory mode does not solve this:
an advisory finding still lands in the agent's context, and an agent that sees a
finding starts fixing it, which is usually the thing you were trying to avoid.
`loupe` typed by hand still reports normally; the switch is only for the hook.

Both switches take `1`, `true`, `yes` and `on`, case-insensitively. Anything
else is read as not on, so `LOUPE_OFF=0` and `LOUPE_OFF=false` do not silence the
hook. `loupe status` prints a `hook: OFF` line with the reason whenever the hook
will say nothing.

### Judging in the hook

Both hooks run `--judge`, and the key is the switch. With a key — the plugin's
*TypeSafe API key* option, asked for when the plugin is enabled, or any of the
places listed under `--judge` above — a write-time report carries the same
judged variants and judged token names `loupe check --judge` prints, and
`patterns/judged-redirect` can fire. With no key the hook judges nothing and
says nothing about it — the deterministic report is the whole report, which is
what it was before. `loupe status` prints a `judge:` line either way, so a run
that quietly stopped asking does not read as one that found nothing to ask.

What this does not change: judging never moves a verdict. It fills in the
suggestion a deterministic finding already carries, and adds one advisory rule
of its own. A turn is still blocked by the same findings, decided the same way,
with or without a key.

The cost is a network round trip per flagged element, inside Claude Code's hook
timeout — 60s on `PostToolUse`, 120s on `Stop`. Each request gives up after 20
seconds and the run keeps the deterministic findings it already had. To stay
offline, drop `--judge` from `hooks/hooks.json`, or just leave the key unset.

The hook only pays for what it prints. A run that does not block prints a
one-line tally, so it asks nothing; a blocking run asks only about the findings
its cap has room to show. Answers are cached per project, keyed by the exact
question, so the next write in the same file, and the `Stop` after it, re-ask
only what changed. What a run spent rides on its summary line —
`judge: 2 asked, 9 from cache` — and `--no-cache` asks everything fresh. See
[What a judged run spends](docs/design/judge.md#what-a-judged-run-spends).

## Reading the report

`--format agent` is the default because its reader is an agent and context is
the scarce resource: guidance is printed once per rule group, and a finding
budget is spent round-robin so one loud rule cannot bury the rest. That is the
right shape for a hook and the wrong shape for a person deciding what to take
on.

It opens with the tally — how many findings, how they split between blocking
and advisory, and how many files were read to reach it — and, when the repo has
any, one line naming what its suppression directives are silencing. Both exist
because their absence was answered by running the tool again: a report that
started on a rule group gave no way to tell a complete one from a truncated
pipe, `0` unparsed stylesheets means nothing until you know whether any were
found, and a repo can report clean with its whole blocking backlog muted by
directives. Each rule group says `blocking` or `advisory` in words next to its
glyph, and the report closes on where findings cluster and what to run next.

`--format html` writes a self-contained page — no CDN, no fonts fetched, one
file you can open, commit, or attach to a build:

```bash
loupe check --all --format html > report.html
```

It renders client-side from the exact `--format json` payload, embedded in the
page. There is no second selection of fields anywhere, so the page and the JSON
cannot describe different reports — a divergence that would otherwise be
invisible, since each looks correct read on its own.

It shows the two things a line-per-finding list cannot:

- **Where the drift is.** Findings rolled up by directory. The text report
  names its three densest files, which is enough to answer "clustered or
  spread"; the page shows the whole distribution.
- **Composites as the N-way relations they are.** `patterns/duplicate-composite`
  and `patterns/unregistered-composite` are the only findings that cannot exist
  in one file. Text prints one line per member file, as though six files each
  had their own problem; the page shows one card per composite, listing the
  files that rebuild it.

Findings are grouped by rule, so the remedy and the severity — both properties
of the rule, not of the finding — are stated once rather than repeated down the
table. Severity is always a glyph and a word beside its color, never the color
alone.

`/loupe-report` renders the same page and publishes it as an Artifact, for
sharing a drift audit with people who are not going to run the CLI. It only
renders and publishes: the page comes from the engine, so two people running it
never see two different reports. Anything you want to change about how it looks
belongs in `engine/src/report-view.ts`, which is the one renderer both the file
and the live UI below draw from. `/loupe-report --local` stops at the
file, `.loupe/report.html` in the project, and hands back the path: in the
Claude Code desktop app a click on it opens the page beside the conversation,
and in a fullscreen terminal a Cmd/Ctrl-click opens it in the browser.

### Live, while you work

```bash
loupe ui                            # then open http://127.0.0.1:7332
```

The same page, on the working tree instead of on a moment. It re-runs on save —
a watcher over the directories the analysis read, pushed to the page — so the
counts restate themselves as you fix things, and it crosses into clean and back
without a reload. Every location links into your editor at the line
(`--editor` takes a template, so Cursor, Zed and the JetBrains IDEs all work).
Each row carries `fix` where the engine settled on exactly one token, and `mute`,
which asks for a reason before it writes the directive — the quick fix leaves
that blank because it has nowhere to ask, and a page does. `accept as baseline`
is a button.

Because it writes to your files it is not `loupe serve`: it binds loopback, sends
no CORS header, and every write carries a secret minted at startup plus the run
it was aimed at, so a click against a page the tree has moved past is refused
rather than applied to whatever now sits at that index.

### In the browser's inspector

`integrations/devtools/` is a Manifest V3 extension over `loupe serve`. It adds a
**Loupe panel** — the findings resolved against the page you are looking at, each
row saying how many elements it currently styles and whether its `@media` query
holds at this width — and a **Loupe pane in Elements**, which is the inversion:
select a node, see the findings that style *that node*.

That second one is the question a person in DevTools actually has. They have
already found the thing that looks wrong; every other output loupe produces
starts from the findings and asks where they are. It is also the only surface
that cannot be a bookmarklet, because it needs the inspector's selection.

Load it unpacked — `integrations/devtools/README.md` has the steps. It reads, it does
not write: `loupe ui` is the surface that changes files, and it answers only the
page it served.

### The pane

The same report, live, beside the transcript. `hooks/register.tsx` is a Claude
Code *mod* — a hooks module that draws — and in a project that opted the hooks
in it opens a pane next to the conversation, runs the engine again after each
edit the model makes to a UI file, and draws what `--format pane` answers: the
tally, the rules in frequency order, where the drift sits, the densest files,
and the composites rebuilt across files. A line in the status bar carries the
count; a toast says once when the blocking count reaches zero; a notification
fires when a turn ends with blocking findings still standing, which is the
case you want to hear about without watching.

What it draws depends on where Claude Code is drawing. The desktop app and the
VS Code panel get the engine's SVG charts, with a tooltip per bar. The terminal
gets the same rows as block-glyph bars sized to the pane, docked beside the
transcript in a fullscreen terminal from 110 columns and inline above the
prompt otherwise. Pressing a rule drafts `/loupe-fix <rule>` into the prompt —
it never sends it. A `show` picker narrows the list to blocking or advisory,
and `HTML report` writes `.loupe/report.html` and puts the path on the
clipboard.

`/loupe-pane` opens it in any project, opted in or not, and from then on edits
refresh it. The plugin's `pane` option turns the automatic pane off while
leaving the hooks alone. It draws nothing in cloud sessions, under `claude -p`
or in the Agent SDK, where the hooks still run and the text report is the whole
story — and the model never reads it: the pane is for the person, and the model
keeps the budgeted agent format, which is the right split. The numbers come from
the engine (`engine/src/report-pane.ts`), so the pane, the page and the JSON
cannot disagree.

### In CI

`--format sarif` puts each finding on the line that caused it in a pull
request's Files tab. `.github/workflows/loupe.yml` in this repo is a reusable
workflow that does it:

```yaml
jobs:
  loupe:
    uses: dabowman/loupe/.github/workflows/loupe.yml@main
    permissions:
      contents: read
      security-events: write
```

It checks this repository out beside yours and runs the engine from it — no npm
install and no published package, because `engine/dist` is committed and needs
neither. Code scanning is free on public repositories and requires GitHub
Advanced Security on private ones; where it is unavailable that upload is
skipped rather than failed, and the HTML report is uploaded as a build artifact
either way. The job does not fail on findings unless you pass
`fail-on-blocking: true` — adopt the report first, then turn the ratchet on.

SARIF results carry a `partialFingerprints` entry derived from the same identity
the baseline ratchets on: rule, file, and normalized code, deliberately not the
line number. An edit above a finding moves its line without re-opening its alert.

Findings your baseline accepted are uploaded too, as results marked suppressed
(`kind: external`, "accepted in the loupe baseline"), so code scanning shows the
backlog as suppressed alerts rather than reading it as a clean repository.

#### Without Node

The reusable workflow needs neither an npm install nor a published package, but
it does need Node and a checkout of this repository. Where neither is wanted — a
CI image that carries no Node, a repository that is not JavaScript, a container
you would rather keep small — `npm run build:binary` produces a single
self-contained executable that carries its presets and its pattern language
inside it. It does not carry the design-system profiles — the component and
pattern registries that `system/locked-component`, `system/superseded-component`
and the composite rules read — so pass them with `--profiles`: without them
those rules are off, and the report is silently clean of them.

```yaml
- run: |
    curl -fsSL -O https://github.com/dabowman/loupe/releases/latest/download/loupe-linux-x64
    chmod +x loupe-linux-x64
    git clone --depth 1 https://github.com/dabowman/loupe .loupe-engine
    ./loupe-linux-x64 check --all --format sarif --profiles .loupe-engine/profiles > loupe.sarif
```

`--judge` still needs `TYPESAFE_API_KEY` from the environment — no key is
compiled into the binary, and a run without one refuses rather than falling back
to anything. In CI that is a secret on the job, exactly as it would be for the
Node path.

Pick the asset to match the image, because this is the one place it bites: the
plain `linux-x64` build links against glibc and will not start on Alpine at all,
and `loupe-linux-x64-musl` needs `libstdc++` there (`apk add libstdc++`), which
Alpine does not carry. Both failures read as a missing file rather than a
missing libc. Releases cover glibc and musl Linux on both architectures, macOS
on both, and Windows.

Pin the version rather than tracking `latest` once a green build matters, and
check what you downloaded — every release carries `SHA256SUMS`:

```yaml
- run: |
    base=https://github.com/dabowman/loupe/releases/download/v0.7.0
    curl -fsSL -O "$base/loupe-linux-x64" -O "$base/SHA256SUMS"
    sha256sum --ignore-missing -c SHA256SUMS
    chmod +x loupe-linux-x64
```

Verified equivalent, not assumed: the Linux binary and macOS Node produce
byte-identical reports over Gutenberg's 9,822 files.

## Remediation

`/loupe-fix` runs `loupe fix` first, so what remains is the work that needs
judgement: did that `margin-bottom` do something `gap` will not, is this `<div>`
editor content that should stay raw, is that inline style computed at runtime.

Above five affected files it dispatches one `loupe-fixer` agent per file. Per
file, never per rule — two agents editing one file collide. `css/dead-class` and
`patterns/*` are never dispatched: both are cross-file judgements a single-file
agent cannot make. Verification is one repo-wide re-run by the caller, because
every run re-indexes the whole repo regardless of `--files` scope.

### In an editor

`loupe lsp` is a language server on stdin/stdout. Findings land in the Problems
panel and the gutter, hover gives the rule's guidance, and where the engine
settled an answer on its own the substitution is offered as a quick fix — the
same one `loupe fix` writes, from the same function, so the editor cannot
propose a substitution the CLI would not. A misspelled token is one action
carrying every line that names it, since clearing one occurrence would leave the
diagnostic standing.

One action goes the other way: `css/dead-class` offers to delete the rule, and
`loupe fix` will not. Every other fix replaces a value, which the next run
checks; a deletion leaves nothing to compare against, and the reference index
behind that check over-collects on purpose, because a false "dead" deletes live
CSS. That trade is priced for someone looking at the rule, so the deletion is
offered where a person accepts it and never in a batch pass over a repo. Where
the rule cannot be lifted out cleanly — a selector list that also styles a live
class, the only rule inside an `@media`, a class several rules declare — no
action is offered and nothing says why.

```bash
ln -s "$(pwd)/bin/loupe" ~/.local/bin/loupe
cd editors/vscode && npm install && npx @vscode/vsce package
code --install-extension loupe-vscode-0.7.0.vsix   # or: cursor --install-extension
```

The extension is a launcher and nothing else — it spawns the server, names the
languages worth syncing, and stops. Everything a reader sees is decided in
`engine/src/lsp.ts`, which is the copy every other editor reaches too: Zed,
Neovim and Helix need no extension at all, just `loupe lsp` as the command.
`editors/vscode/README.md` has the per-editor configuration.

Use `bin/loupe` rather than `engine/bin/loupe.mjs`, here as everywhere: the shim
is what passes the shipped profiles, and without them the component and
composite rules are silently off — the editor would show a thinner report than
CI does, and nothing would say so.

Two things are deliberate and both are visible the first time they bite.

**It reports on save, not on keystroke.** The engine reads the working tree and
correlates across files, so an unsaved buffer is a verdict on a tree that does
not exist; a dirty file shows the last saved verdict until it is written. That
is also why this doubles as the push channel for an agent working in the editor
— every edit an agent makes *is* a save, so there is nothing to approximate.
The cost was measured rather than assumed before settling on re-analyzing whole:
a warm server re-runs a 613-file project in ~115ms and Gutenberg's 9,531 in
~2.4s, against 380ms and 5.9s for the same runs cold through the CLI.

**The suppress quick fix leaves the reason blank.** A directive with no reason
does not mute — it reports as `suppression/malformed`, an error. So taking that
action trades a finding for a louder one that clears only once somebody writes
down why. Filling the reason in for you would be the one way to get a signed-off
silence nobody signed off on.

## Settings

Configured where you enable the plugin, read by the hook from the environment:

| | |
| --- | --- |
| **Block turns on findings** | Governs the hook only. Off by default: the gate reports, it doesn't stop the turn. On, error-severity findings hand the report back. An inferred config never blocks unless this is on. `loupe check` is unaffected — it exits 1 on error-severity findings either way, so CI and pre-commit still gate. |
| **Silence the hook** | Off by default. On, the hook checks nothing in any project and says only that it was skipped. `"env": { "LOUPE_OFF": "1" }` in a project's `.claude/settings.local.json` does the same for that project. |
| **Preset** | `auto` infers per project. A project's own `loupe.config.json` always wins over both. |
| **Project class prefixes** | Comma-separated, e.g. `vip-workflow-, wf-`. Empty infers them. Only these can be reported dead. |
| **Fix attempts** / **Findings shown** | The retry budget and the per-report cap. |

## Hooks

The plugin ships both, and both are off until the project opts in (see
[Install](#install)). `PostToolUse` scopes to the file just written, which is
what makes this a write-time gate rather than a review-time one. `Stop` covers
everything changed in the turn.

They ask different questions. `PostToolUse` blocks only on findings the edit
*introduced*, against the file as it was before the write; what the file already
had is mentioned, not blocked on, so a refactor that is worse before it is
better is not stopped halfway (outside a git worktree, where `Stop` cannot
tell what changed, `PostToolUse` blocks on everything in the file). `Stop` asks whether the turn's work is
conformant, absolutely — the place for "you converted the JSX and left the CSS
behind".

Each gets `hook.maxAttempts` gated passes (default 3, budgeted per file for
`PostToolUse`), then the gate stands down and says so. Bailing out entirely on
`stop_hook_active` — the obvious loop guard — means the turn that *fixes* a
finding is never checked, so you never confirm the fix.

The index is always built repo-wide even when the report is scoped; building it
from changed files alone would make every unchanged reference look absent and
every class look dead. On a large repo that makes `PostToolUse` the more
expensive of the two — drop it to `Stop` only if it drags.

Two guards keep that affordable. A `PostToolUse` on a file no rule could reach —
a README, a lockfile — returns without indexing anything. And a file over 1.5MB
is treated as generated and skipped, because a checked-in emscripten blob costs
more to parse than every finding it could produce. A skipped *stylesheet* still
reports as `stylesheet/unparsed`; a skipped markup file just contributes
nothing. Gutenberg — 6,100 markup files, 1,300 stylesheets — indexes in about
five seconds.

Past 200,000 entries the walk stops and the hook stands aside with a `skipped`
message saying so, rather than reporting "clean" for the part it never read —
the case is a home directory with a stray `package.json`, not a project. Point
the root at the project, or narrow `sources` in `loupe.config.json`; a
project that really is that large raises the ceiling with `"maxEntries"` there
(`LOUPE_MAX_ENTRIES` overrides it for one run).

## Status

Working: all three channels (stylesheets, `style={{ … }}`, CSS-in-JS template
literals), the token set, both composite rules, all three skills, commands,
hooks, the registries, profile selection, and the language server.

A whole-repo scan of Gutenberg — 6,100 markup files, 1,300 stylesheets — takes
about four seconds.

Known limits, in rough priority order:

1. **React-family only.** Markup is parsed with Babel's JSX and TypeScript
   plugins, so any React-based design system works and Vue SFCs, Svelte and
   Angular templates do not — their markup never parses, so the correlation
   rules have nothing to bind a class to. The stylesheet-only rules still run.
2. **Styling surfaces are hand-read.** `system/override` names the prop that
   owns a declaration, or says there is none, only for components whose
   registry entry records a `surface` — read from the package source, per
   component. In a registry that records them, everything else gets the
   plain-element verdict, advisory. The VIP and Archer registries record none
   yet, so there every appearance property on a bound class still blocks.
3. **Structural interpolation.** A template whose shape depends on an
   interpolation (``styled.div`${mixin}` ``) parses only when the interpolation
   sits where a whole statement would. Anything else is recorded as a parse
   diagnostic and left unchecked — visible in the report footer and in
   `parseErrors`, never silent.
4. **Composite matching is greedy.** A registered child claims the first node it
   fits. For registries of a handful of nodes this is exact; a large pattern with
   several interchangeable children could in principle miss a match.
5. **The index is cached per file, not held in memory.** Each unchanged file's
   scan is reused from the last run (see [Caches](docs/design/cli.md#caches)),
   which took a hook run on a Gutenberg-sized tree from 3.8s to about 0.8s. What
   is left is mostly Node starting and the cache file loading; a long-lived
   process holding the index would remove that, and has not been needed yet.
6. **The editor reports on save.** A dirty buffer shows the previous verdict.
   Diagnosing unsaved text means threading a buffer overlay through every read
   in the analyzer.

## Working on the engine

```bash
cd engine
npm install
npm test           # typecheck, then all six suites
npm run build      # rebuild dist/loupe.mjs, and commit it
```

The engine is TypeScript, checked with `strict` plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. `npm run typecheck`
is its own gate rather than a side effect of the build: esbuild transpiles
TypeScript by stripping types, never checking them, so a bundle that builds is
not a bundle that type-checks. CI runs both.

The engine exists twice on purpose. `engine/src/` is the code.
`engine/dist/loupe.mjs` is that code transpiled and bundled with
`@babel/parser`, `picomatch` and `postcss`, committed to the repo, and rebuilt
by `npm run build`.

Committing a build artifact is not free, and the reason is narrow: nothing in a
marketplace install runs `npm install` on a plugin's behalf, and no version of
Node runs `.ts` from a bare `node` invocation. Without the bundle, the engine
throws on every hook run for everyone who installed this the normal way, which
is the only way most people will.

Two things keep the artifact from becoming a second source of truth:

- `engine/bin/loupe.mjs` — the entry point the hooks, the commands and the
  `loupe` shim all reach — runs **source** wherever the dev toolchain is
  installed, and the bundle everywhere else. A checkout with `node_modules` in
  it is a checkout someone is editing, and pinning that to a bundle would mean
  edits to `src/` silently doing nothing until a rebuild. That is a gate
  reporting yesterday's verdict on today's code — the exact failure this engine
  exists to refuse. (Running `.ts` directly needs Node 22.18+; on an older
  Node, the bundle.)
- `npm run build:check` re-bundles and compares. It is what CI runs, and it is
  the only thing standing between a `src/` change and a marketplace install
  still serving the version before it, because the staleness is invisible on the
  machine where the edit happened.

`dist/` sits at the same depth as `src/` so the engine's `import.meta.url`
lookups — the preset directory, the plugin manifest — resolve identically from
either entry. Presets stay on disk as JSON next to the bundle rather than inside
it: `loupe presets` lists that directory, and a preset you can read is a preset
you can copy.

### Comments and design notes

Code comments in `engine/` are concise inline documentation: what a thing is,
what it decides, the contract it holds. Each check states its decision chain as
a `Logic, per <unit>: … → verdict` table; each `judge/` query carries the whole
request body it posts.

Reasoning does not live there. Why a rule is ordered the way it is, what a
simplification would break, and the eval numbers behind a tuned floor are in
[`docs/design/`](docs/design/README.md), and a module whose reasoning moved out
carries a one-line `Design notes:` pointer to the file and anchor. When a change
needs a justification longer than a sentence, put the sentence in the code and
the rest in the matching design note — move the rationale, never drop it.

The type model lives in `engine/src/types.ts`, and two distinctions in it carry
most of the weight: `AuthoredConfig` (a config file, partial all the way down)
against `MergedConfig` (every field present, post-`normalize`), and the
`ClassifiedFinding` → `PendingFinding` → `Finding` progression that separates
what the shared classifier decided from what a formatter is allowed to see.

## Tests

```bash
cd engine && npm test
```

Seven suites over a shared harness. `tests/run.ts` is fixture-driven, one
directory per behaviour, each with a note explaining what it pins down — since
behaviour is config-driven, this is the only thing standing between a preset
edit and a rule silently switching itself off. `tests/detect.ts` covers
inference, which runs in every project that has no config file.
`tests/regressions.ts` covers the failures that reported *success*: a scan that
never finished, a project's own class reported as a third-party internal, an
absolute path that matched nothing and returned clean. `tests/features.ts`
covers the three channels and the two cross-file rules — everything that reports
across a boundary a single-file linter cannot see. `tests/autofix.ts` covers
`fix`, where every failure is invisible: the value is right, the file parses, the
report goes clean, and the meaning has changed. `tests/multi-ds.ts` covers
registry scoping and profile selection — which design system answers for a file,
in a repo that has more than one. `tests/report.ts` covers the formats: that the
HTML page and `--format json` cannot describe different reports, that a finding
carrying `</script>` — CSS-in-JS source routinely does — cannot end the block its
own data sits in, and that a misspelled `--format` is rejected instead of
quietly printing the agent format and exiting 0.

`tests/harness.ts` holds what all seven were carrying their own copy of —
`check`, `assert`, the scratch-repo helpers — plus `one()` and `first()`, which
read a single expected element out of a result list and fail with the count when
there isn't one.

Those are the ones worth a test. A gate that errors gets noticed; a gate that
says "clean" for the wrong reason does not, and every failure mode here breaks
toward *fewer* findings.
