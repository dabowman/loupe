---
name: loupe-authoring
description: >-
  Load BEFORE writing or editing any UI built on a design system — a component library plus design tokens, whatever it is called: WordPress Design System (`@wordpress/components`, `@wordpress/ui`, `--wpds-*`), Archer (`@dabowman/archer`), or the system a project declares in its own `loupe.config.json`. Carries the authoring rules that keep generated code from drifting, and they are the same rules in every system: the component before the element, the prop before the stylesheet, `gap` on a layout primitive before a margin anywhere, a token chosen by role before a value that merely matches. Starts by asking `loupe status` which design system is actually in play, then reads that system's own authoring notes from its profile — so the specifics (which components exist, what the tokens are named, which escape-hatch keyword) come from the project rather than from memory. Also covers when writing CSS is legitimate and how to suppress a finding properly. Triggers on building screens, settings panels, modals, sidebars, toolbars, data tables, empty states, or any JSX importing components from a design-system package. Pair with `loupe-patterns` before assembling a composite and `loupe-remediation` when fixing findings.
compatibility: "Any React-family design system Loupe can be configured for. Conformance checking needs the plugin's engine (node >=18)."
---

# Authoring on a design system

The failure this prevents is not broken code. It is code that compiles, renders
correctly, passes review, and quietly reimplements something the design system
already provides — a hand-rolled flex row beside the layout primitive, a
`font-size` where a component prop already covers it, a `margin-bottom` where
the parent has a `gap`.

That drift is cheap to avoid while writing and expensive to unwind afterwards,
because by then the pattern is load-bearing and every argument for keeping it is
locally true. Decide correctly the first time.

## First: find out which design system this is

The rules below are the same everywhere. The nouns are not — one system's
layout primitive is `Stack`, another's is `Box`, a third has none at all;
tokens are `--wpds-color-*` here and `--color-text-*` there. Guessing those is
the single largest source of code that looks conformant and imports nothing
real.

```bash
loupe status
```

Read the top block before writing anything:

| Line | What it settles |
| --- | --- |
| `system:` | The design system's name |
| `packages:` | What its components are imported from |
| `layout:` | The layout primitive(s), canonical first. A name marked `(legacy)` is recognized but superseded — never write one. `(none)` is a real answer — a headless library has none |
| `text:` | The text component(s), same convention, or `(none)` — then type is a token, not a component |
| `tokens:` | The token namespace(s). Everything you write comes from these |
| `suppress:` | The exact escape-hatch keyword for this project |
| `profile:` | The active design-system profile, and the directory it lives in |

**Then read that profile's `authoring.md`** — `<profile dir>/authoring.md`,
where `<profile dir>` is the path `profile:` printed. That file carries the
system's real component list, its token grammar and the decisions that need
judgement rather than a lookup. It is the difference between "use a token" and
naming one that exists.

If `profile:` says `none selected`, there is no profile for this system and
this skill is the whole of the guidance: work from `loupe status`'s other lines
and from the tokens the project's own stylesheets already define.

`loupe` is on PATH when the plugin is enabled; otherwise
`node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" status --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"`.

## The order of resort

For any visual requirement, work down this list and stop at the first hit. Going
further down than necessary is the drift.

1. **A component prop.** The component already models this — a variant, a size,
   an emphasis.
2. **A layout primitive.** Direction and spacing belong to a container, not to
   the things inside it.
3. **A token, applied in CSS.** Chosen by role, from the namespace `loupe status`
   named.
