# WPDS composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the rules for
registering well. This file is the WPDS registry's own content: which shape to
reach for, and what already ships.

The registry is `patterns/index.json`, beside this file. It realizes the
abstract pattern language in the repo's top-level `patterns/index.json`: every
entry here is keyed by a user need (`confirm`, `choose.segmented`,
`navigate-hierarchy#descend`), never by a component name. The component
currency registry is `components/index.json`; check a candidate's `status`
there before treating "it exists" as "use it".

## Choosing a shape

Read this before writing the JSX, because the wrong choice is made in the
moment of reaching for a control, not afterwards. The reflex the WordPress site
editor encodes: **if a value has a visual identity, render it — do not name it.**
A palette is five swatches, a typeface is the word set in that face, a style
variation is the variation. A dropdown listing their names is a description of
the choice rather than the choice itself. In the registry that is one force,
`representation: rendered`, not a pattern of its own.

The second reflex: **depth beats breadth.** Twelve settings on one screen is a
wall; twelve settings behind four rows that each open a screen is a menu. The
site editor is drilldowns almost all the way down, and every leaf screen shows
only the controls that are actually set.

Two rows below carry most of the drift. `choose.segmented` because
`SelectControl` is the reflex for any set of options, and a dropdown for four
icons costs a click and a popover to say what four icons say at rest.
`field-group.progressive` because every optional setting rendered
unconditionally is a control the reader has to rule out.

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

### About to build

