# Loupe

Design-system conformance checking for front-end codebases.

Linters see one file at a time. This correlates the two sides no single linter
can hold at once: the markup that binds a class to a component, and the CSS that
styles that class. That correlation is what lets it say *"this `font-size` is on
a `<Text>` — use its `variant` prop"* rather than *"this `font-size` isn't a
token."*

`check`, `status` and the gate are pure analysis — they never edit. `fix` is the
one command that does, and only for substitutions with a single right answer.

The package is not published to npm; run it from a checkout (or from the
installed plugin) rather than through `npx`.

This README says what the engine does. Why it is built this way — the failures
that shaped each decision, and the eval numbers behind the tuned ones — is in
[`docs/design/`](../docs/design/README.md).

```bash
node engine/bin/loupe.mjs check --all   # or ./bin/loupe check --all
```

## Why

An agent writing front-end code will produce CSS that lints clean and still
ignores your design system: hand-rolled flexbox next to your `<Stack>`, a
hardcoded hex next to your token, a `<p>` where the system has a `<Text>`, an
override reaching into a third-party component's internals. None of that is a
syntax error. All of it is drift.

Most of the twenty-one rules need cross-file correlation to decide. The rest
would work as a stylelint plugin, and are included because you want one report.

## Rules

| Rule | Detects |
| --- | --- |
| `suppression/malformed` | A blanket disable, or a directive missing a rule id or reason |
| `stylesheet/unparsed` | A stylesheet the parser could not read, so nothing in it was checked |
| `css/dead-class` | A project-namespaced class referenced in no markup or reference file |
| `tokens/unknown-token` | A `var()` naming no token any known source defines |
| `tokens/misapplied-token` | A real token used outside the scope the profile declares for it — another property, or another kind of element |
| `tokens/undelivered` | Tokens used with no evidence their stylesheet reaches the page — from the profile's delivery block |
| `patterns/duplicate-composite` | A registered composite reassembled by hand in 2+ files |
| `patterns/superseded-composite` | A shape a registered pattern exists to replace, in the file that built it |
| `patterns/judged-redirect` | `--judge` only: a control read as standing for something its pattern redirects elsewhere |
| `patterns/unregistered-composite` | The same composite in 3+ files, registered in none |
| `tokens/hardcoded-value` | A literal colour/length where a design token exists |
| `layout/margin-on-child` | Margin, which belongs on the parent's `gap` |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own |
| `typography/untokenized` | Raw type styling with no token and no text component |
| `system/override` | CSS setting a property a design-system component owns (per its registry `surface`), or reaching into a library's internals |
| `system/raw-element` | A raw element that has a design-system analog |
| `system/inline-style` | A style prop doing what a component prop or token already does |
| `layout/negative-margin` | A negative margin pulling against the layout the system provides |
| `typography/in-css` | A text component typed in CSS instead of via its props |
| `system/locked-component` | A private API the design system does not recommend outside its own core |
| `system/superseded-component` | A current, recommended component now covers this job |

`loupe explain <rule>` prints the guidance and whether the rule is active
under your config.

Legacy `R0`–`R8` ids are accepted everywhere a rule id is, in config and in
suppression comments, so an existing codebase's suppressions keep working.

### Rules disable themselves

Each rule declares what it needs from the design-system model. A config with no
component layer — a block theme, say — leaves `system/override`,
`system/raw-element`, `typography/in-css` and `layout/in-css` inert rather than
firing on nothing. That is what makes one engine serve very different projects.

## Suppression

```css
/* ds-allow system/override -- Stack exposes no padding prop */
.card { padding: 12px; }
```

Rule id and reason are both mandatory. A directive on the line above, on the
line itself, or on a rule's selector line (which covers that rule's own
declarations) all count. A block comment covers every line it spans, so a reason
long enough for a formatter to wrap it still anchors.

Only the nearest line is read, so two rules on one node are one directive, not
two stacked comments:

```jsx
{ /* ds-allow system/raw-element, system/inline-style -- one reason for both */ }
```

An import reports on each specifier's own line. A directive above the name mutes
that name; one above `import {` mutes every superseded name in the declaration,
which is rarely what a reason is true of.

Anything looser — `ds-disable`, a missing reason, a bare keyword — is not a mute
but its own finding. That inversion is the point: the escape hatch stays
available and stays legible.

The directive must be the first thing in its comment, so documentation *about*
the grammar isn't mistaken for an instance of it.

The keyword is preset-scoped — `generic` asks for `ds-allow`, `wpds` for
`wpds-allow` — so adopting a different preset renames it. Every keyword the
shipped presets declare is *read* whichever one is active, so a rename never
orphans the directives already written: a directive nothing recognizes is not a
mute and not a finding either, which is the one way a signed-off reason can
disappear entirely. `loupe suppressions` names the keyword such a directive was
written with, so the rename stays discoverable. A config with a keyword of its
own can list the one it replaced under `suppression.aliases`; a term any preset
treats as a blanket disable is never offered as an alias, so an alias can only
ever widen what may be written, never what a directive may do.

Reading is all an alias does, and it runs in both directions: `generic` reads
`wpds-allow` exactly as `wpds` reads `ds-allow`, which also means a project with
nothing to detect — `generic` is the fallback — honours a `wpds-allow`
directive. What the tool tells you to *write* is still one keyword, the active
one. What may be *reported* is wider: the active keyword and the blanket forms
in any shape at all, and an alias whenever the line carries a directive's shape
(the keyword alone, or with rule ids, or with a reason separator) and breaks it.
A comment that merely opens with some other preset's keyword and then reads as a
sentence is prose about a rename far more often than it is a broken directive,
so it is left alone — but a directive someone wrote and broke is never left
silent, whichever keyword it is written in. Silence is the one outcome a
signed-off reason must never have.

## Config

`loupe.config.json` (or `.mjs`, or a `loupe` key in `package.json`),
discovered by walking up from the working directory.

With no config file anywhere, the project is inspected and one is inferred —
preset from the markers each preset declares for itself (`@wordpress/components`
or `@wordpress/ui` in `package.json` → `wpds`; `theme.json` + `templates/` →
`wordpress-block-theme`), namespaces from the class prefixes that appear in
**both** the CSS and the markup. A prefix present only in CSS is exactly what a dead class looks like, so
CSS evidence alone is never enough to adopt one.

That walk stops after 50,000 directory entries, and a result that hit the
ceiling comes back with its namespaces at low confidence and a note saying so —
on stderr, and inside the hook's own message. Inference is a guess, and a guess
made from part of a tree must not read like one made from a project. Only `high`
is demoted: a walk that stopped early and found nothing still answers `none`,
which is the different and still-true claim. The preset is not affected:
`detectPreset` reads manifests and top-level markers, never the walk.

The walk reads the files at each level before descending below it, and prunes
dot-directories unless a glob names one. Both exist for the same reason: with
picomatch's `dot: false`, nothing under `.venv`, `.cache`, `.cargo` or a pnpm
store can ever match a `**` glob, so descending into one bought nothing and
could swallow the whole budget before the project's own files were reached —
an answer indistinguishable from a project with no namespaces at all.