4. **Raw CSS.** Only with a reason you would defend out loud, or for what has no
   primitive at all — CSS Grid is never reported, because no flex primitive
   expresses it. See [Legitimate CSS](#when-css-is-the-right-answer).

## `style={{ … }}` is not an exemption

An inline style is the same decision as the equivalent stylesheet rule, made
somewhere the cascade cannot reach it. `style={{ marginBottom: 16 }}` is
`margin-bottom: 16px` with worse ergonomics: it cannot be themed, cannot be
overridden without `!important`, and on a design-system component it silently
beats the props that are supposed to drive it.

The same goes for a template literal. ``styled.div`margin-bottom: 16px` `` and
emotion's ``css`margin-bottom: 16px` `` are the same decision again, and
``styled(Button)`background: red` `` overrides the component exactly the way a
CSS rule bound to it would.

The checker treats all three channels identically — stylesheets, `style={{ … }}`
and CSS-in-JS run through one classifier — so there is no fast path here.

Legitimate inline styles are the ones no stylesheet could express: a value
computed at runtime (a measured width, a drag offset, a progress percentage).
If the value is a constant, it belongs in a prop or a token.

## Layout: gap, never margin

Spacing between siblings is a property of their container. A child that asserts
its own margin has an opinion about who it sits next to, and it is wrong the
first time it is reused somewhere else.

```jsx
// Wrong — each child asserts its own spacing, and they will disagree.
<div className="toolbar">
	<Button className="toolbar__save">Save</Button>   /* margin-right: 12px */
	<Button>Cancel</Button>
</div>

// Right — the container owns the rhythm; children stay reusable.
<Stack direction="row" gap="md">
	<Button variant="primary">Save</Button>
	<Button>Cancel</Button>
</Stack>
```

Many systems make this literal by shipping no margin token at all — the
dimension scale covers `padding` and `gap` and stops. Check the profile's
`authoring.md`; where that is true it settles the question outright.

When a layout primitive genuinely cannot be used — you do not control the
wrapper, or the markup comes from elsewhere — put `gap` on the parent in CSS.
That is resort 3, and it is fine. What is not fine is spacing a child from
inside the child.

Three margins carry no drift and are not flagged: `margin: 0` (a reset),
`margin: 0 auto` / `margin-inline: auto` (centering, which `gap` cannot
express), and negative margins used for a deliberate bleed — that last one is
reported separately so you confirm the intent rather than defend the technique.

## Typography: one decision, not five

`font-size`, `font-weight`, `line-height`, `letter-spacing` and `font-family`
move together or they drift apart. A rule that sets one of them has taken a
type style apart, and the next edit will change one half of it.

Which mechanism carries them depends on what `loupe status` said under `text:`:

- **A text component exists.** Use it, with its own styling prop — a `variant`
  or `size` that carries the whole style at once — and never set the individual
  properties on a class bound to it.
- **`text: (none)`.** Type is a token composite. Apply the whole set of
  longhands for a named role together; do not assemble a new style out of loose
  values. The profile's `authoring.md` names the roles.

Either way, semantic HTML still applies: a heading is a heading element,
whether it carries a component's `render` prop or a type-style role.

## Tokens by role, not by value

Token names describe purpose, not appearance. Pick by asking what the value is
*for*, never by matching a hex you already had. A background token applied to
`color` gives the right pixels and the wrong meaning, and that survives review
precisely because it looks correct.

Two rules that hold in every system:

- **Never invent a token name.** A plausible-looking name that was never
  defined resolves to nothing and fails silently at runtime. Look it up — in
  the profile's `authoring.md`, in the design system's own generated
  stylesheets, or with whatever token tool the profile names.
- **Prefer the semantic layer over the primitive one.** Most systems ship a raw
  palette and a role layer built on top of it. The role layer is what moves
  when the theme moves; a primitive is a specific colour in light mode and the
  same specific colour in dark.

Where a needed combination does not exist, that is usually a signal to
re-examine the design rather than to invent a token or fall back to a literal.

## Don't restyle a component from outside

A class on a design-system component that sets colour, type, borders or radius
is an override. It couples your code to the component's internals and breaks on
upgrade. Restyle through props, and through whatever tokens the component
declares as its own contract.

Reaching into another library's DOM is worse: those selectors are private and
change without notice. If a component cannot be made to look right through its
API, that is worth raising rather than routing around.

**One exception, and it is a real one.** On a headless library — Base UI, Radix,
Ark, React Aria — styling the parts with your own classes *is* the documented
way to use it, not drift. Loupe knows this: on a headless preset
`system/override` and `system/inline-style` are off, and `loupe status` will
show them that way. Do not apply this section against the grain of what the
status output says.

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

When a finding is genuinely wrong, suppress it precisely and say why, using the
keyword `loupe status` printed under `suppress:`:

```css
/* <keyword> system/override -- Stack exposes no padding prop at this size */
.acme-panel { padding: var(--space-l); }
```

The rule id and the reason are both mandatory; a bare or blanket disable is
itself a blocking finding. This inversion is deliberate — the escape hatch stays
available and stays legible, so suppressions can be audited later with
`loupe suppressions`.

A reason that amounts to "this is how it was already written" is not a reason.

## Before you assemble anything composite

Headers, action bars, modals, notices, sidebars, empty states and form rows are
where duplication accumulates fastest — each one looks like a small local
decision. Load **`loupe-patterns`** before building one, and use the registered
pattern if it exists.

## Checking your work

```bash
loupe check --changed
```

`--all` for the whole repo, `loupe explain <rule>` for a rule's guidance and
whether it is active. Fixing what it reports is **`loupe-remediation`**.
