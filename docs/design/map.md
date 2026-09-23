# Design notes: `loupe map`

Why the token-set mapper is shaped the way it is. What it *does* is in
[the engine README](../../engine/README.md#mapping-one-token-set-onto-another);
the request it posts is written out in full at the top of
`engine/src/judge/counterpart.ts`.

**This one is an experiment, and none of its tuning is measured.** Every other
number in [judge.md](judge.md) has an eval behind it and a command that
reproduces it. The weights and the floor here were chosen by argument. They are
written down so the argument can be checked, not because they are right.
[Two real pairs](#what-two-real-pairs-look-like) say the thing works and that it
is self-consistent, and say nothing about how often it is right — see
[what is not settled](#what-is-not-settled).

## The question it answers

Given a token in set A, which token in set B is the same decision?

Answer that for every token and two design systems become comparable. A design
expressed in one can be read in the other, a migration has a lookup table
instead of a spreadsheet, and the decisions B has not made are exactly the rows
that come back with no counterpart.

Nothing else in loupe works across two systems. The checks all ask "does this
code conform to *its* design system"; profiles exist so that several systems can
each be that one system. This asks a question with two systems in it, which is
why it is a command of its own rather than a rule.

## It reads the authored sources, not the compiled ones

`tokens.ts` reads the other kind of token set: the CSS custom properties a
system ships compiled, which is what a stylesheet can reference and therefore
what `check` needs. `dtcg.ts` reads the DTCG JSON those are generated from.

The compiled form is no good here. `--wpds-color-fg-primary: #1e1e1e` has lost
the `$type` that says a colour is never a duration's counterpart, the
`$description` that is often the clearest statement a set makes about a token's
role, and the alias chain that says which tier it belongs to. Mapping compares
roles, and the role is exactly what compiling throws away.

The cost is that the two readers can disagree about what a system contains, and
nothing checks that they agree. It has not mattered yet because no command uses
both.

## Nothing is configured per system

The premise is that two sets agree on the spec and on nothing else — naming,
grouping, depth, which draft they were authored against, whether they write
tiers down at all. So every system-specific thing the mapper needs is inferred
from the set rather than declared beside it. There is no profile for a token
set, and adding one would defeat the point: the sets worth mapping are the ones
nobody has written a profile for.

Three things get inferred.

### `$type`, where a set leaves it off

Required by the current spec, optional in everything authored before it. A set
with no types at all would put every token in one pool and compare a colour
against a duration, so `inferType` guesses from the value's shape. Where the
shape says nothing the type is empty, and only tokens equally untyped are
comparable to it.

A token that declares no type of its own takes the first one declared along its
alias chain: a semantic token that omits `$type` and points at a colour is a
colour. That comes ahead of its group's `$type`, which is the spec's order: a
group type only reaches a reference whose chain declares none.

### The value, across two drafts of the spec

A dimension was `"16px"` and is now `{ value: 16, unit: "px" }`. A colour was a
hex string and is now `{ colorSpace, components, alpha }`. A real pair of sets
is as likely to straddle that change as to sit on one side of it — WPDS and
Primer do — so both forms render to one string and the draft never reaches the
comparison.

Colours render to hex from every space that reaches sRGB without a colour
library: `srgb`, `srgb-linear`, `hsl`, `hwb`. This is not cosmetic. **Primer
authors its palette in `hsl` and WPDS authors its own in `srgb`**, and before
the conversion existed every cross-system colour pair scored zero — the
shortlist for a pale-red error surface came back as eight ANSI terminal colours
in alphabetical order, because with every score tied the tie-break was doing all
the work. A space this cannot convert (`oklch`, `display-p3`) renders as
`color(space …)` and compares on equality alone, which is worse than a
conversion and better than a guess: a converted-by-guesswork value would rank
*as though it had been measured*. The older string spellings — `hsl()`, `hwb()`,
`rgb()` and the names `white`, `black`, `transparent` — measure through the same
conversion, so the draft does not decide whether two colours can be compared.

A set that publishes its own `hex` beside the components is taken at its word.
Recomputing it only introduces a rounding difference between the map and the CSS
the system actually ships. Alpha is the exception: the spec keeps it out of the
six-digit hex, so it is appended, or every translucent colour would read as
opaque.

### The tier

**The tier is a fact about meaning, not about structure.** Does a token apply to
one component, or does it hold everywhere? Nothing about how a file is wired can
settle that, so this reads what the set *says* and otherwise answers `unknown`.

Two things count as saying it. The folders the file sits in come first: a set
laid out as `base/ common/ component/` has made a deliberate statement about
every file in it. Then a tier word in the token's own path, which is all a
single-file set has.

Folders win over path words because a word in a path may be *describing* the
token rather than placing it. Primer's `display.blue.scale.0` lives in
`functional/` and is a scale of colours, not a declaration that it is a
primitive; reading the path first filed 190 of Primer's functional tokens as
base on that one word. A tier word in the leaf never counts at all —
`color.background.base` is a semantic token whose own name happens to be `base`.

On the three real systems this reads: Archer 954/954, Primer 1488/1488, and WPDS
165 tokens named (it declares `primitive` in the path) with 169 unstated.

#### Alias depth was a bad proxy and is gone

This used to fall back to counting aliases — a literal, a reference to a literal
and a reference to a reference as the three tiers restated. It was wrong in both
directions.

It read Archer's `button.padding: {space.s}` a tier too shallow, because spacing
skips the common tier: 177 of Archer's 644 component tokens landed in the wrong
tier, inside files whose every token is a component token.

Worse, the inference has the interesting case backwards. A component token that
merely re-aliases a common one is barely a token at all — if the common token is
what gets used, the component token is not earning its place. The component
tokens that *do* earn it are exactly the ones reaching past the common tier for a
different primitive than it offers: the deepest chains by that reasoning, and
often the shallowest in fact.

So an unstated tier is now `unknown`, and `unknown` is never agreement — two sets
that both failed to say have not said the same thing. The model is told the tier
where the set declared one, and left to read the name and the description where
it did not.

## Arithmetic first, judgement second

The same division [judge.md](judge.md) makes everywhere: narrow in code, ask the
model the half code cannot do.

Neither half is worth much alone. Names across two systems are related by
meaning and not by spelling — `color.text.primary` and `content.default.fg` are
one decision with no word in common, while `color.text.primary` and
`color.border.primary` share two words and are unrelated. Values agree by
coincidence as often as by design. And the model asked to read 1,488 options is
not being asked a question anyone can answer.

So the ranking narrows a set to eight candidates and the model picks among them,
reading each option's tier, value and `$description`.

**`$type` is the only hard gate.** It is the one thing the spec makes both sets
say in the same words. A colour is never a duration's counterpart, and admitting
the pair costs an option in every shortlist. The exception is a set that writes
its spacing scale as bare numbers, which means `dimension` and says so in a
different draft.

### The weights

| tier | value | name |
|---|---|---|
| base | 0.75 | 0.25 |
| semantic | 0.35 | 0.65 |
| component | 0.30 | 0.70 |

A primitive *is* its value: two palettes are comparable by colour long before
they are comparable by whatever each calls its greys. A role is a name: two
systems that both have a default text colour will have rounded it differently,
and the value is the weaker signal of the two.

Colour distance is Euclidean in OKLab. Distance in sRGB is not the question
anyone is asking — `#000`→`#111` and `#ee0000`→`#ff0000` are the same distance
there and nothing alike to a reader. The falloff is hyperbolic rather than
linear because the pairs worth separating are all bunched near zero: `1 - d`
scores "the same grey, rounded differently" and "a different grey" within a few
points of each other.

Names are compared as word sets, after dropping the tier words and the type's
own name. One set writing `primitive.color.blue` and another writing
`color.blue` have said the same thing, and counting `primitive` as a
disagreement penalises the pair for how the two files are organised. Dropping
the type word matters more than it looks: every colour token in a set has
`color` somewhere, so counting it adds the same constant to every candidate and
separates none of them — and `$type` has already gated the comparison on exactly
that fact. The leaf carries its own weight on top, because it is where two
systems most often agree outright.

## Two rows are settled without a model

The same reasoning as `judgeValues` answering "no token for this property"
without one: there is no question to put.

**A path that exists verbatim in both sets, at a comparable type**, is its own
counterpart. Two systems that agree on the whole path have agreed, and putting
that to a model is paying for a lookup. A set mapped onto itself therefore costs
nothing, which is the invariant `tests/map.ts` checks.

**A token whose type the other set has none of** has no counterpart to choose
among. Saying so is a fact about the second system, not a judgement about this
token.

## The escape hatch is worded as a decision

`none` says the second system *models this differently or not at all, and a port
would have to add a token* — not "none of these looked close". The wording is
the same lesson as `keep` in `judge/value.ts` and `not_text` in
`judge/variant.ts`: an escape hatch that reads as "no exact match" collects every
hard call, and the option name is sent to the model too, so it has to say what
it means.

## An answer outside the shortlist is refused

Recorded as `unsure`, not written into the map. A path the target set may not
even have is worse than no answer, because everything downstream of a map treats
its right-hand column as real tokens.

Under the floor is also `unsure`, and `unsure` is deliberately not the same
outcome as `none`: one is a row to look at by hand, the other is a claim that
the second system is missing something. Collapsing them would turn every
uncertain reading into a false gap in the target system.

## A failed request fails the whole run

Nothing partial is written. Half a map read as a whole one reports every unasked
token as having no counterpart, which is the same failure mode as an empty token
set being read as "no token for anything" — the case `judgeValues` refuses
outright.

## `--dry-run` is the half that is free

It prints the shortlists and asks nothing. This is the first thing to look at on
a new pair of sets, because **a shortlist that does not contain the right answer
cannot be rescued by the model.** It is also what caught the `hsl` bug above:
the ranking was visibly wrong on real data long before anything was spent asking
about it.

## What two real pairs look like

Three runs, all on systems' own published sources. WPDS
(`packages/theme/tokens`) and Primer (`@primer/primitives`) read as DTCG
directly; Atlassian (`@atlaskit/tokens`) publishes Style Dictionary artifacts
and was converted, keeping `original.value` as a DTCG alias so its palette and
its roles stay two tiers rather than collapsing into one.

| run | tokens | semantic tier judged | collisions |
|---|---|---|---|
| WPDS → Primer | 334 → 1,488 | 76 / 128 (59%) | 29 targets, 92 claims |
| Primer → Atlassian | 1,488 → 463 | 215 / 547 (39%) | 109 targets, 458 claims |
| Atlassian → Primer | 463 → 1,488 | 83 / 154 (54%) | 28 targets, 84 claims |

**Size ratio moves the result more than naming does.** Atlassian and Primer have
much more similar token models than WPDS and Primer — both name roles as
foreground/background/border with subtle/subtlest gradations, where WPDS uses a
tone × emphasis matrix — and yet mapping Primer *onto* Atlassian settles worst of
the three. Mapping 1,488 tokens onto 463 forces a collapse: 109 Atlassian tokens
absorb 458 Primer ones, `color.border` alone claiming 48. Reverse the same pair
and the semantic tier goes from 39% to 54%. When comparing two systems, run the
small one onto the large one, or read the collisions as the answer.

**A tier the other system does not have is answered, not guessed at.** Primer
has 276 component tokens and Atlassian has none; 84 came back `none` — including
every `button.primary.*` — rather than being forced onto a semantic token.

**The base tier does not map, in any of the three runs** (24–31%). Two palettes
of near-identical tints do not have counterparts; two sets of roles do. This is
the floor working, not failing.

### The two directions agree where they can

Running a pair both ways is the only validation available without hand labels,
and it is worth doing. Of 257 rows where both Primer → Atlassian and
Atlassian → Primer settled on a counterpart:

| | |
|---|---|
| agreed outright | 63 (25%) |
| differed, target claimed by several | 192 (75%) |
| **genuinely disagreed** | **2 (1%)** |

**Read the 25% correctly.** The 192 are not contradictions: Atlassian has one
`color.border` where Primer has dozens, so the reverse run can only name one of
them and picks the canonical one. Where the relation really is one-to-one the
two runs — independent, over different candidate pools, in opposite directions —
agree on **63 of 65, 97%**. Both exceptions sit at 0.51 and 0.72, which is the
floor being generous rather than the answer being wrong.

So round-trip agreement is a good **precision** signal and a bad recall one. A
mutually confirmed pair is close to certain:

```
borderColor.default                   <-> color.border                            0.99/0.99
bgColor.disabled                      <-> color.background.disabled               0.99/0.98
prettylights.syntax.markup.deleted.bg <-> color.background.code.removed.highlight 0.99/0.99
borderRadius.default (6px)            <-> radius.medium (6px)                     0.96/0.96
bgColor.attention.muted               <-> color.background.warning                0.98/0.93
```

Nothing in the tool does this yet — the two runs were diffed by hand. A
`--confirm` that ran the reverse and marked the agreeing rows would turn it into
a property of the map.

## What context a judgement needs

`evals/counterparts` scores this. A real set is renamed into a different
convention, its descriptions paraphrased, its values nudged, and a fifth of its
tokens held back so their true answer is `none`; the labels are facts about the
transformation rather than opinions about design. Read `rename.ts` for what that
does and does not simulate — mechanical paraphrase leaves the two sides'
descriptions more alike than two real systems' would be.

Two numbers per arm. **Ceiling** is how often the true counterpart was on the
shortlist at all — free to compute, and a hard cap. **Accuracy** is how often the
model then picked it, scored on the raw answer so the floor is not being measured
too.

### The ranking was the bottleneck, not the question

`archer-common`, 63 tokens, whose values are unresolved aliases so the ranking
has only names to work with:

| options offered | ceiling | accuracy |
|---|---|---|
| 4 | 37% | 37% |
| 8 (the old default) | 37% | 37% |
| 16 | 45% | 45% |
| 32 | 69% | 69% |
| all 49 | **100%** | **98%** |

**Accuracy tracks the ceiling exactly, in every arm of both substrates.** The
model picks correctly essentially whenever the answer is in front of it, and
more options do not confuse it — the premise that a short list makes the question
answerable was simply wrong. Eight candidates were throwing away the answer 63%
of the time and the model was being blamed for it.

On the real WPDS-to-Archer pair the cost was plain: at eight options `map`
reported **61 of 106** tokens as having no counterpart; at full choice, **18**.
Forty-three false gaps, none of which the model ever had a chance to avoid.

So the shortlist now exists only because a request has a size limit. 253 options
fit in one question at the measured average option size, and {@link CANDIDATES}
is 200 to leave room for longer descriptions. A set smaller than that is sent
whole. The wider shortlist splits the probability mass, so more rows land under
the floor — on that pair, 34 `unsure` against 4. That is the honest trade: an
unsettled row is a row for a person, where a false `none` is a wrong claim about
the second system. The floor itself has not been re-measured against the wider
list, and should be.

### The description carries the meaning; most of the rest is inert

`primer-semantic`, 92 tokens, whose ceiling is 97% at eight options so the
differences are attributable to the question rather than to the shortlist:

| arm | accuracy | false `none` |
|---|---|---|
| everything `map` sends | 97% | 3% |
| description only (no name) | 97% | 3% |
| name + description | 96% | 4% |
| **name only** | **53%** | **41%** |
| full − description | 73% | 8% |
| full − siblings | 97% | 3% |
| full − value | 97% | 3% |
| full − tier | 97% | 3% |

The `$description` is the load-bearing field. Without it the arm drops 24 points;
with nothing else it loses nothing. A name on its own is not enough — and its
failure mode is the bad one: 41% of the time it declines when a real counterpart
exists, so a set whose tokens are thinly described will quietly report gaps that
are not there.

Siblings, value and tier each cost nothing to remove. They stay for now because
both substrates are single-type colour sets, where the tier is constant and the
value is weak by construction; neither is evidence that they are inert on a set
that spans types. The type gate is untestable for the same reason and its row is
not reported here.

## What is not settled

- **The floor is still an argument.** `evals/counterparts` now measures the
  context and the shortlist width, but 0.5 was chosen before the shortlist grew
  to 200 and the wider list demonstrably pushes rows under it. The tier weight of
  0.2 and the value/name weight table are likewise unmeasured — and the two
  substrates are single-type colour sets, so neither can say anything about the
  type gate. The
  runs above say the thing works, and round-trip agreement says it is
  self-consistent; neither says how often it is *right*, because nobody has
  labelled it. A few hundred hand-checked pairs is what would turn every number
  here into one — and the 63 mutually confirmed pairs are the obvious seed.
- **One direction only, and the reverse run is worth having.** Collisions show
  where the relation collapses into B; nothing shows a token of B that no token
  of A reached. The measurement above says the reverse run is also the best
  precision signal there is, and it is not built in.
- **Modes and themes are ignored.** A token's value is its first definition, and
  a set with light and dark variants contributes whichever it declares first.
  For Primer that means one theme's colours stand for all of them.
- **Strict JSON only.** Primer authors its sources in JSON5, which this cannot
  read; the verification runs went through a conversion step. Whether to take
  the dependency is open.
- **`$extends` and `$ref` are not read.** A group's `$root` token is, but a
  group that inherits through `$extends`, or a token written as a JSON-pointer
  `$ref`, is missing from the set, and rows that should land on it come back
  `none` or `absent`.
- **Composites are compared as JSON.** A typography or shadow token renders as
  its own JSON and matches only on equality, so those rows lean entirely on the
  name and the model.
