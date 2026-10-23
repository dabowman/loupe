# Archer composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the four-node
floor. This file is the Archer registry's own content.

The registry is `patterns/index.json`, beside this file. It realizes the
abstract pattern language in the repo's top-level `patterns/index.json`: every
entry is keyed by a user need (`confirm`, `choose.segmented`, `screen#header`),
never by a component name, and the tables below are generated from the two. It
holds two kinds of entry, and the difference matters more here than in most
systems.

## Anatomy entries

Archer inherits Base UI's anatomy: a Dialog is a root, a trigger, a popup and a
title, in every file that has one. That repetition is the library working
correctly, not house style nobody wrote down — so each of those shapes is
registered under the pattern its component realizes, with `canonical` set to
the root import, and a file that actually uses the component is skipped before
either composite rule sees it. They exist to keep
`patterns/unregistered-composite` quiet about required structure, and they
never produce a finding of their own.

Most rows below are anatomy entries: `ToggleGroup`, `RadioGroup`, `Select`,
`Combobox` and `Autocomplete` (`choose.*`), `Field`, `Drawer`
(`edit-record.drawer`), `Toolbar`, `Menu` (`action-cluster.overflow`),
`AlertDialog` (`confirm`), `Tabs`, `NavigationMenu` (`navigate-sections`),
`Table` (`browse-collection#items`), `Accordion` and `Popover` (`disclose.*`),
`List` (`group.list`), `Breadcrumb` (`screen#header.breadcrumb`) and `Dialog`
(`screen.overlay`). `Dialog` is the modal container, not a shipped form
dialog, which is why `edit-record.dialog` stays a gap.

If you add a component to Archer whose anatomy runs to four nodes or more, add
its entry here at the same time, keyed by the pattern it realizes. Skipping it
means the third consumer to use the component gets told their correct code is
an unregistered composite.

`AppShell` and `PageHeader` have no anatomy entry, and that is not an
oversight. Their regions are props — `brand`, `nav`, `actions`, `breadcrumb` —
and a signature is built from JSX children only, so what a file nests inside
them is the page, not their structure. There is nothing fixed to absorb.

## Judgement entries

These are the shapes with a right and a wrong form, and the "Not this" column
is the wrong one. Several anatomy entries are judgement entries too.

Only `action-cluster.toolbar` carries an `instead_of_signature` —
`Stack(Button, Button, Separator, Button)` is unambiguous, and that is rare. A
plain `Button` inside a `Toolbar` is the same defect one level down: it drops
out of the roving-focus order, so use `ToolbarButton`, `ToolbarLink` or
`ToolbarInput`.

`confirm`'s anti-shape is deliberately prose: a form dialog also has a title, a
description and two buttons, and containment matching cannot tell the two
apart. Decide that one when you reach for the component, not from a finding.
`screen#header` keeps its anti-shape as prose too: a `Card` or a `Dialog` also
holds a `Heading` beside a `Stack` of `Button`s.

The list under the tables names variants this registry has no entry for, not
components Archer lacks: `Card`, `Alert`, `Spinner`, `Input`, `Switch` and
`Fieldset` all ship. Check `components/index.json` before building one, and
registering it here is adding its row.

<!-- generated:patterns -->

_Generated from `patterns/index.json` and the abstract language by `engine/scripts/patterns-doc.ts`. Edit those, then run `npm run patterns-doc` in `engine/`._

### Before choosing a shape

Most bad choices are the wrong pattern, not the wrong variant. Each row is a force to settle first.

| Building | If | Go to | Because |
| --- | --- | --- | --- |
| `choose` (choose) | represents = command | `action-cluster.overflow` | A list of things to do is a menu, not a choice of value. |
| `choose` (choose) | represents = destination | `navigate-hierarchy#descend` | A list of places to go is navigation. |
| `enter-value` (enter) | set = closed | `choose` | A value from a fixed set is a choice. |
| `edit-graph` (enter) | structure = fields | `edit-record` | One thing's own fields are a form, however the region draws them. |
| `action-cluster` (act) | represents = destination | `navigate-hierarchy` | Something that navigates is a link, however it is styled. |
| `confirm` (confirm) | reversibility = reversible | `report.toast` | Reversible actions get an undo, not a question. A confirm on a reversible action trains the user to click through it. |
| `navigate-hierarchy` (navigate) | relation = siblings | `switch-view` | Tabs are for peers; depth wants navigation. |
| `switch-view` (navigate) | relation = parent-child | `navigate-hierarchy` | Levels are not peers. |
| `browse-collection` (view) | representation = rendered, selection = one | `choose.rendered` | A grid of previews where one is picked is a choice, not a browse. |
| `disclose` (view) | context = own-screen | `navigate-hierarchy` | Content big enough for a screen of its own is a level to descend to, not a panel to unfold. |

