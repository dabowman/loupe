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

1. **Look first.** Read `<profile dir>/patterns.md` — the prose about which
   shape to reach for — and `<profile dir>/patterns/index.json`, the registry
   itself. Read the project's own `patterns/` directory too, if it has one. If a
   pattern covers what you need, use it: import the shared implementation rather
   than copying its structure.
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

One entry per sanctioned composite:

```jsonc
{
  "id": "confirm-modal",
  "summary": "Destructive-action confirmation dialog with confirm/cancel actions.",
  "use": "Any irreversible action needing explicit consent.",
  "import": "@acme/ui",          // where the shared implementation lives
  "canonical": "ConfirmDialog",  // the name the code binds
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

**A signature under four nodes is documentation, not a check.** The engine skips
it. `Stack(Button,Button)` is a true description of an action bar and a useless
finding — it matched 48 files in one repo, and "you have 48 action bars" is not a
defect anyone can act on. Entries like that are in a registry for you to read,
not for the engine to enforce.

`canonical` earns its keep the moment you fill it in: a file that imports it is
using the pattern rather than rebuilding it, and is skipped before either
composite rule sees it. Until then the remedy the engine offers is "extract one
shared implementation", because telling an agent to import something that does
not exist sends it hunting for a module.

Write `canonical` as **the name the code binds**, not the import statement that
produces it: `ConfirmDialog`, not `__experimentalConfirmDialog as ConfirmDialog`;
`EmptyState`, not `EmptyState.Root`. It is matched against a file's local import
names, so anything else silently never matches and the pattern reports every
file that is already using it correctly.

`instead_of_signature` records the shape a pattern *replaces*, in the same
`[name, ...children]` form. It is `instead_of` promoted from prose to a check,
and it obeys the same four-node floor. Most entries carry the anti-pattern as
prose only, which is why reading the registry before assembling matters more
than the check does.

The three rules this drives:

| | |
| --- | --- |
| `patterns/duplicate-composite` | A registered pattern reassembled by hand in two or more files |
| `patterns/superseded-composite` | A shape a pattern exists to replace — reported against the one file that built it, because a wrong choice is a defect where it is made |
| `patterns/unregistered-composite` | The same shape in three or more files, in no registry — two is a coincidence, three is house style |

A project's own registry is merged over the profile's, winning on `id`.

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

Add the entry, then keep it honest:

- **`summary` says what it is for**, not what it contains. "Destructive-action
  confirmation" is useful; "Modal with two buttons" is not — the second
  describes a shape anyone could match by accident.
- **`signature` is the structure that matters**, not every node. Four to six
  nodes at depth 2–3 is the useful band. Under four the engine ignores it as too
  generic to check; over-specify and near-identical variants stop matching.
- **`instead_of` names the anti-pattern** you have actually seen in this
  codebase. That is the line that stops the next rebuild.
- **`instead_of_signature` only if the anti-pattern has a shape**, four nodes
  minimum. Most do not: the thing agents reach for by default is usually one
  control, and a rule that fires on every dropdown is a rule people turn off.
  Watch for collisions, too — an anti-shape that a legitimate composite also
  contains will fire on the legitimate one, because matching is containment.
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
loupe check --all
```

The composite rules need a registry and the design system's packages to be
declared; `loupe status` says whether they are live. Where they are not, this
skill is the enforcement, which means reading the registry before assembling is
not optional.
