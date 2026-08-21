---
name: wpds-patterns
description: >-
  Load BEFORE assembling any composite UI out of WordPress Design System components — a page or panel header, an action bar, a confirmation or form modal, a notice or notification stack, a detail sidebar, an empty state, a form row, or a DataViews toolbar. Carries the registry of sanctioned WPDS compositions in `patterns/`: what each one is for, its canonical structure, and the anti-patterns it replaces. Use it to check whether a composite already exists before writing a new one, and to register a new pattern when it genuinely does not. Prevents the failure where an agent assembles a fifth bespoke header, each locally reasonable and collectively unmaintainable. Triggers on "build a header", "add a modal", "confirmation dialog", "action buttons", "notice", "sidebar", "empty state", "toolbar", or any JSX composing two or more `@wordpress/components` into a reusable shape. Pair with `wpds-authoring` for the styling rules.
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

1. **Look first.** Read `patterns/index.json` in this plugin and the project's
   own `patterns/` directory if it has one. If a pattern covers what you need,
   use it — import the shared implementation rather than copying its structure.
2. **Search the codebase second.** If nothing is registered, grep for the shape
   before writing it. Two existing near-copies mean the pattern already exists
   informally and should be extracted, not tripled.
3. **Register third.** A genuinely new composite gets an entry, so the next
   session finds it. See [Registering](#registering-a-pattern).

```bash
# What is already sanctioned?
cat "${CLAUDE_PLUGIN_ROOT}/patterns/index.json"
```

## The registry

`patterns/index.json` holds one entry per sanctioned composite:

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

Matching is **containment, not equality**:

- Extra children are fine. A header with one more button is still that header.
- A registered child may sit anywhere beneath the root, not just as a direct
  sibling. `form-modal` records its footer beside the body; real code nests the
  footer inside the body, and both are the same composition. Demanding the
  recorded shape exactly would mean the rule only ever matched code that had
  already been generated from the pattern — the one case with nothing to report.
- Each registered child claims a distinct node, so `["VStack", "Text", "Text"]`
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

The two rules this drives:

| | |
| --- | --- |
| `patterns/duplicate-composite` | A registered pattern reassembled by hand in two or more files |
| `patterns/unregistered-composite` | The same shape in three or more files, in no registry — two is a coincidence, three is house style |

The engine reads this file when the hooks and commands pass `--patterns`. A
project's own registry is merged over the shipped one, winning on `id`.

## The starting set

Some of these are genuinely project-specific compositions — the shapes vary
per codebase, and a canonical file invented here would be wrong everywhere.
Fill `canonical`/`import` in from the project's real implementation the first
time you build one:

| Pattern | Replaces |
| --- | --- |
| `page-header` | Ad-hoc row `Stack` + heading `Text` + action cluster per screen |
| `action-bar` | Bespoke button rows with hand-set spacing and alignment |
| `form-modal` | `Modal` with an inline form and inconsistent submit placement |
| `detail-sidebar` | One-off panel layouts beside a main region |
| `dataviews-toolbar` | Custom filter/search/action clusters above a list |

The rest already have `canonical`/`import` filled in, because WPDS ships the
composition as a real component — the pattern exists to point at it, not to
describe a shape to reassemble:

| Pattern | Canonical component |
| --- | --- |
| `confirm-modal` | `ConfirmDialog` (`@wordpress/components`) — wraps `Modal` with confirm/cancel already built |
| `notice-stack` | `NoticeList` (`@wordpress/components`) |
| `empty-state` | `EmptyState.Root/Title/Description/Actions` (`@wordpress/ui`) |
| `form-row` | `Field.Root/Label/Control/Description` (`@wordpress/ui`) |
| `card` | `Card.Root/Header/Title/Content` (`@wordpress/ui`) |

A file that imports the canonical component stops being reported by
`patterns/duplicate-composite` — check for it before assembling any of these
five by hand.

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
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" check --all
```

Composite detection (`patterns/duplicate-composite`,
`patterns/unregistered-composite`) is implemented — the engine builds a
component tree per JSX subtree and runs it against the registry. It only sees
what a project's `ds-hygiene.config.json` passes as `--patterns`; without that,
this skill is still the enforcement, which means reading the registry before
assembling is not optional.