### About to build

| About to build | Reach for | Not this |
| --- | --- | --- |
| All options visible on one row, the active one marked; re-selecting the active one clears it when 'no opinion' is a valid state. | `choose.segmented` → `ToggleGroup` (`@dabowman/archer`) |  |
| All options visible as a labelled vertical list. | `choose.radio` → `RadioGroup` (`@dabowman/archer`) |  |
| The current value is the trigger; the set opens on demand. | `choose.select` → `Select` (`@dabowman/archer`) |  |
| Typed filtering over a long set; the value is one of its options. | `choose.combobox` → `Combobox` (`@dabowman/archer`) |  |
| A text input that suggests known values as the user types; what was typed stands even when nothing matches. | `choose.autocomplete` → `Autocomplete` (`@dabowman/archer`) |  |
| A control needs a label the accessibility tree can find, a description, and somewhere for its validation message. | `field` → `Field` (`@dabowman/archer`) | A Stack holding a <label> above an Input, with the error message conditionally rendered beside it — Field owns the association, the aria wiring and the rhythm; A placeholder standing in for a label |
| A side surface for a multi-section edit that keeps the subject visible. | `edit-record.drawer` → `Drawer` (`@dabowman/archer`) |  |
| A persistent aside that edits whatever is selected in the main region, with its own header and scroll area. | `edit-record.inspector` — not shipped; extract the project's own | One-off panel layouts, each with its own width, padding and section rhythm |
| Two or three visible actions, consistently ordered, gap-spaced, primary last. | `action-cluster.bar` — not shipped; extract the project's own | A div with hand-set margins between the buttons; Buttons spaced with margin-right |
| Grouped commands with one tab stop and arrow-key movement between them. | `action-cluster.toolbar` → `Toolbar` (`@dabowman/archer`) | A Stack of Buttons with a Separator between the groups — it looks the same and has no roving focus, so every control is a tab stop |
| Secondary and destructive commands behind one icon-triggered menu. | `action-cluster.overflow` → `Menu` (`@dabowman/archer`) | Three secondary Buttons sitting in the header, competing with the one action that matters |
| An action cannot be undone and the user must consent to it knowingly. | `confirm` → `AlertDialog` (`@dabowman/archer`) | A Dialog with a title, a description and a Cancel/Confirm button pair — AlertDialog already is that, with the dismissal behaviour and button emphasis a destructive action needs; window.confirm() |
| Content is nested deeper than one level, and showing it all at once makes a wall. | `navigate-hierarchy` — not shipped; extract the project's own | Tabs standing in for hierarchy; One long panel showing every control at once; A Select that swaps the pane beneath it |
| A tab list and one panel per tab, sharing whatever surrounds them. | `switch-view.tabs` → `Tabs` (`@dabowman/archer`) | Tabs standing in for hierarchy — peers belong in tabs, depth belongs in navigation |
| The user moves between the top-level sections of an app or site from anywhere in it, and must be able to tell which section they are in. | `navigate-sections` → `NavigationMenu` (`@dabowman/archer`) |  |
| Many items of one kind must be found, compared and acted on. | `browse-collection#items` → `Table` (`@dabowman/archer`) | A Grid or a Stack of rows standing in for a table — it looks the same and is not navigable cell by cell |
| One panel shown and hidden in place by the control that names it; what follows moves to make room. | `disclose.collapsible` → `Collapsible` (`@dabowman/archer`) | An Accordion holding a single section |
| Several named sections, each heading the trigger for its own panel, opened in place. | `disclose.accordion` → `Accordion` (`@dabowman/archer`) | An Accordion holding a single section — that is Collapsible |
| The panel opens over the view, anchored to its trigger and non-modal; moving on closes it. | `disclose.anchored` → `Popover` (`@dabowman/archer`) |  |
| Why the region is empty and the action that fills it, centred in the space the content would occupy. | `report.empty` → `Empty` (`@dabowman/archer`) | A bare 'No results' string where the rows would be; A spinner that never resolves because there is nothing to load |
| Transient, raised from anywhere, queued and dismissed by a manager the app mounts once; carries undo when the action was reversible. | `report.toast` → `useToastManager` (`@dabowman/archer`) | A hand-managed array of messages in component state, rendered into a fixed-position Stack — the manager already owns queueing, timing, focus and dismissal; An inline error rendered where the button was |
| Like items in a run, bulleted, or numbered when their order means something; the list spaces them, not each item. | `group.list` → `List` (`@dabowman/archer`) |  |
| Title, optional breadcrumbs or icon, optional description, trailing actions. | `screen#header` → `PageHeader` (`@dabowman/archer`) | An ad-hoc row rebuilt per screen — a Stack holding a Heading, a Text and a Stack of Buttons — each with its own heading level and spacing |
| Title, optional breadcrumbs or icon, optional description, trailing actions. | `screen#header.breadcrumb` → `Breadcrumb` (`@dabowman/archer`) |  |
| A screen hosted in a modal or drawer: the container supplies header and footer, the body may be a switch-view. | `screen.overlay` → `Dialog` (`@dabowman/archer`) |  |

