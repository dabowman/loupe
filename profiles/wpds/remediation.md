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

## What a remedy costs here

`delivery.json` beside this file records how WPDS reaches a WordPress page, with
its sources:

- `@wordpress/components` is an external — `wp-components`, provided by
  WordPress — so moving within it costs the bundle nothing.
- `@wordpress/ui` (and `@wordpress/dataviews`, `@wordpress/admin-ui`,
  `@wordpress/global-styles-ui`, `@wordpress/icons`) is in
  `@wordpress/dependency-extraction-webpack-plugin`'s `BUNDLED_PACKAGES`: no
  `wp-ui` handle exists, webpack compiles it into the plugin's own bundle. The
  first `Stack` or `Text` from it is a new runtime dependency, a larger bundle, a
  `react` entry in the asset manifest, and often a Jest mapping for its ESM
  build. A finding carrying `bundling required: @wordpress/ui …` is proposing
  that; say so before converting a plugin that does not already ship it.
- `--wpds-*` tokens are defined only by the `wp-theme` stylesheet. A page that
  does not load it resolves every one of them to nothing. List `'wp-theme'` in
  the dependency array of the `wp_enqueue_style` that loads the plugin's CSS
  before substituting any token — WordPress core registers the handle from 7.1,
  the Gutenberg plugin before that.

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
itself and has no prop for it` — `Card.Root`'s border and background, the
`@wordpress/components` controls' font size — means there is nothing to move
to: keep the default, or suppress with the reason the design needs it.

A class on a `*Control` lands on the wrapper around label, input and help, not
on the input, so `border` there frames the whole field and is not an override.
CSS that reaches the input itself goes through `.components-*-control__input`
— a library internal, below. A component the registry records no surface for
gets the plain-element verdict, advisory. That holds only while this
profile's registry is active: a run without it — `--preset wpds` and no
`--profiles` — has no surfaces to read, and every appearance property on a
bound class reports as `restyle via its props/tokens, not CSS`.

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
finding names the package to import from — `InputControl`, `SelectControl`
and `TextareaControl` are in both, and only the `@wordpress/ui` one is
current.

A message ending `— converted, would block: …` names what the conversion
promotes. On `Text` that is usually `font-size`, `line-height`, `font-weight`
or `font-family`, which `variant` sets: pick the variant and drop them in the
same edit.

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

A suggestion ending `(review: …)` is a token held back by `token-scopes.json`
beside this file. Radius is the common one: the scale is by role, not size —
`xs` elements nested inside controls, `sm` standalone buttons and inputs, `md`
menus and popovers, `lg` cards, dialogs and notices, `xl` the page shell — so
`4px` on a dialog is `lg` (8px), not the `md` the value matches.

## `tokens/misapplied-token`

The grammar is `--wpds-color-<property>-<target>-<tone>[-<emphasis>][-<state>]`.
`property` is the CSS property it sets — `background`, `foreground` (`color`,
`fill`, icons), `stroke` (borders, outlines). `target` is what it sits on:
`surface` is for static containers and "not for clickable parts", `content` for
static text and icons, `interactive` for buttons, inputs, links. So a radio,
button or link takes `background-interactive-*`, `foreground-interactive-*` and
`stroke-interactive-*`, matching tone and emphasis across the three; and
`--wpds-cursor-control` is for controls that are not links.

## `tokens/undelivered`

Add `'wp-theme'` to the dependency array of the `wp_enqueue_style` (or
`wp_register_style`) that loads the CSS using the tokens:

```php
wp_enqueue_style( 'my-plugin-admin', $url, array( 'wp-theme' ), $version );
```

Name `wp-theme` itself, even where the style already depends on
`wp-components`: that dependency brings `wp-theme` along only on WordPress 7.1+
or with Gutenberg active, so it does not count. A `block.json` style naming
`wp-theme` does. Do not bundle `@wordpress/theme/design-tokens.css` into the
plugin; the package's README asks plugins to enqueue the handle so the tokens
follow the site's theme.

A note beginning `fallbacks render but won't follow the theme` means the build
(`@wordpress/build`, which applies them when `@wordpress/theme` is installed)
writes the default theme's values into each `var()`. The page renders, so it
can look fixed — but every token is pinned to the default theme. That is not
delivery; add the handle anyway. On a core older than 7.1 without Gutenberg
there is no `wp-theme` handle at all: say so, and the fallbacks are what keeps
the declarations from dropping there.

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
