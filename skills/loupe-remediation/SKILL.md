---
name: loupe-remediation
description: >-
  Load when fixing WPDS conformance findings — output from `loupe`, the `/loupe-audit` command, or a blocked Stop/PostToolUse hook reporting `layout/margin-on-child`, `layout/in-css`, `typography/in-css`, `typography/untokenized`, `system/override`, `system/inline-style`, `system/raw-element`, `system/locked-component`, `system/superseded-component`, `tokens/hardcoded-value`, `tokens/unknown-token`, `patterns/duplicate-composite`, `patterns/unregistered-composite`, `css/dead-class`, `stylesheet/unparsed`, or `suppression/malformed`. Carries the per-rule remedy, the checks that stop a "fix" from silently changing rendering, and the rule for when suppressing beats changing code. Use it whenever a design-system check blocks a turn or a cleanup pass is requested over existing UI. Triggers on "fix the loupe findings", "the quality gate is blocking", "clean up this component's CSS", "why is this flagged", or a pasted finding list. Pair with `loupe-authoring` for the underlying rules.
compatibility: "Targets WPDS on WordPress 6.5+ / 7.0. Needs the plugin's engine (node >=18)."
---

# Fixing WPDS conformance findings

Two failure modes to avoid, in both directions.

**Cosmetic compliance.** Deleting a `margin-bottom` silences the rule and
collapses the layout. A fix that changes rendering is not a fix — it is a
regression with a clean report.

**Reflex suppression.** Adding `wpds-allow` because the finding is inconvenient
converts a real problem into a permanent one, wearing a comment that says it was
considered.

The test for any change: *would I have written it this way from scratch?* If
yes, it is a fix. If it only exists to satisfy the checker, stop.

Before reaching for a prop or token name below, check it against the bundled
`design-system` MCP (`get_component_details`, `get_design_tokens`) rather than
recalling it — the remedies here name real current props, but WPDS moves
twice a year and a remedy that's right today can be stale by the next release.
The MCP is for prop/usage detail on a component already chosen — it carries no
maturity signal at all, so it is the wrong tool for "is this still the right
component." That question is `profiles/wpds/components/index.json`'s job; see
`system/locked-component`/`system/superseded-component` below.

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

The import is a private API — WordPress does not recommend using it outside
Gutenberg core, and it can change or break without notice on any update. The
finding names the public replacement; import that instead. `error` severity,
never `warn`, because this is a real risk, not a style preference.

If the finding is wrong — the file genuinely is Gutenberg core, or there is no
usable replacement yet — suppress with that specific reason. "It still works"
is not a reason; that is true of every locked API right up until it isn't.

### `system/superseded-component`

A current, recommended component now covers this job — the finding names it.
Check `profiles/wpds/components/index.json`'s entry for the *target* before swapping: some
replacements are a straight rename (`HStack`/`VStack` → `Stack` with a
`direction` prop), others change the prop surface entirely (`Text` from
`@wordpress/components` had `size`/`weight`/`color`; `Text` from
`@wordpress/ui` has only `variant`). Read the target's real props via the MCP
before writing the replacement — do not assume the old props carry over.

Only fires when the replacement's own status in `profiles/wpds/components/index.json` is
`recommended` — an `experimental`-status alternative (most of the newer
`@wordpress/ui` overlay components right now — `Dialog`, `AlertDialog`,
`Drawer`, `Menu`, `Button`, `IconButton`, `LinkButton`, `Notice`, `Popover`)
never generates this finding, because WPDS itself flags those not yet safe to
mix with `@wordpress/components`. If you see one of those names and no finding
fired, that is correct — do not "fix" it preemptively.

A stale registry entry is a real possibility — WPDS ships twice yearly and
this file is a point-in-time snapshot. If the named replacement does not
match what the MCP or trunk source actually shows, treat the finding as
suspect and say so rather than forcing a mismatched swap; that is worth
surfacing to whoever maintains this plugin, not silently working around.

### `layout/margin-on-child`

Move the spacing to the parent. Delete the margin, then give the container the
gap:

```jsx
<Stack direction="row" gap="md">…</Stack>
// or, when you don't own the wrapper:
.acme-parent { display: flex; gap: var(--wpds-dimension-gap-md); }
```

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

Replace the hand-rolled flexbox with `Stack`: `direction="row"` for a row,
`direction="column"` for a column, `gap` for spacing. When the element must
stay a plain container — or lays out with CSS Grid, which no primitive
expresses — keep the CSS but drive values from `--wpds-dimension-gap-*`. CSS
Grid is never reported — flex primitives cannot express it.

### `typography/in-css`

The class is on a `Text`. Delete the type declarations and use `variant`
(`heading-2xl`…`body-sm`) — that is `Text`'s whole styling surface, headings
included via `render`. `variant` has no color axis; if the finding is on
`color`, that is a system gap — set it via `style` with a
`--wpds-color-foreground-content-*` token (the one sanctioned inline-style case
on a WPDS component) and leave a comment naming the missing prop.

### `typography/untokenized`

Raw type styling on something with no text component. Prefer converting to
`Text`. If it must stay CSS, move to `--wpds-typography-font-size-*`,
`-line-height-*`, `-font-weight-{default,emphasis}`.

