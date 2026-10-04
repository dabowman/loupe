---
name: loupe-remediation
description: >-
  Load when fixing design-system conformance findings — output from `loupe`, the `/loupe-audit` command, or a blocked Stop/PostToolUse hook reporting `layout/margin-on-child`, `layout/negative-margin`, `layout/in-css`, `typography/in-css`, `typography/untokenized`, `system/override`, `system/inline-style`, `system/raw-element`, `system/locked-component`, `system/superseded-component`, `tokens/hardcoded-value`, `tokens/unknown-token`, `tokens/misapplied-token`, `tokens/undelivered`, `patterns/duplicate-composite`, `patterns/superseded-composite`, `patterns/judged-redirect`, `patterns/unregistered-composite`, `css/dead-class`, `stylesheet/unparsed`, or `suppression/malformed`. Works on whatever design system the project is on — WordPress Design System, Archer, or one declared in the project's own config — reading the system-specific half of each remedy from the active profile. Carries the order to fix in, the per-rule remedy, the checks that stop a "fix" from silently changing rendering, and the rule for when suppressing beats changing code. Use it whenever a design-system check blocks a turn or a cleanup pass is requested over existing UI. Triggers on "fix the loupe findings", "the quality gate is blocking", "clean up this component's CSS", "why is this flagged", or a pasted finding list. Pair with `loupe-authoring` for the underlying rules.
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
- `delivery:` says how the system reaches a page: which packages the host
  provides, which get bundled into the project's own build, and which
  stylesheet defines the tokens. Absent means the profile declares nothing —
  not that everything is free. `<profile dir>/delivery.json` carries the same
  facts with their sources.

## Before converting or tokenizing: state the cost

A remedy is a proposal to *this* project, and two of them can cost more than
the finding is worth. Say so before the edit, not after it:

- **A component from a bundled package.** A remedy naming a package that
  `delivery:` lists as bundled is asking the project to take its first runtime
  dependency on it, unless it already imports it: a bigger bundle, the
  package's own dependencies with it, and possibly test config for its ESM
  build. The engine cannot measure the bundle, so it does not claim a number.
  Such a finding's note says so — `bundling required: <pkg> is bundled into
  your build, not provided by <host>` — and the note is absent once the project
  imports the package anywhere. `new dependency: <pkg> is not in package.json`
  is the same question for a package the profile says nothing about. Check
  whether the project is deliberately dependency-free; when the cost is new,
  state it to the user and let them choose before converting.
- **Tokens whose stylesheet never loads.** A `var()` naming a token the page
  never defines is invalid at computed-value time: the declaration drops, it
  does not fall back. Before substituting tokens, confirm the stylesheet
  `delivery:` names reaches the page the CSS styles — for a WordPress plugin, a
  dependency on its handle in the enqueue that loads the CSS. `tokens/undelivered`
  reports a project where the profile's evidence says it does not. Until it does,
  every token substitution is dead on the page, and "rendering change: none" is
  false.

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
3. `css/dead-class`, pruning — delete what is already dead. Nothing below can
   revive a class no markup references today, and every later stage gets a
   smaller input instead of tokenizing rules about to be deleted. Still a
   cross-file call: a class can be assembled at runtime, in PHP or a template
   string, so confirm it is not before deleting
4. `system/locked-component`, `system/superseded-component` — is this even the
   right component; swapping it can change what every finding below says
5. `system/override`, `system/inline-style`, `typography/in-css` — the
   component is being fought
6. `layout/*` — structure
7. `patterns/*` — composites, once individual components are conformant
8. `tokens/undelivered`, then `tokens/hardcoded-value`, `tokens/unknown-token`,
   `tokens/misapplied-token`, `typography/untokenized` — values; the first
   decides whether any of the rest render
9. `css/dead-class`, sweep — what the work above left dead, once the rest has
   settled. The same cross-file check applies

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
carrying the whole type style — the message names it where the registry
records one (`font-size on <Text> — set via its variant prop`). Delete the type
declarations and use it. If the
finding is on `color` and the styling prop has no colour axis, that is a system
gap — set colour separately with a foreground token and leave a comment naming
the missing prop.

### `typography/untokenized`

Raw type styling where no text component is bound. Where the system has one,
prefer converting to it. Where `text:` is `(none)`, the remedy is the token
route: apply the named type role as a whole, not a font size on its own — the
five type properties move together or they drift apart.

One finding is a whole CSS rule's type block, so it lists several declarations
and each carries its own remedy. A token ending `(judged 0.xx)` came from
`check --judge`, which picked it among the tokens near the value by what the
rule styles — the same reading as for `tokens/hardcoded-value`, and the same
caution: check it against the role. `no letter-spacing token in the design
system` is not a judgement but a fact, and the declaration stays. A finding
does not clear until every declaration in it does.

### `system/override`

CSS setting a property a design-system component owns, or reaching into
another library's internals.

The per-declaration form fires only where the component registry records that
the component owns the property, and the message says what controls it:

- `<Text> ← font-size — set via its variant prop` — delete the declaration and
  use that prop.
- `<TextControl> ← font-size — it sets this itself and has no prop for it` —
  there is nothing to move to. Keep the component's own styling, or keep the
  declaration with a suppression whose reason says why the design needs it;
  that override is what a version bump breaks first.

- `<Button> ← background — restyle via its props/tokens, not CSS` — the
  registry this component comes from records no styling surfaces at all, so
  nothing says what it owns and every appearance property on its class
  reports. Look for the prop or token in the component's docs; where there
  is none, the same two exits as above.

Where the registry does record surfaces, a class setting a property the
component does not own is not reported here — it gets the same verdict it
would on a plain element, usually `tokens/hardcoded-value`. For a library
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

That conversion trips `jsx-a11y/heading-has-content`. The lint rule reads
`<h4 />` statically and cannot follow the children through `render` to the
element that actually renders, which has them. It is a false positive: disable
it on that line, with the reason in the directive —

```
eslint-disable-next-line jsx-a11y/heading-has-content -- children pass through render
```

— not by dropping the semantic element, and not by reverting the conversion.

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
`fix --judge` leaves these unsuppressed and lists them as skipped for exactly
that reason. `no <property> token in the design system` is a fact, not a
judgement, and `fix --judge` suppresses it with that as the reason.

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

A token followed by `(review: …)` matched by value, but the active profile
scopes it to another kind of element, or to one nothing shows this element to
be — `--wpds-border-radius-md` is for menus and popovers, whatever the pixels.
`loupe fix` left it on purpose. Read the reason, find what the element actually
is, and use the token its role names (a dialog's radius is `lg`), even where
that changes the value; or keep the value if the design meant it. Do not apply
the named token because it is the one offered.

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

### `tokens/misapplied-token`

The token is real and the pixels are probably right; the meaning is not. The
finding says which half is wrong. *"a background token sets background, …"* —
it is on a property its family is not for: use the token of the right family
(`foreground` for `color`, `stroke` for a border). *"not for interactive; this
styles `<button>`"* or *"for overlay; this styles `<button>`"* — it is on a kind
of element its role excludes: a surface colour on a clickable control, a menu
radius on a button. Pick the token whose target or step names what the element
is (`background-interactive-*`, `radius-sm`), keeping tone and emphasis aligned
with the rest of the element.

It is advisory, and the scope is the profile author's reading of the system. If
the element really is what the token says — a card that is also a link, say —
suppress it with that reason; and if the profile's scope is simply wrong, that
is the profile's `token-scopes.json` to fix, not the code.

### `tokens/undelivered`

The project uses the design system's tokens, and nothing the profile counts as
evidence shows the stylesheet defining them reaches the page. Every `var()` of
them resolves to nothing there, and each declaration drops — the element loses
its background, not just its colour.

Fix the delivery, not the tokens: the finding's note names the handle, and
`loupe explain tokens/undelivered` prints what counts as delivery here and the
profile's own advice. Usually that is one line — the handle added to the
dependency array of the enqueue that loads the CSS. Do not paste the token
definitions into the project's own stylesheet to silence it; that forks the
design system and stops following its themes.

It reports only on a positive no: enqueues found, every one read, none
qualifying. If the CSS genuinely renders only where the host already loads the
sheet (inside the block editor's iframe, say), suppress it with that reason.

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

When the reason is a property of the project rather than of a line — the only
conformant target needs a library the project deliberately does not ship — turn
the rule off in config instead of writing the same directive thirty times, and
record the reason there, once:

```json
"rules": {
  "system/raw-element": {
    "severity": "off",
    "reason": "Stack/Text require bundling @wordpress/ui; this plugin ships zero runtime deps by design"
  }
}
```

The same bar applies: a config-scope off silences every finding of the rule,
everywhere, so it needs the reason more than a directive does, not less.

Audit them periodically; constraints expire. This lists the inline directives
and every rule turned off in config, with its reason or `no reason given`:

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

Then burn it down by rule (`--rule <id>` scopes both `check` and `fix`) — one
rule across the whole codebase is a far more reviewable diff than one file
across all rules, and the mechanical repetition makes a mistake obvious.

## Verify

Re-run the check, then confirm the UI still renders as before. A conformance
pass that changes what the user sees needs to be flagged as such, not folded
into a cleanup commit.

Then run the project's own linters. A conformance fix that trips another tool is
still a fix, not a regression — but prove it, the same way you prove rendering
did not change, rather than assume it. Formatter churn is the common case: a
conversion that adds a JSX prop often reflows onto several lines, and the
project's fix script (`lint:js:fix` on a `wp-scripts` project) settles it. Run
that instead of hand-formatting.
