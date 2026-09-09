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
included via `render`. `variant` has no color axis; if the finding is on
`color`, that is a system gap — set it via `style` with a
`--wpds-color-foreground-content-*` token (the one sanctioned inline-style case
on a WPDS component) and leave a comment naming the missing prop.

## `typography/untokenized`

Prefer converting to `Text`. If it must stay CSS, move to
`--wpds-typography-font-size-*`, `-line-height-*`,
`-font-weight-{default,emphasis}`.

## `system/override`

For a WPDS component, restyle through props. For a library internal
(`.components-*`, `.block-editor-*`, `.dataviews-*`) there is no supported fix:
the selector depends on markup that will change without notice. Find the
supported API, or accept the default. If you must keep it, the suppression
reason should say it is a known-fragile coupling.

## `system/inline-style`

Map each declaration to a prop — `Text` has only `variant`; `Stack` has
`direction`, `gap`, `align`, `justify`, `wrap`. Spacing between children moves
to the parent's `gap`.

A declaration `variant`/layout props genuinely can't express — most often
`color`, which `Text` has no prop for — is the one case where `style` on a WPDS
component is sanctioned rather than an override.

## `system/raw-element`

`<p>` → `Text` (`variant="body-md"`), `<h1>`–`<h6>` → `Text` with
`variant="heading-*"` and `render` supplying the semantic element, a styled
`<div>` → `Stack`, a styled `<span>` → `Text`.

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
