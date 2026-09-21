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

```bash
node engine/bin/loupe.mjs check --all   # or ./bin/loupe check --all
```

## Why

An agent writing front-end code will produce CSS that lints clean and still
ignores your design system: hand-rolled flexbox next to your `<Stack>`, a
hardcoded hex next to your token, a `<p>` where the system has a `<Text>`, an
override reaching into a third-party component's internals. None of that is a
syntax error. All of it is drift.

Most of the seventeen rules need cross-file correlation to decide. The rest
would work as a stylelint plugin, and are included because you want one report.

## Rules

| Rule | Detects |
| --- | --- |
| `suppression/malformed` | A blanket disable, or a directive missing a rule id or reason |
| `stylesheet/unparsed` | A stylesheet the parser could not read, so nothing in it was checked |
| `css/dead-class` | A project-namespaced class referenced in no markup or reference file |
| `tokens/unknown-token` | A `var()` naming no token any known source defines |
| `patterns/duplicate-composite` | A registered composite reassembled by hand in 2+ files |
| `patterns/superseded-composite` | A shape a registered pattern exists to replace, in the file that built it |
| `patterns/judged-redirect` | `--judge` only: a control read as standing for something its pattern redirects elsewhere |
| `patterns/unregistered-composite` | The same composite in 3+ files, registered in none |
| `tokens/hardcoded-value` | A literal colour/length where a design token exists |
| `layout/margin-on-child` | Margin, which belongs on the parent's `gap` |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own |
| `typography/untokenized` | Raw type styling with no token and no text component |
| `system/override` | CSS restyling a design-system component, or reaching into a library's internals |
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
    "layout/margin-on-child": "off"
  }
}
```

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
    profile.json       { id, name, packages, preset, patterns, components, tokenDescriptions }
    patterns/index.json
    components/index.json
    authoring.md       read by the plugin's skills, not by this engine
    patterns.md
    remediation.md
```

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

## Fixing

```bash
loupe fix   # apply; --dry-run to preview; --judge for the values below
```

Applies only `tokens/hardcoded-value` findings the engine already resolved to
exactly **one** on-role token, and only in stylesheets. Two candidate tokens is
a semantic choice — the right pixels with the wrong meaning is the failure the
suggestion machinery exists to prevent — and the JS channels (`style={{ … }}`,
CSS-in-JS) are left alone because a CSS-shaped substitution there writes a
syntax error with a clean report.

A declaration that is not on its reported line exactly once is skipped and
named: the file moved under the report, and substituting against a stale line
number edits the wrong declaration. `!important` and the terminator survive.

The baseline is ignored here. It exists to stop the gate blocking on an accepted
backlog; burning that backlog down is what this command is for.

## Judging

```bash
loupe check --judge
```

This covers the `system/raw-element` findings whose analog has `variants` in
the component registry: `Text (@wordpress/ui)` in the WPDS profile. It sends
each element's source and parent lines to TypeSafe in one request per 40
elements, and asks which variant fits, or `not_<name>` when the element is not
that component's content. A pick at 0.5 confidence or above is written into
the suggestion — `<p> → <Text variant="body-sm"> (judged 0.80)`, a
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

`tokens/hardcoded-value` suggests a token only when exactly one on-role token
carries the value. `--judge` settles the rest, and `fix --judge` applies what
it settled.

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
anything". Every family would come back empty, and `fix --judge` would
suppress every value as tokenless, so `check --judge` leaves values unjudged
and says so, and `fix --judge` stops. A negative length, a `%` or an `hsl()` on
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
into the finding (`padding: 6px 12px → var(…-sm) var(…-md) (judged 0.60)`, or
`deliberate, no token fits`) and recorded on `judged`. For values, `answer` is
the replacement text or `keep`.

`fix --judge` applies those answers in stylesheets only. A replacement goes
through the same line-exact substitution as `fix`. A kept value gets a
directive on its own line above the declaration, with the judgement as its
reason:

```css
	/* wpds-allow tokens/hardcoded-value -- deliberate, no token fits (judged 0.98) */
	background: rgba(0, 0, 0, 0.55);
```

A directive mutes its whole next line. So one is written only where every
hardcoded value on that line was kept, and otherwise the value is reported as
skipped.

```bash
npm run eval:values                     # three runs
node evals/values/run.ts --bare         # without the token descriptions
```

`evals/values` carries all 145 literals `--judge` asks about in
`vip-digital-asset-manager`, an un-remediated WPDS plugin written against the
wp-admin palette. Each one is hand-labelled with every answer a careful reader
would accept: `10px` of padding is `sm` or `md`, a scrim is `keep`. It scores
97% on each of three runs, and 97% of its answers repeat run to run. As
`fix --judge` applies it (at the 0.5 floor, plus the in-scale spacing picks)
it acts on 70% of the literals: one wrong token, and not one wrong keep, across
three runs. Three measurements shaped the
design:

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

