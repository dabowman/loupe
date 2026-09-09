# WPDS composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the rules for
registering well. This file is the WPDS registry's own content: which shape to
reach for, and what already ships.

The registry is `patterns/index.json`, beside this file. The component currency
registry is `components/index.json`; check a candidate's `status` there before
treating "it exists" as "use it".

## Choosing a shape

Read this before writing the JSX, because the wrong choice is made in the
moment of reaching for a control, not afterwards. The reflex the WordPress site
editor encodes: **if a value has a visual identity, render it — do not name it.**
A palette is five swatches, a typeface is the word set in that face, a style
variation is the variation. A dropdown listing their names is a description of
the choice rather than the choice itself.

The second reflex: **depth beats breadth.** Twelve settings on one screen is a
wall; twelve settings behind four rows that each open a screen is a menu. The
site editor is drilldowns almost all the way down, and every leaf screen shows
only the controls that are actually set.

| About to build | Pattern | Not this |
| --- | --- | --- |
| Settings more than one level deep | `navigator-drilldown` | Tabs standing in for hierarchy; one long panel; a `SelectControl` that swaps panes |
| A row that opens another screen | `drilldown-row` | A column of `Button`s; anchors styled as rows |
| A setting whose value is visible — color, font, shadow | `value-preview-row` | A label beside an always-open picker; a swatch beside an "Edit" button |
| Choosing between things that *look* different | `preview-tile-grid` | A `SelectControl` of variation names; a `RadioControl` of preset names |
| A color or gradient inside a panel | `color-dropdown-item` | A `ColorPicker` rendered inline for every slot |
| A group of optional settings | `tools-panel` | A `PanelBody` showing all twelve at once; a hand-rolled "Advanced" toggle |
| Two to five exclusive options on one row | `segmented-choice` | `SelectControl`; `RadioControl`; `Button`s with `isPressed` |
| A CSS length the user tunes | `size-control` | A bare `RangeControl`; a `TextControl` holding `"16px"` |
| Presets from several origins | `preset-group` | An editable table; a repeater of input rows |
| Rename / Delete / Reset on a thing | `overflow-actions` | Two secondary `Button`s sitting in the header |
| Narrowing a list by one dimension | `filter-menu` | A `SelectControl` beside the search field |
| A list where one item is selected | `selectable-list` | `Button`s with hand-managed `aria-selected` |
| A modal drawing on several sources | `modal-with-tabs` | A `SelectControl` inside the modal that swaps its body |
| A catalog of rendered output | `live-example-gallery` | Static thumbnails; a list of names |
| A form over a WordPress entity | `entity-dataform` | A stack of `TextControl`s with a `useState` and an `onChange` per field |
| The top of a screen or pane | `page-header` (`Page`) | A hand-built title row rebuilt per screen |
| The top of a sub-screen | `screen-header` | A heading plus a `Button` with an arrow icon |

Two of those rows carry most of the drift. `segmented-choice` because
`SelectControl` is the reflex for any set of options, and a dropdown for four
icons costs a click and a popover to say what four icons say at rest.
`tools-panel` because every optional setting rendered unconditionally is a
control the reader has to rule out.

## Check the component registry second

Before assembling anything from primitives, check whether the shape you're
about to hand-roll (an empty state, a form field, a card) already ships as a
single real compound component (`EmptyState.*`, `Field.*`, `Card.*`) — and
check its `status`, not just that it exists. `empty-state` and `form-row`
turned out to be this case (both `recommended`); `confirm-modal` and
`notice-stack` do too, in the other direction — `@wordpress/ui` ships newer
`AlertDialog`/`Notice` compounds that *look* like the obvious replacement, but
the registry marks both `experimental`, so the pattern correctly stays on
`ConfirmDialog`/`NoticeList` (`@wordpress/components`) until that clears.
Existence alone is not the signal — current status is.

A compound component's sub-parts (`Card.Root`, `Card.Header`,
`EmptyState.Title`, `Field.Control`, …) are distinct signature nodes even
though only the root name is ever imported — write the full dotted name.

An alternation is usually needed on WPDS layout nodes, because one shape has
more than one spelling: `Stack|VStack|HStack|Flex`. Measured on 2110 Gutenberg
files, `form-modal` written with `Stack` alone missed nine real modals built
with `VStack`/`Flex`.

## The starting set

Some of these are genuinely project-specific compositions — the shapes vary
per codebase, and a canonical file invented here would be wrong everywhere.
Fill `canonical`/`import` in from the project's real implementation the first
time you build one:

| Pattern | Replaces |
| --- | --- |
| `action-bar` | Bespoke button rows with hand-set spacing and alignment |
| `form-modal` | `Modal` with an inline form and inconsistent submit placement |
| `detail-sidebar` | One-off panel layouts beside a main region |
| `dataviews-toolbar` | Custom filter/search/action clusters above a list |
| `screen-header` | A heading and a back arrow rebuilt on every sub-screen |
| `preview-tile-grid` | A dropdown of names where the options are visibly different |
| `size-control` | A slider with the unit implied, or a text field holding a CSS length |
| `preset-group` | A preset table with inline editing, origin flattened away |

The rest already have `canonical`/`import` filled in, because WPDS ships the
composition — or the component the composition is built around — as something
real. The pattern exists to point at it, not to describe a shape to reassemble.
A file that imports the canonical name stops being reported:

| Pattern | Canonical |
| --- | --- |
| `page-header` | `Page` (`@wordpress/admin-ui`) — title, breadcrumbs, an `actions` slot, `hasPadding` |
| `confirm-modal` | `ConfirmDialog` (`@wordpress/components`) — wraps `Modal` with confirm/cancel already built |
| `notice-stack` | `NoticeList` (`@wordpress/components`) |
| `empty-state` | `EmptyState` (`@wordpress/ui`) — `.Root/.Title/.Description/.Actions` |
| `form-row` | `Field` (`@wordpress/ui`) — `.Root/.Label/.Control/.Description` |
| `card` | `Card` (`@wordpress/ui`) — `.Root/.Header/.Title/.Content` |
| `navigator-drilldown`, `drilldown-row`, `value-preview-row` | `Navigator` (`@wordpress/components`) |
| `tools-panel` | `ToolsPanel` (`@wordpress/components`) |
| `segmented-choice` | `ToggleGroupControl` (`@wordpress/components`) |
| `color-dropdown-item` | `Dropdown` (`@wordpress/components`) |
| `overflow-actions`, `filter-menu` | `Menu` (`@wordpress/components`) |
| `selectable-list`, `live-example-gallery` | `Composite` (`@wordpress/components`) |
| `modal-with-tabs` | `Tabs` (`@wordpress/ui`) |
| `entity-dataform` | `DataForm` (`@wordpress/dataviews`) |
