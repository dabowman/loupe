---
name: wpds-remediation
description: >-
  Load when fixing WPDS conformance findings — output from `ds-hygiene`, the `/wpds-audit` command, or a blocked Stop/PostToolUse hook reporting `layout/margin-on-child`, `layout/in-css`, `typography/in-css`, `typography/untokenized`, `system/override`, `system/inline-style`, `system/raw-element`, `tokens/hardcoded-value`, `css/dead-class`, `stylesheet/unparsed`, or `suppression/malformed`. Carries the per-rule remedy, the checks that stop a "fix" from silently changing rendering, and the rule for when suppressing beats changing code. Use it whenever a design-system check blocks a turn or a cleanup pass is requested over existing UI. Triggers on "fix the ds-hygiene findings", "the quality gate is blocking", "clean up this component's CSS", "why is this flagged", or a pasted finding list. Pair with `wpds-authoring` for the underlying rules.
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

## Work in this order

Fix upward through the layers, because the lower fixes change what the higher
findings say:

1. `stylesheet/unparsed` — a file nobody read, so its findings do not exist yet
2. `suppression/malformed` — a broken directive is muting nothing
3. `system/override`, `system/inline-style`, `typography/in-css` — the
   component is being fought
4. `layout/*` — structure
5. `tokens/hardcoded-value`, `typography/untokenized` — values
6. `css/dead-class` — once the rest has settled

Re-run between stages rather than fixing from a stale list.

## Per-rule remedies

### `layout/margin-on-child`

Move the spacing to the parent. Delete the margin, then give the container the
gap:

```jsx
<HStack spacing={3}>…</HStack>
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

Replace the hand-rolled flexbox with a primitive: `HStack` for a row, `VStack`
for a column, `Grid` where it is a grid. When the element must stay a plain
container, keep `display: flex` and `gap` but drive values from
`--wpds-dimension-gap-*`. CSS Grid is never reported — flex primitives cannot
express it.

### `typography/in-css`

The class is on a `Text` or `Heading`. Delete the type declarations and use the
props — `size`, `weight`, `variant`, `lineHeight`, `align`, `color`. If the
exact value has no prop, that is a system gap: use `--wpds-typography-*` and
leave a comment naming the missing prop.

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

Map each declaration to a prop — `Text` has `size`, `weight`, `color`,
`variant`, `align`; layout primitives have `spacing`, `justify`, `alignment`,
`expanded`. Spacing between children moves to the parent's `spacing`/`gap`.

Keep inline only what no stylesheet could express: a value computed at runtime,
such as a measured width or a drag offset. A constant is never that. When some
declarations are dynamic and some are not, move the constants out and leave the
computed ones — then suppress with a reason naming what is computed.

### `system/raw-element`

`<p>` → `Text`, `<h1>`–`<h6>` → `Heading` with the matching `level`, a styled
`<div>` → `HStack` / `VStack`, a styled `<span>` → `Text`.

Not every raw element should convert. Content rendered from the editor, docs
prose, and third-party render props are legitimately raw — suppress those with
that as the reason, or exclude the path in config, which is better because it
scales.

### `tokens/hardcoded-value`

Replace with the token whose *role* matches — never the token whose value
happens to match. Body text is `--wpds-color-foreground-content-neutral` because
of what it is, not because the hex lines up. Look the token up with the WPDS MCP
(`get_design_tokens`) rather than guessing; invented names resolve to nothing
and fail silently.

If no token fits the role, the value may be genuinely outside the system.
Suppress with that reason rather than forcing an approximate token — a wrong
token is worse than a literal, because it will move when the system moves.

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
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" suppressions
```

## Large backlogs

Do not fix hundreds of findings in one pass. Baseline the backlog, which
silences existing findings and surfaces new ones immediately:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" baseline
```

Then burn it down by rule — one rule across the whole codebase is a far more
reviewable diff than one file across all rules, and the mechanical repetition
makes a mistake obvious.

## Verify

Re-run the check, then confirm the UI still renders as before. A conformance
pass that changes what the user sees needs to be flagged as such, not folded
into a cleanup commit.
