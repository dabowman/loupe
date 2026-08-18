---
name: wpds-authoring
description: >-
  Load BEFORE writing or editing any UI that uses the WordPress Design System — `@wordpress/components`, `@wordpress/ui`, or `--wpds-*` tokens — in wp-admin, Gutenberg, WordPress.com, Jetpack, or any React surface built on WPDS. Carries the authoring rules that keep generated code from drifting: use the component before the element (`Text`/`Heading` over `<p>`/`<h2>`), the prop before the stylesheet (`size`/`weight`/`variant` over `font-size`/`font-weight`), and `gap` on a layout primitive over margin anywhere — WPDS ships no margin token at all. Also covers token selection by role, when writing CSS is legitimate, and the `wpds-allow` escape hatch. Triggers on building admin screens, settings panels, modals, sidebar plugins, DataViews surfaces, toolbars, or any JSX importing from `@wordpress/components`. Pair with `wpds-patterns` before assembling a composite and `wpds-remediation` when fixing findings.
compatibility: "Targets WPDS on WordPress 6.5+ / 7.0. Conformance checking needs the plugin's engine (node >=18)."
---

# Authoring for the WordPress Design System

The failure this prevents is not broken code. It is code that compiles, renders
correctly, passes review, and quietly reimplements something the design system
already provides — a hand-rolled flex row beside `HStack`, a `font-size` beside
`Text`'s `size` prop, a `margin-bottom` where the parent has a `gap`.

That drift is cheap to avoid while writing and expensive to unwind afterwards,
because by then the pattern is load-bearing and every argument for keeping it is
locally true. Decide correctly the first time.

## The order of resort

For any visual requirement, work down this list and stop at the first hit. Going
further down than necessary is the drift.