### `system/override`

CSS restyling a WPDS component, or reaching into another library's internals
(`.components-*`, `.block-editor-*`, `.dataviews-*`).

For a WPDS component, restyle through props. For a library internal, there is no
supported fix: the selector depends on markup that will change without notice.
Find the supported API, or accept the default. If neither works, that is worth
raising rather than routing around — and if you must keep it, the suppression
reason should say it is a known-fragile coupling.

### `system/inline-style`

A `style={{ … }}` attribute on a WPDS component. One finding covers the whole
attribute, because the remedy is the component's API rather than a better value
for each declaration.

Map each declaration to a prop — `Text` has only `variant`; `Stack` has
`direction`, `gap`, `align`, `justify`, `wrap`. Spacing between children moves
to the parent's `gap`.

A declaration `variant`/layout props genuinely can't express — most often
`color`, which `Text` has no prop for — is the one case where `style` on a
WPDS component is the sanctioned path rather than an override; see
`loupe-authoring`. Everything else: keep inline only what no stylesheet could
express, a value computed at runtime such as a measured width or a drag
offset. A constant is never that. When some declarations are dynamic and some
are not, move the constants out and leave the computed ones — then suppress
with a reason naming what is computed.

### `system/raw-element`

`<p>` → `Text` (`variant="body-md"`), `<h1>`–`<h6>` → `Text` with
`variant="heading-*"` and `render` supplying the semantic element, a styled
`<div>` → `Stack`, a styled `<span>` → `Text`.

The element handed to a WPDS text or layout component's substitution prop —
`render`, `as`, `component` — is not flagged: it names the tag that component
emits, so converting a `<h4>` to `Text` with `render={ <h4 /> }` settles the
finding rather than moving it. That holds for those components only. Markup
nested inside such a prop still counts, as does an element handed to a genuine
render callback — another library's, or `FormFileUpload`'s.

Not every raw element should convert. Content rendered from the editor, docs
prose, and third-party render props are legitimately raw — suppress those with
that as the reason, or exclude the path in config, which is better because it
scales.

### `tokens/hardcoded-value`

When the finding names a token — `border-radius: 4px → var(--wpds-border-radius-md)`
— it read that from the design system's own definitions. Use it.

When it names none, the engine found no token on-role for that value. Do not
substitute one that merely matches: body text is
`--wpds-color-foreground-content-neutral` because of what it is, not because the
hex lines up. Look it up with the WPDS MCP (`get_design_tokens`) rather than
guessing; invented names resolve to nothing and fail silently.

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

If the token is real but defined somewhere the engine cannot see, the fix is
`designSystem.tokenSources` in config, which fixes every finding of this shape at
once.

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

### `patterns/unregistered-composite`

The same composite in three or more files, in no registry. Two would be a
coincidence; three is house style that nobody wrote down.

Extract it, register it in `profiles/wpds/patterns/index.json` with a `summary` saying what it
is *for*, and point `import`/`canonical` at the new implementation. If the three
instances are genuinely different things that happen to share a shape, say so in
the entry's `instead_of` — or suppress with that reason, which is a real one.

### `css/dead-class`

The class appears in no markup or reference file. Usually delete the rule.

Before deleting, confirm it is not built at runtime — `` `acme-${kind}` ``
template classes, PHP-side `class="..."`, or a class supplied by an entirely
different repo. Runtime-generated families belong in `namespaces.neverDead` in
config, which fixes the whole family instead of one rule.

This rule is only meaningful repo-wide. On a `--changed` run a JS edit that
removed the last reference will not report it, so run `--all` before trusting it.

### `stylesheet/unparsed`

The file was not checked at all. If the message asks for a syntax package,
install it (`npm i -D postcss-scss`). Otherwise there is a genuine syntax error.
Never suppress this one — it does not mute a finding, it hides a blind spot.

### `suppression/malformed`

A directive missing a rule id or a reason, or a blanket disable. Rewrite it as
`wpds-allow <ruleId> -- <reason>`. If the original had no reason, work out
whether one exists; often the honest answer is that the finding should be fixed.

## Suppressing well

```css
/* wpds-allow system/override -- Notice exposes no dismissible-icon slot */
```

A good reason names the constraint that makes the finding wrong here. "Legacy
code", "intentional", "matches existing style" are not reasons — the first two
describe nothing and the third is the drift restating itself.

Audit them periodically; constraints expire:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" suppressions
```

## Large backlogs

Do not fix hundreds of findings in one pass. Baseline the backlog, which
silences existing findings and surfaces new ones immediately:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" baseline --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

`--profiles` matters: the hooks always pass it, and the registry-backed rules
(`system/locked-component`, `system/superseded-component`) only fire when it is
there. Baselining without it reports `baselined 0 finding(s)` and leaves the
gate blocking on findings this backlog never recorded.

Then burn it down by rule — one rule across the whole codebase is a far more
reviewable diff than one file across all rules, and the mechanical repetition
makes a mistake obvious.

## Verify

Re-run the check, then confirm the UI still renders as before. A conformance
pass that changes what the user sees needs to be flagged as such, not folded
into a cleanup commit.
