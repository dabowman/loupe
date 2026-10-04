# Design notes: the checks

Why each rule decides the way it does. The rules themselves are documented in
[the engine README](../../engine/README.md#rules); the decision chain each one
runs is stated at the top of its file in `engine/src/checks/`. This file is the
reasoning behind those chains — the failures that shaped them, and what would
break if they were simplified.

A theme runs through all of it: **the expensive failure is almost never the
missed finding.** A rule that misses one override costs one override. A rule
that reports a false one sends an agent to change code that was correct, and on
a weaker model that turns into a loop. Every asymmetry below resolves in that
direction.

## `layout/margin-on-child`, `layout/negative-margin`

The original rule fired on every margin, which sounds right — the design system
ships no margin token, so margin is never the sanctioned way to space things.
But the majority of real margins in a codebase have no `gap` remedy at all:

    margin: 0            a reset. There is nothing to move to a parent.
    margin: 0 auto       horizontal centering. `gap` cannot express it.
    margin-inline: auto  same, logical form.

Reporting those trains everyone to reflex-suppress the one rule that matters
most, and a habitually suppressed rule is an off rule. So zero and `auto` are
claimed and passed rather than left to the next check.

Negative margins split out on their own: a bleed is a real technique, so it
warrants a "confirm this" rather than the "move it to `gap`" remedy, which
would be wrong advice.

## `layout/in-css`

Collapsed to one finding per CSS rule. `display:flex; flex-direction:column;
align-items:center; gap:8px` is four findings for a single decision — replace
this with a layout primitive — and a real repo produced 702 of them. Four times
the report buys nothing, and a rule that floods the report crowds out every rule
with a cheaper remedy. See [whole-rule findings](analysis.md#whole-rule-findings).

## `system/override`

Restricted to appearance properties, and — per declaration — to the ones the
component owns; see below. Layout and box-model props are deliberately
excluded: on a layout primitive that exposes no padding or per-child sizing prop,
a styling-hook class carrying them is the *intended* usage, not an override, so
flagging them just manufactures suppressions.

It supersedes the ordinary verdict on a declaration, so it has to step aside
when it is off. On a headless library a class on a component is how you are
meant to style it — and the `background: #fff` still owes its token, so the
declaration must fall through to `tokens/hardcoded-value` rather than vanish.

### It blocks only where the component owns the property

The rule used to fire on any appearance property on any class bound to a
component. Its remedy — restyle via the props — was then false most of the
time: `@wordpress/ui`'s `Text` has one styling prop, `variant`, and no colour,
letter-spacing or text-transform axis at all, so `<Text> ← color` offered a
prop that does not exist, and the only exits were a suppression or the
baseline. Worse, it punished taking the tool's own advice. `<h4
className="rp-title">` with a colour, a text-transform and a letter-spacing
was three advisory findings; converting it to `<Text render={ <h4 /> }>`, as
`system/raw-element` asks, turned the same unchanged CSS into three blocking
ones. On a real plugin that conversion cost 41 new blockers, none with a prop
to move to, and the session ended by baselining all of them.

`className` is a public prop on both WPDS and Base UI — the sanctioned
styling channel, not an override. So a declaration only blocks when the
component *owns* the property: its own styles set it on the element the class
lands on, or a prop does. That is what the component registry's `surface`
records per entry:

```json
"surface": {
  "properties": { "font-size": "variant", "border-radius": null, "color": ["variant", "tone"] },
  "verifiedAgainst": "@wordpress/ui 0.23.0 (npm), src/text/text.tsx and style.module.css, read 2026-10-02",
  "note": "where className lands, and anything a reader needs to act on it"
}
```

Each listed property maps to the prop (or props) that controls it, or to
`null` where the component sets it and no prop does. The finding says which:
`<Text> ← font-size — set via its variant prop`, or `<TextControl> ←
font-size — it sets this itself and has no prop for it`. The second is still
blocking — that is the declaration most likely to break on a version bump —
but it no longer sends anyone to look for a prop; the decision it leaves is
keep the component's styling, or suppress with the reason the design needs
otherwise. A property the surface does not list falls through to the verdict
the declaration would get on a plain element: `tokens/hardcoded-value` or
`typography/untokenized`, advisory. Shorthands overlap their longhands both
ways, so a surface owning `border-color` owns what `border: 0` would reset,
and `font` reaches `font-size`.

**No surface fails safe.** An entry without `surface` — or a component the
registry does not list — has not been read for one, and a blocking finding
that promises a prop nobody checked exists is the failure above. Its
declarations get the plain-element verdict. `"properties": {}` is different:
it is a verified answer that the component owns nothing there (`Stack`,
`Field.Root`, every `@wordpress/ui` `*Control` root), and it is recorded so
that absence keeps meaning "unreviewed". The cost is that a project or a
profile with no surfaces gets no per-declaration blocking at all until someone
reads its components; that is the right way round for a rule at `error`.

**A surface describes one element.** It is what the component styles where its
`className` lands — for most `@wordpress/components` controls that is
`BaseControl`'s wrapper around label, input and help, not the input, so
`border` on a `TextControl` class is a border around the whole field and owns
nothing. A compound part is its own element: `Card.Content` does not inherit
the surface `Card` records (for `Card.Root`). Reaching past that element into
the component's internals is the whole-rule form below, which needs no surface.

**`typography/in-css` reads the same surface.** Being a declared text
component is the claim that it owns its type; a recorded surface narrows the
claim. `Text` sets family, size, line height and weight through `variant` and
never sets `letter-spacing`, so a letter-spacing on a `Text` class is
`typography/untokenized` again. With no surface recorded, a text component's
type declarations still report as before — `designSystem.components.text` is
itself a declaration, which `APPEARANCE_PROPS` never was.

The surface lives on the component registry entry, beside currency, rather
than in the profile: it is a fact about one component in one package, read
from that package's source, and it carries its own provenance because it is a
separate reading from the currency one.

**A project prefix wins over a library one** in the whole-rule form.
`wp-parsely-*` matches the `wp-` external prefix, and reporting a project's own
class as a library internal sends the agent to fix something it does not own.

## `system/raw-element`

A `styledOnly` mapping only earns its suggestion when the element is doing what
the suggested component is for. `<span>` → `<Text>` needs styling of any kind;
`<div>` → a layout primitive needs the div to actually lay something out.
Accepting any styling for both told agents to turn every bordered `<div>` into
an `<HStack>` — the largest single source of findings in a real repo, and wrong
nearly every time.

**The analog is forwarded through the component registry.** The element map is
keyed by tag and names a bare component; the registry is keyed by package and
knows currency. Nothing reconciled them, so on a two-package system the two
rules contradicted each other: `system/raw-element` said `<h3> → <Heading>`, and
doing that earned a `system/superseded-component` saying `Heading` is legacy. An
agent that follows the first finding manufactures the second, which is a loop a
weaker model can run forever.

Forwarding happens only when *every* package carrying the name is stale, so a
component that is legacy in one package and recommended in another (WPDS has
several) keeps its name, and the finding names the package whose entry is
`recommended`: `<input> → <InputControl> (@wordpress/ui)`, not a bare name that
is equally the legacy `@wordpress/components` import. With no single
recommended entry the name stays bare.

**An element can be keyed by an attribute.** `<input>` is a dozen controls, and
the tag alone would send a checkbox to `InputControl` and flag
`type="hidden"`, which has no visual analog. A mapping may name an `attribute`
and a `values` table (`null` = no analog); only a value the source states
outright is read, so a computed `type={ t }` falls back to the element's own
analog. This is what a parser buys over a tag regex: wpds-guard, the
regex-based check this coverage came from, flags hidden inputs and offers every
input control at once.

**An element can keep its semantics.** A heading's analog is not `Text`
alone: on WPDS it is `Text` rendered as the heading, and a bare component name
leaves the agent to research the rest. A mapping may name a `render` element,
and the suggestion carries it — `<h4> → <Text render={ <h4 /> }>`. The variant
is deliberately not mapped: WPDS separates the tag (structure) from `variant`
(visual size), and pinning one to the other would re-couple them.

**Every analog must be one the registry recommends.** A test fails, per shipped
profile against its own preset, when an element-map name is unknown to the
registry or only `legacy` there, so a suggestion cannot outlive the component
it names. Forwarding hid the drift rather than preventing it: `h1`–`h6` →
`Heading` read fine with the registry loaded and sent a preset-only project to
`__experimentalHeading`, a private API. Keeping the registry current against
trunk is the other half.

The variant is left to `--judge`; see [judge.md](judge.md#which-variant).

## `system/inline-style`

One finding for the attribute supersedes the per-declaration ones. The remedy is
"use the props", not "tokenize that value" — the same way a library-internal
override supersedes advice about how to style it.

Dynamic parts (a spread, a computed key, an identifier value) produce no
per-declaration finding, since naming a property whose value is unknown is
noise, but they still count toward the element carrying an inline style, which
is what this rule keys on.

## `system/locked-component`, `system/superseded-component`

**`experimental` entries never fire.** WPDS itself flags those as not-yet-safe
to recommend, so the call is contextual rather than mechanical, and belongs in
the authoring skill, not a blocking check.

**A replacement the registry itself would not recommend is not a replacement.**
If every candidate named in `supersededBy` is itself `locked` or `experimental`,
the finding is withheld. `DropdownMenu` is the shipped case: `Menu
(@wordpress/components)` is core-only and `Menu (@wordpress/ui)` is in flux, so
the finding asks for a migration onto an API nobody should adopt, and the only
answer available to whoever gets it is a suppression restating what the registry
already records. This is the same judgement `experimental` status already earns
on the *import* side, applied to the replacement instead.

Two narrower rules inside that check:

- **Unknown to the registry is not a reason to stay silent.** The registry
  records currency, not existence, and a name it has never heard of is far
  likelier to be a real component than a retracted one.
- **A compound component's currency is its root's.** `Menu.Group` is not its own
  entry, so the lookup falls back to `Menu`. Without it the dotted subcomponents
  of a locked component read as unknown, and `MenuGroup` and `MenuItem` went on
  demanding a migration their parent was spared.

`supersededBy` is prose — `Stack (@wordpress/ui, direction="row")`, or a
sentence naming two candidates and when each applies — so candidates are read
off it rather than parsed. A string that names none ("CSS grid or absolute
positioning") yields nothing, which is the honest answer: the remedy there is
hand-written, not an import swap.

The finding anchors at the import, one per file, so the `×N` use count is what
says whether this is a one-line edit or a dozen call sites — the question an
agent otherwise answers by grepping the file. The registry `note` is carried on
the finding rather than concatenated into the message, because the finalize pass
caps `message` and a note spliced into it lost its own last clause in every
format at once. `scopeLines` covers the declaration line and the one above it:
both were live suppression anchors when every specifier reported on the
declaration, and a directive someone signed off must not go silent because the
reporting moved.

### A same-name move is not a drop-in move

`system/superseded-component` offers no fix, and `dropIn` on a registry entry is
what would license one.

Eight of the twenty-nine `legacy` entries name a replacement with the same
exported name in the other package — `Text`, `Card`, `Icon`, `Spinner`,
`Tooltip`, `VisuallyHidden`, `TextareaControl`, `InputControl`, all
`@wordpress/components` → `@wordpress/ui`. A matching name is what makes a
mechanical rewrite *look* available, and it is the only thing about those eight
that is mechanical. The rest need a new prop, a structural rewrite or a
judgement call, and nothing claims otherwise.

**`dropIn` is the claim that moving the import changes the specifier and nothing
else.** Every prop the old component accepts, accepted by the new one with the
same meaning; no prop the new one requires that the old one did not; the same
default element and the same rendering. A renamed prop, a changed default, a
dropped prop, a component that became a namespace, a class or a margin that went
away — any one of those disqualifies the pair, because the failure it produces
is a component that renders differently everywhere it is used, with a diff that
reads like a one-line import tidy.

**The evidence is both implementations, read.** The replacement's own props file
and its stylesheet, against the same two for the component being replaced. Not
the names matching, not the registry's own `supersededBy` prose, and not the
design-system MCP — which carries no maturity signal at all and is measurably
behind trunk. Where the source does not settle it, the answer is no. There is no
`false` to record, because a verified no and nobody having looked have to leave
the same trace: a fix that fires on a recorded guess is the failure this field
exists to prevent.

**No WPDS entry carries it.** All eight were checked against Gutenberg trunk at
037f7ed and all eight failed, for reasons that are not close calls: `Card` and
`Tooltip` are namespaces in `@wordpress/ui` (`Card.Root`, `Tooltip.Trigger`), so
the old element does not render at all; `Text` keeps the name `variant` for an
entirely different set of values; `Icon` requires an SVG element where the old
one took a Dashicon name or a component; `VisuallyHidden` swaps polymorphic `as`
for `render`; both form controls require `label` and changed `onChange` from the
value to the event; and `Spinner` — the one pair whose props do line up — drops
the `components-spinner` class, the `width`/`height` attributes and a
`margin: 5px 11px 0`, which moves every call site.

So the licence exists and holds nothing, and the import-rewriting machinery it
would license is not built: see [report.md](report.md#moving-an-import-is-not-a-substitution).
Populating this field is the whole of the work, and it is not a reading of the
registry — it is a reading of the design system.

## `typography/in-css`, `typography/untokenized`

`typography/in-css` supersedes the ordinary verdict — `font-size: 13px` is
otherwise `typography/untokenized` — so it, too, steps aside when it is off.

`typography/untokenized` claims every type property and passes inert values.
`font-family: inherit` and `line-height: 0` are not untokenized type styling:
there is no token that means "whatever the parent said", and a rule that demands
one for every reset is a rule people turn off.

## `tokens/hardcoded-value`

Last in the chain, so any property an earlier check claimed has already had its
verdict. The finding carries the declaration as a hint rather than a remedy; the
analyzer's token pass names the token that carries the value, and `--judge`
settles the ones no single token does. See [tokens](analysis.md#the-token-set).

## `tokens/unknown-token`

Runs only once every stylesheet has been read: a set that is still being built
reports the design system's own tokens as unknown. **An empty set means nothing
was found to check against, not that every token is unknown**, so it reports
nothing at all rather than everything.

The message is the bare name. The `var()` wrapper was the same on every line of
the group, and the rule's title already says a token is what is being named —
with the replacement beside it where one is settled, so a reader sees what
`loupe fix` would write without running it.

One finding per file and name, carrying **every** line that names it, because
the known token set is right here and a name nothing defines is usually a
misspelling. Where exactly one known token is one keystroke away, and that
keystroke is not a digit, the finding carries the rename and `loupe fix` applies
it on all of those lines. Where two are, or none is, it carries where the name is
written instead, and `--judge` asks which real token was meant — see
[judge.md](judge.md#which-token-was-meant-judgetokents). Unjudged, it stands for
a reader. The defence of that threshold — and why a scale step is
never read as a spelling — is in [fixing](report.md#fixing).

## `css/dead-class`

The reference index over-collects on purpose (see
[markup scanning](analysis.md#markup-scanning-two-passes-two-characters)): a false "referenced"
costs one missed finding, a false "dead" tells an agent to delete live CSS.

The remedy is a deletion, which is why it is the one finding the editor offers
a quick fix for that `loupe fix` refuses — see [deleting is the editor's
alone](report.md#deleting-is-the-editors-alone).

The finding carries its selector, which is the verdict restated as a question a
browser can answer. This rule's expensive failure — the reference index missing
a class built at runtime — is invisible in the source and obvious in a page,
where the class is sitting on three elements. Carrying the selector is what lets
`loupe serve` show the rule being wrong.

## `patterns/duplicate-composite`, `superseded-composite`, `unregistered-composite`

The only findings that cannot exist in one file. A sixth bespoke page header is
not a defect anywhere in particular — it is a defect in the set, which is why
the index is whole-repo even when the report is scoped to one file. The matching
machinery is in [analysis.md](analysis.md#composite-signatures); what follows is
how the counting is decided.

**Largest match wins for a registered pattern.** A page header contains an
action bar, and reporting both says the same thing twice at two levels of the
same tree.

**Smallest wins for an anti-shape**, the opposite. Containment means an outer
wrapper matches whatever its children match, and the whole form's tree is a
worse answer to "where" than the one field that should have been a `Field`.

**Ties between anti-shapes go to the most specific one that matched**, not to
the largest replacement. A pattern's own `size` says nothing about how well its
anti-shape fit, and ranking by it means the smallest entry in the registry can
never win a tie it deserves.

**An already-imported `canonical` means the file is using the pattern, not
rebuilding it** — and, beside an anti-shape, that the clunky version is
deliberate.

**Anatomy is not composition.** An anatomy entry matches from the component's
root down, but a file that renders only a row or a popup cuts the same anatomy
lower: `TableRow(TableCell,TableCell,TableCell)` is a Table's parts, not a
composition anyone chose. Only a tree of *nothing but* parts is excluded — a
`DialogPopup` holding a form is still the form.

The thresholds:

| rule | floor | why |
|---|---|---|
| `duplicate-composite` | 2 files | one is just the first use |
| `superseded-composite` | 1 file | a wrong choice made here, not a duplication across the set |
| `unregistered-composite` | 3 files | nothing says the second one was wrong; a third means it is the house style and belongs in the registry |

A detector hit is the same finding from below the four-node floor: the file in
hand made the choice the entry exists to replace.

Where no `canonical` is recorded there is nothing to import yet, so the remedy
reads "extract one shared implementation" — telling an agent to import it would
send it looking for a module that does not exist.

These rules lead with a signature and close with the remedy, and a signature is
as big as the tree it describes — a five-column card runs past the line bound on
its own. The remedy goes in `suffix`, which that bound is built to spare: eliding
the shape still names the file count and what to do about it, where eliding the
end left neither. See [message bounding](report.md#bounding).
