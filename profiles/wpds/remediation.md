# Fixing WPDS findings

The design-system half of `loupe-remediation`. Load that skill first — it
carries the order to work in, the two failure modes, and the rules for
suppressing well. This file is what each remedy means in WPDS terms.

Before reaching for a prop or token name below, check it against the bundled
`design-system` MCP (`get_component_details`, `get_design_tokens`) rather than
recalling it — the remedies here name real current props, but WPDS moves twice
a year and a remedy that's right today can be stale by the next release. The
MCP is for prop/usage detail on a component already chosen — it carries no
maturity signal at all, so it is the wrong tool for "is this still the right
component." That question is `components/index.json`'s job.

## `system/locked-component`

The import is a private API — WordPress does not recommend using it outside
Gutenberg core, and it can change or break without notice on any update. The
finding names the public replacement; import that instead.

If the finding is wrong — the file genuinely is Gutenberg core, or there is no
usable replacement yet — suppress with that specific reason. "It still works"
is not a reason; that is true of every locked API right up until it isn't.

## `system/superseded-component`

Check `components/index.json`'s entry for the *target* before swapping: some
replacements are a straight rename (`HStack`/`VStack` → `Stack` with a
`direction` prop), others change the prop surface entirely (`Text` from
`@wordpress/components` had `size`/`weight`/`color`; `Text` from
`@wordpress/ui` has only `variant`). Read the target's real props via the MCP
before writing the replacement — do not assume the old props carry over.

Only fires when the replacement's own status is `recommended` — an
`experimental`-status alternative (most of the newer `@wordpress/ui` overlay
components right now — `Dialog`, `AlertDialog`, `Drawer`, `Menu`, `Button`,
`IconButton`, `LinkButton`, `Notice`, `Popover`) never generates this finding,
because WPDS itself flags those not yet safe to mix with
`@wordpress/components`. If you see one of those names and no finding fired,
that is correct — do not "fix" it preemptively.

A stale registry entry is a real possibility — WPDS ships twice yearly and
this file is a point-in-time snapshot. If the named replacement does not match
what the MCP or trunk source actually shows, treat the finding as suspect and
say so rather than forcing a mismatched swap.

## `layout/margin-on-child`

Move the spacing to the parent:

```jsx
<Stack direction="row" gap="md">…</Stack>
// or, when you don't own the wrapper:
.acme-parent { display: flex; gap: var(--wpds-dimension-gap-md); }
```

WPDS ships no margin token at all, so there is no "tokenize it instead" branch
here — the spacing belongs to the container or it does not belong.

## `layout/in-css`

Replace the hand-rolled flexbox with `Stack`: `direction="row"` for a row,
`direction="column"` for a column, `gap` for spacing. When the element must
stay a plain container, keep the CSS but drive values from
`--wpds-dimension-gap-*`.

## `typography/in-css`

The class is on a `Text`. Delete the type declarations and use `variant`
(`heading-2xl`…`body-sm`) — that is `Text`'s whole styling surface, headings
included via `render`: family, size, line height and weight. `letter-spacing`
is not part of it, so it reports as `typography/untokenized` instead. `variant`
has no color axis; if a finding is on `color`, that is a system gap — set it
via `style` with a `--wpds-color-foreground-content-*` token (the one
sanctioned inline-style case on a WPDS component) and leave a comment naming
the missing prop.

## `typography/untokenized`

Prefer converting to `Text`. If it must stay CSS, move to
`--wpds-typography-font-size-*`, `-line-height-*`,
`-font-weight-{default,emphasis}`.

## `system/override`

Only a property the component owns reports per declaration, and the message
says what controls it. `set via its variant prop` (`Text`), `intent` (`Badge`),
`variant`/`tone` (`Button` in `@wordpress/ui`): use that prop. `it sets this
itself and has no prop for it` — `Card.Root`'s border and background — means
there is nothing to move to: keep the default, or suppress with the reason the
design needs it.

A component the registry records no surface for gets the plain-element
verdict, advisory.

For a library internal
(`.components-*`, `.block-editor-*`, `.dataviews-*`) there is no supported fix:
the selector depends on markup that will change without notice. Find the
supported API, or accept the default. If you must keep it, the suppression
reason should say it is a known-fragile coupling.

## `system/inline-style`

Map each declaration to a prop — `Text` has only `variant`; `Stack` has
`direction`, `gap`, `align`, `justify`, `wrap`. Spacing between children moves
to the parent's `gap`.

`color` on `Text`, which has no prop for it, is the one case where `style` on a
WPDS component is sanctioned rather than an override — the preset already
exempts it, so a finding here names some other property. Remove any
`wpds-allow system/inline-style` left on a color-only `Text` style;
`loupe suppressions --stale` lists them.

## `system/raw-element`

`<p>` → `Text` (`variant="body-md"`), `<h1>`–`<h6>` → `Text` with
`variant="heading-*"` and `render` supplying the semantic element, a styled
`<div>` → `Stack`, a styled `<span>` → `Text`.

Interactive elements are flagged whether or not anything styles them, because
the component carries the focus, labelling and state wiring the raw element
lacks: `<button>` → `Button`, `<select>` → `SelectControl`, `<textarea>` →
`TextareaControl`, `<table>` → `DataViews`, `<dialog>` → `Modal` (or
`ConfirmDialog` for a yes/no), `<progress>` → `ProgressBar`, `<details>` →
`Collapsible`. `<input>` is read by its `type`: `checkbox`, `radio`, `search`,
`file` and `range` have their own controls, `submit`/`button`/`reset` are a
`Button`, anything else is `InputControl`, and `hidden` is never flagged. The
finding names the package to import from — `InputControl` and
`TextareaControl` are in both, and only the `@wordpress/ui` one is current.

"No design-system equivalent" is usually wrong; check before suppressing. A
file input with `webkitdirectory`, which `FormFileUpload` cannot set, is the
kind of exception worth a `wpds-allow`.

WPDS's substitution props are `render`, `as` and `component`; an element handed
to one of those on a WPDS text or layout component is not flagged. Markup
nested inside such a prop still counts, as does an element handed to a genuine
render callback — another library's, or `FormFileUpload`'s.

## `tokens/hardcoded-value` and `tokens/unknown-token`

Look the token up with the WPDS MCP (`get_design_tokens`) rather than guessing
a plausible shape; `--wpds-font-size-13` is the classic invented token and it
resolves to nothing. Body text is `--wpds-color-foreground-content-neutral`
because of what it is, not because the hex lines up.

## `patterns/*`

The registry is `patterns/index.json` beside this file, and `loupe-patterns`
carries what each entry is *for*. Most WPDS patterns already have a `canonical`
— the remedy is usually an import and a deletion, because the hand-built
version's state, layout and a11y wiring all come with the sanctioned
component.

## Suppressing

The keyword is `wpds-allow`:

```css
/* wpds-allow system/override -- Notice exposes no dismissible-icon slot */
```