Applied to that plugin, `fix --judge` took `tokens/hardcoded-value` from 183
findings to 63, with 16 suppressions and no other finding moved. What is left
is mostly the coin-flips: `10px` between 8 and 12, `3px` between 2 and 4.

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
one, and the hook never runs it. Without `--judge` the scanner never sees the
detector.

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
loupe baseline          # record the current findings
loupe check --changed   # only what's new
```

Entries key on rule + file + normalized code, not line number, so reformatting
doesn't resurrect the whole file.

The baseline goes to `.loupe-baseline.json` in the project, whatever the tool was
invoked as, and is meant to be committed. One location is the point: `loupe
baseline` from a shell and the Stop hook running as a plugin are different
processes with different environments, and a backlog only one of them can see is
a gate that blocks on findings it was told to accept. Set `baseline` in the
config, or pass `--baseline <path>`, to put it elsewhere. `loupe status` prints
the path in use, and says so when that path is a fallback.

A committed `.loupe-baseline.json` the config has since pointed away from is
still read. 0.1.x baseline locations (`.loupe/baseline.json`, the plugin data
directory) are not: re-run `loupe baseline` to record one in the project.

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

On blocking findings it exits 2 and hands a budgeted report back to the agent:
guidance printed once per rule, a sample of each rule rather than a flood of
the first one. On a clean run it exits 0 with a one-line tally.

Installed as a Claude Code plugin, the hook reads its settings from
`CLAUDE_PLUGIN_OPTION_*` — whether it may block, which preset to force, the
class prefixes the project owns, and the attempt and finding caps. (Claude Code
won't substitute `${user_config.*}` into a shell-form hook command, since the
value would reach a shell, but it does export the options to the hook process.)

Each session gets `hook.maxAttempts` gated passes (default 3), then the gate
stands down and says so. Bailing out entirely on `stop_hook_active` — the
obvious loop guard — means the turn that *fixes* a finding is never checked, so
you never confirm the fix.

The hook is off until the project opts in: `LOUPE=on` in its environment,
which Claude Code supplies from `"env": { "LOUPE": "on" }` in the project's
`.claude/settings.local.json`. When the environment doesn't set `LOUPE`, the
engine reads that same key from `.claude/settings.local.json`,
`.claude/settings.json` and `~/.claude/settings.json`, in that order, so that
`loupe status` in a terminal agrees with the hook.

Set `LOUPE_OFF=1` in the hook's environment to silence an opted-in hook for a session —
`LOUPE_OFF=1 claude`. It produces no output at all rather than downgrading to
advisory, because an advisory finding still reaches the agent and an agent that
sees a finding starts fixing it. `loupe` run by hand ignores the switch.

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
loupe suppressions                  # audit every active directive
```

Exit codes are a contract: `0` clean or advisory-only, `1` blocking findings,
`2` could not run.

JSON findings carry `suggest` when the engine matched a value against the token
set: `[{ prop, value, tokens }]`, most specific first. The prose message says the
same thing for a reader; `suggest` is there so a consumer does not have to parse
it back out of a sentence. `loupe fix` is that consumer for the
single-token case.

`message` is one line, and bounded: a quoted value has its whitespace collapsed,
and a message longer than the bound is elided with `…`, or — where it is a list
of remedies — shortened to whole remedies and a `(+N more)` count. `suggest` and
`code` are not bounded, so a consumer that needs the whole of what was matched
should read those rather than the prose.

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
| `patterns` | A composite registry: an inline array, or a path. `--patterns` merges a second registry over it, the config's own winning on id. Two formats load: version 1 keys an entry by `id` with one `signature`; version 2 keys it by `pattern` (`confirm`, `choose.segmented`, `navigate-hierarchy#descend`), may nest `parts` (loaded as `id#part`, inheriting `canonical` unless a part sets it to `null`), may carry `rendered_signature` as a second shape under the same id, and says in `detector` how it is checked. A detector object names an AST rule the engine ships — `few-static-options` (`components`, `prop`, `min`, `max`, `maxLabelChars`) or `confirm-pair` (`container`, `button`, `labels`, `controls`) — and a hit reports `patterns/superseded-composite` against that file, skipped when the file imports the entry's `canonical`. A `judge` detector (`components`, `unless`) names elements for `check --judge` to ask about, and reports `patterns/judged-redirect`. |
| `componentRegistry` | A component-currency registry (recommended/legacy/locked/experimental per component+package): an inline array, or a path. `--components` merges a second registry over it, the config's own winning on `package::name`. Distinct from `designSystem.components` (the layout/text categorization) — same word, unrelated concern. |

`scope` filters what is *reported*. The index is always built repo-wide —
building it from changed files alone would make every unchanged reference look
absent and every class look dead.

Two guards bound the cost: a hook payload naming a file no source glob matches
returns before indexing, and any file over 1.5MB is skipped as generated (a
stylesheet skipped this way still reports `stylesheet/unparsed`, so the hole is
never silent).

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
selection — which design system answers for a file). `tests/harness.ts` is not a
suite: it holds the `check`/`assert`/scratch-repo helpers the six share, typed
once instead of copied six times.
Once behaviour is config-driven, these are the only thing standing between a
preset edit and a rule silently switching itself off.
