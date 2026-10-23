# Authoring for Archer

This is a reference profile: `@dabowman/archer` is not published, so the profile
cannot be selected by package until it is, and meanwhile it is the worked
example of a non-WordPress profile.

The design-system half of `loupe-authoring`. Load that skill first — it carries
the order of resort, gap over margin, the inline-style rule and the escape
hatch, all of which apply here unchanged. This file says what those rules mean
in Archer terms.

Archer is one package, `@dabowman/archer`; its registry has 60 roots. 40 wrap
[Base UI](https://base-ui.com) for behaviour and accessibility; the other 20 are
Archer's own — layout, content, status and application regions, where Base UI
ships nothing. All of them are styled entirely with token custom properties.
Colour comes from Leonardo against contrast targets, type and space from
Utopia's fluid interpolation. Every value the
system exposes is a CSS custom property, and both themes are just a different
set of values for the same names.

## Which component

`components/index.json`, beside this file, is the registry: every root, what it
is for, and the parts it ships. Archer is on one release line, so nothing is
`legacy` or `locked` yet — the registry earns its keep as the answer to "which
of these is this", not as a currency check.

Read it before reaching for one of the families where the wrong pick is easy:

| Question | Answer |
| --- | --- |
| Confirmation of something destructive | `AlertDialog`, never `Dialog` plus two `Button`s |
| A focused task in an overlay | `Dialog` |
| Editing something already on screen, or a multi-step flow | `Drawer` |
| Anchored, non-modal, interactive | `Popover` |
| A short text label on hover | `Tooltip` — it holds nothing interactive |
| A rich hover summary of a link or entity | `PreviewCard` |
| Commands, navigation, in-menu settings | `Menu` |
| Choosing one predefined value | `Select` |
| A value chosen from a filterable list | `Combobox` |
| Free-form text with suggestions | `Autocomplete` |
| An immediate on/off setting | `Switch` |
| A pressed/unpressed control | `Toggle` |
| A form value | `Checkbox` |
| Progress toward completion | `Progress` |
| A static measurement in a range | `Meter` |
| Several expandable sections | `Accordion`; one on its own is `Collapsible` |
| One value shared across a set of toggles | `ToggleGroup` |
| Multi-line text entry | `Textarea`, inside `Field` like `Input` |
| The frame of an application | `AppShell` — `brand`, `actions` and `nav` are props |
| The top of a screen or pane | `PageHeader`, with a `Breadcrumb` in its `breadcrumb` prop |
| A heading | `Heading` — `variant="ui"` on application screens |
| A paragraph of prose | `Text` |
| Tabular data | `Table` |
| A message that stays on the page | `Alert`; one that leaves on its own is a toast from `useToastManager()` |
| A collection that correctly holds nothing | `Empty` |
| A wait with no number | `Spinner`; a placeholder whose layout is known is `Skeleton` |
| A short status, count or category label | `Badge` |

Parts are flat sibling exports off the same import — `DialogPopup`, not
`Dialog.Root`. A component's parts are its anatomy, not a separate choice.

## Layout: Stack, Grid and Center

Base UI ships **no layout components** — it bundles no CSS by design, so flow
and spacing are Archer's half of the job. Three primitives own it; reach for
one instead of a margin on a child.

- **`Stack`** spaces siblings along one axis.
  - `direction` — `column` (the default; the case margins were being used for) or `row`
  - `gap` — a **single** step of the space scale: `4xs 3xs 2xs xs s m l xl 2xl 3xl`
  - `align` — `start center end stretch baseline` · `justify` — `start center end between`
  - `wrap` — boolean, row direction
- **`Grid`** lines cells up in columns. `min` is the narrowest a column may be
  (a CSS length, default `16rem`) and `gap` takes the same single steps. The
  column count is the browser's: it fits as many as the container holds, and a
  short last row keeps the columns above it, which a wrapping `Stack` cannot.
- **`Center`** caps a column's width and centres it. `max` is `content` (the
  default, `--size-content`, 72rem) for a screen's main column, or `measure`
  (`--size-measure`, 42rem) for prose or a single-column form.

