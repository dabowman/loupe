# Fixing Archer findings

The design-system half of `loupe-remediation`. Load that skill first — it
carries the order to work in, the two failure modes and the rules for
suppressing well. This file is what each remedy means in Archer terms.

`authoring.md` beside this file carries the token families and the type-style
roles; every remedy below assumes them.

## `layout/margin-on-child`

Move the spacing to the parent's `gap`:

```jsx
<Stack direction="column" gap="m">…</Stack>
// or, when you don't own the wrapper:
.thing { display: flex; flex-direction: column; gap: var(--space-m); }
```

`gap` takes a **single** space step. If the margin you are removing was a pair
step (`--space-s-m`), that was a fluid container range and it belongs as the
parent's `padding`, not as a sibling gap.

Check what the margin was doing first. Trailing space below the last child is
not a gap — that is `padding-block-end` on the parent. Archer keeps a handful
of margins for exactly this reason and baselines them rather than pretending
`gap` covers them.

## `layout/in-css`

Replace hand-rolled flexbox with `Stack` — `direction`, `gap`, `align`,
`justify`, `wrap` cover it. When the element must stay a plain container, or
lays out with CSS Grid, keep the CSS and drive the spacing from `--space-*`.
Grid is never reported.

## `typography/untokenized`

Archer ships no text component, so the remedy is always the token route: apply
a `--type-styles-<role>-*` composite, all five longhands together. Roles are in
`authoring.md`.

Two failure modes specific to this:

- `letter-spacing` tokens are unitless em proportions and need
  `calc(var(--…) * 1em)`. Written raw the declaration is invalid and the
  browser drops it silently — a "fix" that reads as done and changes nothing.
- One longhand on its own is fine. Two or more in one rule is a new type style;
  mint the role in the token config rather than assembling it inline.

## `system/override`

A class on an Archer component setting colour, type, borders or radius. Archer
components take `variant` and `size` props and read their own
`--<component>-*` tokens; restyle through those.

Remapping a component token on a wrapper is the sanctioned route where a prop
does not exist — `.toolbar { --button-bg: var(--color-background-secondary); }`
— because those tokens are the component's declared contract. Reaching past
them into Base UI's internal parts is not.

## `system/inline-style`

`Stack` already has `direction`, `gap`, `align`, `justify`, `wrap`; `Button`
has `variant` and `size`. Spacing between children moves to the parent's `gap`.

Keep inline only what no stylesheet could express — a measured width, a drag
offset, a computed percentage. A constant is never that. When some declarations
are computed and some are not, move the constants out and suppress with a
reason naming what is computed.

## `system/raw-element`

Archer maps one element: a styled, laying-out `<div>` → `Stack`. It fires only
when the div is actually laying something out, so what it reports is a flex
container that should have been the primitive.

There is no mapping for `<p>` or `<h1>`–`<h6>`, and that is correct — Archer
has no text component, so a heading stays a heading and carries a type-style
role.

## `tokens/hardcoded-value`

When the finding names a token, it read that from Archer's generated
stylesheets — use it. When it names none, pick by role from `authoring.md`
rather than by matching the value: a hex that happens to equal
`--color-neutral-600` is not thereby the right token, and the common tier
exists so that dark mode can move it.

If nothing in the common tier fits, the value may genuinely sit outside the
system — a 1px hairline below the smallest space step, for instance. Suppress
with that reason rather than forcing an approximate token, or mint a real one
in the token config.

Never reach for the base tier (`--color-neutral-600`, `--color-brand-400`) to
satisfy this. A primitive says what colour, not what for, and it does not move
between themes.

## `tokens/unknown-token`

Archer's token set is generated, so a name nothing defines is either a typo or
a token that was removed when the config changed. Regenerate
(`npm run tokens:build`) and check the name against the output rather than
defining it locally — a token defined locally to satisfy the checker is a fork
of the design system with one member.

Custom properties Base UI sets at runtime — `--anchor-width`,
`--collapsible-panel-height`, and friends — are real but come from no
stylesheet. If they report here, declare them in a small CSS file and add it to
`designSystem.tokenSources`, which fixes every finding of that shape at once.

## `patterns/unregistered-composite` on component anatomy

If this fires on the parts of an Archer component used correctly — a Dialog's
root, trigger, popup and title across several files — the anatomy entry for that
component is missing from `patterns/index.json`. Add it, with `canonical` set to
the root import name. Do not reshape correct markup to dodge the match, and do
not register it without a `canonical`: that converts the finding into
`patterns/duplicate-composite` and asks for an extraction that should not
happen.

## Suppressing

The keyword is `archer-allow`:

```css
/* archer-allow layout/margin-on-child -- no wrapper here; the consumer supplies it */
```
