# VIP composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the four-node
floor. This file is the VIP registry's own content.

The registry is `patterns/index.json`, beside this file. It realizes the
abstract pattern language in the repo's top-level `patterns/index.json`: every
entry is keyed by a user need (`confirm`, `disclose.accordion`,
`browse-collection#items`), never by a component name, and the tables below are
generated from the two. It was seeded from composites that already recur in a
real VIP Design System codebase, so it is short on purpose: an entry here is a
shape that already recurs, not a guess at one that might.

## Anatomy entries

`browse-collection#items` (`Table`), `action-cluster.overflow` (`Dropdown`),
`disclose.accordion` (`Accordion`), `switch-view.tabs` (`Tabs`).

These record structure the library requires — a `Table` is rows of cells in
every file that has one — so it is not reported as an unregistered composite.
Each carries `canonical` set to its root import and never produces a finding.
`browse-collection#items` also covers a row component that renders
`TableRow(TableCell, …)` without importing `Table` itself: `TableRow` is read as
a part of `Table` by its name.

`NewDialog.Root` and `Drawer` have no anatomy entry. Their regions — `trigger`,
`title`, `description`, `content` — are props, and a signature is built from JSX
children only, so there is no fixed shape to absorb.

If you use a VIP component whose anatomy runs to four nodes or more and the
composite rule reports it, add its entry here, keyed by the pattern it
realizes, with `canonical` set to the root import. Registering it without a
`canonical` turns the finding into `patterns/duplicate-composite`, which asks
for an extraction that must not happen.

## Judgement entries

`report.loading` is the busy button, and the only entry with an
`instead_of_signature`. It is written as the action row it usually sits in —
`Flex(Button, Button(Spinner))` — because `Button(Spinner)` alone is under the
four-node floor. A spinner inside a lone button is the same mistake and will not
be reported; catch it on sight. The answer is `<Button loading>`, or
`ButtonSubmit`, and it has no `canonical` because every file that builds the
anti-shape already imports `Button`, which would read as deliberate.

`confirm` keeps its anti-shape as prose: `NewDialog.Root` takes its content as
a prop, so the two buttons never appear as its JSX children.

Label/value pairs are `DescriptionList`, not a `Grid` of `Text` pairs. The
pattern language has no entry for them, so the table does not say so.

The list under the tables names variants this registry has no entry for, not
components VIP lacks: `Card`, `Notice`, `Spinner`, `Input`, `Toggle` and
`ToggleGroup` all ship. Check `components/index.json` before building one, and
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
| A control needs a label the accessibility tree can find, a description, and somewhere for its validation message. | `field` — not shipped; extract the project's own | Rebuilding the row per form, with the label/toggle/description wiring re-typed each time |
| Two or three visible actions, consistently ordered, gap-spaced, primary last. | `action-cluster.bar` — not shipped; extract the project's own | The second Button carrying sx={{ ml: 2 }} |
| Secondary and destructive commands behind one icon-triggered menu. | `action-cluster.overflow` → `Dropdown` (`@automattic/vip-design-system`) |  |
| An action cannot be undone and the user must consent to it knowingly. | `confirm` → `NewConfirmationDialog` (`@automattic/vip-design-system`) | A NewDialog.Root whose content is a message and a Cancel/Confirm Button pair — NewConfirmationDialog already is that, with the button order and focus handling fixed; ConfirmationDialog, which is deprecated; window.confirm() |
| A row that names the sub-screen and opens it: one control, one tab stop, one accessible name. | `navigate-hierarchy#descend` → `OptionRow` (`@automattic/vip-design-system`) | A Card of Heading + Text + an arrow icon |
| A tab list and one panel per tab, sharing whatever surrounds them. | `switch-view.tabs` → `Tabs` (`@automattic/vip-design-system`) |  |
| Many items of one kind must be found, compared and acted on. | `browse-collection#items` → `Table` (`@automattic/vip-design-system`) |  |
| Several named sections, each heading the trigger for its own panel, opened in place. | `disclose.accordion` → `Accordion` (`@automattic/vip-design-system`) |  |
| Transient, raised from anywhere, queued and dismissed by a manager the app mounts once; carries undo when the action was reversible. | `report.toast` → `Snackbar` (`@automattic/vip-design-system`) | A Notice that removes itself on a timer |
| A placeholder shaped like the content, or a spinner when the shape is unknown. | `report.loading` — not shipped; extract the project's own | A Spinner rendered inside a Button's children while a flag is set — `{ loading && <Spinner size={ 14 } sx={ { mr: 2 } } /> }` |
| Title, optional breadcrumbs or icon, optional description, trailing actions. | `screen#header` → `ServiceHeader` (`@automattic/vip-design-system`) | A Card holding a Heading, a Badge and a Flex of Buttons |

### Containers

A pattern declares where it happens; the profile picks the container.

| Container | For | Here |
| --- | --- | --- |
| modal | Blocks the parent view until dismissed. For a focused, single-decision task the user can scan without scrolling, reachable from more than one entry point. | `NewDialog` (`@automattic/vip-design-system`) — NewDialog.Root takes its trigger, title, description and content as props, so it has no anatomy entry. A destructive confirmation is NewConfirmationDialog — see confirm. |
| drawer | Slides over the parent view and keeps it visible. For editing something already on screen, or a multi-section task a modal would cramp. | `Drawer` (`@automattic/vip-design-system`) — Its regions are props too, so it has no anatomy entry. |
| menu | A popover of items: commands, destinations, or settings scoped to the thing the trigger sits on. | `Dropdown` (`@automattic/vip-design-system`) — Its anatomy is action-cluster.overflow. |

No vip realization yet: `choose.segmented`, `choose.radio`, `choose.select`, `choose.combobox`, `choose.autocomplete`, `choose.rendered`, `choose.checklist`, `choose.token-list`, `enter-value.text`, `enter-value.number`, `enter-value.length`, `enter-value.color`, `enter-value.toggle`, `enter-value.media`, `enter-value.date`, `enter-value.rich-text`, `field-group.fieldset`, `field-group.collapsible`, `field-group.progressive`, `edit-record.data-form`, `edit-record.dialog`, `edit-record.drawer`, `edit-record.inspector`, `edit-record.form-screen`, `edit-graph.canvas`, `edit-graph.auto-layout`, `action-cluster.toolbar`, `navigate-hierarchy.drilldown`, `navigate-sections.list`, `navigate-sections.panels`, `browse-collection.list`, `browse-collection.selectable-list`, `browse-collection.gallery`, `browse-collection.grouped-list`, `disclose.collapsible`, `disclose.anchored`, `report.notice`, `report.inline`, `report.empty`, `group.card`, `group.section`, `group.list`, `screen.page`, `screen.sub-screen`, `screen.overlay`. Building one of these is registering one, not inventing a pattern.

<!-- /generated:patterns -->

## Not shipped — extract when you build it

`field` is a `Label` and a `Toggle` on one row, with help text under them,
wired by `htmlFor` / `id` / `aria-describedby`. Projects build it by hand, once
per form. It has no `canonical` because the package does not ship it —
`ToggleRow` looks close but is a list row with a `Heading` title, an image and a
badge, and no `<label>` association, so it is not a drop-in.

The next project to touch a file that builds it extracts the row once, and fills
in `import` and `canonical` in the entry, so the next agent reading the registry
is pointed at the shared implementation instead of writing another copy.
