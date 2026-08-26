---
name: loupe-patterns
description: >-
  Load BEFORE assembling any composite UI out of WordPress Design System components — a page or panel header, an action bar, a confirmation or form modal, a notice or notification stack, a detail sidebar, an empty state, a form row, or a DataViews toolbar. Carries the registry of sanctioned WPDS compositions in `patterns/`: what each one is for, its canonical structure, and the anti-patterns it replaces. Use it to check whether a composite already exists before writing a new one, and to register a new pattern when it genuinely does not. Prevents the failure where an agent assembles a fifth bespoke header, each locally reasonable and collectively unmaintainable. Triggers on "build a header", "add a modal", "confirmation dialog", "action buttons", "notice", "sidebar", "empty state", "toolbar", or any JSX composing two or more `@wordpress/components` into a reusable shape. Pair with `loupe-authoring` for the styling rules.
compatibility: "Targets WPDS on WordPress 6.5+ / 7.0."
---

# WPDS composition patterns

Component-level conformance is the easy half. The expensive drift is
compositional: a codebase ends up with six headers, four modal footers and
three empty states, each individually defensible, collectively a maintenance
tax nobody chose to take on.

It happens because each one is a small local decision made in isolation, and
because assembling components feels like *using* the system rather than
extending it. Check the registry before you assemble.

## How to use this

1. **Look first.** Read `profiles/wpds/patterns/index.json` in this plugin and the project's
   own `patterns/` directory if it has one. If a pattern covers what you need,
   use it — import the shared implementation rather than copying its structure.
2. **Check `profiles/wpds/components/index.json` second.** Before assembling anything from
   primitives, check whether the shape you're about to hand-roll (an empty
   state, a form field, a card) already ships as a single real compound
   component (`EmptyState.*`, `Field.*`, `Card.*`) — and check its `status`,
   not just that it exists. `empty-state` and `form-row` turned out to be this
   case (both `recommended`); `confirm-modal` and `notice-stack` do too, in
   the other direction — `@wordpress/ui` ships newer `AlertDialog`/`Notice`
   compounds that *look* like the obvious replacement, but the registry marks
   both `experimental`, so the pattern correctly stays on
   `ConfirmDialog`/`NoticeList` (`@wordpress/components`) until that clears.
   Existence alone is not the signal — current status is.
3. **Search the codebase third.** If nothing is registered and nothing ships,
   grep for the shape before writing it. Two existing near-copies mean the
   pattern already exists informally and should be extracted, not tripled.
4. **Register fourth.** A genuinely new composite gets an entry, so the next
   session finds it. See [Registering](#registering-a-pattern).

```bash
# What is already sanctioned?
cat "${CLAUDE_PLUGIN_ROOT}/profiles/wpds/patterns/index.json"
```

## The registry

`profiles/wpds/patterns/index.json` holds one entry per sanctioned composite:

```jsonc
{
  "id": "confirm-modal",
  "summary": "Destructive-action confirmation dialog with confirm/cancel actions.",
  "use": "Any irreversible action needing explicit consent.",
  "import": "@wordpress/components",   // where the shared implementation lives
  "canonical": "__experimentalConfirmDialog as ConfirmDialog",
  "signature": ["Modal", "Text", ["Stack", "Button", "Button"]],
  "instead_of": [
    "A hand-built Modal + Stack + Button pair reimplementing confirm/cancel",
    "window.confirm()"
  ]
}
```

`signature` is the normalized component tree. A node is `[name, ...children]`;
each child is either a bare component name or another node. Only design-system
components appear — raw elements between them are transparent, so
`<Stack><div><Button/></div></Stack>` and `<Stack><Button/></Stack>` have the
same signature, which is right, because they are the same composition.
A compound component's sub-parts (`Card.Root`, `Card.Header`, `EmptyState.Title`,
`Field.Control`, …) are distinct nodes even though only the root name is ever
imported — write the full dotted name in the signature.

A node may name alternatives with `|` — `Stack|VStack|HStack|Flex`,
`ToggleGroupControlOption|ToggleGroupControlOptionIcon`. One shape usually has
more than one spelling, and an entry that knows only the newest one reports
every file still writing the old one as an unregistered composite. Measured on
2110 Gutenberg files, `form-modal` written with `Stack` alone missed nine real
modals built with `VStack`/`Flex`.