Where the root is not a project at all, inference does not run. Hook runs and
`check`/`fix --changed` stand aside there instead of indexing it — the refusal
they would have got from the changed-file scope anyway, except on a `PostToolUse`
payload naming a file, which used to analyze such a root and now does not. What
counts as a project is deliberately generous, because a false negative is a gate
that silently turns itself off, and they are asked cheapest first: a
`package.json` or a `composer.json` (a WordPress plugin is as likely to carry
the second as the first); a `.git` entry found anywhere up the tree, read off
disk, so a dubious-ownership mount or a missing `git` binary is not mistaken for
"no repo" — searched upwards, because the case that needs answering is the
subdirectory and a subdirectory has no `.git` of its own; git itself, for a
worktree the filesystem cannot see; or a preset whose markers match, which is
how a block theme's `theme.json` + `templates/` counts with none of the others.
A `--config` path or a `--preset` flag names this directory and skips the
question outright; the `preset` plugin option does not, since it is set once for
every project its owner opens. Plain `loupe check`, `--all` and `--files` name
their own scope and run anywhere.

`loupe init` refuses to write a config built from a truncated inference unless
`--force` is passed. A written config is not held to advisory: `inferred` goes
false, blocking comes back on by default and `css/dead-class` returns to its
configured severity — so persisting a namespace list drawn from part of a tree
turns a guess into a rule that deletes code.

It refuses the `generic` fallback the same way. When no preset's markers match,
`init` prints what it determined, the available presets, and the evidence it
saw but could not rank — `@wordpress/*` imports no manifest declares,
`@types/wordpress__*` packages, `build/*.asset.php` dependencies, `.wp-env.json`,
`composer.json` — and writes nothing. Name the design system with
`init --preset <name>` (which keeps the inferred namespaces), or pass `--force`
to write the guess anyway. Until a config exists, `check` ends its report with a
line saying it ran on that guess.

`detect` also lists **possible external** prefixes: CSS-module and hashed class
names, prefixes an installed dependency defines, and prefixes only stylesheets
mention. They are never written — a prefix nothing references is also what dead
CSS looks like — so confirm them into `namespaces.external` by hand, or let
`/loupe-init` ask.

```bash
loupe detect   # what would be inferred, and why
loupe init     # write it to loupe.config.json
loupe status   # the effective config: rules, severities, what blocks
```

An inferred config is held to a lower bar than one somebody wrote down:
`css/dead-class` is forced to advisory (its remedy is "delete this CSS", and a
guess must not drive that), and in hook mode nothing blocks unless blocking is
turned on explicitly. `check` is unaffected — it still exits 1 on
error-severity findings, so CI behaviour does not depend on this.

```jsonc
{
  "extends": "wordpress-components",

  "namespaces": {
    "project": ["acme-"],           // classes you own; only these can be "dead"
    "external": ["components-"],    // third-party internals; styling them is an override
    "neverDead": ["has-*"]          // generated at runtime, never in source
  },

  "rules": {
    "css/dead-class": "error",
    "layout/margin-on-child": "off",
    "system/raw-element": {
      "severity": "off",
      "reason": "Stack/Text require bundling @wordpress/ui; this plugin ships zero runtime deps by design"
    }
  }
}
```

