---
name: loupe-remediation
description: >-
  Load when fixing design-system conformance findings — output from `loupe`, the `/loupe-audit` command, or a blocked Stop/PostToolUse hook reporting `layout/margin-on-child`, `layout/negative-margin`, `layout/in-css`, `typography/in-css`, `typography/untokenized`, `system/override`, `system/inline-style`, `system/raw-element`, `system/locked-component`, `system/superseded-component`, `tokens/hardcoded-value`, `tokens/unknown-token`, `patterns/duplicate-composite`, `patterns/superseded-composite`, `patterns/judged-redirect`, `patterns/unregistered-composite`, `css/dead-class`, `stylesheet/unparsed`, or `suppression/malformed`. Works on whatever design system the project is on — WordPress Design System, Archer, or one declared in the project's own config — reading the system-specific half of each remedy from the active profile. Carries the order to fix in, the per-rule remedy, the checks that stop a "fix" from silently changing rendering, and the rule for when suppressing beats changing code. Use it whenever a design-system check blocks a turn or a cleanup pass is requested over existing UI. Triggers on "fix the loupe findings", "the quality gate is blocking", "clean up this component's CSS", "why is this flagged", or a pasted finding list. Pair with `loupe-authoring` for the underlying rules.
compatibility: "Any React-family design system Loupe can be configured for. Needs the plugin's engine (node >=18)."
---

# Fixing conformance findings

Two failure modes to avoid, in both directions.

**Cosmetic compliance.** Deleting a `margin-bottom` silences the rule and
collapses the layout. A fix that changes rendering is not a fix — it is a
regression with a clean report.

**Reflex suppression.** Suppressing because the finding is inconvenient converts
a real problem into a permanent one, wearing a comment that says it was
considered.

The test for any change: *would I have written it this way from scratch?* If
yes, it is a fix. If it only exists to satisfy the checker, stop.

## Before the first edit

```bash
loupe status
```

The remedies below are the shape of the fix. What to write instead — which
component, which token, which prop — is a fact about *this* design system, and
getting it from memory is how a fix ends up importing something that does not
exist.

- `layout:` / `text:` name the components the remedies refer to. `(none)` is a
  real answer and changes the remedy.
- `tokens:` names the namespace every replacement value comes from.
- `suppress:` is the exact keyword for a suppression here.
- `profile:` names the active profile and its directory. **Read
  `<profile dir>/remediation.md`** — it carries the system-specific half of
  every rule below, and `<profile dir>/authoring.md` carries the token families
  a value has to come from.

When the finding rather than the fix is what needs explaining, `loupe explain
<ruleId>` prints the rule's guidance and whether it is live in this config — and
for `system/locked-component` and `system/superseded-component`, which registry
decided it, how many of its entries fire the rule, and where that file sits. That
is how you check a suspect entry instead of arguing with it.

## Work in this order

Fix upward through the layers, because the lower fixes change what the higher
findings say:

1. `stylesheet/unparsed` — a file nobody read, so its findings do not exist yet
2. `suppression/malformed` — a broken directive is muting nothing
3. `system/locked-component`, `system/superseded-component` — is this even the
   right component; swapping it can change what every finding below says
4. `system/override`, `system/inline-style`, `typography/in-css` — the
   component is being fought
5. `layout/*` — structure
6. `patterns/*` — composites, once individual components are conformant
7. `tokens/hardcoded-value`, `tokens/unknown-token`, `typography/untokenized` — values
8. `css/dead-class` — once the rest has settled

Re-run between stages rather than fixing from a stale list.

## Per-rule remedies

### `system/locked-component`

The import is a private API the design system does not recommend using outside
its own core, and it can change or break without notice on any update. The
finding names the public replacement; import that instead.

If the finding is wrong — the file genuinely is that core, or there is no usable
replacement yet — suppress with that specific reason. "It still works" is not a
reason; that is true of every locked API right up until it isn't.

### `system/superseded-component`

A current, recommended component now covers this job — the finding names it.
Check the profile's `components/index.json` entry for the *target* before
swapping: some replacements are a straight rename, others change the prop
surface entirely. Read the target's real props before writing the replacement —
do not assume the old props carry over.

Silent only when *every* component the remedy names is itself `locked` or
`experimental` — the system's own metadata saying do not reach for this yet, so
the finding would ask for a migration onto an API nobody should adopt.
`DropdownMenu` is the shipped case. One usable candidate among several is enough
to fire it, a remedy that names no component at all still fires, and a name the
registry has never heard of fires too: the registry records currency, not
existence. Compound names resolve through their root, so `Menu.Group` inherits
`Menu`'s status rather than reading as unknown.

A stale registry entry is a real possibility; these files are point-in-time
snapshots. If the named replacement does not match what the design system's own
source or docs show, treat the finding as suspect and say so rather than forcing
a mismatched swap.

### `layout/margin-on-child`

