---
name: loupe-patterns
description: >-
  Load BEFORE assembling any composite UI out of design-system components — a page or panel header, an action bar, a confirmation or form modal, a notice or notification stack, a detail sidebar, an empty state, a form row, a data-table toolbar. Works on whatever design system the project is on: WordPress Design System, Archer, or one declared in the project's own config. Carries how the composite registry works — signature matching, the four-node floor, `canonical`, `instead_of_signature` — and points at the active profile's own registry of sanctioned compositions, so you check what already exists before writing a new one, and register a new one when it genuinely does not. Prevents the failure where an agent assembles a fifth bespoke header, each locally reasonable and collectively unmaintainable. Triggers on "build a header", "add a modal", "confirmation dialog", "action buttons", "notice", "sidebar", "empty state", "toolbar", or any JSX composing two or more design-system components into a reusable shape. Pair with `loupe-authoring` for the styling rules.
compatibility: "Any React-family design system Loupe can be configured for."
---

# Composition patterns

Component-level conformance is the easy half. The expensive drift is
compositional: a codebase ends up with six headers, four modal footers and
three empty states, each individually defensible, collectively a maintenance
tax nobody chose to take on.

It happens because each one is a small local decision made in isolation, and
because assembling components feels like *using* the system rather than
extending it. Check the registry before you assemble.

## How to use this

```bash
loupe status
```

The `profile:` line names the active design-system profile and the directory it
lives in. Everything below refers to that directory as `<profile dir>`.

1. **Look first.** Read `<profile dir>/patterns.md` — the redirect table that
   settles which pattern you are in, then the reach-for table — and
   `<profile dir>/patterns/index.json`, the registry itself. Read the project's
   own `patterns/` directory too, if it has one. If a pattern covers what you
   need, use it: import the shared implementation rather than copying its
   structure.
2. **Check the component registry second.** Before assembling anything from
   primitives, check `<profile dir>/components/index.json` for whether the shape
   you are about to hand-roll already ships as a single real compound component
   — and check its `status`, not just that it exists. Existence alone is not the
   signal; a component the registry marks `experimental` or `locked` is not the
   answer even though it is right there.
3. **Search the codebase third.** If nothing is registered and nothing ships,
   grep for the shape before writing it. Two existing near-copies mean the
   pattern already exists informally and should be extracted, not tripled.
