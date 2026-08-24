# Loupe

Keeps agent-written wp-admin interfaces on the WordPress Design System.

A loupe is what a printer holds over a proof before the run: close enough to
see the dot, early enough that fixing it costs nothing. Same idea here — the
drift is caught on the file just written, not in review.

An agent writing UI produces code that compiles, renders correctly, passes
review, and quietly reimplements things WPDS already provides: a hand-rolled
flex row beside `Stack`, a `font-size` beside `Text`'s `variant` prop, a
`margin-bottom` where the parent has a `gap`. None of it is an error. All of it
is drift, and it is expensive to unwind once the pattern is load-bearing —
because by then every argument for keeping it is locally true.

This plugin works at two moments: **before** the code is written (skills that
set the rules and the sanctioned compositions) and **as** it is written (hooks
that report drift on the file just touched, not forty tool calls later).

## Install

```
/plugin marketplace add dabowman/loupe
/plugin install loupe@loupe
```

Nothing else to run. The engine ships pre-bundled with its dependencies, so a
fresh install is a working install on any machine with Node 18 or newer — no
`npm install`, no toolchain, no build step. See
[Working on the engine](#working-on-the-engine) if you are changing it rather
than using it.

## What's in it

| | |
| --- | --- |
| `skills/loupe-authoring` | The authoring rules — order of resort, gap over margin, props over CSS, tokens by role. Load before writing UI. |
| `skills/loupe-patterns` | Registry of sanctioned composites. Load before assembling a header, modal, action bar, sidebar. |
| `skills/loupe-remediation` | Per-rule remedies, and the checks that stop a "fix" from silently changing rendering. |
| `agents/loupe-fixer` | Per-file remediation agent. `/loupe-fix` fans it out once the work spans enough files to be worth it. |
| `commands/` | `/loupe-audit`, `/loupe-fix`, `/loupe-baseline` |
| `hooks/hooks.json` | `PostToolUse` on the file just written, `Stop` across changed files |
| `profiles/wpds/` | The WPDS profile — the packages that identify it, its preset, and its two registries |
| `profiles/wpds/patterns/index.json` | The composite registry |
| `profiles/wpds/components/index.json` | The component currency registry — recommended/legacy/locked/experimental per component+package |
| `engine/` | `loupe` — the conformance engine |

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
loupe explain layout/margin-on-child
```

`bin/loupe` is on PATH inside any Claude Code session — Claude Code adds each
enabled plugin's `bin/` to the environment it runs commands in. For plain
terminals, symlink it somewhere on your `PATH`:

```bash
ln -s "$HOME/.claude/plugins/<marketplace>/loupe/bin/loupe" ~/.local/bin/loupe
```

It runs against whatever directory you are in and adds nothing to that project:
the engine carries its own dependencies and writes nothing into your repo. It
also passes the shipped pattern and component registries unless you name your
own with `--patterns`/`--components`.

Pure analysis — it never edits. Fixing is `loupe-remediation`'s job, because the
fixes need judgment that a codemod does not have.

### Rules

| Rule | Detects | wpds preset |
| --- | --- | --- |
| `stylesheet/unparsed` | A stylesheet nothing could read — a hole in coverage | error |
| `suppression/malformed` | A blanket disable, or one missing a rule id or reason | error |
| `layout/margin-on-child` | Spacing margin, which belongs on the parent's `gap` | error |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own | error |
| `typography/in-css` | A text component typed in CSS instead of via props | error |
| `system/override` | CSS restyling a WPDS component, or reaching into a library's internals | error |
| `system/inline-style` | `style={{ … }}` on a WPDS component — it overrides the props | error |
| `system/locked-component` | A private API WPDS does not recommend outside Gutenberg core | error |
| `layout/negative-margin` | A bleed — confirm it is deliberate | warn |
| `typography/untokenized` | Raw type styling with no token and no text component | warn |
| `system/raw-element` | A raw element that has a WPDS analog | warn |
| `system/superseded-component` | A current, recommended component now covers this job | warn |
| `tokens/hardcoded-value` | A literal colour or length where a token exists | warn |
| `css/dead-class` | A namespaced class referenced in no markup or reference file | warn |
| `tokens/unknown-token` | A `var()` naming no token the design system defines | warn |
| `patterns/duplicate-composite` | A registered composite reassembled by hand in more than one file | warn |
| `patterns/unregistered-composite` | The same composite built in three or more files, registered in none | warn |

Rules disable themselves when the config cannot support them — a block theme
with no component layer leaves the component rules inert rather than firing on
nothing.

### Tokens

`tokenPrefixes` used to be cosmetic — it shaped a message and validated nothing.
So a finding said *"13px is hardcoded — use a `--wpds-*` token"*, and the agent,
having no list to choose from, invented `--wpds-font-size-13`. A finding that
names a namespace instead of a value manufactures its own next bug.

`designSystem.tokenSources` points at the stylesheets that *define* the tokens —
for `wpds` that is `@wordpress/theme`, 190 of them in one file — and anything the
project defines itself is added to the set. Findings then name the token:

```
styles/card.scss:12  border-radius: 4px → var(--wpds-border-radius-md)
```

Only an on-role token is offered. `1px` is both `--wpds-border-radius-xs` and
`--wpds-border-width-xs`; suggesting the wrong one gives the right pixels and the
wrong meaning, which survives review precisely because it looks correct. When
nothing on-role matches, the finding names no token rather than a plausible one.

`tokens/unknown-token` catches the other direction — a `var()` naming nothing the
design system defines. It stays silent when no definitions were found at all,
because an empty token set proves nothing.

Because the engine resolved that substitution itself, it can also apply it:

```bash
loupe fix   # --dry-run to see it first
```

Only where exactly one on-role token carries the value, and only in stylesheets
— the same rule fires on `style={{ padding: '13px' }}`, where a CSS-shaped
substitution would write a syntax error with a clean report. Two candidate
tokens is a semantic choice, so it is left alone. Paying a model to read a file
back and retype an answer nothing had to reason about is the expensive way to
apply a substitution, and this is usually the highest-volume rule in a report.

### Composites

The expensive drift is compositional: six page headers, four modal footers, each
individually defensible. No per-file linter can see it — every instance looks
fine on its own, and the finding only exists across files.

A signature is the design-system component tree with everything else dropped, so
an intervening `<div>` never hides a match and a prop change never invents one.
Matching is containment: `form-modal` records its footer as a sibling of the
body, real code nests it inside, and both are the same composition.

- `patterns/duplicate-composite` — a registered pattern reassembled by hand in
  two or more files.
- `patterns/unregistered-composite` — the same shape in three or more files and
  in no registry. Two is a coincidence; three is house style.

Signatures below four nodes are documentation, not checks. `Stack(Button,Button)`
is a true description of an action bar and a useless finding — it matched 48
files in one repo, and *"you have 48 action bars"* is not a defect anyone can act
on.

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
and applies a profile only to a project importing its packages.

```jsonc
// profiles/wpds/profile.json
{
  "id": "wpds",
  "name": "WordPress Design System",
  "preset": "wpds",
  "packages": ["@wordpress/components", "@wordpress/ui"],
  "patterns": "./patterns/index.json",
  "components": "./components/index.json",
  "skills": ["loupe-authoring", "loupe-patterns", "loupe-remediation"]
}
```

This matters because composite signatures match on component *names*, and
`Stack`, `Text`, `Button` and `Modal` are names nearly every design system uses.
`Stack(Stack(Text,Text),Stack(Button))` is a WPDS page header and a Chakra one,
so before profiles the hook reported a React repo as rebuilding a WordPress
pattern it had never heard of. Now the same code is reported on a WordPress
project and silent on a Chakra one.

`loupe status` names the active profile. Adding a second design system is
adding a directory here plus a preset in `engine/presets/` — see **Adding a
design system** in the [engine README](engine/README.md#adding-a-design-system).
Its authoring prose goes in `skills/` and is listed in its `profile.json`, so
which skills belong to which design system stays written down.

### Config

`loupe.config.json` at the repo root, discovered by walking up:

```jsonc
{
  "extends": "wpds",
  "namespaces": {
    "project": ["acme-"],        // classes you own; only these can be "dead"
    "external": ["components-"], // third-party internals; styling them is an override
    "neverDead": ["has-*"]       // generated at runtime, never in source
  }
}
```

Presets: `wpds` (WPDS tokens + a severity policy that actually blocks),
`wordpress-components` (the older admin surface), `wordpress-block-theme`,
`generic`.

Without a config file, one is inferred: `@wordpress/components` or
`@wordpress/ui` in **any** `package.json` within three levels selects `wpds`
(a WordPress repo is usually a monorepo, and the manifest that imports the
component library is rarely the root one); `theme.json` plus `templates/`
selects `wordpress-block-theme`; and the class prefixes you own are read off the
classes appearing in **both** your CSS and your markup, minus any a dependency
defines — `rbc-` looks exactly like a namespace you own until you notice
react-big-calendar ships the stylesheet that declares it.

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

`status` reads the plugin settings from `~/.claude` and says where it got them,
because Claude Code exports plugin options to hook processes only — a terminal
sees none of them, and a diagnostic that silently guesses at the switch it is
diagnosing is worse than no diagnostic.

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
`loupe suppressions`.

### Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
node engine/bin/loupe.mjs baseline
```

Entries key on rule + file + normalized code, not line number, so reformatting
does not resurrect the whole file.

The baseline and the hook's retry counter live in the plugin's data directory,
keyed by project — carrying the plugin between repos writes nothing into them.
A baseline already committed to a project still wins. `status` prints which.

## Remediation

`/loupe-fix` runs `loupe fix` first, so what remains is the work that needs
judgement: did that `margin-bottom` do something `gap` will not, is this `<div>`
editor content that should stay raw, is that inline style computed at runtime.

Above five affected files it dispatches one `loupe-fixer` agent per file. Per
file, never per rule — two agents editing one file collide. `css/dead-class` and
`patterns/*` are never dispatched: both are cross-file judgements a single-file
agent cannot make. Verification is one repo-wide re-run by the caller, because
every run re-indexes the whole repo regardless of `--files` scope.

## Settings

Configured where you enable the plugin, read by the hook from the environment:

| | |
| --- | --- |
| **Block turns on findings** | Off by default: the gate reports, it doesn't stop the turn. On, error-severity findings hand the report back. An inferred config never blocks unless this is on. |
| **Preset** | `auto` infers per project. A project's own `loupe.config.json` always wins over both. |
| **Project class prefixes** | Comma-separated, e.g. `vip-workflow-, wf-`. Empty infers them. Only these can be reported dead. |
| **Fix attempts** / **Findings shown** | The retry budget and the per-report cap. |

## Hooks

The plugin ships both. `PostToolUse` scopes to the file just written, which is
what makes this a write-time gate rather than a review-time one. `Stop` covers
everything changed in the turn.

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

## Status

Working: all three channels (stylesheets, `style={{ … }}`, CSS-in-JS template
literals), the token set, both composite rules, all three skills, commands,
hooks, the registries, and profile selection.

A whole-repo scan of Gutenberg — 6,100 markup files, 1,300 stylesheets — takes
about four seconds.

Known limits, in rough priority order:

1. **React-family only.** Markup is parsed with Babel's JSX and TypeScript
   plugins, so any React-based design system works and Vue SFCs, Svelte and
   Angular templates do not — their markup never parses, so the correlation
   rules have nothing to bind a class to. The stylesheet-only rules still run.
2. **Prop maps.** A finding can now name the token that replaces a value, but
   not the *prop* that replaces a declaration: `system/override` says "restyle
   via its props" without naming which one. That needs a per-component prop map,
   which the WPDS MCP could generate.
3. **Structural interpolation.** A template whose shape depends on an
   interpolation (``styled.div`${mixin}` ``) parses only when the interpolation
   sits where a whole statement would. Anything else is recorded as a parse
   diagnostic and left unchecked — visible in the report footer and in
   `parseErrors`, never silent.
4. **Composite matching is greedy.** A registered child claims the first node it
   fits. For registries of a handful of nodes this is exact; a large pattern with
   several interchangeable children could in principle miss a match.
5. **No index cache.** Every hook run rebuilds the repo index. At four seconds on
   the largest repo in the ecosystem this has not been worth the complexity —
   revisit if a project drags.

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
  exists to refuse. (`tsx` is what lets that file import a `.ts` entry point at
  all; absent it, the bundle.)
- `npm run build:check` re-bundles and compares. It is what CI runs, and it is
  the only thing standing between a `src/` change and a marketplace install
  still serving the version before it, because the staleness is invisible on the
  machine where the edit happened.

`dist/` sits at the same depth as `src/` so the engine's `import.meta.url`
lookups — the preset directory, the plugin manifest — resolve identically from
either entry. Presets stay on disk as JSON next to the bundle rather than inside
it: `loupe presets` lists that directory, and a preset you can read is a preset
you can copy.

The type model lives in `engine/src/types.ts`, and two distinctions in it carry
most of the weight: `AuthoredConfig` (a config file, partial all the way down)
against `MergedConfig` (every field present, post-`normalize`), and the
`ClassifiedFinding` → `PendingFinding` → `Finding` progression that separates
what the shared classifier decided from what a formatter is allowed to see.

## Tests

```bash
cd engine && npm test
```

Five suites over a shared harness. `tests/run.ts` is fixture-driven, one
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
report goes clean, and the meaning has changed.

`tests/harness.ts` holds what all five were carrying their own copy of —
`check`, `assert`, the scratch-repo helpers — plus `one()` and `first()`, which
read a single expected element out of a result list and fail with the count when
there isn't one.

Those are the ones worth a test. A gate that errors gets noticed; a gate that
says "clean" for the wrong reason does not, and every failure mode here breaks
toward *fewer* findings.
