# Authoring for the WordPress Design System

The design-system half of `loupe-authoring`. Load that skill first — it carries
the order of resort, the gap-over-margin rule, the inline-style rule and the
escape hatch, all of which apply here unchanged. This file says what those rules
mean in WPDS terms.

## Two different questions, two different sources

"Which component should this be" and "what are that component's props" are
different questions, and WPDS's two live packages (`@wordpress/components`,
stable; `@wordpress/ui`, the actively-growing target) make it easy to answer
the first one wrong by asking the second tool.

**Which component — `components/index.json`, beside this file.** A
verified-once, versioned registry of every known component's currency:
`recommended` (use it), `legacy` (works, but a recommended replacement now
covers the job), `locked` (a private API — do not use outside Gutenberg core,
can break without notice), `experimental` (real and documented, but WPDS's
own metadata flags it not yet safe to recommend broadly — informational, not
a migration target). The engine mechanically flags `locked`/`legacy` imports
(`system/locked-component`, `system/superseded-component`); `experimental`
never fires automatically, because whether it's safe here is contextual, not
mechanical — see [Choosing a component](#choosing-a-component) below.

**What are its props — the bundled `design-system` MCP**
(`.mcp.json` → `@wordpress/design-system-mcp`). Use `get_component_details`
once you've picked the component. It has **no maturity signal at all** — it
shows an `experimental` component with the same confidence as a `recommended`
one, and it's measurably behind trunk for several newer `@wordpress/ui`
additions (`Dialog`, `AlertDialog`, `Drawer`, `IconButton`, `LinkButton`
return nothing from it). Before asserting a prop or a token's name, or that
something "doesn't exist," check `get_components`/`get_component_details`/
`get_design_tokens` rather than recalling it — this doc's own examples have
drifted before (`HStack`/`VStack` → `Stack`, `Heading` → `Text` with
`variant`). Never assert a negative — "there's no prop for that" — without
having actually looked.

## Choosing a component

Past the basics (`Stack`, `Text`, `Card`, `Badge`, `Icon` — check the
registry, but these are settled), a handful of families need a real decision,
not a lookup. Check `components/index.json` for current status before
treating any of these as settled — WPDS ships twice yearly and this
section's calls can go stale.

**Button, IconButton, Link, LinkButton** — choose by what happens on
activation, not appearance:

| Goal | Component |
| --- | --- |
| Action on the current page (submit, open an overlay, run JS) | `Button` |
| Same, icon-only | `IconButton` |
| Navigate to another page/URL | `Link` |
| Navigate, styled as a button (standalone CTA, card action) | `LinkButton` |

`Button` and `IconButton` (`@wordpress/ui`) are `experimental` — not yet safe
alongside `@wordpress/components`, which is most real codebases today. Use
`Button` from `@wordpress/components` (`recommended`) until that clears;
`size`: `default` for text buttons, `compact` for toggle/icon buttons,
`small` for icon buttons on advanced/auxiliary features. One prominent
(primary) action per layout, secondary for the rest, tertiary sparingly.
Label with `{verb}+{noun}` (Save/Close/Cancel/OK exempted), strip filler
words. Never `Button`+`onClick` for actual navigation — that belongs to
`Link`.

**Modal, Dialog, AlertDialog, Drawer** — `Modal` (`@wordpress/components`) is
still `recommended`; `Dialog`/`AlertDialog`/`Drawer` (`@wordpress/ui`) are its
eventual replacements but are `experimental`, not yet safe alongside
`@wordpress/components`. Stay on `Modal`/`ConfirmDialog` until the registry
says otherwise. The decision for when it does clear: `Dialog` for a focused,
single-decision, scannable-without-scrolling task reachable from multiple
entry points; `AlertDialog` specifically for destructive/irreversible
confirmations (dismissal behavior and button emphasis match the severity);
`Drawer` for editing something already on screen, or a flow with multiple
fields/sections/drill-down steps that a `Dialog` would cramp.

**Menu vs. Select vs. Autocomplete vs. SelectControl** — by what the options
represent: `Menu` (commands, actions, navigation destinations — `Menu.Item`
for commands, `Menu.LinkItem` for navigation, `Menu.CheckboxItem`/
`Menu.RadioItem` for settings within the menu) vs. `SelectControl`/`Select`
(choosing one predefined value — the trigger represents the current value)
vs. `Autocomplete` (free-form filtering of suggestions). The
`@wordpress/components` `Menu` is `locked` — a private API, never use it.
The `@wordpress/ui` `Menu` is real but `experimental` — same
not-yet-safe-alongside-`@wordpress/components` gate as the Button family.

**Field, Fieldset** — low-level form primitives (`@wordpress/ui`,
`recommended`, no caution flag — they're stable, just low-altitude). Check
for a higher-level `*Control` component (either package) or `DataForm` first;
most UI should not need `Field`/`Fieldset` directly.

## The order of resort, in WPDS terms

1. **A component prop.** `<Text variant="body-sm">`.
2. **A layout primitive.** `<Stack direction="row" gap="sm">`, `<Stack direction="column">`.
3. **A token, applied in CSS.** `padding: var(--wpds-dimension-padding-md)`.
4. **Raw CSS.** Only with a reason you would defend out loud, or for what has no
   primitive at all — CSS Grid is never reported, because no flex primitive
   expresses it.

## Layout: gap, never margin

**WPDS ships no margin token.** The dimension scale covers `padding`, `gap`,
`size` and `surface-width` — margin is absent by design, because the system
expresses spacing as a property of a container, not of the things inside it.

This is a fact about the system, not a style preference, and it settles the
question: there is no sanctioned way to write margin, so spacing belongs to the
parent.

```jsx
// Wrong — each child asserts its own spacing, and they will disagree.
<div className="toolbar">
	<Button className="toolbar__save">Save</Button>   /* margin-right: 12px */
	<Button>Cancel</Button>
</div>

// Right — the container owns the rhythm; children stay reusable.
<Stack direction="row" gap="md" justify="flex-start">
	<Button variant="primary">Save</Button>
	<Button>Cancel</Button>
</Stack>
```

## Typography: variant, not properties

There is one text component, `Text`, and one styling prop, `variant`
(`heading-2xl`…`heading-sm`, `body-xl`…`body-sm`) — that is the entire
surface, headings included. A heading is `Text` at a heading variant with
`render` supplying the semantic element, not a separate `Heading` component:

```jsx
<Text variant="heading-lg" render={<h2 />}>Section title</Text>   // yes
<Text variant="body-sm">Draft</Text>                               // yes
<span className="status">Draft</span>                              // no
```

Never set `font-size`, `font-weight`, `line-height`, `letter-spacing` or
`font-family` on a class bound to `Text` — `variant` already carries all of
them together, and a class that touches one drifts them out of sync with each
other.

`variant` has no color axis, and `Text` has no `color` prop — the component's
own docs set color via `style` when a variant alone can't express it (e.g.
`style={{ color: 'var(--wpds-color-foreground-content-warning)' }}`), which
makes this the one sanctioned case for `style` on a WPDS component rather than
an override. The `wpds` preset knows the exception
(`designSystem.allowedInlineStyles`): a `style` on `Text` carrying only `color`
is not `system/inline-style`, and needs no suppression. The value is still
checked, so it has to be a token — a raw colour there is
`tokens/hardcoded-value`. Don't invent a `color` prop that does not exist.

Raw `<p>` and `<h1>`–`<h6>` both have a `Text` analog. Use it.

## Tokens by role, not by value

Token names describe purpose, not appearance. Pick by asking what the value is
*for*, never by matching a hex you already had:

```
--wpds-color-<property>-<target>-<tone>[-<emphasis>][-<state>]
```

- **property** — `background`, `foreground`, `stroke`
- **target** — `surface` (containers), `interactive` (controls), `content`
  (static text and icons), `track` / `thumb`
- **tone** — `neutral`, `brand`, `success`, `info`, `caution`, `warning`, `error`
- **emphasis** — `weak`, `strong` · **state** — `active`, `disabled`

Body text on a panel is `--wpds-color-foreground-content-neutral`. A primary
button's fill is `--wpds-color-background-interactive-brand-strong`. Keep the
role fixed across states and vary only the state segment — pair
`…-interactive-neutral` with `…-interactive-neutral-active`, rather than
switching tone when something is hovered.

Other families, all `--wpds-` prefixed:

| Need | Family |
| --- | --- |
| Space inside a container | `dimension-padding-{xs…3xl}` |
| Space between children | `dimension-gap-{xs…3xl}` |
| Control / icon sizing | `dimension-size-{5xs…lg}` |
| Max width of a surface | `dimension-surface-width-{xs…2xl}` |
| Type | `typography-font-size-{xs…2xl}`, `-line-height-*`, `-font-weight-{default,emphasis}` |
| Corners, borders | `border-radius-{xs…xl}`, `border-width-{xs…lg,focus}` |
| Animation | `motion-duration-{xs…xl}`, `motion-easing-{subtle,balanced,expressive}` |

The set is role-based, not a full matrix. A combination that does not exist
usually should not — that is a signal to re-examine the design, not to invent a
token or fall back to a literal.

Never invent a token name. If the exact token is not obvious, look it up with
the WPDS MCP server (`get_design_tokens`) rather than guessing a plausible
shape; `--wpds-font-size-13` is the classic invented token and it resolves to
nothing.

## Library internals are off limits

Reaching into another library's DOM — `.components-*`, `.block-editor-*`,
`.dataviews-*` — is worse than an override of your own component: those
selectors are private and change without notice. If a component cannot be made
to look right through its API, that is worth raising rather than routing
around.

## The escape hatch

The keyword here is `wpds-allow`:

```css
/* wpds-allow system/override -- Stack exposes no padding prop at this size */
.acme-panel { padding: var(--wpds-dimension-padding-lg); }
```

`wpds-disable`, `wpds-allow-file` and `ds-disable` are blanket forms and are
themselves blocking findings.