Move the spacing to the parent. Delete the margin, then give the container the
gap — via the layout primitive's prop where one exists, or `gap` in CSS on a
parent you own, with a token for the value.

Check what the margin was actually doing first. A `margin-bottom` on the last
child of a scroll container is often trailing space, which `gap` does not
reproduce — that wants `padding-block-end` on the parent. Collapsed margins
between siblings do not translate one-to-one either; verify visually.

Zero margins, `auto` centering and negative bleeds are not reported, so
anything you see here is real spacing.

### `layout/negative-margin`

A bleed is legitimate. Confirm it is deliberate, then either restructure so the
parent's padding stops before the bleeding element, or suppress with a reason
naming the effect. Do not convert it to `gap` — that is the wrong remedy.

### `layout/in-css`

Replace the hand-rolled flexbox with the layout primitive `loupe status` named
under `layout:`. When the element must stay a plain container — or lays out with
CSS Grid, which no primitive expresses — keep the CSS but drive the values from
tokens. CSS Grid is never reported.

### `typography/in-css`

The class is on a text component, and that component already has a prop
carrying the whole type style. Delete the type declarations and use it. If the
finding is on `color` and the styling prop has no colour axis, that is a system
gap — set colour separately with a foreground token and leave a comment naming
the missing prop.

### `typography/untokenized`

Raw type styling where no text component is bound. Where the system has one,
prefer converting to it. Where `text:` is `(none)`, the remedy is the token
route: apply the named type role as a whole, not a font size on its own — the
five type properties move together or they drift apart.

### `system/override`

CSS restyling a design-system component, or reaching into another library's
internals.

For a component of your own design system, restyle through props, and through
whatever tokens that component declares as its own contract. For a library
internal, there is no supported fix: the selector depends on markup that will
change without notice. Find the supported API, or accept the default. If you
must keep it, the suppression reason should say it is a known-fragile coupling.

This rule is off on a headless design system, where styling the parts is the
documented way to use the library. If it fired, the system is not headless and
the override is real.

### `system/inline-style`

A `style={{ … }}` attribute on a design-system component. One finding covers the
whole attribute, because the remedy is the component's API rather than a better
value for each declaration.

Map each declaration to a prop. Spacing between children moves to the parent's
`gap`. Keep inline only what no stylesheet could express — a value computed at
runtime, such as a measured width or a drag offset. A constant is never that.
When some declarations are dynamic and some are not, move the constants out and
leave the computed ones, then suppress with a reason naming what is computed.

### `system/raw-element`

The element has a design-system analog and the finding names it. Convert it.

An element handed to a text or layout component's substitution prop — `render`,
`as`, `component` — is not flagged: it names the tag that component emits, so
converting an `<h4>` to the text component with `render={<h4 />}` settles the
finding rather than moving it. Markup nested inside such a prop still counts, as
does an element handed to a genuine render callback.

Not every raw element should convert. Content rendered from an editor, docs
prose, and third-party render props are legitimately raw — suppress those with
that as the reason, or exclude the path in config, which is better because it
scales.

A suggestion ending `(judged 0.80)` came from `check --judge`: a model read the
element and filled in what the tag alone could not say — the variant in
`<Text variant="body-sm">`, or `no analog, not Text content` when the element
is a swatch or a wrapper rather than text. Use the variant; it is the half you
would otherwise guess. Treat `no analog` as the reason to suppress rather than
convert, and say what the element actually is.

### `tokens/hardcoded-value`

When the finding names a token, it read that from the design system's own
definitions. Use it. A token ending `(judged 0.xx)` came from `check --judge`,
which picked it by what the rule styles among the tokens near the value. It is
usually right but check it against the role. `deliberate, no token fits
(judged …)` means the model read the value as a decision: suppress it with
what it actually is (a scrim, a pill, a brand colour), not with the judgement.

When it names none, the engine found no token on-role for that value. Do not
substitute one that merely matches: a token is chosen by what the value is
*for*, not because the hex lines up. Look it up in the profile's `authoring.md`
or in the system's generated stylesheets rather than guessing; invented names
resolve to nothing and fail silently.

Prefer the semantic layer over the raw palette. A primitive gives the right
colour today and the same colour in the other theme, which is the bug the role
layer exists to prevent.

If no token fits the role, the value may be genuinely outside the system.
Suppress with that reason rather than forcing an approximate token — a wrong
token is worse than a literal, because it will move when the system moves.

### `tokens/unknown-token`

The `var()` names a token nothing defines — almost always a typo or a name
carried over from an older version of the system. It resolves to nothing at
runtime, so the declaration is silently doing whatever the fallback does, or
nothing at all.

Look up the intended token rather than inventing a definition for this one. A
token defined locally to satisfy the checker is a fork of the design system with
one member.