A screen caps its column with `Center` and lines its cards up with `Grid`:

```jsx
<Center>
	<Stack gap="l">
		<PageHeader title="Billing" actions={<Button variant="primary">Upgrade</Button>} />
		<Grid min="16rem">
			<Card>…</Card>
			<Card>…</Card>
			<Card>…</Card>
		</Grid>
	</Stack>
</Center>
```

Props map to custom properties (`--stack-gap`, `--grid-min`, `--center-max`, …),
not to modifier classes, so the class count stays at one.

The **pair steps** in the space scale (`--space-s-m`, `--space-l-xl`, …) are
fluid ranges for container padding, not for the gap between two siblings.
`Stack`'s `gap` only accepts single steps for that reason; if you are writing
one in CSS, hold to the same rule.

Spacing a child from inside the child is the drift Archer's `Stack` exists to
end. Every container Archer owns carries its rhythm as `gap` and its children
set `margin: 0`.

## Typography: components first, then composites

In markup, text is a component. A heading is `Heading` and a paragraph of prose
is `Text`:

```jsx
<Heading level={2} variant="ui">Payment method</Heading>
<Text variant="body-2">Charged on the first of each month.</Text>
```

- `Heading` — `level` 1–6 (default 2) sets the element *and* the size, so the
  outline and the visual hierarchy cannot drift apart. `variant` is `prose`
  (the default: `heading-1`…`heading-6`) or `ui` (`ui-title` at level 1,
  `ui-heading` below it). Use `ui` on application screens. Never pick a level
  for its size.
- `Text` — `variant` is `body-1`, `body-2` (the default) or `body-3`: the prose
  styles, for running text.

Text *inside* a control is the control's job, and a type style your own
component needs in its stylesheet is a *composite* — five longhands that move
together — applied from the `--type-styles-*` family:

```css
.panel-title {
	font-family:    var(--type-styles-ui-title-font-family);
	font-size:      var(--type-styles-ui-title-font-size);
	font-weight:    var(--type-styles-ui-title-font-weight);
	line-height:    var(--type-styles-ui-title-line-height);
	letter-spacing: calc(var(--type-styles-ui-title-letter-spacing) * 1em);
}
```

Roles, and what each is for:

| | |
| --- | --- |
| UI | `ui-title` `ui-heading` `ui-body-lg` `ui-body` `ui-control` `ui-label` `ui-caption` `ui-overline` |
| Prose | `heading-1`…`heading-6`, `body-1` `body-2` `body-3` |

Two things about this that bite:

- **letter-spacing tokens are unitless em proportions.** Written raw —
  `letter-spacing: var(--type-styles-ui-body-letter-spacing)` — that is invalid
  CSS the browser drops silently. It always needs `calc(… * 1em)`.
- **A single longhand override is fine** (a variant's `font-size`, a state's
  `font-weight`). Two or more in one rule is a new type style, and it belongs
  in the token config as a role rather than inline in a component.

There is no `font` shorthand route: it cannot carry letter-spacing and it
resets `font-variant`.

Semantic HTML still applies — a heading is a `Heading` (an `<h2>` underneath),
not a `<div>` with a heading's type style.

## Tokens by role, not by value

Archer's tokens are unprefixed and arrive in three tiers. **Consumers use the
common tier.** The base tier is the raw palette the common tier is built from,
and the component tier is each component's internal contract.

| Tier | Looks like | Use it? |
| --- | --- | --- |
| base | `--color-neutral-600`, `--color-brand-400` | No — a primitive says what colour, not what for |
| common | `--color-text-primary`, `--space-m`, `--radius-3` | Yes |
| component | `--button-bg`, `--menu-item-color` | No — internal to that component |

Colour, by role:

| Need | Family |
| --- | --- |
| Text | `--color-text-{primary,secondary,tertiary,inverse,link,link-hover,on-primary}` |
| Text carrying status | `--color-text-{success,warning,error,info}` |
| Surfaces | `--color-background-{primary,secondary,tertiary,quaternary,inverse}` |
| Surfaces carrying status | `--color-background-{success,warning,error,info}` |
| Lines | `--color-border-{primary,secondary,control,control-hover,focus}`, and `-{success,warning,error,info}` |
| The brand action | `--color-primary`, `-hover`, `-active`, `-surface`, `-surface-hover`, `-surface-active` |

Everything else:

| Need | Family |
| --- | --- |
| Space | `--space-{4xs…3xl}`, pair steps `--space-{s-m,l-xl,…}` for fluid container padding · `--spacing-*` |
| Type | `--type-styles-<role>-{font-family,font-size,font-weight,line-height,letter-spacing}` |
| Loose type values | `--font-size-{xs…5xl}`, `--font-weight-{extralight…extrabold}`, `--font-line-height-*`, `--font-family-{sans,serif,mono,pixel,hybrid}` |
| Corners | `--radius-{none,1…6,full}` · Borders `--border-width-{0,1,2,4}` |
| Elevation | `--shadow-{1…6}` |
| Control heights | `--size-sm` `--size-md` `--size-lg` (fluid steps) · `--size-target` (24px, the minimum hit area) · `--size-icon` (16px) |
| Layout widths | `--size-measure` (42rem) `--size-content` (72rem) — through `Center`'s `max` |
| Motion | `--duration-{fast,base,slow}`, `--easing-ease-{in,out,in-out}`, `--delay-{none,short,medium,long}`, `--transition-*` |
| Stacking | `--z-index-{dropdown,sticky,fixed,modal-backdrop,modal,popover,tooltip}` |
| Other | `--opacity-{0…100}`, `--cursor-*`, `--breakpoint-{xs…2xl}` |

**Dark theme is the argument for all of this.** The theme switches on
`[data-theme="dark"]`, and it switches by redefining these names. A hardcoded
`#f3f2f2` is not a style preference — it is a value that will stay light when
everything around it goes dark. Same for a base-tier primitive: `--color-neutral-100`
is a specific light grey in both themes, which is why the common tier exists.

Never invent a token name. The set is generated — `npm run tokens:build` in the
Archer repo emits it — so a plausible-looking name that was never generated
resolves to nothing and fails silently.

## Control heights come from the size scale

Archer pins control height to `--size-*` rather than growing it out of padding,
because labels are cap-height trimmed and a trimmed box is shorter than its
leading. A control you build to sit beside Archer's should take the same
height from the same three fluid steps:

- `--size-md` (31.5→36px) — the default. Buttons, toggles, tabs, popup list
  items, and every form field: `Input`, the `Select` trigger, `Combobox`,
  `Autocomplete`, `NumberField`.
- `--size-sm` (24.5→28px) — small buttons.
- `--size-lg` (42→48px) — large buttons, the accordion trigger.

`--size-target` (24px, fixed) is not a step: it is the WCAG 2.5.8 floor for a
hit area, used as a `min-block-size`/`min-inline-size` on small interactive
parts like a checkbox row or a slider thumb. `--size-icon` is the icon slot
inside a control.

## State comes from data attributes

Base UI publishes state as `[data-*]` attributes — `[data-checked]`,
`[data-disabled]`, `[data-open]`, `[data-highlighted]` — and Archer styles
against those, not against `:checked`/`:disabled`. Styling your own wrapper
around an Archer part, use the same attributes: they are the ones that exist on
every part, including the ones with no native element underneath.

Hover and focus are different jobs and must not be mixed. Hover changes a
surface: background, text colour, border colour, elevation. Keyboard focus is
the focus ring and nothing else — never a border or a box-shadow dressed up as
a ring, and never a hover property inside a focus rule.

## The escape hatch

The keyword here is `archer-allow`:

```css
/* archer-allow tokens/hardcoded-value -- 1px hairline; the space scale starts above it */
.thing { padding: 1px; }
```

`archer-disable` and `ds-disable` are blanket forms and are themselves blocking
findings.
