# Design notes: the analysis

Why the analyzer, the scanners and the token set are built the way they are.
The rules themselves are in [checks.md](checks.md); what the engine *does* is
documented in [the engine README](../../engine/README.md).

## Why an analyzer and not a stylelint plugin

The one thing here that no single-language linter can do: correlate the markup
that binds a class to a component with the CSS that styles that class. Rules
that need no correlation — hardcoded values, margins — are a stylelint plugin in
disguise. The correlation rules are why this exists.

## The index is repo-wide, the report is scoped

`scope` filters what gets *reported*, never what gets indexed. Building the
index from changed files alone would make every unchanged reference look absent
and every class look dead.

The one exception is cost: a path that cannot contribute anything is skipped
before it is classified, so a scoped hook run does not classify every inline
style in the repo on every edit.

## One classifier, three channels

`margin-bottom: 16px` in a stylesheet, `style={{ marginBottom: 16 }}` in JSX and
the same declaration inside a `styled.div` template are the same mistake with
the same remedy. They must not be able to drift into different verdicts, which
is exactly what happens when the chain is written out twice — so all three
channels go through one `classify`.

**At most one finding per declaration, most specific first.** Emitting both the
precise remedy and the generic one doubles the report and leaves the agent to
guess which to act on. A check returns `undefined` to pass the declaration on,
`null` to claim it and pass it (`margin: 0` is the margin check's, and nothing
after it may call it a hardcoded value), or a finding to claim it and fail it.

The two superseding checks — `typography/in-css` and `system/override` — only
supersede while their rule is live. Off, they must step aside so the declaration
reaches the generic verdict it still deserves.

### Why the other two channels exist at all

A stylesheet-only checker leaves `style={{ … }}` and CSS-in-JS entirely
unexamined — and those are the shapes an agent reaches for when it wants
something to look right immediately. Leaving them unchecked is not a neutral
gap: **the tighter the CSS gate gets, the more attractive the unchecked channel
becomes.** Closing the inline channel is why `inline.ts` exists; the same
argument, applied to the channel `@wordpress/components` is itself built on, is
why `cssinjs.ts` does.

### Whole-rule findings

Some remedies are one action for the whole CSS rule, not one per declaration.
`display:flex; flex-direction:column; align-items:center; gap:8px` is four
findings for a single decision — replace this with a layout primitive — and a
real repo produced 702 of them. Four times the report buys nothing, and a rule
that floods the report crowds out every rule with a cheaper remedy.

Values stay in the message, because they are what the agent carries across to
the primitive; `code` drops them, so baseline identity survives a value tweak.

## Capture, dedupe, bound — in that order

Snippets are captured unbounded and the line is bounded once, at the end of
`analyze`. The order is load-bearing:

- **`message` is part of a finding's identity.** On the rules whose `code` is
  only the property (`margin-*`, `gap`) it is the *only* thing telling two
  findings apart, so a cap applied at capture folds two distinct declarations on
  one line into one finding and drops a real violation.
- **The dedupe keys on identity *and* display.** Nesting and multi-selector
  rules legitimately reach the same declaration twice. A cap decides how a
  finding reads; it must not get to decide whether a finding survives, and
  folding on a capped message is exactly that.
- **A CSS-in-JS selector is held whole.** It is the only thing telling two
  otherwise identical findings in one template apart, and it never reaches
  `code` — so bounding it at capture made two of them byte-identical and the
  dedupe folded them into one.