| About to build | Reach for | Not this |
| --- | --- | --- |
| All options visible on one row, the active one marked; re-selecting the active one clears it when 'no opinion' is a valid state. | `choose.segmented` → `ToggleGroupControl` (`@wordpress/components`) | A SelectControl with two to five options; A RadioControl for a set that fits on one row; A row of Buttons with isPressed and hand-managed exclusivity |
| All options visible as a labelled vertical list. | `choose.radio` → `RadioControl` (`@wordpress/components`) (unverified) |  |
| The current value is the trigger; the set opens on demand. | `choose.select` → `SelectControl` (`@wordpress/ui`) |  |
| Typed filtering over the set; may accept values the set lacks. | `choose.combobox` → `ComboboxControl` (`@wordpress/components`) (unverified) |  |
| Chosen options shown as removable tokens; unchosen ones found by typing. | `choose.token-list` → `FormTokenField` (`@wordpress/components`) (unverified) |  |
| The option is its rendering — a swatch, a word set in its face, a live preview — laid out as a grid of tiles with the active one marked; the name is secondary, in a tooltip or caption. | `choose.rendered` → `Variation` (`@wordpress/global-styles-ui`) | A SelectControl of variation names; A RadioControl list of theme or preset names; Static thumbnails that are not the thing they preview |
| A CSS length: a unit-aware input and a slider under one label, the slider's range derived from the unit. | `enter-value.length` — not shipped; extract the project's own | A bare RangeControl with the unit implied; A TextControl holding a CSS length as free text; A SelectControl of fixed sizes where the value is continuous |
| The current color shown as itself; the editor opens on demand; reset appears only while a local value is set. | `enter-value.color` → `Dropdown` (`@wordpress/components`) | A ColorPicker rendered inline for every color slot; A SelectControl of palette slug names; A reset button that is always visible whether or not anything is set |
| One on/off. | `enter-value.toggle` → `ToggleControl` (`@wordpress/components`) (unverified) |  |
| Pick or upload; the current asset shown as itself. | `enter-value.media` — not shipped; extract the project's own |  |
| A control needs a label the accessibility tree can find, a description, and somewhere for its validation message. | `field` → `Field` (`@wordpress/ui`) | Label, control and help rebuilt per field with a hand-built Stack — Field.Root already handles the layout, association and a11y; Fieldset.Root for a group of controls sharing one legend, instead of Field.Root per control |
| Only fields that hold a value, or are shown by default, render; each has its own reset and the group has reset-all. | `field-group.progressive` → `ToolsPanel` (`@wordpress/components`) | A PanelBody rendering all twelve possible controls at once; A stack of controls with no per-control reset; A hand-rolled 'Show advanced' toggle hiding half of them |
| A heading that opens to its fields; closed by default when the group is auxiliary. | `field-group.collapsible` → `PanelBody` (`@wordpress/components`) (unverified) |  |
| A legend and its fields, all shown. | `field-group.fieldset` → `Fieldset` (`@wordpress/ui`) |  |
| Fields declared as data and rendered by the system's form renderer against the record store: no local state, no save button, undo for free. | `edit-record.data-form` → `DataForm` (`@wordpress/dataviews`) | A stack of TextControls with a useState per field and a hand-written onChange each; Media pickers wired up individually instead of a field of type 'media'; A submit button doing what editEntityRecord already does per keystroke |
| A modal with the fields and a submit/cancel cluster in the standard place. | `edit-record.dialog` — not shipped; extract the project's own | Modal with an inline form and per-instance submit placement |
| A side surface for a multi-section edit that keeps the subject visible. | `edit-record.drawer` — not shipped; extract the project's own |  |
| A persistent aside that edits whatever is selected in the main region, with its own header and scroll area. | `edit-record.inspector` — not shipped; extract the project's own | One-off panel layouts with bespoke headers |
| The author arranges the things and draws the connections: positions are theirs and are kept, and the layout only re-runs when asked for. | `edit-graph.canvas` — not shipped; extract the project's own | A flow editor whose layout re-runs on every edit, so an arrangement the author made is gone by the next keystroke; Endpoints that can be grabbed and dropped and silently spring back, because nothing asked the model whether the move was allowed |
| Two or three visible actions, consistently ordered, gap-spaced, primary last. | `action-cluster.bar` — not shipped; extract the project's own | div.actions with hand-set margins; Buttons spaced with margin-right |
| Grouped commands with one tab stop and arrow-key movement between them. | `action-cluster.toolbar` → `Toolbar` (`@wordpress/components`) (unverified) | A Stack of Buttons with a Divider between the groups — it looks the same and has no roving focus, so every control is a tab stop |
| Secondary and destructive commands behind one icon-triggered menu. | `action-cluster.overflow` → `Menu` (`@wordpress/ui`) | Rename and Delete rendered as two secondary Buttons in a header; A destructive Button sitting in the primary action row |
| An action cannot be undone and the user must consent to it knowingly. | `confirm` → `ConfirmDialog` (`@wordpress/components`) | A hand-built Modal + Stack + Button pair reimplementing confirm/cancel — ConfirmDialog already does this, controlled or uncontrolled; window.confirm() |
| Content is nested deeper than one level, and showing it all at once makes a wall. | `navigate-hierarchy` → `Navigator` (`@wordpress/components`) | Tabs standing in for hierarchy — tabs are for siblings, not for parent and child; One long scrolling panel holding every control for every level; A SelectControl that swaps which panel is rendered; A column of Buttons standing in for navigation; Anchors styled to look like list rows; A bare heading plus a Button with an arrow icon, rebuilt per sub-screen; A breadcrumb trail inside a panel that is already one screen deep |
| One route per screen, declared flat. | `navigate-hierarchy#stack` → `Navigator` (`@wordpress/components`) |  |
| A row that names the sub-screen and opens it: one control, one tab stop, one accessible name. | `navigate-hierarchy#descend` → `Navigator.Button` (`@wordpress/components`) |  |
| Back, title, optional description, state controls on the right. | `navigate-hierarchy#sub-screen-header` — not shipped; extract the project's own |  |
| A tab list and one panel per tab, sharing whatever surrounds them. | `switch-view.tabs` → `Tabs` (`@wordpress/ui`) | A SelectControl that swaps its body; Several Modals for what is one task with several sources |
| The system's data view: fields declared as data; sorting, filtering and pagination owned by the view. | `browse-collection.list` → `DataViews` (`@wordpress/dataviews`) |  |
| Search, one choose per filter dimension, bulk actions — one row above the items. | `browse-collection.list#toolbar` — not shipped; extract the project's own | Custom filter/search/action clusters per list |
| Search, one choose per filter dimension, bulk actions — one row above the items. | `browse-collection.list#toolbar.filter` → `Menu.RadioItem` (`@wordpress/ui`) | A SelectControl sitting beside the search field; A row of filter chips built from Buttons with isPressed |
| A listbox where one item is selected and the selection drives a preview elsewhere; one tab stop for the list, arrows within it. | `browse-collection.selectable-list` → `Composite` (`@wordpress/components`) | A stack of Buttons with aria-selected managed by hand; A RadioControl standing in for a list of records; A DataViews table whose only action is 'select' |
| Grouped, live-rendered items as the reference — not screenshots, not names — with real group semantics; previews are inert. | `browse-collection.gallery` → `Composite` (`@wordpress/components`) | A grid of static images standing in for live output; A list of names with the rendering left to the reader's imagination; Sections built from headings with no grouping semantics |
| Items sectioned by an attribute that decides what may be done to them, each section with its own add and overflow, each row descending to its own editor. | `browse-collection.grouped-list` — not shipped; extract the project's own | An editable table of presets with inline delete buttons; A repeater of TextControl + NumberControl rows; One flat list that hides which origin a preset came from |
| Why the region is empty and the action that fills it, centred in the space the content would occupy. | `report.empty` → `EmptyState` (`@wordpress/ui`) | A centred div (or hand-built Stack + Text + Button) with a paragraph and a button |
| Persistent and region-level, stacked by one container that owns order, spacing and dismissal. | `report.notice` → `NoticeList` (`@wordpress/components`) | Individually placed Notice components with local margins — NoticeList already takes notices + onRemove |
| Transient, raised from anywhere, queued and dismissed by a manager the app mounts once; carries undo when the action was reversible. | `report.toast` → `SnackbarList` (`@wordpress/components`) (unverified) | A hand-managed array of messages in component state, rendered into a fixed-position Stack; A confirm dialog on a reversible action |
| A placeholder shaped like the content, or a spinner when the shape is unknown. | `report.loading` → `Spinner` (`@wordpress/ui`) |  |
| A bounded surface with an optional header, title and actions. | `group.card` → `Card` (`@wordpress/ui`) | A styled div with a border/shadow rebuilt per surface |
| A heading and its content, rhythm from the parent, no box. | `group.section` — not shipped; extract the project's own |  |
| A root screen: header, main, optional aside. | `screen.page` → `Page` (`@wordpress/admin-ui`) |  |
| Title, optional breadcrumbs or icon, optional description, trailing actions. | `screen.page#header` → `Page` (`@wordpress/admin-ui`) | An ad-hoc row Stack + heading Text + buttons rebuilt per screen |
| A root screen: header, main, optional aside. | `screen.page#aside` — not shipped; extract the project's own |  |
| A screen hosted in a modal or drawer: the container supplies header and footer, the body may be a switch-view. | `screen.overlay` — not shipped; extract the project's own |  |
| A screen below the root of a hierarchy; its header is navigate-hierarchy#sub-screen-header. | `screen.sub-screen` — not shipped; extract the project's own |  |

