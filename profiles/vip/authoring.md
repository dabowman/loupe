# Authoring for the VIP Design System

The design-system half of `loupe-authoring`. Load that skill first — it carries
the order of resort, gap over margin, the inline-style rule and the escape
hatch, all of which apply here unchanged. This file says what those rules mean
in VIP terms.

The VIP Design System is one package, `@automattic/vip-design-system`: about 70
exports, almost all of them thin wrappers over a [Theme UI](https://theme-ui.com)
component of the same name, with Radix underneath the interactive ones (dialog,
dropdown, tabs, tooltip, accordion, navigation). Styling is Theme UI's: every
component takes an `sx` prop, and `sx` values are **keys into the theme**, not
CSS. The theme is generated from Figma Studio tokens and has a light and a dark
colour mode.

## What Loupe can and cannot see here

Loupe checks stylesheets, `style={{ … }}` objects and emotion/styled-components
templates. It does **not** read `sx`. In a VIP codebase `sx` is where nearly all
styling lives, so the rules below that concern values inside `sx` — margins on
children, literal colours, literal pixel sizes — are yours to hold. A clean
report on a VIP file says the component choices and composites are right; it
says nothing about what is inside its `sx`.

## Which component

`components/index.json`, beside this file, is the registry: every export, what
it is for, and which are deprecated. Every import is a named import off the
package root — never a deep path into `build/` or `src/`.

Six exports are namespaces, not components: `NewDialog`, `Form`, `Dropdown`,
`Drawer`, `Accordion`, `Nav`. Use their parts (`NewDialog.Root`, `Form.Select`,
`Dropdown.Item`, `Nav.Tab`), not the namespace as a tag.

| Question | Answer |
| --- | --- |
| A modal dialog | `NewDialog.Root` — `trigger`, `title`, `description`, `content` are props. Never `Dialog`, which is deprecated |
| Confirm an action first | `NewConfirmationDialog`, never `NewDialog` plus two `Button`s, never `ConfirmationDialog` |
| A panel from an edge | `Drawer` |
| Commands on a thing | `Dropdown.Root`, with the trigger in its `trigger` prop and `Dropdown.Item`s as children |
| One filter from a set | `FilterDropdown` |
| A short label on hover | `NewTooltip`, never `Tooltip`, which is deprecated |
| Choosing a value from a list | `Form.Select`, or `Form.Autocomplete` / `Form.AutocompleteMulti` to type into it |
| A text field | `Form.Input` / `Form.Textarea`, labelled by `Form.Label`, message under it in `Validation` |
| An immediate on/off setting | `Toggle` |
| A value applied on submit | `Checkbox`, `Radio`, `RadioBoxGroup` (options with descriptions), `RadioGroupChip` (compact) |
| One mode out of a few | `ToggleGroup` |
| An action | `Button` — `variant` primary / secondary / tertiary / ghost / display / text / icon; `danger` for destructive; `loading` while it runs |
| A form's submit | `ButtonSubmit` |
| Navigation that looks like a button | `Link` with a `button-*` variant |
| A link off the dashboard | `LinkExternal` |
| Peer views of one subject | `Tabs` + `TabsList` / `TabsTrigger` / `TabsContent`; tabs that change route are `Nav.Tab` |
| Several expandable sections | `Accordion.Root` / `Item` / `Trigger` / `Content` |
| A message that stays | `Notice` — `variant` warning / error / alert / success / info |
| A message that leaves on its own | `Snackbar` |
| A status or category label | `Badge` — `variant` is a colour |
| A wait with no number | `Spinner`; a placeholder of known layout is `Skeleton`; a number is `Progress` |
| A surface grouping content | `Card` — `variant` primary / secondary / notice / indent |
| Tabular data | `Table`, `TableRow`, `TableCell` (`head` for a header cell) |
| Label/value pairs | `DescriptionList` |
| A row the user drills into | `OptionRow` |
| The header of a service page | `ServiceHeader` |
| "N results" above a filtered list | `ResultsSummary` |
| A heading | `Heading` with `variant="h1"`…`"h6"` |
| Running text | `Text` |
| A divider | `Hr` |
| Text for screen readers only | `ScreenReaderText` |
| A multi-step flow | `Wizard` + `WizardStep` |

## Layout: Flex, Grid and Box

- **`Flex`** lays siblings along one axis. Theme UI's `Flex` has no `gap`
  prop of its own — the gap goes in its `sx`, as a space step:
  `<Flex sx={{ gap: 3, alignItems: 'center' }}>`. `flexDirection: 'column'`
  for a vertical stack.
- **`Grid`** lines cells up in columns: `columns`, `gap`, and `width` (a
  minimum column width that makes it auto-fill). A wrapping row of cards is
  this, not a `Flex` with `flexWrap`.
- **`Box`** is the generic block, and the answer to "I need a `<div>` with
  styles". It is not a layout primitive — it has no gap. A `Box` whose children
  each carry `mb` is a `Flex` in column direction with a `gap`.

Spacing between siblings belongs to the parent's `gap`. The pattern this system
drifts into most is the action row:

```jsx
// Not this — the margin lives on the second child
<Flex sx={{ justifyContent: 'flex-end' }}>
	<Button variant="secondary">Cancel</Button>
	<Button sx={{ ml: 2 }}>Save</Button>
</Flex>

// This
<Flex sx={{ justifyContent: 'flex-end', gap: 2 }}>
	<Button variant="secondary">Cancel</Button>
	<Button>Save</Button>
</Flex>
```

`Text` carries `marginBottom: 2` of its own, so inside a `Flex` or `Grid` with
a `gap` it spaces twice. Give it `sx={{ mb: 0 }}` there.

## Typography

In markup, text is a component: `Heading` for a heading, `Text` for everything
else. `Heading`'s `variant` sets both the element and the type style
(`variant="h2"` renders an `<h2>` in the `h2` style) — choose it for the
outline, never for the size.

When a `Text` genuinely needs another size or weight, use theme keys:

| | Keys |
| --- | --- |
| `fontSize` | `0` 11px · `1` 12px · `2` 14px · `3` 16px · `4` 18px · `5` 28px · `6` 40px |
| `fontWeight` | `light` · `regular` · `medium` · `semibold` · `bold` |
| `lineHeight` | `0` 100% · `1` 115% · `2` 125% · `3` 130% · `4` 140% · `5` 150% |
| `fontFamily` | `default` · `monospace` |

`fontSize: 14` is not `fontSize: 2`. A number past the end of the scale is
read as pixels, so it looks right and bypasses the scale entirely.

## Tokens: theme keys by role

Every value an `sx` needs has a theme key, and the key is the token.

| Scale | Keys |
| --- | --- |
| `space` (margin, padding, gap, inset) | `0` 0 · `1` 4 · `2` 8 · `3` 12 · `4` 16 · `5` 24 · `6` 32 · `7` 56 · `8` 80 · `9` 160 |
| `radii` | `0` 2px · `1` 4 · `2` 8 · `3` 16 · `4` 32 |
| `shadows` | `low` · `medium` · `high` |
| `breakpoints` | responsive arrays: `px: [ 3, 4, 5 ]` |

Colours, by role — dotted paths into `theme.colors`:

| Need | Keys |
| --- | --- |
| Text | `texts.primary` `texts.secondary` `texts.helper` `texts.disabled` `texts.inverse` `texts.accent`, `texts.error` `texts.success`; `heading` for headings |
| Surfaces | `layer.1`…`layer.4`, `layer.inverse`, `layer.accent`; `backgrounds.primary` |
| Lines | `borders.1`…`borders.4`, `borders.inverse`, `borders.accent` |
| Icons | `icon.primary` `icon.secondary` `icon.helper` `icon.brand` `icon.inverse` `icon.disabled` |
| Links | `links.default` `links.hover` `links.active` `links.visited` |
| Status | `support.background.<status>`, `support.text.<status>`, `support.icon.<status>`, `support.accent.<status>` — status is `error` `warning` `info` `success` `neutral` `feature` |
| Tags | `tag.<colour>.background` / `tag.<colour>.text` — or just a `Badge` |

Outside `sx` — a stylesheet, or a value passed to a non-Theme-UI library — the
same colours are CSS custom properties: `var(--theme-ui-colors-borders-2)`,
`var(--theme-ui-colors-texts-helper)`. The dots become dashes.

**Dark mode is the argument for all of this.** The theme switches colour modes
by swapping values under the same keys. A `'#1e1e1e'`, a `rgba(…)`, or a
colour read out of the exported `theme` object and written back as a literal,
stays put when everything around it changes. The raw palette the theme also
exposes (`gray.70`, `blue.50`) does not move between modes either — the role
keys above exist so that it does.

## The `style` prop on NewDialog

`NewDialog.Root` takes a prop named `style` that is a Theme UI style object for
the dialog's content box, not React's inline style. Sizing and overflow there
(`width`, `maxWidth`, `overflowY`, …) are its documented API and Loupe does not
report them. Colour or spacing there is the same drift it would be anywhere.

## The escape hatch

The keyword here is `vip-allow`:

```jsx
{ /* vip-allow system/inline-style -- flexGrow is the measured build duration */ }
<Box style={{ flexGrow: buildMs }} />
```

`vip-disable` and `ds-disable` are blanket forms and are themselves blocking
findings.