1. **A component prop.** `<Text size="small" weight="emphasis">`.
2. **A layout primitive.** `<HStack spacing={2}>`, `<VStack>`, `<Grid>`.
3. **A token, applied in CSS.** `padding: var(--wpds-dimension-padding-md)`.
4. **Raw CSS.** Only with a reason you would defend out loud. See
   [Legitimate CSS](#when-css-is-the-right-answer).

## Layout: gap, never margin

**WPDS ships no margin token.** The dimension scale covers `padding`, `gap`,
`size` and `surface-width` — margin is absent by design, because the system
expresses spacing as a property of a container, not of the things inside it.

This is a fact about the system, not a style preference, and it settles the
question: there is no sanctioned way to write margin, so spacing belongs to the
parent.

```jsx
// Wrong — each child asserts its own spacing, and they will disagree.
<div className="toolbar">
	<Button className="toolbar__save">Save</Button>   /* margin-right: 12px */
	<Button>Cancel</Button>
</div>

// Right — the container owns the rhythm; children stay reusable.
<HStack spacing={3} justify="flex-start">
	<Button variant="primary">Save</Button>
	<Button>Cancel</Button>
</HStack>
```

When a layout primitive genuinely cannot be used — you do not control the
wrapper, or the markup comes from elsewhere — put `gap` on the parent in CSS.
That is resort 3, and it is fine. What is not fine is spacing a child from
inside the child.

Three margins carry no drift and are not flagged: `margin: 0` (a reset),
`margin: 0 auto` / `margin-inline: auto` (centering, which `gap` cannot
express), and negative margins used for a deliberate bleed — that last one is
reported separately so you confirm the intent rather than defend the technique.

## Typography: props, not properties

`Text` and `Heading` expose the type scale as props. Reaching past them to CSS
recreates a system decision by hand and detaches it from the system's future.

```jsx
<Text size="small" weight="emphasis" color="warning">Draft</Text>   // yes
<span className="status">Draft</span>                               // no
```

Never set `font-size`, `font-weight`, `line-height`, `letter-spacing` or
`font-family` on a class bound to a `Text` or `Heading`. If the size you need
has no prop, that is a design-system conversation, not a local override — reach
for `--wpds-typography-*` and leave a comment saying which prop was missing.

Raw `<p>`, `<h1>`–`<h6>` and styled `<span>` all have analogs. Use them.

## Tokens by role, not by value

Token names describe purpose, not appearance. Pick by asking what the value is
*for*, never by matching a hex you already had:

```
--wpds-color-<property>-<target>-<tone>[-<emphasis>][-<state>]
```

- **property** — `background`, `foreground`, `stroke`
- **target** — `surface` (containers), `interactive` (controls), `content`
  (static text and icons), `track` / `thumb`
- **tone** — `neutral`, `brand`, `success`, `info`, `caution`, `warning`, `error`
- **emphasis** — `weak`, `strong` · **state** — `active`, `disabled`

Body text on a panel is `--wpds-color-foreground-content-neutral`. A primary
button's fill is `--wpds-color-background-interactive-brand-strong`. Keep the
role fixed across states and vary only the state segment — pair
`…-interactive-neutral` with `…-interactive-neutral-active`, rather than
switching tone when something is hovered.

Other families, all `--wpds-` prefixed:

| Need | Family |
| --- | --- |
| Space inside a container | `dimension-padding-{xs…3xl}` |
| Space between children | `dimension-gap-{xs…3xl}` |
| Control / icon sizing | `dimension-size-{5xs…lg}` |
| Max width of a surface | `dimension-surface-width-{xs…2xl}` |
| Type | `typography-font-size-{xs…2xl}`, `-line-height-*`, `-font-weight-{default,emphasis}` |
| Corners, borders | `border-radius-{xs…xl}`, `border-width-{xs…lg,focus}` |
| Animation | `motion-duration-{xs…xl}`, `motion-easing-{subtle,balanced,expressive}` |

The set is role-based, not a full matrix. A combination that does not exist
usually should not — that is a signal to re-examine the design, not to invent a
token or fall back to a literal.

Never invent a token name. If the exact token is not obvious, look it up with
the WPDS MCP server (`get_design_tokens`) rather than guessing a plausible
shape; `--wpds-font-size-13` is the classic invented token and it resolves to
nothing.

## Don't restyle a component from outside

A class on a WPDS component that sets colour, type, borders or radius is an
override. It couples your code to the component's internals and breaks on
upgrade. Restyle through props and the tokens the component reads.

Reaching into another library's DOM — `.components-*`, `.block-editor-*`,
`.dataviews-*` — is worse: those are private and change without notice. If a
component cannot be made to look right through its API, that is worth raising
rather than routing around.

## When CSS is the right answer

Writing CSS is not the failure. Writing CSS *instead of using the system* is.
These are legitimate:

- `gap` and `padding` on a container you own, using tokens
- CSS Grid — no flex primitive expresses it, and the checker will not ask you to
  convert it
- Positioning, `overflow`, `z-index`, and other things no component covers
- Responsive rules a prop cannot express

In all of them, values come from tokens.

## The escape hatch

When a finding is genuinely wrong, suppress it precisely and say why:

```css
/* wpds-allow system/override -- Stack exposes no padding prop at this size */
.acme-panel { padding: var(--wpds-dimension-padding-lg); }
```

The rule id and the reason are both mandatory; a bare or blanket disable is
itself a blocking finding. This inversion is deliberate — the escape hatch stays
available and stays legible, so suppressions can be audited later with
`wpds-audit --suppressions`.

A reason that amounts to "this is how it was already written" is not a reason.

## Before you assemble anything composite

Headers, action bars, modals, notices, sidebars, empty states and form rows are
where duplication accumulates fastest — each one looks like a small local
decision. Load **`wpds-patterns`** before building one, and use the registered
pattern if it exists.

## Checking your work

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" check --changed
```

`--all` for the whole repo, `explain <rule>` for a rule's guidance and whether
it is active. Fixing what it reports is **`wpds-remediation`**.