### Containers

A pattern declares where it happens; the profile picks the container.

| Container | For | Here |
| --- | --- | --- |
| modal | Blocks the parent view until dismissed. For a focused, single-decision task the user can scan without scrolling, reachable from more than one entry point. | `Modal` (`@wordpress/components`) — Dialog (@wordpress/ui) is the eventual replacement; experimental per components/index.json — stay on Modal until that clears. |
| drawer | Slides over the parent view and keeps it visible. For editing something already on screen, or a multi-section task a modal would cramp. | `Drawer` (`@wordpress/ui`) — Experimental. Realize drawer-shaped tasks as Modal until it clears; declare the pattern as edit-record.drawer anyway so the migration is a find-and-replace later. |
| popover | Anchored to its trigger, non-modal, small. For a control that expands in place. | `Dropdown` (`@wordpress/components`) — Dropdown when the popover holds a control (a color editor); Popover for bare anchored content. Popover in @wordpress/ui is experimental. |
| menu | A popover of items: commands, destinations, or settings scoped to the thing the trigger sits on. | `Menu` (`@wordpress/ui`) — Menu in @wordpress/components is locked (system/locked-component). Outside Gutenberg core the shape is the same and the import is @wordpress/ui. |

### Checked by rule

Below the four-node floor the engine runs `few-static-options`, `confirm-pair`, `judge`.
Specified but not shipped: `button-that-navigates`, `unconditional-optional-controls`, `hand-managed-selection`.

No wpds realization yet: `choose.checklist`, `enter-value.text`, `enter-value.number`, `enter-value.date`, `enter-value.rich-text`, `edit-record.form-screen`, `edit-graph.auto-layout`, `report.inline`. Building one of these is registering one, not inventing a pattern.

<!-- /generated:patterns -->

## Check the component registry second

Before assembling anything from primitives, check whether the shape you're
about to hand-roll (an empty state, a form field, a card) already ships as a
single real compound component (`EmptyState.*`, `Field.*`, `Card.*`) — and
check its `status`, not just that it exists. `report.empty` and `field` turned
out to be this case (both `recommended`); `confirm` and `report.notice` do too,
in the other direction — `@wordpress/ui` ships newer `AlertDialog`/`Notice`
compounds that *look* like the obvious replacement, but the registry marks both
`experimental`, so the pattern correctly stays on `ConfirmDialog`/`NoticeList`
(`@wordpress/components`) until that clears. Existence alone is not the
signal — current status is.

A compound component's sub-parts (`Card.Root`, `Card.Header`,
`EmptyState.Title`, `Field.Control`, …) are distinct signature nodes even
though only the root name is ever imported — write the full dotted name.

An alternation is usually needed on WPDS layout nodes, because one shape has
more than one spelling: `Stack|VStack|HStack|Flex`. Measured on 2110 Gutenberg
files, `edit-record.dialog` written with `Stack` alone missed nine real modals
built with `VStack`/`Flex`.

## Entries without a canonical

Some compositions are genuinely project-specific — the shape varies per
codebase, and a canonical file invented here would be wrong everywhere. The
table marks them "not shipped; extract the project's own". Fill
`canonical`/`import` in from the project's real implementation the first time
you build one; the engine then stops reporting files that import it and names
it as the remedy.
