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
`tabs-anatomy`, `accordion-anatomy`, `navigation-menu-anatomy`.

If you add a component to Archer whose anatomy runs to four nodes or more, add
its entry here at the same time. Skipping it means the third consumer to use
the component gets told their correct code is an unregistered composite.

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

Only `toolbar` carries an `instead_of_signature` — `Stack(Button, Button,
Separator, Button)` is unambiguous, and that is rare. `alert-dialog-anatomy`'s
anti-shape is deliberately prose: a form dialog also has a title, a description
and two buttons, and containment matching cannot tell the two apart. Decide
that one when you reach for the component, not from a finding.

## Not shipped — extract when you build it

Archer has no page header, empty state, detail sidebar or settings drilldown.
Those four are registered without a `canonical` on purpose: the first project
that needs one builds it, and the second one imports it rather than rebuilding
it. Fill in `import` and `canonical` at that point — the engine then stops
reporting the rebuilds and starts naming the answer.

`page-header` in particular is worth watching, because Archer ships no text
component: the heading is a semantic element carrying a `type-style` role, and
without a shared implementation every screen picks its own heading level and
its own spacing.

For `settings-drilldown`, the reflex is worth stating outright: **depth beats
breadth.** Twelve settings on one screen is a wall; twelve settings behind four
rows that each open a screen is a menu, and each leaf screen shows only what is
actually set.