What *is* bounded at capture is a single contributor to a composed message, so
one long value cannot spend the whole line. See [bounding](report.md#bounding)
for how the final cap splits body from tail.

The token pass is the last of several writers of `message`, which is the other
reason the cap comes after it: applied earlier it would simply be overwritten.

## The token pass runs last

Deferred until every stylesheet has been read, because a rule that fires against
a half-built token set reports the design system's own tokens as unknown.

It rewrites findings to **name the replacement instead of the namespace**. A
finding that says "13px is hardcoded — use a `--wpds-*` token" leaves the agent
to invent one, and it invents `--wpds-font-size-13`.

The match comes first and the prose is rendered from it, rather than the other
way round: an unambiguous substitution should not need a model to parse it back
out of a sentence in order to apply it, and the message a reader sees is then a
rendering of the same thing `fix` acts on rather than a second account of it.
One entry per flagged declaration, matched or not — `fix` clears a finding only
when every declaration in it was substituted, and an entry with no tokens is how
it knows one was not.

## The token set

`tokenPrefixes` used to be cosmetic: it shaped a message and nothing validated
anything against it. Reading the real set — the design system ships its tokens
as plain custom properties in a stylesheet; `@wordpress/theme` 3.0.0 emits 171
of them — is what lets a finding name a token instead of a namespace. Token
source paths deliberately reach into `node_modules`, which the project walk
prunes: the design system's tokens are the whole point, and they live there.

Everything degrades to the old behaviour when no definitions are found: no
annotation on hardcoded values, and `tokens/unknown-token` stays silent rather
than declaring every token unknown.

**Naming the wrong token is worse advice than naming none.** `1px` is both
`--wpds-border-radius-xs` and `--wpds-border-width-xs`; the agent applies the
wrong one, the value is right, and the semantics are quietly wrong forever. So
candidates are filtered by role, and a value that several on-role tokens carry
is left for `--judge` rather than resolved by array order.

Lengths and durations are narrowed arithmetically to the scale steps either side
of the literal — closeness on a scale is arithmetic, and there is no role left to
choose once the property has picked its family. Everything else gets the whole
family. See [judge.md](judge.md#which-token) for what was measured about that.

**Spacing snaps rather than keeps.** A spacing value the scale covers is snapped:
the scale is how the system spaces things, and "6px is deliberate" is the
judgement that lets a one-off survive every pass. Past the end of the scale it
may still be kept — 48px of page padding snapped to a 32px top step is a
different layout.

## Token scopes

A token's type says what kind of value it is; it does not say what the value is
*for*. A stroke colour and a text colour are both `color`, and applying one where
the other belongs gives the right pixels with the wrong meaning — which survives
review precisely because it looks correct, and moves the wrong way the next time
the system moves. The role filter above used to be a table of regex pairs in the
engine (`ROLE_HINTS`), guessing at several systems' spellings at once
(`fg|text|content|foreground`). That table is a system's data, so a profile now
states it, and adding a design system stays a directory rather than an engine
patch.

**A grammar plus segment meanings, not a per-token table.** A well-built system
writes the role into the name, and WPDS publishes the grammar:
`--wpds-color-<property>-<target>-<tone>[-<emphasis>][-<state>]`. A profile's
`tokenScopes` declares that pattern, which CSS properties each `property` segment
sets, and which kinds of element each `target` segment may or may not sit on —
and stays correct as the system adds tokens. A scale whose role is *not* in the
name is enumerated instead: nothing in `--wpds-border-radius-md` says "menus and
popovers", so each radius step names the kind of element it belongs on.

```jsonc
"tokenScopes": {
  "kinds": { "interactive": ["button", "a", "Button", …], "overlay": ["Popover"], "nested-in-control": [] },
  "grammars": [{
    "pattern": "--wpds-color-{property}-{target}...",
    "property": {
      "background": ["background", "background-color", "background-image"],
      "stroke": { "sets": ["border-color", "outline-color", …], "also": ["box-shadow"] }
    },
    "target": { "surface": { "not": ["interactive"] }, "interactive": { "requires": ["interactive"] } }
  }],
  "scales": { "--wpds-border-radius-md": { "on": ["overlay"] } }
}
```

`sets` is what the token is *for* — the properties it is suggested for. `also` is
where it may appear without being what it is for: the stroke colour inside a
focus-ring `box-shadow`, a width inside a `border` shorthand. Keeping the two
apart is what stops a shorthand's family filling up with the wrong kind of value:
the border-width tokens may sit in `border`, but `border: 1px solid #ddd` is
still offered only stroke colours for the hex.

**The engine keeps the old table as the fallback, verbatim.** A profile that
declares nothing, and every property no declared segment `sets`, is answered by
the generic table exactly as before — a test holds the two equal. Where a
profile does cover a property, it decides alone for the names under its
grammars' own prefixes: a primitive `--wpds-dimension-*` the grammar does not
place is not on-role there. Fail safe in both directions — a token no grammar's
prefix claims (a project's own `--acme-*`, another preset's `--wp-components-*`)
has no declared scope, keeps today's matching beside the placed ones, and is
never reported as misapplied.

**What an element is comes from what the engine already correlates.** A
stylesheet rule's key compound naming a tag (`.card button`), the design-system
components the markup binds its key classes to, the raw elements carrying them,
an inline style's own element, a CSS-in-JS template's target. A component is
looked up as the component it is, whatever the file called it: `Button`
imported as `B`, the `Button` of `import * as WP`, and a compound part as itself
— `Card.Header` is not the `Card` it belongs to. Kinds are the profile's: `interactive` is `button`, `a`, `Button`, `Link`…; a component is
listed only where its `className` lands on that element (`Dropdown`'s lands on
the toggle's wrapper, so it is not an overlay). A kind declared empty is one no
markup can show — "nested inside a control", "the app shell".

A selector is read for what its key compound says about the element itself, and
when unsure, what it styles is unknown. `.a.b` lands only on elements carrying
both; a class inside `:not()`, `:is()` or `:has()`, or an attribute value, says
nothing about the element; every selector of a list counts, a CSS-in-JS nested
group's included. An interpolated compound (`${Icon}`), a class carried by an
element the index records nothing for — a project component, a tag the element
map does not name — and a project component's own inline style or template are
not shown, so a rule reaching one of them is held for review, never reported as
misapplied on the elements beside it.

**A constraint is only held against what is shown.** `requires` (and a scale
step's `on`) is satisfied when every element shown is one of the kinds; it is
violated when every element is shown to be none of them; anything else —
nothing shown, elements that disagree, a kind no markup can show, an element no
kind lists — is unknown. A kind's list says what an element is, never what it is
not: a `<div>`, a `<span>` inside a button, or a component the profile has not
read could be any kind.
`not` is violated only when every element is shown to be the forbidden kind.
Unknown is never reported. It is also never applied unattended, which is where
this meets [fixing](report.md#fixing): one candidate whose scope is off, or
unconfirmed, is held for review the way two on-role candidates already were.

The schema is validated as the profile loads, all or nothing: one malformed
entry refuses the whole block with every problem named, and `loupe` prints them.
A half-read declaration would put some of a system's tokens in scope and leave
their siblings on the generic table, which is worse than either.

## Markup scanning: two passes, two characters

1. **Structure — bindings, raw elements, composites — comes from a real AST.**
   The regex this replaced silently dropped any tag containing a nested brace
   (`style={{}}`, a handler with a block body), and the bias ran the wrong way:
   an inline-styled component is *more* likely to be an override, not less.
2. **The reference index for dead-class detection stays raw-text token
   harvesting**, and over-collects on purpose. A false "referenced" costs one
   missed finding; a false "dead" tells an agent to delete live CSS.

A file larger than `MAX_BYTES` is skipped: nothing a person wrote is that big, a
generated blob costs more to parse than every finding it could produce, and one
10MB checked-in emscripten file was on its own enough to push a repo scan past
every hook timeout. The same file is why the class-stem scanner walks
identifiers backwards from `${` by hand — the obvious
`/([A-Za-z_][\w-]*)\$\{/g` backtracks quadratically on a long run of word
characters and turned a whole-repo scan into a hundred seconds.

Other decisions in that scanner:

- **Export names are normalized before matching.** `@wordpress/components`
  publishes `__experimentalText`; matching the raw specifier against `Text`
  never hits, and `typography/in-css` silently degraded into a generic override.
- **A class needs no hyphen to be a binding.** Filtering on `-` made
  `<Text className="title">` unbindable.
- **An import finding anchors at the specifier's line, not the declaration's.**
  Every name in a multi-line import used to report on the `import {` line, so
  the one placement a reader reaches for — the comment above the offending name
  — anchored to nothing, and the placement that did work muted every other
  superseded name in the declaration under a reason written for one of them.
- **A mapped child is still a child.** The walk descends through expression
  containers, fragments and conditionals, or `{items.map((i) => <Button />)}`
  would make a list look empty.
- **A lone component is not a composition** and reporting one would drown every
  real finding in the file.
- **`Card.Root` and `Card.Header` stay dotted** in a composite tree even though
  only `Card` is imported, so they do not collapse into one indistinguishable
  node; import membership is tested against the object half.

### Substitution props

`render={ <h4 /> }` is how a design-system text component is told which tag to
emit — `as` and `component` are the same idiom elsewhere — so the element handed
to one is exempt from `system/raw-element`. The exemption follows every spelling
an ordinary refactor produces: the callback form, a block body returning one
element, the older `function` spelling, a conditional or a guard choosing
between two elements. **A spelling the rule does not follow reproduces exactly
the unsatisfiable finding the exemption exists to end** — which is why both arms
of a conditional count, and why keying on a callback's *first* statement was
wrong: `( { className, ...rest } ) => { … return <h4 /> }` is the shape a
callback takes the moment it touches its props.

Two narrowings keep it from swallowing real findings:

- **Only tag-emitting components earn it.** Not every export of a design-system
  package: `@wordpress/components` ships `FormFileUpload`, whose `render` is an
  ordinary render callback, and hand-rolled markup inside that is markup the
  author wrote. The text and layout sets are exactly the components whose job is
  emitting a tag.
- **Only a plain identifier prop name.** `render` is not a name WPDS reserved —
  react-router, Formik and Downshift all spell a render prop that — and
  `attr.name` collapses a namespace, so `xlink:render` would otherwise read as
  `render` and exempt an element no substitution prop was ever given.

Anything opaque — a variable, a call — yields nothing, which is the safe
direction: the element still reports. Anything nested *inside* the handed-over
element is markup the author wrote, and stays subject to every rule.

### Inline styles

Two React-specific conversions stand between the JSX and the rules: camelCase
property names, and bare numbers React silently suffixes with `px`. The
unitless-property list is what keeps `fontWeight: 600` from classifying as a
hardcoded length. A dynamic value yields null, because `width: [expression]` is
noise rather than a finding — but it still counts toward the element carrying an
inline style.

**An inline style is styling.** Requiring a CSS-styled class for the
`system/raw-element` gate exempted exactly the shape agents write most: a bare
`<div>` laid out with `style={{ display: 'flex' }}` and no `className` at all.

### CSS-in-JS

`keyframes` is excluded: its body is animation stops, where a literal is the
point and there is no token to reach for.

The template's CSS text is taken from `raw` rather than `cooked` — an escape
sequence in `cooked` collapses to one character and shifts every line number
after it. Interpolations are neutralized in place, as a comment where one stands
in for whole statements and as an identifier where it is part of a value or
selector; neither introduces a newline, which is what keeps the line map exact.
A bare-declaration body is wrapped in a synthetic rule, prepended without a
newline for the same reason.

An interpolation is opaque: `${({ theme }) => …}` could emit anything. A
template whose *structure* depends on one is reported as a parse diagnostic
rather than guessed at — not a finding, since a rule that fired on every one of
them would just be turned off, but recorded, so a clean report can be checked
against it.

`&:hover` on a `styled(Button)` is still that Button; a descendant selector is
some other element and must not answer for it.

## Stylesheet parsing

The analyzer used vanilla postcss for every file the `styles` glob matched, and
that glob ships with `**/*.scss` in it. A single `//` comment — line one of most
Sass files — throws "Unknown word", the file is dropped, and the only trace was a
footnote under the findings. **A Sass codebase got a clean report from a tool
that had read none of it.** Silence is the worst failure mode a gate can have.

So: custom syntaxes resolved at first use, and every file that could not be read
reported as `stylesheet/unparsed`. A machine without `postcss-scss` still gets a
working gate on its plain CSS plus an explicit finding naming what it skipped.
That is the difference between degraded and dishonest.

`postcss-scss` and `postcss-less` are declared as optional deps and imported by
*literal* specifier so the bundler can fold them into `dist/` — the only reason a
marketplace install parses Sass at all. The other two stay behind a computed
specifier: not shipped, resolved from the host's `node_modules` when it happens
to have them, reported missing when it doesn't. Resolution is cached per
extension including the failure, so a repo with 400 `.scss` files attempts the
import once rather than 400 times.

## Reading a stylesheet

- **Declarations belong to THIS rule.** postcss's `walkDecls` is recursive, so a
  parent rule sees every descendant's declarations: findings duplicate across
  parent and child, a child's `font-size` is attributed to whatever component
  the *parent* class is bound to, and a nested `display: grid` marks the whole
  parent as a grid. At-rules are transparent — a `@media` block's declarations
  still belong to the enclosing selector — but nested rules are not.
- **Bindings correlate against the key selector only.** `.card .title` styles
  `.title`, so `.card`'s component must not answer for it.
- **A `var(--x)` margin has no visible sign.** A leading `--` is a custom
  property name, not a minus: `var( --gap )` splits on the spaces prettier
  writes, and reading that as a bleed flags every tokenized margin in the repo.
- **Selector and media condition are carried on the finding** so a browser-side
  reader can resolve the rule to the elements it actually styles and say whether
  it is styling them right now. The comma-joined selector list is both what the
  author wrote and a valid `querySelectorAll` argument; the media condition is
  what `matchMedia` takes. Conditions are joined with ` and ` unparenthesized,
  which is correct for both shapes that actually occur; a comma inside one of
  several conditions cannot be combined without rewriting the query, so that
  case returns nothing and the finding reads as unconditional.
- **A sheet that cannot be read is a hole in coverage, not a diagnostic**, so it
  reports as a finding. A clean run then always means "checked and clean".

## Design-system stylesheets

`namespaces.external` recognises a library's internals by prefix, and a system
whose classes carry none — `.field-label`, `.toast-viewport` — slipped past it
entirely. No JSX binds those classes (the component renders them itself), so a
consumer rule restyling one correlated with nothing and reported nothing: **the
override most likely to break on upgrade was the one the gate could not see.**
Reading the classes out of the system's own stylesheets recognises them without
a prefix to match.

The part a library selector styles is the first class of its key compound.
Ancestors (`.dark .label`), state modifiers (`.tab.is-active`), pseudo-class
arguments and attribute values are context, not a part — harvesting them made a
project's own `.acme-tab.is-active` a "library internal" whose verdict replaced
the real findings on the rule.

`dirs` are resolved through symlinks, so a vendored library is recognised
however the project walk spelled its path — a workspace link, a different case —
and is never checked as the project's own code. Its token definitions still
count.

## Composite signatures

Component-level drift is the cheap half. The expensive half is compositional: a
codebase ends up with six page headers and four modal footers, each individually
defensible, collectively a maintenance tax nobody chose. No per-file linter can
see it, because every instance looks fine on its own — the finding only exists
across files.

A signature is the design-system component tree with everything else dropped.
Props, text and raw elements are transparent, so an intervening `<div>` never
hides a match and a prop change never invents one.

**Matching is containment, not equality**, on both axes:

- A registered pattern matches when its children appear among the subtree's
  children *in order*. A header with one extra button is still that header.
- A registered child has to appear *somewhere* beneath the root, not as a direct
  sibling in a fixed order. `form-modal` records its footer as a sibling of the
  body; real code nests the footer inside the body, and both are the same
  composition.

Demanding equality on either axis meant the rules only ever fired on code that
had already been generated from the pattern — the one case where there is
nothing to report.

**`>Name` pins a child to its parent's direct children** (in the system tree —
raw elements between are still transparent). Anywhere-beneath is right for a
shape with a distinctive component in it; for one written only in layout
primitives, `Text` and `Button` it is wrong, because a whole screen's outer
`Stack` contains a row with a label and a button *somewhere*. `screen.page#header`
and `edit-record.inspector` both fired on whole screens that way until their
inner stacks were pinned.

Each registered child must claim a distinct node, so `["VStack","Text","Text"]`
needs two Texts rather than matching one twice. Assignment is greedy, pinned
children first, then largest child first; a registered pattern is a handful of nodes, so the cases where
greedy loses to a smarter assignment do not arise in practice.

**Alternations** (`"Stack|VStack|HStack"`) exist because one shape often has more
than one spelling — `ToggleGroupControlOption` and `ToggleGroupControlOptionIcon`
are the same segmented control; the same modal footer is written with `Stack` in
new code and `VStack` in old. Without them each spelling needs its own entry, and
the ones nobody wrote come back as `unregistered-composite` noise against code
that is in fact using the pattern.

**Package qualification is opt-in per node** and narrows a match, never invents
one: an unqualified pattern node matches any package, and a tree node whose
import could not be resolved is not evidence of a mismatch. A registry scoped by
its own `packages` field needs none of it; qualification is for the project that
imports two systems at once.

**Floors.** A three-node signature like `HStack(Button,Button)` is a true
description of an action bar and a useless finding: it matched 48 files in one
repo, and "you have 48 action bars" is not a defect anyone can act on. Below the
floor a registry entry is documentation for a person, not a check. The same
floor applies to anti-shapes — a bare `SelectControl` is one node and says
nothing about whether the choice it presents wanted a segmented control.

**`avoid` takes a list or a single shape**, and a list never starts with a
string, so the leading element settles which was written. Without that,
`["Modal", ["VStack", …]]` read as four separate anti-shapes: the `"Modal"` that
gave the rest its context dropped under the floor, and the nested child survived
as a standalone shape far broader than the author asked for.

**An explicit null `canonical` opts a part out of its parent's**: a toolbar above
a DataViews is not "using DataViews" the way a row of `Navigator.Button`s is
using Navigator. And a `canonical` is matched against a file's local import
names, so it has to be a name the code binds — a part written as
`Navigator.Button` can never be one.

Both registry formats load through the same reader. v1 keys an entry by `id`
with one `signature`; v2 keys it by `pattern` (`id.variant` or `id#part`), may
nest `parts` and `rendered_signature`, and says in `detector` how it is checked.
The fields the matcher needs are the same, so a registry written before v2
existed keeps working. In `detector`, a bare string is documentation of how the
entry is checked and nothing acts on it; only an object carries parameters a
shipped rule runs with.
