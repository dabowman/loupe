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
  "summary": "Destructive-action confirmation with a titled Modal and a right-aligned action pair.",
  "use": "Any irreversible action needing explicit consent.",
  "import": "@acme/ui",          // where the shared implementation lives, if extracted
  "canonical": "confirm-modal.jsx",
  "signature": ["Modal", ["Text"], ["HStack", ["Button", "Button"]]],
  "instead_of": [
    "A bare Modal with a hand-built div.actions footer",
    "window.confirm()"
  ]
}
```

`signature` is the normalized component tree — element names only, props and
text dropped. It is what makes a pattern checkable rather than merely
documented: two composites with the same signature are the same pattern, no
matter how their classes are named.

The engine's composite rules read this file. An entry without a `signature`
still documents the pattern for you; it just cannot be enforced.

## The starting set

These ship empty of canonical source deliberately — the shapes are project
specific, and a canonical file invented here would be wrong everywhere. Fill
each one in from the project's real implementation the first time you build it.

| Pattern | Replaces |
| --- | --- |
| `page-header` | Ad-hoc `HStack` + `Heading` + action cluster per screen |
| `action-bar` | Bespoke button rows with hand-set spacing and alignment |
| `confirm-modal` | Bare `Modal` + hand-built footer, or `window.confirm()` |
| `form-modal` | `Modal` with an inline form and inconsistent submit placement |
| `notice-stack` | Individually-placed `Notice` components with local spacing |
| `detail-sidebar` | One-off panel layouts beside a main region |
| `empty-state` | A centred `<div>` with a paragraph and a button |
| `form-row` | Label/control/help arrangements rebuilt per field |
| `dataviews-toolbar` | Custom filter/search/action clusters above a list |

## Registering a pattern

Add the entry, then keep it honest:

- **`summary` says what it is for**, not what it contains. "Destructive-action
  confirmation" is useful; "Modal with two buttons" is not — the second
  describes a shape anyone could match by accident.
- **`signature` is the structure that matters**, not every node. Depth 2–3 is
  usually right. Over-specify and near-identical variants stop matching;
  under-specify and unrelated composites collide.
- **`instead_of` names the anti-pattern** you have actually seen in this
  codebase. That is the line that stops the next rebuild.
- **`import` earns the entry.** A pattern documented but never extracted still
  gets rebuilt. Once two call sites exist, extract and point `import` at it.

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
`patterns/unregistered-composite`) is not implemented yet — the registry is
live and read by humans and agents, the rules that enforce it are the next
build step. Until then this skill is the enforcement, which means reading the
registry before assembling is not optional.
