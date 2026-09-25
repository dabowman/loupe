# Fixing VIP findings

The design-system half of `loupe-remediation`. Load that skill first — it
carries the order to work in, the two failure modes and the rules for
suppressing well. This file is what each remedy means in VIP terms.

`authoring.md` beside this file carries the theme scales and colour roles;
every remedy below assumes them. The fix for a value almost always lands in an
`sx`, and Loupe does not read `sx` — so re-running the checker confirms the
finding is gone, not that what replaced it is on the theme. Check that by eye.

## `layout/margin-on-child`

Move the spacing to the parent's `gap`. On a `Flex` that is its `sx`:

```jsx
<Flex sx={{ flexDirection: 'column', gap: 3 }}>…</Flex>
```

and in a stylesheet you own, `gap` in pixels from the space scale. Trailing
space below the last child is not a gap — that is `pb` on the parent.

## `layout/in-css`

Replace the hand-rolled flexbox with `Flex` (`sx={{ gap, alignItems,
justifyContent, flexDirection, flexWrap }}`) or a column layout with `Grid`
(`columns`, `gap`, `width`). CSS grid is never reported.

## `typography/in-css` and `typography/untokenized`

If the element is a heading or running text, the remedy is the component —
`Heading` with the `variant` its place in the outline needs, or `Text` — and the
CSS goes. Where a size or weight has to differ, set it in the component's `sx`
with theme keys (`fontSize: 1`, `fontWeight: 'semibold'`), not pixels.

## `system/override`

A class on a VIP component setting colour, type, borders or spacing. Restyle
through the component's own props first (`variant`, `inline`, `danger`, …),
then its `sx` — which merges over the component's own styles rather than
fighting their specificity. `Card` exposes `headerStyles` and `bodyStyles` for
its two regions; a selector reaching into `.vip-card-header-component` or
`.vip-card-body-component` is what those props replace.

## `system/inline-style`

Everything a `style={{ … }}` does on a VIP component, its `sx` does with theme
keys and colour modes — move it there. Keep inline only what no theme key can
express — a measured width, a computed `flexGrow`, a drag offset — and suppress
that with a reason naming what is computed.

`NewDialog.Root`'s `style` prop is a Theme UI style object for the dialog box,
and sizing and overflow there are not reported. What is reported there is
anything else — or a spread Loupe cannot see into.

## `system/raw-element`

`<p>` → `Text`, `<h1>`–`<h6>` → `Heading` with the matching `variant`, `<a>` →
`Link` (or `LinkExternal` when it leaves the dashboard), `<button>` → `Button`,
`<table>` → `Table`, `<label>` → `Label`, `<code>` → `Code`, `<hr>` → `Hr`, a
styled `<div>` → `Box`, `<input>` → `Form.Input` / `Checkbox` / `Radio` by type,
`<select>` → `Form.Select`.

Two cases that are not drift: a raw element inside a test's mock of some other
component, and an element handed to a library that needs a DOM node of its own
(a chart's tooltip, a third-party widget's container). Suppress those with that
reason rather than converting them.

## `tokens/hardcoded-value`

The finding cannot name a token here — Theme UI builds its custom properties at
runtime, so there is no token file to read. Pick by role from `authoring.md`:
inside `sx` a theme key (`color: 'texts.helper'`, `borderColor: 'borders.2'`),
in a stylesheet the matching `var(--theme-ui-colors-…)`. A hex that happens to
equal a palette entry is not thereby the right role, and a palette entry
(`gray.70`) does not follow dark mode.

## `tokens/unknown-token`

Inert until a token source exists: `--theme-ui-colors-*` is defined at runtime,
not in a file. A project that wants it on can snapshot the custom properties
once (`getComputedStyle(document.documentElement)` in each colour mode) into a
CSS file and list it under `designSystem.tokenSources`.

## `system/superseded-component`

- `Tooltip` → `NewTooltip`. The text moves to `content`; the trigger becomes the
  single child.
- `ConfirmationDialog` → `NewConfirmationDialog`. Pass `description`, not
  `body`, which is deprecated on the new one too.
- `Dialog` and its parts → `NewDialog.Root` when it was a modal task, or
  `Dropdown.Root` when it was a menu anchored to a trigger (`DialogMenu` /
  `DialogMenuItem` / `DialogDivider` map to `Dropdown.Item` / `Dropdown.Separator`).

## `patterns/superseded-composite` on `busy-button`

Delete the `Spinner` from the button's children and pass `loading` instead
(`ButtonSubmit` for a form's submit). `loading` also disables the button and
sets `aria-busy`, so a hand-written `disabled={ loading }` beside it can go.

## `patterns/duplicate-composite` on `labelled-toggle`

Extract the row once — label, toggle and help text, with the `htmlFor` / `id` /
`aria-describedby` wiring taking one `id` — then fill `import` and `canonical`
into the entry in `patterns/index.json` so every other file reports until it
imports it. Do not reach for `ToggleRow`: it has no `<label>`.

## `patterns/unregistered-composite` on component anatomy

If this fires on the parts of a VIP component used correctly, the anatomy entry
for it is missing from `patterns/index.json`. Add it, with `canonical` set to the
root import name. Do not reshape correct markup to dodge the match.

## Suppressing

The keyword is `vip-allow`:

```jsx
{ /* vip-allow system/raw-element -- mock of next/link in a unit test */ }
```