A rule takes a bare severity, or `{ "severity", "reason" }` to say why; any
other key is a config error. The `["warn", { … }]` form was removed in 0.8.0,
and a config still using it does not load — under the hook that means the gate
checks nothing until it is fixed. The rewrite is one line per rule; see
[MIGRATION.md](MIGRATION.md#upgrading-a-loupe-config-from-before-080).

Turning a rule off in config is a suppression of the whole rule, everywhere, so
`loupe suppressions` lists it beside the inline directives —
`loupe.config.json  system/raw-element  (rule off)  <reason>`, or
`no reason given` — and `loupe status` prints the reason beside the rule. A
preset's setting is replaced whole by the project's, so a preset's reason never
outlives the setting it explained, and one a preset turned off is listed under
`preset <name>` rather than your config file.

`maxEntries`, top level, moves the ceiling on the analysis walk — 200,000
entries by default, past which analysis refuses rather than report on part of
the tree (see [Programmatic use](#programmatic-use)) — for a project genuinely
larger than that, or lowers it. It must be a positive whole number; anything
else is a config error. `LOUPE_MAX_ENTRIES` outranks it for a single run.

Defaults are `DEFAULTS` in `src/config.ts`; `presets/generic.json` adds the
ignore globs and CSS-in-JS packages every shipped preset inherits. The
design-system block is what makes a preset:

```jsonc
{
  "designSystem": {
    "name": "WordPress",                 // what findings call it
    "packages": ["@wordpress/components"],
    "tokenPrefixes": ["--wp-admin-theme-"],
    "normalizeExports": "^__(experimental|unstable)",
    "components": { "layout": ["Stack"], "text": ["Text"] },
    "elementMap": {
      "p": "Text",
      "h4": { "component": "Text", "render": "h4" },    // <h4> → <Text render={ <h4 /> }>
      "div": { "component": "Stack", "styledOnly": true }
    }
  }
}
```

`normalizeExports` exists because design systems ship components under prefixed
names. `@wordpress/components` publishes `__experimentalText`; without
normalization the text rules never match and quietly degrade into generic
override findings.

`designSystem.substitutionProps` — defaulted for every config rather than
declared by a preset — names the props that hand a component the element it
should render: `<Text variant="heading-md" render={ <h4 /> }>`. The element in
one of those is an argument naming a tag, not markup, and it is how you keep an
element's semantics through the conversion `system/raw-element` asks for, so
that rule leaves it alone. The default covers `render` (WPDS, Base UI) and
`as`/`component` (most other React systems).

Two bounds keep the exemption from hiding drift. It is the prop's own element
only, never the subtree under it — `render={ <div><p/></div> }` still reports the
`<p>`. And it applies only on a component whose job is emitting a tag, meaning
one of the `components.text` or `components.layout` names imported from a
`packages` package. `render` is also react-router's, Formik's and Downshift's
prop name, and `@wordpress/components` spells an ordinary render callback that
way too (`FormFileUpload`); an element handed to one of those is markup the
author wrote, with an analog to convert to.

### Bundled presets

- `wpds` — extends `wordpress-components` with `--wpds-*` tokens, the
  `wpds-allow` suppression keyword, and a severity policy that blocks
- `wordpress-components` — the Gutenberg/admin surface
- `wordpress-block-theme` — `--wp--preset--*` tokens, `templates/`+`parts/` HTML
  as reference sources, no component layer
- `base-ui` — the headless case: `@base-ui/react` packages so composites are
  seen, no token or component layer to inherit, and the two rules that assume
  you must not restyle a component turned off
- `archer` — a *styled* system built on Base UI: its own layout primitives
  (`Stack`, `Grid`, `Center`) and text components (`Heading`, `Text`),
  unprefixed tokens in seventeen families, and the
  override rules back on, because a consumer of a styled system is not supposed
  to restyle its components from outside
- `vip` — `@automattic/vip-design-system`, on Theme UI: `Flex`/`Grid`/`Box`
  and `Text`/`Heading`, `--theme-ui-colors-*` for stylesheets, `vip-allow`.
  Theme UI styles through the `sx` prop, which the engine does not read, so on a
  VIP codebase the value rules see only stylesheets, `style` and CSS-in-JS;
  component currency, raw elements and composites are where it earns its keep
- `generic` — namespaces and token prefixes only

`base-ui` and `archer` are the two halves of the same lesson. A library that
ships no CSS wants the override rules off; a system built on top of one, that
does ship CSS, wants them on. Which of those you are on is not something the
dependency list can tell you, so the preset says it.

### Adding a design system

Nothing about WordPress is compiled into this engine — it is one configuration
of it, and the rules gate on what the config can support rather than on what
design system it is. A second one is data, in up to three pieces:

**1. A preset.** Drop `presets/<name>.json` in. It is listed by `loupe presets`
and usable as `--preset <name>` immediately. Give it a `detect` block and it is
also inferred with no config at all:

```jsonc
{
  "extends": "generic",
  "detect": {
    "priority": 30,                          // higher wins when two match
    "confidence": "high",
    "dependencies": ["@acme/ui"]             // a marker in any package.json
  },
  "designSystem": {
    "name": "Acme",
    "packages": ["@acme/ui"],
    "tokenPrefixes": ["--acme-"],
    "tokenSources": ["node_modules/@acme/tokens/dist/tokens.css"],
    "components": { "layout": ["Row", "Column"], "text": ["Label"] },
    "elementMap": { "p": "Label" }
  }
}
```

File markers work too, for a system that leaves no dependency — `"files": {
"all": ["theme.json"], "any": ["templates/", "parts/"] }`, probed at the root and
one level down, with `"confidence": { "full": "high", "partial": "medium" }` to
say what an `all`-without-`any` match is worth. A preset with no `detect` block
is never inferred, which is how a parent preset stays a parent rather than
becoming a conclusion.

**2. Registries, scoped.** A pattern signature is component *names*, and names
are the one thing design systems do not keep to themselves — `Stack(Stack(Text,
Text),Stack(Button))` is a WPDS page header and a Chakra one. So a registry
declares who it is for, and applies to nothing else:

```jsonc
{
  "packages": ["@acme/ui"],
  "patterns": [ /* … */ ]
}
```

A headless library (Base UI, Radix, Ark, React Aria) fills in only the packages
half: it has no layout or text primitive to name, and the compositional rules
ask for nothing else — a composite is built from every name imported out of
`designSystem.packages`. `system/override` and `system/inline-style` are the two
that do not carry over, because on an unstyled library a class on a component is
the documented way to style it; turn them off in the preset, as `base-ui` does.

A registry that declares no `packages` applies everywhere, which is what a
project's own registry wants. Where one project genuinely runs two systems at
once, a signature node can name its package directly:
`"@acme/ui::Stack"`. Bare names stay permissive, and a node whose import cannot
be resolved never blocks a match — qualifying narrows a match, it never invents
one.

**3. A profile**, if the registries ship with the tool rather than the project.
See `--profiles` below.

The one hard limit is the markup parser: Babel with the JSX and TypeScript
plugins, so any React-family design system works and Vue SFCs, Svelte and
Angular templates do not.

### Profiles

A profile is a design system's bundle — its preset, the packages that identify
it, and the registries describing its components and composites:

```
profiles/
  acme/
    profile.json       { id, name, packages, preset, patterns, components,
                         tokenDescriptions, tokenScopes, delivery }
    patterns/index.json
    components/index.json
    delivery.json      how its packages and tokens reach a page
    authoring.md       read by the plugin's skills, not by this engine
    patterns.md
    remediation.md
```

`delivery.json` says what adopting the system costs a project: which packages
the host provides at runtime (`external`, with its handle) and which the build
compiles in (`bundled`), and which stylesheet defines the tokens. `loupe status`
prints it as `delivery:`. See
[delivery](../docs/design/checks.md#delivery).

The three `.md` files are the design system's own authoring prose. The engine
never opens them — it prints the profile's directory in `loupe status`, and the
plugin's skills read them from there, which is what lets one set of skills serve
whatever design system a project is on.

`--profiles <dir>` reads them all and applies the ones whose packages the
project actually imports; `--profile <id>` forces one. A profile declaring no
packages is never selected automatically — there is nothing to recognize it by.

Forcing one applies the whole bundle: its registries merge without the scope
check the flag has already answered, and its preset configures the run. That
preset is the least explicit statement anything makes about a project —
`--config`, `--preset`, the plugin's own `preset` option and the project's
config file each outrank it — and it replaces only the preset *inference* would
have chosen, never what inference found about the project's own class
namespaces. A config reached that way is still an inferred one, so the hook
holds it advisory; `loupe check` run by hand reports at the profile's own
severities, which is what naming the profile asked for — expect exit 1 where
the same repo unnamed exits 0.

The two halves have different reach, and that is the case to watch. On a repo
with its own config file the preset is outranked but the registries still merge,
so a forced profile can lint one design system's code against another's
composites — signatures are bare component names, and `Modal(Text,Stack(Button,
Button))` fits every system that ships those names. That is allowed; it is what
the flag asks for. It is not silent: stderr names both sides of the mismatch, and
`--profile <id>` matching no profile at all now says so rather than checking
less than the same command with no flag.

This is what keeps a shipped registry off the wrong repo. Point `--profiles` at
every project you like: one on a different design system selects nothing and is
checked by the rules that need no registry at all. `loupe status` prints which
profile is active, and a registry passed but not applied says so on stderr
rather than looking like a registry that found nothing.

### Token scopes

A profile can say what each of its tokens is *for*, which a token's type does
not: a stroke colour and a text colour are both colours. `tokenScopes` — inline
in `profile.json`, or a profile-relative path to a JSON file holding it — is a
naming grammar plus what its segments mean, and an explicit list for any scale
whose role is not in the name. WPDS's is `profiles/wpds/token-scopes.json`:

```jsonc
{
  "kinds": {                                   // what markup can show an element to be
    "interactive": ["a", "button", "input", "Button", "Link"],
    "control": ["button", "input", "Button"],
    "overlay": ["Popover"],
    "nested-in-control": []                    // empty: no markup can show it
  },
  "grammars": [
    {
      "pattern": "--wpds-color-{property}-{target}...",
      "property": {                            // segment → the CSS properties it sets
        "background": ["background", "background-color", "background-image"],
        "stroke": { "sets": ["border-color", "border-*-color", "outline-color"], "also": ["box-shadow"] }
      },
      "target": {                              // segment → where it may sit
        "surface": { "not": ["interactive"] },
        "interactive": { "requires": ["interactive"] }
      }
    },
    { "pattern": "--wpds-cursor-{target}", "properties": ["cursor"], "target": { "control": { "requires": ["control"] } } }
  ],
  "scales": { "--wpds-border-radius-md": { "on": ["overlay"] } }
}
```

- **`pattern`** is a custom-property name with placeholders. `{property}`
  matches one of the segments the entry maps (so `surface-width` and `font-size`
  can be one segment); every other placeholder is one word; a trailing `...`
  allows any further segments. The first grammar that matches a token places it.
- **`property`** maps each segment to the CSS properties it `sets` — what the
  token is suggested for — and optionally those it may `also` appear in without
  being what it is for (a stroke inside a focus-ring `box-shadow`). A list is
  `sets` alone. `*` matches within a name: `padding-*`, `border-*-radius`. A
  pattern with no `{property}` names its family's properties under `properties`.
- **`target`** maps a segment to the kinds of element it `requires` or must
  `not` sit on. **`kinds`** names those kinds by tag (lowercase) and component
  (capitalised). **`scales`** gives a token with no role in its name the kinds it
  is `on`.
- Keys beginning with `$` are comments.

What it changes. Wherever a declared segment `sets` a property, the declared
grammar — not the engine's generic table — decides which of the tokens under its
patterns' prefixes are suggested for it; a token no pattern's prefix claims (a
project's own `--acme-*`), every other property, and a profile declaring
nothing get the generic table exactly as before. A single suggested token scoped to a kind of element
is applied by `loupe fix` only where the declaration is shown to style that kind
(see [Fixing](#fixing)), and `tokens/misapplied-token` reports a real token used
off its declared property or kind. Where nothing shows what an element is, a
scope is never reported and never applied unattended.

It is validated as the profile loads, and refused whole if any of it is wrong:
`loupe` names every problem on stderr and the profile falls back to the generic
table, its registries still applied. Design notes:
[token scopes](../docs/design/analysis.md#token-scopes).

## Fixing

```bash
loupe fix   # apply; --dry-run to preview; --judge for the values below
```

Applies only the declarations the engine already resolved to exactly **one**
on-role token — in `tokens/hardcoded-value` and `typography/untokenized`. Two
candidate tokens is a semantic choice — the right pixels with the wrong meaning
is the failure the suggestion machinery exists to prevent. A type property in a
stylesheet is where the rule's first remedy — use the text component — is not
available, which is the case its second one is for.

So is one token outside the scope its profile declares. `border-radius: 4px` is
`--wpds-border-radius-md` by value on a dialog and on a button alike, and `md`
is the radius for menus and popovers. Where the [token scopes](#token-scopes)
tie the one candidate to a kind of element and the declaration is not shown to
style that kind, the finding names it with `(review: …)` and the reason, and
`fix` prints a `review` line instead of writing it:

```
review src/a.scss:2  border-radius: 4px → --wpds-border-radius-md — for overlay; this styles <dialog>
```

The same holds for a token that settles one part of a value, or equals it in
another unit — `4px 4px 0 0`, `border: 1px solid #ddd`, `0.25rem` — which
`--judge` would otherwise write without asking; the review names the token:

```
review src/a.scss:3  border-radius: 4px 4px 0 0 — --wpds-border-radius-md for overlay; this styles <dialog>
```

`tokens/unknown-token` is fixed on the same terms. A `var()` naming a token
nothing defines is usually a misspelling, so where exactly **one** known token
is one keystroke away — one insertion, deletion or substitution, and not a
digit — the name is renamed on every line of the file that references it. Two
candidates, or none, and the finding stands, unless `--judge` settles it
([judged renames](#judged-renames)). A digit is excluded because
`--wpds-dimension-space-20` and `--wpds-dimension-space-30` are one keystroke
apart and mean different amounts: a step on a scale is not a spelling.

All three channels are written, two ways. A stylesheet declaration and a
CSS-in-JS one are matched as CSS on the line they were reported at: inside a
template the text *is* CSS, and a declaration whose value comes from an
interpolation never gets here because the template parse drops it. A JSX style
object is spliced at the literal instead — `style={{ paddingBottom: 13 }}` is
reported as `padding-bottom: 13px`, and neither half of that is in the file, so
the scan records where the value sits and the fix writes the token there as a
string, in the quote the value already used.

A finding is not a substitution. `typography/untokenized` collapses a CSS rule's
whole type block into one finding reported at the first declaration's line, and
every other declaration in it carries the line it is actually written on, so
each is matched against that. `tokens/unknown-token` reports once per file and
name however many lines reference it, and every one of them is rewritten. One
part settled beside one nobody could settle is a substitution made and a finding
still standing, which is why the summary counts both:

```
loupe: fixed 79 substitution(s). 258 of 312 finding(s) left for review.
```

A declaration that is not on its reported line exactly once is skipped and
named: the file moved under the report, and substituting against a stale line
number edits the wrong declaration. `!important` and the terminator survive. A
rename is matched only inside `var()`, and stops at the end of the name, so it
touches neither a definition nor a longer name beside it.

The baseline is ignored here. It exists to stop the gate blocking on an accepted
backlog; burning that backlog down is what this command is for.

## Judging

```bash
loupe check --judge
```

This covers the `system/raw-element` findings whose analog has `variants` in
the component registry: `Text (@wordpress/ui)` in the WPDS profile. It sends
each element's source and parent lines to TypeSafe in a request of its own, six
in flight, and asks which variant fits, or `not_<name>` when the element is not
that component's content. A pick at 0.5 confidence or above is written into
the suggestion — `<p> → <Text variant="body-sm"> (judged 0.80)`,
`<h3> → <Text variant="heading-lg" render={ <h3 /> }>`, a
`variant="heading-*"` placeholder filled, or `no analog, not Text content` in
place of a wrong analog — and recorded as `judged: { answer, confidence, spans }`
on the finding, the spans being what the agent format paints green. Anything
below leaves the finding alone. Verdicts, severities and the
baseline identity (`code`) are untouched. The key comes from
`TYPESAFE_API_KEY` in the environment, or from the `.env` two directories above
the engine entry point, which is the repo root of a checkout — and from the
working directory for a compiled binary, which has no checkout above it. A
failed request prints a note and the report goes out unjudged.

The key is always the caller's own. None is compiled into any artifact, and
that is checked rather than assumed: a canary value placed in the checkout's
`.env`, exported into the build environment, or dropped as a `.env` beside the
build leaves `dist/loupe.mjs` and every binary clean, and a binary run without a
key refuses `--judge` and says where to put one. The value is read through
`process.env` at runtime and neither compiler substitutes it — which is why
`scripts/build-binary.mjs` must never grow a `--define` for it.

### Judged values

`tokens/hardcoded-value` and `typography/untokenized` suggest a token only
where exactly one on-role token carries the value. `--judge` settles the rest,
and `fix --judge` applies what it settled. A type property in a stylesheet is
where the typography rule's first remedy — use the text component — is not
available, so a token is the remedy left, and which token is the same question
as for any other value.

The answer is written onto the declaration, not the finding:
`typography/untokenized` collapses a CSS rule's whole type block into one
finding, and three declarations there can settle three different ways. Each is
asked about with its own line's context, and each carries its own answer on
`suggest[i].judged`. The finding's own `judged` is those answers joined, for a
reader; `fix --judge` acts on the per-declaration ones.

A value the property has a family for but that the engine cannot relate to it
is not asked about and is left exactly as reported — `line-height: 1.4` against
line heights written in px is the case that comes up, and on
`vip-digital-asset-manager` it is 11 of the 27 open type declarations. Working
out what a ratio means needs the `font-size` beside it, which is code's job,
not a question.

`planValue` splits a flagged value into parts (on whitespace outside
parentheses), skips zeros and keywords, and settles each literal part a single
exact token carries. For each remaining part, `candidatesFor` builds the
options from the property's on-role family (the same role table the exact match
uses):

- **exact**: several on-role tokens carry the value, so only role separates
  them (`top: 24px`: padding or gap).
- **near**: a length or duration, narrowed to the scale steps either side of
  it (`10px` of padding: `padding-sm` or `padding-md`).
- **end**: a length or duration past the first or last step, which is
  offered alone (`48px` of padding: `padding-3xl`, 32px).
- **family**: anything else, colours included, gets every on-role token.

Every candidate list also offers `keep`, except for spacing (padding, gap and
position) in the `exact` and `near` tiers. A spacing value the scale covers
only snaps, and the model just picks which step. That pick is applied whatever
its confidence, because 6px sits exactly between 4 and 8 and either is a snap
someone would accept. Past the end of the scale spacing may still be kept:
48px of page padding snapped to 32px is a different layout.

An empty token set is refused outright rather than read as "no token for
anything". Empty means the design system's `tokenSources` yielded nothing;
tokens the project defines under the same prefix do not fill it. Every family
would come back empty, and `fix --judge` would
suppress every value as tokenless, so `check --judge` leaves values unjudged
and says so. So does `fix --judge`, and a failed request is handled the same
way: what the judge could not settle is left alone, and every fix that needed
no model is still written. A negative length, a `%` or an `hsl()` on
a px or colour family is a literal no token can stand for. That value is not
asked about, since rewriting the rest would leave the finding standing. A property whose family is empty
(`box-shadow` in WPDS) is settled without a model, as kept.

Each open part is one request, six in flight. The state is the file, the eight
lines before the declaration and the three from it. The options are the
candidate tokens, each described by the active profile's `tokenDescriptions`
(for WPDS, the `$description` of every token in `@wordpress/theme`'s DTCG
sources), plus `keep` where it is allowed. A value settles only if every part
clears 0.5, apart from the in-scale spacing picks above. A value judged `keep` in
every part is kept; one that mixes `keep` with a token is left for review, since
a `var()` anywhere in it would exempt the kept literal. The result is written
into the finding (`padding: 6px 12px → …-sm …-md (judged 0.60)`, or
`deliberate, no token fits`) and recorded on `judged`. For values, `answer` is
the replacement text — `var()` and all, since that is what `fix --judge`
writes — or `keep`. The message names the tokens without it.

`fix --judge` applies a replacement through the same substitution as `fix`, in
whichever channel the declaration came from. A value kept because the design
system has no token for its property at all gets a directive on its own line
above the declaration, with that as its reason:

```css
	/* wpds-allow tokens/hardcoded-value -- no box-shadow token in the design system */
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
```

A value the model judged deliberate is not suppressed. `deliberate, no token
fits` is the judgement, not a reason: what the value is (a scrim, a pill, a
brand colour) is for a reader to write, so `fix --judge` reports it as skipped
and the finding stays.

A directive mutes its whole next line. So one is written only where every
flagged value on that line was kept without a judgement, and otherwise the
value is reported as skipped. It names the rules the kept declarations on that line were reported
under, which on a minified stylesheet is not always one. Suppressions are
stylesheets only: a substitution replaces bytes already there, while a directive
adds a line, and a comment line above a JSX element is rendered text rather than
a comment. A value kept outside a stylesheet is reported as skipped for a reader
to suppress by hand.

```bash
npm run eval:values                     # three runs
node evals/values/run.ts --bare         # without the token descriptions
```

`evals/values` carries all 157 literals `--judge` asks about in
`vip-digital-asset-manager`, an un-remediated WPDS plugin written against the
wp-admin palette — 145 from `tokens/hardcoded-value` and 12 from
`typography/untokenized`. Each one is hand-labelled with every answer a careful
reader would accept: `10px` of padding is `sm` or `md`, a scrim is `keep`. It
scores 96–97% on each of three runs, and 98% of its answers repeat run to run.
As `fix --judge` applies it (at the 0.5 floor, plus the in-scale spacing picks)
it acts on 71% of the literals: three wrong tokens, and not one wrong keep,
across three runs. The type literals score 11 of 12 on every run; the miss,
`line-height: 18px` on a pill, answers at 0.24 and so is never acted on. Three
measurements shaped the design:

- **Descriptions.** Without them it scores 85% and makes 16 wrong token picks
  at the floor. The name says `track`; the description says "eg. scrollbar
  track", which is what stops a `#f0f0f1` badge becoming one because its value
  is a digit away.
- **Colours get the whole family.** Narrowing them to the perceptually nearest
  tokens scored 91%. A light tint's nearest tokens are greys of the wrong role,
  and the success wash `#edf6ee` should have been is further away than they are.
- **Position is spacing.** `top`, `right`, `bottom`, `left` and `inset` are
  offered padding and gap tokens only, not the `size-*` ones for icons and
  buttons. Offering the sizes had the model put `size-5xs` on `top: 4px`, and
  took the score from 97% to 95%.

Applied to that plugin, what `fix --judge` leaves is the values judged
deliberate — left for review now, rather than suppressed with the judgement as
their reason — the coin-flips, `10px` between 8 and 12 or `3px` between 2 and
4, and the unitless line heights nobody is asked about. Its rewrite and
suppression counts there were last taken while deliberate values were still
suppressed, against a checkout this repository does not carry, so none is
given here: `evals/values` above is the measurement that reproduces.

### Judged renames

A `tokens/unknown-token` name the spelling rule could not settle is one of two
things: a typo that lands one keystroke from two real tokens, or, far more
often, a name an agent made up in someone else's vocabulary —
`--wpds-color-text-muted`, `--wpds-spacing-lg`, `--wpds-font-weight-semibold`.
`--judge` asks which real token its author was naming, or `none`. A pick at 0.80
or above is written onto the finding as a rename, exactly as a spelled one would
be, and `fix --judge` applies it on every line of the file that names it:

```
src/card.scss
     9  --wpds-color-text-primary → --wpds-color-foreground-content-neutral (judged 0.98)
    14  --wpds-color-text-muted → --wpds-color-foreground-content-neutral-weak (judged 0.92)
     6  --wpds-z-index-dropdown
```

The options are the known tokens for the property the name is written in, by
the same role table the value suggestions use. A custom property is read by
the longest property its name ends in (`--acme-button-background-color` as
`background-color`), and one that matches nothing falls back to the tokens that
share the name's leading segments. Every token a keystroke away is added too, and
each is described by its value and the profile's `tokenDescriptions`. A name
with no candidates at all, such as `--wpds-z-index-dropdown` in WPDS, is never
asked about and stands for a reader. `none` answers are written as `no token
means this` and renamed to nothing.

```bash
npm run eval:renames
```

`evals/renames` carries 158 made-up names. Real code has almost none to label
(Gutenberg's three are test fixtures), so each is a real `var(--wpds-*)` from
`site-foundry` or Gutenberg with its name swapped for an agent-style guess, a
typo between two steps, or a name for something WPDS has no token for. At the
floor it renames 49% of them at 99% right across three runs. Its one wrong pick
is `--wpds-color-background-control-primary-weak-active` read as brand rather
than neutral, which "primary" arguably is. It never renames a between-steps
typo. The measurements are in [docs/design/judge.md](../docs/design/judge.md#which-token-was-meant-judgetokents).

### Judged redirects

The abstract pattern language decides between patterns on *forces*, things a
signature cannot see: does this control stand for a `value`, a `command` or a
`destination`? Most of its `resolve` rows consult one, so without a reading
they never run. `--judge` supplies the reading and runs the table in code.

A realization entry names the elements that are instances of its pattern with a
`judge` detector — in WPDS, `Button` for `action-cluster.bar`, `Menu.Item` and
`MenuItem` for `action-cluster.overflow`, `ToolbarButton` for the toolbar, and
`SelectControl` for `choose.select`. Each is asked about every force its
pattern's `resolve` consults that the vocabulary gives a `judge` block (only
`represents`, so far), one control per request, six in flight. An answer under
0.90 confidence stays unknown. `resolveRule` walks the table on what is known,
stopping at the first row it cannot decide, and a redirect is reported as
`patterns/judged-redirect` with the row's `because` as its note:

```
widgets/site-preview/render.tsx:116  <Button> (represents: destination) → `navigate-hierarchy` (judged 1.00)
```

An element with a prop from the detector's `unless` (`href`, `render`) already
realizes the target and is not asked; neither is one with a spread, which might
carry it. The finding is `warn`, written after the baseline so it never enters
one. Without `--judge` the scanner never sees the detector — and the hook passes
`--judge`, so on a project with a key this runs at write time too, advisory as
everywhere else.

On Gutenberg that is 734 controls in about 20 seconds and 13 findings: six that
navigate by `window.location`, a router call or a menu item and should be links
or `Navigator` parts, five editor-internal navigations and back buttons where
the reading is right and a link is not always possible, and two pagination
buttons. Pagination is the known gap: the eval has no label for it, and it is
why the floor is not lower.

```bash
npm run eval:represents                          # three runs
node evals/represents/run.ts 1 --batch 10         # sweep the batch size
```

`evals/represents` carries 100 controls lifted from
`gutenberg/packages/{editor,edit-site}` and `site-foundry/src`, hand-labelled,
13 of them flagged ambiguous because a careful reader could defend either
answer. It asks the question exactly as `--judge` does, from the vocabulary's
wording, so an edit to `patterns/index.json` is an edit the eval scores. It
scores 93–94% against a 54% majority-class baseline and repeats itself on 99%
of controls, with `destination` at 100% precision and 97% recall; every answer
at 0.90 or above was right. It is deliberately outside `npm test`: it costs
tokens, needs a key, and a model may drift in ways a build should not fail on.
`tests/features.ts` pins the wiring offline.

Batch size is per judgement and was measured rather than chosen. At 40 controls
to a request this question scores 81% and finds 69% of the destinations, because
every control in a batch shares one state with the other 39; alone it scores 93%
and finds 97%.

## Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
loupe baseline --dry-run  # what would be recorded, by rule — writes nothing
loupe baseline            # record the current findings
loupe check --changed     # only what's new
```

`--dry-run` prints the count each rule would record and, against a baseline
already in force, how many entries are new (`+N new`, backlog being accepted)
and how many it holds that nothing matches any more (`-N fixed`), followed by
that baseline's entry count and when it was recorded. `check` cannot answer
this: it applies the existing baseline, and `--no-baseline` shows everything
rather than what would change.

Entries key on rule + file + normalized code, not line number, so reformatting
doesn't resurrect the whole file.

The baseline goes to `.loupe-baseline.json` in the project, whatever the tool was
invoked as, and is meant to be committed. One location is the point: `loupe
baseline` from a shell and the Stop hook running as a plugin are different
processes with different environments, and a backlog only one of them can see is
a gate that blocks on findings it was told to accept. Set `baseline` in the
config, or pass `--baseline <path>`, to put it elsewhere. `loupe status` prints
the path in use, and says so when that path is a fallback.

The hook's retry counter is the opposite case, and never lands in the project:
it goes in `$CLAUDE_PLUGIN_DATA` under the plugin, and otherwise in a temp
directory of this user's own, keyed by project — so running the engine directly
from `.claude/settings.local.json` leaves no `.loupe/` in your tree. `loupe
status` prints the location on its `state:` line.

`loupe baseline` ends by saying to commit the file: until it is tracked, CI and
every other clone run with no baseline at all. When the path is ignored it says
that instead, with the number of findings those runs will report; outside a
repository it does not ask.

A committed `.loupe-baseline.json` the config has since pointed away from is
still read. 0.1.x baseline locations (`.loupe/baseline.json`, the plugin data
directory) are not: re-run `loupe baseline` to record one in the project, then
delete the old file. Until a current baseline exists, `check` says so on stderr
(never in JSON or SARIF on stdout) and `status` says so under its `baseline:`
line; the hook does not.

## Claude Code hook

```jsonc
// .claude/settings.local.json
{
  "env": { "LOUPE": "on" },
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/engine/bin/loupe.mjs hook" }] }
    ]
  }
}
```

Hook mode reads the payload on stdin, scopes to changed files, and emits the
hook protocol directly — no `jq`, no wrapper script.

A `PostToolUse` payload names the file just written, and there the hook asks
whether *this edit* made it worse: it blocks only on findings the edit
introduced, compared by baseline key against the content Claude Code hands back
as `tool_response.originalFile`. Findings the file already had are named in the
message, not blocked on — a refactor passes through states that are worse before
they are better. `Stop` keeps the absolute check over everything changed. With
no pre-edit content to compare against (a file the write created, or an older
payload), `PostToolUse` checks absolutely too.

On blocking findings it exits 2 and hands a budgeted report back to the agent:
guidance printed once per rule, a sample of each rule rather than a flood of
the first one. On a clean run it exits 0 with a one-line tally.

Installed as a Claude Code plugin, the hook reads its settings from
`CLAUDE_PLUGIN_OPTION_*` — whether it may block, which preset to force, the
class prefixes the project owns, and the attempt and finding caps. (Claude Code
won't substitute `${user_config.*}` into a shell-form hook command, since the
value would reach a shell, but it does export the options to the hook process.)
The same options are read from `pluginConfigs` in `~/.claude/settings.json`, and
the two are merged per key with the environment winning, so the hook and a
terminal resolve the same set; `loupe status` prints each option with where it
came from.

Each session gets `hook.maxAttempts` gated passes (default 3), then the gate
stands down and says so. Bailing out entirely on `stop_hook_active` — the
obvious loop guard — means the turn that *fixes* a finding is never checked, so
you never confirm the fix.

The hook is off until the project opts in: `LOUPE=on` in its environment,
which Claude Code supplies from `"env": { "LOUPE": "on" }` in the project's
`.claude/settings.local.json`. When the environment doesn't set `LOUPE`, the
engine reads that same key from `.claude/settings.local.json`,
`.claude/settings.json` and `~/.claude/settings.json`, in that order, so that
`loupe status` in a terminal agrees with the hook. `.claude/` is the Claude Code
project's, not the run's root: `CLAUDE_PROJECT_DIR` when it is set, otherwise the
nearest `.claude/` above `--root` or the working directory, looking no further
than the repository's top — so `status` run from inside a monorepo package reads
the same file the hook does.

To silence an opted-in hook, turn on the plugin's `off` option (every project),
put `"env": { "LOUPE_OFF": "1" }` in the project's `.claude/settings.local.json`
(one project, read on every run, so it takes effect mid-session), or start a
session as `LOUPE_OFF=1 claude`. All three feed the same option. The hook then
checks nothing and says only `loupe: skipped — silenced by …` to the user,
rather than downgrading to advisory, because an advisory finding still reaches
the agent and an agent that sees a finding starts fixing it. `loupe status`
reports the switch on its `options:` line with where it was set. `loupe` run by
hand ignores it.

Both read the same on/off spelling as every plugin option: `1`, `true`, `yes`,
`on`, case-insensitively. `LOUPE_OFF=0` is not one of them and leaves the hook
running — `loupe status` prints a `hook: OFF` line only when the switch actually
took, so the diagnostic and the gate cannot disagree.

The hook still drains its stdin before it returns, silenced or not: Claude Code
writes the payload into this process, and a `Write` of a large file carries the
whole file body in it. Exiting without reading leaves that write on a pipe with
no reader.

## Output

```bash
loupe check --all --format json     # stable, versioned schema
loupe check --all --format sarif    # GitHub code scanning
loupe check --changed --max-findings 20
loupe check --rule layout/margin-on-child --format json   # one rule, every finding
loupe suppressions                  # audit every active directive, and every rule off in config
loupe suppressions --stale          # only the ones muting nothing; exit 1 if any
```

Exit codes are a contract: `0` clean or advisory-only, `1` blocking findings,
`2` could not run.

The JSON payload carries a `version`, bumped whenever a field it already emitted
changes meaning or goes away; adding a field does not bump it, so a consumer
should ignore keys it does not know. Version `2` dropped `options` from every
`config.rules` entry, which is now `{ severity }`, since a rule no longer takes
the `[severity, {opts}]` form; an entry whose setting says why also carries
`reason`, an addition.

A baseline hides findings from `findings`, not from the record. The JSON
`summary` carries `baselined` — findings the baseline hid — whenever a baseline
step ran, and `fixed` — baseline *entries* nothing matches any more, the unit a
baseline stores and the same `-N fixed` `baseline --dry-run` prints — on a
whole-repo run that read a baseline file (under `--rule`, only those rules'
entries). Both are additive: absent rather than
0 when the question was not asked. SARIF lists each baselined finding as a
result carrying `suppressions: [{ "kind": "external", "justification":
"accepted in the loupe baseline" }]`, after the live ones, so code scanning
shows it as suppressed rather than as fixed, and puts the same two counts in the
run's `properties`.

`--rule <id>` scopes `check` and `fix` to the rules it names: repeat it, or give
a comma list. The exit code answers for what is left, the baselined count is the
same rule's, and `fix` rewrites only that rule's findings. An id that is not a
rule is exit `2` — filtering on it would report `clean` — and one this config
has off runs with a note saying so. `--rule <id> --format json` is every
occurrence, for a fix scripted in one pass; the agent format collapses identical
findings onto one line with `×N` and their lines, and says on each rule heading
how concentrated it is (`25 in 9 files, 11 distinct`).

JSON findings that flag a declaration carry `suggest`: `[{ prop, value, tokens,
line? }]`, one entry per declaration, tokens most specific first. `tokens` is
empty where nothing matched — the entry is still there, so "no token for this"
and "this declaration was never flagged" are told apart without reading the
prose. `line` appears only where the declaration is not on the finding's own
line, which is how a collapsed finding carries the rest of its CSS rule. The
prose message says the same thing for a reader; `suggest` is there so a consumer
does not have to parse it back out of a sentence. `loupe fix` is that consumer
for the single-token case.

`message` is one line, and bounded: a quoted value has its whitespace collapsed,
and a message longer than the bound is elided with `…`, or — where it is a list
of remedies — shortened to whole remedies and a `(+N more)` count. `suggest` and
`code` are not bounded, so a consumer that needs the whole of what was matched
should read those rather than the prose.

A finding from a stylesheet also carries `selector`: the selector of the rule it
sits in, whole and as authored, and for `css/dead-class` the bare class it is
about. It is the one field that is not a source location — a selector is a DOM
query, so it is what lets a consumer in a browser resolve a finding to the
elements it actually affects. JSX, inline-style and CSS-in-JS findings have no
selector and omit the field.

Where the rule sits under one or more `@media` queries, `media` carries the
condition, nested ones joined with ` and `, ready for `matchMedia`. `selector`
says which elements a rule reaches; `media` says when — the difference between
"these three elements are wrong" and "these three would be wrong at a width you
are not at". A comma binds looser than `and`, so a combination that would need
the query rewritten to stay correct is omitted rather than guessed at; an
unconditional rule omits the field.

## In the browser

```bash
loupe serve                         # then open http://localhost:7331
loupe serve --port 8100
```

A small server that hands the findings to the app you are developing: open the
URL it prints, drag the bookmarklet to your bookmarks bar, and click it on any
page of your app. A panel lists every finding; the ones carrying a `selector`
resolve against the live page, so each says how many elements it currently hits,
and hovering one outlines them. Click to pin and scroll to the first. A finding
behind an `@media` query says so, and says whether the query holds at the width
you are at — resize and the list restates itself.

It serves rather than integrates — stdlib HTTP and a bookmarklet, no bundler
plugin — because the dev environments this has to work in are not all a Vite
server with a middleware slot. One of them is webpack inside a Docker WordPress.

A bookmarklet injects into the current document only, so on a multi-page app it
is a click per navigation. For WordPress that is solved: `integrations/wordpress/`
ships a development mu-plugin that loads the overlay itself, and this server
hands it over at `/loupe-overlay.php` so installing it is a `curl` rather than a
hunt through the plugin's install path. The landing page prints both steps with
this server's own origin filled in. It is gated on a cookie (`?loupe=1`) as well
as the `LOUPE_OVERLAY_URL` constant, because browser tests usually drive the same
WordPress you are looking at and a fixed panel over every page intercepts their
clicks. `integrations/wordpress/README.md` has the wiring, including the
non-wp-env case.

Two limits are worth stating plainly, because the panel's whole risk is reading
as a verdict rather than a view:

- **It can only see the page you are on.** A finding in an unopened modal, an
  unrendered branch or an error state is listed but resolves to nothing. It is
  still real.
- **Roughly a third of findings have no selector at all** — every JSX-anchored
  rule, `system/raw-element` most of all. They are listed and labelled, never
  hidden.

The terminal remains the complete report. This answers the one question it
cannot: *which elements on screen*.

## Programmatic use

```js
import { analyze } from 'loupe';
import { loadConfig } from 'loupe/config';

const config = await loadConfig({ root: process.cwd() });
const { findings, blocking, directives } = analyze(config, { scope: null });
```

### Config keys added for these rules

| key | |
| --- | --- |
| `designSystem.tokenSources` | Paths (file or directory) holding the token definitions. Read even under `node_modules`, which the project walk prunes — that is where a design system's tokens live. Missing paths are skipped. |
| `designSystem.styleSources` | Paths (file or directory) holding the design system's own stylesheets (`.css`, `.scss`, `.less`). Every class they define is a library internal: a project rule whose key selector is one of them reports `system/override (library internal)`, the way a `namespaces.external` prefix does. This is how an unprefixed system (`.field-label`, `.toast-viewport`) is recognised, since no JSX binds the classes a component renders itself. The sheets are not checked as project code, a `namespaces.project` prefix still wins, and custom properties set on a project class (a slot rebind) are not an override. Missing paths are skipped. |
| `designSystem.cssInJsPackages` | Packages whose tagged templates are CSS. Defaults cover styled-components and emotion. |
| `designSystem.substitutionProps` | Props whose value names the element a component should render (`render={ <h4 /> }`, and the callback spelling of the same). That element is exempt from `system/raw-element` when the carrier is a `components.text` or `components.layout` name; nothing nested inside it is, and a genuine render callback on any other component is not. Defaults to `render`, `as`, `component`; `[]` exempts nothing. A list replaces the default rather than extending it. |
| `designSystem.allowedInlineStyles` | Inline-style properties a component's own API sanctions, as `{ "Text": ["color"] }` keyed by canonical component name. A `style` on that component made only of those properties is not `system/inline-style`; its values still go through the ordinary checks, so a raw colour there is still `tokens/hardcoded-value`. Any other property, a spread, or an opaque `style={obj}` reports the element as before, naming only the unsanctioned properties. The `wpds` preset sanctions `color` on `Text`, which has no color prop. |
| `patterns` | A composite registry: an inline array, or a path. `--patterns` merges a second registry over it, the config's own winning on id. Two formats load: version 1 keys an entry by `id` with one `signature`; version 2 keys it by `pattern` (`confirm`, `choose.segmented`, `navigate-hierarchy#descend`), may nest `parts` (loaded as `id#part`, inheriting `canonical` unless a part sets it to `null`), may carry `rendered_signature` as a second shape under the same id, and says in `detector` how it is checked. A detector object names an AST rule the engine ships — `few-static-options` (`components`, `prop`, `min`, `max`, `maxLabelChars`) or `confirm-pair` (`container`, `button`, `labels`, `controls`) — and a hit reports `patterns/superseded-composite` against that file, skipped when the file imports the entry's `canonical`. A `judge` detector (`components`, `unless`) names elements for `check --judge` to ask about, and reports `patterns/judged-redirect`. |
| `maxEntries` | How many entries the analysis walk reads before it refuses (default 200,000). A positive whole number; anything else is a config error. `LOUPE_MAX_ENTRIES` outranks it for one run. |
| `componentRegistry` | A component-currency registry (recommended/legacy/locked/experimental per component+package, and optionally each component's styling `surface` — `{ "properties": { "font-size": "variant", "border-radius": null } }` — which `system/override` and `typography/in-css` read; a registry recording none on any entry keeps `system/override`'s pre-surface reading, where every appearance property on a bound class blocks): an inline array, or a path. `--components` merges a second registry over it, the config's own winning on `package::name`. Distinct from `designSystem.components` (the layout/text categorization) — same word, unrelated concern. |

`scope` filters what is *reported*. The index is always built repo-wide —
building it from changed files alone would make every unchanged reference look
absent and every class look dead.

Two guards bound the cost: a hook payload naming a file no source glob matches
returns before indexing, and any file over 1.5MB is skipped as generated (a
stylesheet skipped this way still reports `stylesheet/unparsed`, so the hole is
never silent).

And a ceiling bounds the walk itself: past 200,000 entries (pruned directories
not counted) analysis refuses rather than reporting on part of the tree, since
a partial index calls everything it never reached clean. The hook stands aside
with a `skipped` message naming the count; a typed command exits 2. Point
`--root` at the project, or narrow `sources` / extend `sources.ignore`.
A project that really is that large sets the ceiling in `loupe.config.json` —
`"maxEntries": 500000`, a positive whole number, anything else a config error —
and `LOUPE_MAX_ENTRIES` overrides that for one run: the variable, then the
config, then 200,000.

## Source and bundle

`src/` is the engine, in TypeScript. `dist/loupe.mjs` is the same code
transpiled and bundled with its three dependencies, committed, and rebuilt by
`npm run build` — a marketplace install runs no `npm install` and no version of
Node runs `.ts` unaided, so without the bundle the engine throws on load for
anyone who installed the plugin rather than cloned it.

`bin/loupe.mjs` is the entry point every caller reaches, and it picks between
them: source wherever the dev toolchain is present (a checkout with
`node_modules` in it is a checkout someone is editing, and running a bundle
there would mean `src/` edits silently doing nothing), the bundle everywhere
else. `npm run build:check` re-bundles and compares — CI runs it, because a
stale `dist/` is invisible on the machine that made it stale.

esbuild transpiles TypeScript itself; it strips types without checking them. So
`npm run typecheck` is a separate gate, and both run in CI — a bundle that
builds is not a bundle that type-checks.

```bash
npm install
npm run typecheck    # tsc, no emit
npm run build        # rebuild dist/loupe.mjs, and commit it
npm run build:check  # fail if dist/ no longer matches src/
```

### Binary

A third artifact, for hosts that have no Node and should not be made to grow
one. `npm run build:binary` compiles the engine into one self-contained
executable; Bun does the compiling and is needed only to build, never to run.

```bash
npm run build:binary                      # this machine
npm run build:binary -- --target=linux-x64
npm run build:binary:all                  # all seven targets
```

Output lands in `binaries/`, which is gitignored: these are 60-110 MB each, 674
MB for the set, and belong on a release rather than in the history.
`.github/workflows/release.yml` is what puts them there — push a `v*` tag and it
runs the engine's own gate first (a tag matches no branch, so `ci.yml` does not
fire on one), checks the tag against `package.json` and against the version the
built binary reports, proves the glibc build runs and the musl build runs on
Alpine, writes `SHA256SUMS`, and attaches the lot. Running it by hand from the
Actions tab builds and verifies without publishing. Targets are `linux-x64`,
`linux-arm64`, their `-musl` variants, `darwin-x64`, `darwin-arm64` and
`windows-x64`, and every one of them cross-compiles from any one machine.

The data the engine ships — the presets, and the pattern language `--judge`
reads — is imported rather than read from disk, so it is inside whichever
artifact the bundler produced. Disk still wins wherever a `presets/` directory
exists, so an ordinary install behaves exactly as it did and a preset dropped in
by hand still takes effect. A side effect worth knowing: `patterns/index.json`
sits above the package and `files` never shipped it, so `--judge` from a
published npm install used to fail; embedding it fixes that too.

Two things the compiled binary does not inherit from a directory install. It
reports its own path from `execPath` rather than from `import.meta.url`, which
inside an executable resolves to a synthetic root — `loupe version` says
`binary` where it would otherwise say `source` or `bundle`. And `--judge` looks
for a `.env` in the working directory rather than beside a checkout that is not
there; in CI the key comes from the environment anyway.

### Types

`src/types.ts` holds the shapes more than one module speaks: `Finding`,
`Config`, `Pattern`, the scan results. Rule ids and capability names are written
out as unions rather than derived from `RULES`, so a typo is an error where it
was typed rather than a silently-absent lookup downstream.

Two distinctions in there carry most of the weight:

- **`AuthoredConfig` vs `MergedConfig`.** A config file, a preset and an
  inferred config are all partial *all the way down*; everything downstream of
  `normalize` has every field present. Keeping them apart is what stops a
  defaulted-but-absent field reading as a deliberate empty one.
- **`ClassifiedFinding` → `PendingFinding` → `Finding`.** What the shared
  classifier decides, what a channel walk has completed, and what a formatter
  sees. `hints` and `suffix` exist only on the middle two.

The compiler settings are the strict ones, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` included. Fields that are deliberately assigned
`undefined` say so (`suffix?: string | undefined`) rather than turning the flag
off for everyone.

## Tests

```bash
npm test        # typecheck, then all six suites
```

Six suites, in the order `npm test` runs them: `tests/run.ts` (fixtures, one
directory per behaviour), `tests/detect.ts` (inference), `tests/regressions.ts`
(failures that reported success), `tests/features.ts` (the three channels and the
two cross-file rules), `tests/autofix.ts` (the fix path, where a wrong
substitution is invisible), and `tests/multi-ds.ts` (registry scoping and profile
selection — which design system answers for a file). `tests/scopes.ts` covers
token scopes: the schema's validation, the generic table's parity with what it
replaced, `fix` holding back an off-role token, and `tokens/misapplied-token`.
`tests/harness.ts` is not a
suite: it holds the `check`/`assert`/scratch-repo helpers the six share, typed
once instead of copied six times.
Once behaviour is config-driven, these are the only thing standing between a
preset edit and a rule silently switching itself off.
