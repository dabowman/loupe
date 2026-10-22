# VIP composition patterns

The design-system half of `loupe-patterns`. Load that skill first — it carries
the look/check/search/register order, the registry format and the four-node
floor. This file is the VIP registry's own content.

The registry is `patterns/index.json`, beside this file. It was seeded from the
composites vip-dashboard actually repeats, so it is short on purpose: an entry
here is a shape that already recurs, not a guess at one that might.

## Anatomy entries

`table-anatomy`, `dropdown-anatomy`, `accordion-anatomy`, `tabs-anatomy`.

These record structure the library requires — a `Table` is rows of cells in
every file that has one — so it is not reported as an unregistered composite.
Each carries `canonical` set to its root import and never produces a finding.
`table-anatomy` also covers a row component that renders
`TableRow(TableCell, …)` without importing `Table` itself: `TableRow` is read as
a part of `Table` by its name.

`NewDialog.Root` and `Drawer` have no anatomy entry. Their regions — `trigger`,
`title`, `description`, `content` — are props, and a signature is built from JSX
children only, so there is no fixed shape to absorb.

If you use a VIP component whose anatomy runs to four nodes or more and the
composite rule reports it, add its entry here with `canonical` set to the root
import. Registering it without a `canonical` turns the finding into
`patterns/duplicate-composite`, which asks for an extraction that must not
happen.

## Judgement entries

| About to build | Reach for | Not this |
| --- | --- | --- |
| Confirmation before an action | `NewConfirmationDialog` | `NewDialog.Root` whose content ends in Cancel/Confirm `Button`s; `ConfirmationDialog`; `window.confirm()` |
| A button whose action is running | `<Button loading>`, or `ButtonSubmit` | `{ loading && <Spinner /> }` inside the button's children |
| A setting toggled in place | the `labelled-toggle` shape, once extracted — see below | the row rebuilt per form |
| Two or three actions together | `Flex` with `sx={{ gap: 2 }}`, primary last | the second `Button` carrying `sx={{ ml: 2 }}` |
| Label/value pairs | `DescriptionList` | a `Grid` of `Text` pairs |
| A list of things to open | `OptionRow` per item | a `Card` of `Heading` + `Text` + an arrow icon |
| A service page's header | `ServiceHeader` | a `Card` holding a `Heading`, a `Badge` and a `Flex` of `Button`s |
| Transient result messages | `Snackbar` | a `Notice` that removes itself on a timer |

`busy-button` is the only entry with an `instead_of_signature`, and it is
written as the action row it usually sits in — `Flex(Button, Button(Spinner))` —
because `Button(Spinner)` alone is under the four-node floor. A spinner inside a
lone button is the same mistake and will not be reported; catch it on sight.

`confirmation-dialog` keeps its anti-shape as prose: `NewDialog.Root` takes its
content as a prop, so the two buttons never appear as its JSX children.

## Not shipped — extract when you build it

`labelled-toggle` is a `Label` and a `Toggle` on one row, with help text under
them, wired by `htmlFor` / `id` / `aria-describedby`. vip-dashboard builds it by
hand in seventeen files. It has no `canonical` because the package does not ship
it — `ToggleRow` looks close but is a list row with a `Heading` title, an image
and a badge, and no `<label>` association, so it is not a drop-in.

The next project to touch one of those files extracts the row once, and fills in
`import` and `canonical` in the entry, so the next agent reading the registry is
pointed at the shared implementation instead of writing an eighteenth.