### Containers

A pattern declares where it happens; the profile picks the container.

| Container | For | Here |
| --- | --- | --- |
| modal | Blocks the parent view until dismissed. For a focused, single-decision task the user can scan without scrolling, reachable from more than one entry point. | `Dialog` (`@dabowman/archer`) — Its anatomy is screen.overlay. A destructive confirmation is AlertDialog — see confirm. |
| drawer | Slides over the parent view and keeps it visible. For editing something already on screen, or a multi-section task a modal would cramp. | `Drawer` (`@dabowman/archer`) — Its anatomy is edit-record.drawer. |
| popover | Anchored to its trigger, non-modal, small. For a control that expands in place. | `Popover` (`@dabowman/archer`) — Its anatomy is disclose.anchored. |
| menu | A popover of items: commands, destinations, or settings scoped to the thing the trigger sits on. | `Menu` (`@dabowman/archer`) — Commands, navigation destinations and in-menu settings. Its anatomy is action-cluster.overflow. |

No archer realization yet: `choose.rendered`, `choose.checklist`, `choose.token-list`, `enter-value.text`, `enter-value.number`, `enter-value.length`, `enter-value.color`, `enter-value.toggle`, `enter-value.media`, `enter-value.date`, `enter-value.rich-text`, `field-group.fieldset`, `field-group.collapsible`, `field-group.progressive`, `edit-record.data-form`, `edit-record.dialog`, `edit-record.form-screen`, `edit-graph.canvas`, `edit-graph.auto-layout`, `browse-collection.list`, `browse-collection.selectable-list`, `browse-collection.gallery`, `browse-collection.grouped-list`, `report.notice`, `report.inline`, `report.loading`, `group.card`, `group.section`, `screen.page`, `screen.sub-screen`. Building one of these is registering one, not inventing a pattern.

<!-- /generated:patterns -->

## Shipped as components

`screen#header` and `report.empty` began as unshipped entries and are now
components, so both carry `import` and `canonical`. `PageHeader` sets its title
as a `Heading` with `variant="ui"` and takes the breadcrumb, description and
actions as props, so every screen gets the same heading level, spacing and
action placement. `Empty` takes `title`, `description` and `icon`, with the way
out as its children.

## Not shipped — extract when you build it

Archer has no detail sidebar or settings drilldown. `edit-record.inspector` and
`navigate-hierarchy` are registered without a `canonical` on purpose: the first
project that needs one builds it, and the second one imports it rather than
rebuilding it. Fill in `import` and `canonical` at that point, so the next agent
reading the registry is pointed at the shared implementation instead of
rebuilding it.

For `navigate-hierarchy`, the reflex is worth stating outright: **depth beats
breadth.** Twelve settings on one screen is a wall; twelve settings behind four
rows that each open a screen is a menu, and each leaf screen shows only what is
actually set.