4. **Register fourth.** A genuinely new composite gets an entry, so the next
   session finds it. See [Registering](#registering-a-pattern).

If `profile:` says `none selected`, there is no shipped registry for this
system. Steps 3 and 4 still apply, against the project's own registry.

## The registry format

One entry per sanctioned composite, keyed by the **user need** it answers, not
by a component name. The key names something in the shared pattern language
(the repo's top-level `patterns/index.json`): an abstract pattern (`confirm`),
a variant (`choose.segmented`), or a part (`navigate-hierarchy#descend`).

```jsonc
{
  "pattern": "confirm",
  "import": "@acme/ui",          // where the shared implementation lives
  "canonical": "ConfirmDialog",  // the name the code binds
  "detector": ["signature", { "rule": "confirm-pair", "container": "Modal", "button": "Button" }],
  "signature": ["Modal", "Text", ["Stack", "Button", "Button"]],
  "instead_of": [
    "A hand-built Modal + Stack + Button pair reimplementing confirm/cancel",
    "window.confirm()"
  ],
  "note": "The signature also matches a form dialog; the rule reads the labels."
}
```

`detector` says how the entry is checked, so an entry never has to inflate a
signature to look checkable:

| Detector | Checks |
| --- | --- |
| `signature` | Tree containment against `signature`. Four nodes or more. |
| `import` | Nothing beyond the canonical import; the entry exists to name the remedy and to fill the table. |
| A rule object | An AST rule the engine ships, parameterised here: `few-static-options` reads a select's option count and label width; `confirm-pair` reads a modal's button labels and looks for form controls. Either reports `patterns/superseded-composite` on the file that made the choice. `judge` names the elements that are instances of the entry's pattern, for `check --judge` to read a force off and run the abstract `resolve` table on; a redirect reports `patterns/judged-redirect`. |
| `declared` | Documentation only, until a declaration tag exists. |

A registry written before this format existed, keyed by `id`, still loads.

`signature` is the normalized component tree. A node is `[name, ...children]`;
each child is either a bare component name or another node. Only design-system
components appear — raw elements between them are transparent, so
`<Stack><div><Button/></div></Stack>` and `<Stack><Button/></Stack>` have the
same signature, which is right, because they are the same composition.

How a system spells its sub-parts decides how you write them. A compound
component's parts are distinct nodes either way: write `Card.Header` where the
system exposes dotted parts, and `DialogPopup` where it exposes flat sibling
exports. Check the profile's own registry for which shape it uses.

A node may name alternatives with `|` — `Stack|VStack|HStack|Flex`. One shape
usually has more than one spelling, and an entry that knows only the newest one
reports every file still writing the old one as an unregistered composite.

Matching is **containment, not equality**:

- Extra children are fine. A header with one more button is still that header.
- A registered child may sit anywhere beneath the root, not just as a direct
  sibling. A footer recorded beside the body and a footer nested inside it are
  the same composition. Demanding the recorded shape exactly would mean the rule
  only ever matched code that had already been generated from the pattern — the
  one case with nothing to report.
- Each registered child claims a distinct node, so `["Stack", "Text", "Text"]`
  needs two `Text`s rather than matching one twice.
- Prefix a child with `>` to pin it to its parent's **direct** children:
  `["Stack", [">Stack", ">Text", ">Button"], ...]`. Do this whenever a shape is
  built from layout primitives, `Text` and `Button` alone — matched at any depth,
  such a shape fires on every screen whose outer `Stack` holds a label and a
  button somewhere. Better still, include a component that is distinctive to the
  pattern (a field for an inspector), so the shape says what it is.

**A signature under four nodes is documentation, not a check.** The engine skips
it. `Stack(Button,Button)` is a true description of an action bar and a useless
finding — it matched 48 files in one repo, and "you have 48 action bars" is not a
defect anyone can act on. The wrong choice is usually one control, under that
floor, and that is what a rule detector is for.

`canonical` earns its keep the moment you fill it in: a file that imports it is
using the pattern rather than rebuilding it, and is skipped before either
composite rule sees it. Until then the remedy the engine offers is "extract one
shared implementation", because telling an agent to import something that does
not exist sends it hunting for a module. **A container is not a canonical.**
`Modal` is where a form dialog lives, not the shipped form dialog; naming it
skips every file that imports `Modal`, which is every file.

Write `canonical` as **the name the code binds**, not the import statement that
produces it: `ConfirmDialog`, not `__experimentalConfirmDialog as ConfirmDialog`;
`EmptyState`, not `EmptyState.Root`. It is matched against a file's local import
names; a dotted part name is cut to its root on load.

A `parts` block nests one entry per part of the pattern, each loaded as
`id#part` and inheriting the parent's `canonical` unless it sets its own to
`null`. `rendered_signature` is the same part with the `representation:
rendered` force applied — a second shape under the same key, not a second
pattern.

`instead_of_signature` records the shape a pattern *replaces*, in the same
`[name, ...children]` form. It is `instead_of` promoted from prose to a check,
and it obeys the same four-node floor.

The rules this drives:

| | |
| --- | --- |
| `patterns/duplicate-composite` | A registered pattern reassembled by hand in two or more files |
| `patterns/superseded-composite` | A shape a pattern exists to replace, or a rule detector's hit — reported against the one file that built it, because a wrong choice is a defect where it is made |
| `patterns/unregistered-composite` | The same shape in three or more files, in no registry — two is a coincidence, three is house style |
| `patterns/judged-redirect` | `--judge` only: a model read what a control stands for, and its pattern's `resolve` redirects that reading — a button that navigates, a select of commands |

A project's own registry is merged over the profile's, winning on key.

## Anatomy entries

Some libraries require a shape. A headless component is a root, a trigger, a
portal and a popup in every file that has one; that repetition is the library
working, not house style nobody wrote down. Left unregistered, the third
correct use reports as `patterns/unregistered-composite`.

The fix is an entry whose `canonical` is the component's root import name. Any
file that actually uses the component imports that name and is skipped before
either composite rule sees it, so the entry absorbs the shape and never
produces a finding of its own.

The same entry covers the component's parts cut below its root — a file that
renders only a row of cells, or only a menu's popup and items. Anything named
as a part of the root counts, whether or not the signature lists it
(`TableHeaderCell`, `Menu.Separator`). This holds only while the tree is nothing
*but* parts: a popup that also holds a form is the form, and still reports.

Do **not** register required anatomy without a `canonical`. That converts the
finding into `patterns/duplicate-composite` and asks for an extraction that
should not happen.

## Registering a pattern

Say which of three things you are adding. Nearly everything is the first.

| Level | Allowed when | Must supply |
| --- | --- | --- |
| **Realization** (in the profile) | An abstract variant or part has no entry for this system yet | `pattern`, `canonical` or `signature`, `detector` |
| **Variant** (in the abstract file) | A `when` no sibling variant already matches, using forces that exist | the `when`, a summary, its consequences |
| **Abstract pattern** | An empty (intent, scale) cell, or an occupied one plus a *new* force that separates it | problem, forces, parts, resolve, and the nearest neighbour it differs from |

A shape that would land in an occupied cell with no new force is a variant or a
realization, not a pattern. That is the vocabulary doing the work a "be
concise" rule cannot: there is nowhere to put a fourth copy of one idea.

Those levels assume a registry that names the abstract file in `extends`. A v1
registry has no `extends`: it is a flat `patterns` list of `{ id, summary,
signature, … }` entries, as Archer's and VIP's are, and
`profiles/vip/patterns/index.json` is the small example. The engine still reads
it — `signature`, `rendered_signature`, `canonical` and `instead_of_signature`
mean what they mean above, and `summary` falls back to `note` — while `use`,
`import` and `instead_of` are prose for whoever reads the file next. Adding to
one is appending an entry under a new `id`. Its `patterns.md` is written by
hand, since there is no abstract layer to generate a table from, so update that
too.

Then keep the entry honest:

- **`note` says what it is for**, not what it contains. "Destructive-action
  confirmation" is useful; "Modal with two buttons" is not — the second
  describes a shape anyone could match by accident.
- **`signature` is the structure that matters**, not every node. Four to six
  nodes at depth 2–3 is the useful band. Under four the engine ignores it as too
  generic to check; over-specify and near-identical variants stop matching.
- **`instead_of` names the anti-pattern** you have actually seen in this
  codebase. That is the line that stops the next rebuild.
- **`instead_of_signature` only if the anti-pattern has a shape**, four nodes
  minimum. Most do not: the thing agents reach for by default is usually one
  control, which is a rule detector's job, not a signature's.
- **`import` and `canonical` earn the entry.** A pattern documented but never
  extracted still gets rebuilt. Once two call sites exist, extract it, point
  `import` at the module and `canonical` at the component name — the engine then
  stops reporting files that already use it, and starts naming it as the remedy.
- **Regenerate the table.** `npm run patterns-doc` in `engine/` validates the
  entry against the abstract language and rewrites the profile's reach-for
  table. A key that names nothing fails the run. It skips a v1 registry, so
  `--check` never covers a hand-written `patterns.md`.

## When a pattern does not fit

Patterns are defaults, not law. A screen with a real reason to diverge should
diverge — and say so in a comment naming the pattern it departs from and why.
That comment is what stops the next session "fixing" it back, and it is also
how you find out a pattern needs a variant.

What is not a reason: the surrounding code already does it this way. Existing
duplication is the problem being solved, not evidence for its own correctness.

## Checking

```bash
loupe check --all
```

The composite rules need a registry and the design system's packages to be
declared; `loupe status` says whether they are live. Where they are not, this
skill is the enforcement, which means reading the registry before assembling is
not optional.