If the token is real but defined somewhere the engine cannot see — including
custom properties a library sets at runtime rather than in a stylesheet — the
fix is `designSystem.tokenSources` in config, which fixes every finding of this
shape at once.

### `patterns/duplicate-composite`

The shape is a registered pattern, rebuilt by hand here and in at least one other
file. If the registry entry carries a `canonical`, import it. If it does not,
that is the work: extract one implementation from the instances that exist, then
fill in `import` and `canonical` so the next session finds it.

Read `loupe-patterns` before extracting — the entry records what the pattern is
*for*, and an extraction that misses the intent produces a shared component
nobody uses.

This is never fixed by making the markup look less like the pattern. That
silences the finding and keeps the duplication.

### `patterns/superseded-composite`

The shape a registered pattern exists to replace, found in the one file that
built it — this is the only composite rule that does not need a second file,
because a wrong choice is a defect where it is made. The finding names the
pattern and, when the entry carries a `canonical`, the component to use instead.

Read the entry's `instead_of` before rewriting: it says what the replacement
actually buys, and a swap made without that reads as churn. The rewrite is
usually a deletion — the hand-built version's state, layout and a11y wiring all
come with the sanctioned component.

If this file is the one legitimate exception, suppress it with that reason. Do
not reshape the markup to dodge the match; that keeps the wrong composition and
loses the record of why.

### `patterns/judged-redirect`

Only `check --judge` writes this, and it is a model's reading, not a parse:
confirm it before changing anything. The finding says what the control was read
as and where that sends it,
``<Button> (represents: destination) → `navigate-hierarchy` (judged 0.97)``;
the note is the pattern language's reason. Read the handler. A `Button` whose
`onClick` sets `window.location` or calls a router is a link — give it `href`
(or `render` a link) so it opens in a new tab and reads as navigation. A
`SelectControl` whose `onChange` runs a command is a menu.

When the reading is right and the remedy is impossible — editor state that no
URL can express — suppress it with that reason. When the reading is wrong,
suppress it and say what the control actually does; a wrong reading is worth
reporting against the eval, not working around in the markup.

### `patterns/unregistered-composite`

The same composite in three or more files, in no registry. Two would be a
coincidence; three is house style that nobody wrote down.

First ask whether the shape is *required* rather than chosen — a headless
component's root/trigger/portal/popup anatomy is the library working correctly,
and reporting it is the registry missing an entry, not the code being wrong. Fix
that by registering the anatomy with `canonical` set to the root import name;
see `loupe-patterns`.

Otherwise extract it, register it with a `summary` saying what it is *for*, and
point `import`/`canonical` at the new implementation. If the three instances are
genuinely different things that happen to share a shape, say so in the entry's
`instead_of` — or suppress with that reason, which is a real one.

### `css/dead-class`

The class appears in no markup or reference file. Usually delete the rule.

Before deleting, confirm it is not built at runtime — `` `acme-${kind}` ``
template classes, server-rendered `class="..."`, or a class supplied by an
entirely different repo. Runtime-generated families belong in
`namespaces.neverDead` in config, which fixes the whole family instead of one
rule.

This rule is only meaningful repo-wide. On a `--changed` run a JS edit that
removed the last reference will not report it, so run `--all` before trusting it.

### `stylesheet/unparsed`

The file was not checked at all. If the message asks for a syntax package,
install it (`npm i -D postcss-scss`). Otherwise there is a genuine syntax error.
Never suppress this one — it does not mute a finding, it hides a blind spot.

### `suppression/malformed`

A directive missing a rule id or a reason, or a blanket disable. Rewrite it in
the form `loupe status` printed under `suppress:` — `<keyword> <ruleId> --
<reason>`. If the original had no reason, work out whether one exists; often the
honest answer is that the finding should be fixed.

## Suppressing well

```css
/* <keyword> system/override -- Notice exposes no dismissible-icon slot */
```

A good reason names the constraint that makes the finding wrong here. "Legacy
code", "intentional", "matches existing style" are not reasons — the first two
describe nothing and the third is the drift restating itself.

Audit them periodically; constraints expire:

```bash
loupe suppressions
```

## Large backlogs

Do not fix hundreds of findings in one pass. Baseline the backlog, which
silences existing findings and surfaces new ones immediately:

```bash
loupe baseline
```

If you are invoking the engine directly rather than through the `loupe` shim,
pass `--profiles "${CLAUDE_PLUGIN_ROOT}/profiles"`: the hooks always pass it, and
the registry-backed rules only fire when it is there. Baselining without it
reports `baselined 0 finding(s)` and leaves the gate blocking on findings this
backlog never recorded.

Then burn it down by rule — one rule across the whole codebase is a far more
reviewable diff than one file across all rules, and the mechanical repetition
makes a mistake obvious.

## Verify

Re-run the check, then confirm the UI still renders as before. A conformance
pass that changes what the user sees needs to be flagged as such, not folded
into a cleanup commit.
