# Design notes: `loupe map`

Why the token-set mapper is shaped the way it is. What it *does* is in
[the engine README](../../engine/README.md#mapping-one-token-set-onto-another);
the request it posts is written out in full at the top of
`engine/src/judge/counterpart.ts`.

**This one is an experiment, and none of its tuning is measured.** Every other
number in [judge.md](judge.md) has an eval behind it and a command that
reproduces it. The weights and the floor here were chosen by argument. They are
written down so the argument can be checked, not because they are right.
[One real pair](#what-one-real-pair-looks-like) says the thing works and says
nothing about how often it is right — see
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
colour.

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
*as though it had been measured*.

A set that publishes its own `hex` beside the components is taken at its word.
Recomputing it only introduces a rounding difference between the map and the CSS
the system actually ships.

### The tier

A named tier wins. A set that groups under `primitive/` has said outright what
those tokens are, and no structural signal should overrule it.

The name has to appear **above the leaf** to count. `color.background.base` is a
semantic token whose own name happens to be `base`, and reading that as a tier
files every "base" and "core" variant of every scale as a primitive.

Otherwise the alias depth answers, because a literal, a reference to a literal
and a reference to a reference are the three tiers restated. It is the weaker
signal — a set whose semantic tokens alias each other reads one tier too deep —
which is why the tier is evidence and never a gate. It is worth 0.2 of the
score, and a cross-tier candidate is still offered.

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

## What one real pair looks like

WPDS's own DTCG sources (334 tokens, 5 files) mapped onto Primer's (1,488
tokens, 63 files) — two systems that share the spec and nothing else. The whole
run took 14 seconds.

| | judged | no counterpart | under the floor |
|---|---|---|---|
| base (206) | 62 | 8 | 136 |
| semantic (128) | 76 | 14 | 38 |

Three things in that table are worth reading.

**Semantic tokens map and base tokens mostly do not.** 59% of the semantic tier
settled against 30% of the base tier, and the base colours alone are 27 of 155.
This is the result behaving correctly rather than failing: WPDS primitives are
`primary.surface1…5`, `error.surface1…5` — five near-identical tints per tone —
and Primer's palette has dozens of entries equally close to each. The
probability mass genuinely splits, and a confident answer there would be a
worse outcome than an uncertain one. Two palettes mostly do not have
counterparts; two sets of *roles* do, and the roles are what makes the systems
comparable.

The temptation is to lower the floor to make the number look better. Don't
without an eval: the median unsettled row sits at 0.27, and dropping the floor
to 0.4 recovers 31 rows of the 174 while admitting every near-tie with it.

**The model bridges naming gaps that nothing else could.** WPDS's `info`
surface maps to Primer's `bgColor.accent.muted` and its `warning` to
`bgColor.attention.muted` — right, and unreachable from either the names or the
values alone.

**The map is not one-to-one, and that is the interesting part.** 138 judged rows
land on 75 distinct Primer tokens. 29 targets are claimed by more than one
source, `bgColor.disabled` by nine: WPDS has a disabled background per tone and
per emphasis where Primer has one. Likewise WPDS separates `warning` from
`caution` and normal from `-weak`, and Primer's `attention.muted` absorbs three
of those at once.

Every one of those rows is individually defensible, which is exactly why the
collapse has to be reported rather than left to be noticed. A per-row report
reads like a bijection. `collisionsIn` counts the claims, the report marks each
shared row inline *and* lists the collisions under their own heading, and the
JSON carries them. "This system draws a distinction the other one does not" is
what someone comparing two systems came to find out.

## What is not settled

- **No eval.** `evals/` has labelled sets for `represents` and `values`; there
  is none for this, so the floor of 0.5, the eight candidates, the tier weight
  of 0.2 and the weight table are all arguments rather than measurements. The
  WPDS/Primer run above says the thing works; it does not say how often it is
  *right*, because nobody has labelled it. A few hundred hand-checked pairs
  between those two sets is what would turn every number here into one.
- **One direction only.** `map A B` does not imply `map B A`. Collisions show
  where the relation collapses *into* B; nothing shows a token of B that no
  token of A reached, which is the other half of the same question and needs the
  reverse run. Diffing the two would also catch pairs that only agree one way.
- **Modes and themes are ignored.** A token's value is its first definition, and
  a set with light and dark variants contributes whichever it declares first.
  For Primer that means one theme's colours stand for all of them.
- **Strict JSON only.** Primer authors its sources in JSON5, which this cannot
  read; the verification runs went through a conversion step. Whether to take
  the dependency is open.
- **Composites are compared as JSON.** A typography or shadow token renders as
  its own JSON and matches only on equality, so those rows lean entirely on the
  name and the model.