Matching is **containment, not equality**:

- Extra children are fine. A header with one more button is still that header.
- A registered child may sit anywhere beneath the root, not just as a direct
  sibling. `form-modal` records its footer beside the body; real code nests the
  footer inside the body, and both are the same composition. Demanding the
  recorded shape exactly would mean the rule only ever matched code that had
  already been generated from the pattern — the one case with nothing to report.
- Each registered child claims a distinct node, so `["Stack", "Text", "Text"]`
  needs two `Text`s rather than matching one twice.

**A signature under four nodes is documentation, not a check.** The engine skips
it. `Stack(Button,Button)` is a true description of an action bar and a useless
finding — it matched 48 files in one repo, and "you have 48 action bars" is not a
defect anyone can act on. `action-bar`, `form-row` and `notice-stack` are in the
registry for you to read, not for the engine to enforce.

`canonical` earns its keep the moment you fill it in: a file that imports it is
using the pattern rather than rebuilding it, and stops being reported. Until
then the remedy the engine offers is "extract one shared implementation", because
telling an agent to import something that does not exist sends it hunting for a
module.

Write `canonical` as **the name the code binds**, not the import statement that
produces it: `ConfirmDialog`, not `__experimentalConfirmDialog as ConfirmDialog`;
`EmptyState`, not `EmptyState.Root`. It is matched against a file's local import
names, so anything else silently never matches and the pattern reports every
file that is already using it correctly.

`instead_of_signature` records the shape a pattern *replaces*, in the same
`[name, ...children]` form. It is `instead_of` promoted from prose to a check,
and it obeys the same four-node floor — a one-node anti-shape like a bare
`SelectControl` says nothing about whether the choice it presents wanted a
segmented control, and would fire on half a codebase. Most entries therefore
carry the anti-pattern as prose only, which is why reading this file before
assembling matters more than the check does.

The three rules this drives:

| | |
| --- | --- |
| `patterns/duplicate-composite` | A registered pattern reassembled by hand in two or more files |
| `patterns/superseded-composite` | A shape a pattern exists to replace — reported against the one file that built it, because a wrong choice is a defect where it is made |
| `patterns/unregistered-composite` | The same shape in three or more files, in no registry — two is a coincidence, three is house style |

The engine reads this file when the hooks and commands pass `--patterns`. A
project's own registry is merged over the shipped one, winning on `id`.

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

## Registering a pattern

Add the entry, then keep it honest:

- **`summary` says what it is for**, not what it contains. "Destructive-action
  confirmation" is useful; "Modal with two buttons" is not — the second
  describes a shape anyone could match by accident.
- **`signature` is the structure that matters**, not every node. Four to six
  nodes at depth 2–3 is the useful band. Under four the engine ignores it as too
  generic to check; over-specify and near-identical variants stop matching.
- **`instead_of` names the anti-pattern** you have actually seen in this
  codebase. That is the line that stops the next rebuild.
- **`instead_of_signature` only if the anti-pattern has a shape.** Four nodes
  minimum, same as `signature`. Most do not: the thing agents reach for by
  default is usually one control, and a rule that fires on every `SelectControl`
  is a rule people turn off. Leave it out unless the wrong version is a
  recognisable composite in its own right — `Modal(TextControl,TextControl,TextControl)`
  is; `SelectControl` is not.
- **`import` and `canonical` earn the entry.** A pattern documented but never
  extracted still gets rebuilt. Once two call sites exist, extract it, point
  `import` at the module and `canonical` at the component name — the engine then
  stops reporting files that already use it, and starts naming it as the remedy.

## When a pattern does not fit

Patterns are defaults, not law. A screen with a real reason to diverge should
diverge — and say so in a comment naming the pattern it departs from and why.
That comment is what stops the next session "fixing" it back, and it is also
how you find out a pattern needs a variant.

What is not a reason: the surrounding code already does it this way. Existing
duplication is the problem being solved, not evidence for its own correctness.

## Checking

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all
```

Composite detection (`patterns/duplicate-composite`,
`patterns/superseded-composite`, `patterns/unregistered-composite`) is implemented — the engine builds a
component tree per JSX subtree and runs it against the registry. It only sees
what a project's `loupe.config.json` passes as `--patterns`; without that,
this skill is still the enforcement, which means reading the registry before
assembling is not optional.
