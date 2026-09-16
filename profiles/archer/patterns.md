# Archer composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the four-node
floor. This file is the Archer registry's own content.

The registry is `patterns/index.json`, beside this file. It holds two kinds of
entry, and the difference matters more here than in most systems.

## Anatomy entries

Archer inherits Base UI's anatomy: a Dialog is a root, a trigger, a popup and a
title, in every file that has one. That repetition is the library working
correctly, not house style nobody wrote down — so each of those shapes is
registered with `canonical` set to its root import, and a file that actually
uses the component is skipped before either composite rule sees it. They exist
to keep `patterns/unregistered-composite` quiet about required structure, and
they never produce a finding of their own.

`dialog-anatomy`, `alert-dialog-anatomy`, `drawer-anatomy`, `popover-anatomy`,
`menu-anatomy`, `select-anatomy`, `combobox-anatomy`, `autocomplete-anatomy`,
`tabs-anatomy`, `accordion-anatomy`, `navigation-menu-anatomy`,
`breadcrumb-anatomy`, `table-anatomy`, `list-anatomy`, `toggle-group-anatomy`,
`radio-group-anatomy`.

If you add a component to Archer whose anatomy runs to four nodes or more, add
its entry here at the same time. Skipping it means the third consumer to use
the component gets told their correct code is an unregistered composite.

`AppShell` and `PageHeader` have no anatomy entry, and that is not an
oversight. Their regions are props — `brand`, `nav`, `actions`, `breadcrumb` —
and a signature is built from JSX children only, so what a file nests inside
them is the page, not their structure. There is nothing fixed to absorb.

## Judgement entries

These are the shapes with a right and a wrong form.

| About to build | Reach for | Not this |
| --- | --- | --- |
| A destructive confirmation | `AlertDialog` | `Dialog` with a title, a description and a Cancel/Confirm pair — or `window.confirm()` |
| A labelled input with description and error | `Field` | A `Stack` holding a `<label>` above an `Input`, error conditionally rendered beside it |
| An action bar with groups, or more than ~4 controls | `Toolbar` | A `Stack` of `Button`s with a `Separator` between the groups |
| Any control inside a `Toolbar` | `ToolbarButton`, `ToolbarLink`, `ToolbarInput` | A plain `Button` — it drops out of the roving-focus order |
| Two or three actions together | `Stack` with a `gap`, primary last | A `div` with hand-set margins between the buttons |
| Transient result messages | `useToastManager()` under one `ToastProvider` | An array of messages in component state, rendered into a fixed `Stack` |
| Secondary actions on a thing | `Menu` | Three secondary `Button`s competing with the one that matters |
| Peer views of one subject | `Tabs` | Tabs standing in for hierarchy — depth wants navigation |
| One expandable region | `Collapsible` | An `Accordion` holding a single section |
| The top of a screen or pane | `PageHeader` | A `Stack` holding a `Heading`, a `Text` and a `Stack` of `Button`s, rebuilt per screen |
| What an empty collection shows | `Empty` | A bare "No results" string, or a spinner that never resolves |
| Tabular data | `Table` | A `Grid` or a `Stack` of rows — it looks the same and is not navigable cell by cell |

Only `toolbar` carries an `instead_of_signature` — `Stack(Button, Button,
Separator, Button)` is unambiguous, and that is rare. `alert-dialog-anatomy`'s
anti-shape is deliberately prose: a form dialog also has a title, a description
and two buttons, and containment matching cannot tell the two apart. Decide
that one when you reach for the component, not from a finding.

`page-header` keeps its anti-shape as prose too: a `Card` or a `Dialog` also
holds a `Heading` beside a `Stack` of `Button`s.

## Shipped as components

`page-header` and `empty-state` began as unshipped entries and are now
components, so both carry `import` and `canonical`. `PageHeader` sets its title
as a `Heading` with `variant="ui"` and takes the breadcrumb, description and
actions as props, so every screen gets the same heading level, spacing and
action placement. `Empty` takes `title`, `description` and `icon`, with the way
out as its children.

## Not shipped — extract when you build it

Archer has no detail sidebar or settings drilldown. Those two are registered
without a `canonical` on purpose: the first project that needs one builds it,
and the second one imports it rather than rebuilding it. Fill in `import` and
`canonical` at that point, so the next agent reading the registry is pointed at
the shared implementation instead of rebuilding it.

For `settings-drilldown`, the reflex is worth stating outright: **depth beats
breadth.** Twelve settings on one screen is a wall; twelve settings behind four
rows that each open a screen is a menu, and each leaf screen shows only what is
actually set.
