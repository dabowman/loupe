# Design notes: `--judge`

Why the model layer is shaped and tuned the way it is. What it *does* is in
[the engine README](../../engine/README.md#judging); the request each question
posts is written out in full at the top of its file in `engine/src/judge/`.

Everything here was measured. `engine/evals/` holds the labelled sets and the
runners; a number in this file is reproducible with the command beside it.

## The shape of it

`ask` is the transport every judgement shares — batch the items, post one
request per batch, hand back one answer per item. `judge/` holds one file per
*question*: what to put in the state and what to ask about it. That is the half
worth reading and the half an eval scores, so an eval imports the query it
scores and calls `ask` with it, exactly as the check does.

**None of it changes a deterministic verdict.** A variant or a token is written
into a finding's suggestion; a redirect is its own advisory finding, written
after the baseline and never by the hook. The gate stays deterministic and
offline, and this runs only when asked.

## The model is pinned to a version

`jev-1.13.0`, not `jev-latest`. The alias moves when a release ships, and every
floor in the engine was measured against the model the evals ran on. Moving to a
new one means re-running `evals/` and changing that line in the same commit.

## Batch size is 1

The state budget allows 40 items per request, but accuracy does not survive the
sharing. `represents` kept **97%** of its destinations one per request and
**69%** at 40:

    node evals/represents/run.ts --batch N

A control is a few lines, so one request each is cheap, and the bounded pool
keeps a hundred of them quick — 6 in flight held for a whole eval without a 429,
against an endpoint that answers a single control in about 200ms.

Every element in a batch is visible to every question in it, which is also why a
batched question has to be *scored* batched.

## Which variant (`judge/variant.ts`)

`<p> → <Text>` is right about the component and silent about the variant, which
is the half an agent has to guess. On a real plugin it is also wrong about the
component often enough to matter — a `<span>` that is a colour swatch, a `<p>`
that only wraps a button. Neither is decidable from the tag and its classes;
both are obvious from reading the element.

Hence `not_text` as an option: the answer "no variant applies" is a real one,
and a question that cannot express it forces a wrong pick.

## Which token (`judge/value.ts`)

The candidates arrive already narrowed wherever arithmetic can narrow them, so
what is asked is the half code cannot do: which token this rule *means*, judged
by what it styles, and whether the value was a decision at all. The pink card
background is the case the `keep` option exists for — either a mistake with a
system default it should have used, or a choice to suppress and leave alone.

Three things were measured on `evals/values` (`node evals/values/run.ts`):

| change | result |
|---|---|
| sending `tokenDescriptions` as each option's meaning | **85% → 92%**, and the wrong tokens it would act on at 0.5 fell from 16 to 3 over three runs |
| narrowing colours to the tokens within sight of the value | **95% → 91%** — *worse*, so colours get the whole family |
| labelling each colour option with its OKLab distance | **96% → 94%**, and keeps got worse (precision 93% → 82%) |

The descriptions matter because the name alone says `track`; the description
says "eg. scrollbar track", which is what stops `#f0f0f1` on a badge becoming
one for being a digit away from its value.

Narrowing colours fails because a light tint's nearest tokens are greys of the
wrong role, and the success wash it should have been is further away than they
are. Distance labelling — the docs' advice for a model that cannot compare hex —
fails for the same reason: the misses it was aimed at were never about distance.
Most are content against interactive at the same hex, and in the rest the
nearest token is the wrong one.

**The floor is 0.70 on the pick's confidence.** At that floor the question acts
on 71% of the literals with three wrong tokens in three runs and no wrong keep.
Gating on probability instead — keep on P(keep), else the likeliest token on
P(any token) — was scored on the same answers and is no better: at 0.90 it acts
on 52% with none wrong, which the floor at 0.70 matches.

Spacing the scale covers is exempt from the floor entirely: it snaps whatever
the confidence, because a low confidence there is only 6px sitting exactly
between 4 and 8, where every option is a snap somebody would accept.

**A keep beside a part that settled on a token is half an answer.** Keeping the
whole declaration would suppress the part that has a token; rewriting the rest
would exempt the kept literal. That declaration is left for review.

## Which force (`judge/force.ts`)

The `resolve` tables in `patterns/index.json` decide on things a signature
cannot see — does this control stand for a value, a command or a destination —
so this asks. The wording is the force's own, from the vocabulary, so the
definition an author reads beside `about` is the one the model is scored on.

`represents` was tuned against `evals/represents`:

- **One disambiguating line per value and no more**, or the eval scores a cheat
  sheet rather than the question.
- **Its no-match stays `none`**, against the `not_text` lesson in `variant.ts`,
  because it is rare and the three real classes separate cleanly.
  `not_a_control` moved nothing and cost two points.
- **The state carries the element and where it came from, and nothing else.** An
  ablation over 100 labelled controls scored the enclosing component's source
  exactly level with leaving it out, at 1.5× the tokens, because the slice
  usually missed the handler it was there to supply.

### The redirect floor is 0.90

A redirect sends an agent to a *different pattern*, which is the expensive
error, so an answer counts only where the eval found nothing wrong: every
`represents` answer at 0.90 or above was right, and under it a third of the
`command` picks were not.

One floor for every value, though the eval argues for less on `destination` — 27
of 27 picks under 0.90 were right there. Gutenberg says otherwise: of its 19
destination picks between 0.5 and 0.9, **11 were pagination buttons**, a control
the eval has no label for, and only 2 were plainly links. The cost of holding
0.90 is site-foundry's one real case, `onClick={ () => navigate( '#/new' ) }`,
at 0.83. **Label pagination into the eval before lowering it.**

The floor is on the pick's confidence, not the class's own probability. That was
scored as the gate too, on the same answers: at 0.90 it acts on one more
destination and two more commands, one of them wrong. No reason to switch.

## Reporting a judgement

The answer goes where the reader would otherwise have had to put it: `<p> →
<Text>` becomes `<p> → <Text variant="body-sm"> (judged 0.81)`, and a suggestion
already naming a placeholder — `variant="heading-*"` — has it filled. A `not_`
answer replaces the suggestion, since the analog was the wrong call.

A redirect reads `<Button> (represents: destination) → \`navigate-hierarchy\`
(judged 0.97)`: what it was read as, where that sends it, and the least certain
reading the redirect rests on. **The least certain answer speaks for the
finding**, since it is the one a floor downstream would stop at.

A judged finding's message is recomposed by the same `declarationMessage` the
token pass uses, so a judged finding and an unjudged one read by one set of
rules. Two renderings of one answer, because they have two readers: the message
names the tokens the way every other suggestion in the report does, and `answer`
stays the CSS `fix --judge` writes into the file, where the `var()` is not
decoration.

## Guards

- **An empty token set proves nothing about the system.** With nothing read,
  every property's family is empty, and "no padding token in the design system"
  would be said of every value and suppressed by `fix --judge` as fact.
- **One failure fails the whole ask.** The pool stops its other workers rather
  than pay for answers that are about to be thrown away — a worker mid-retry
  stops at its next attempt; the caller reports the failure and keeps what it had.
- **Overload is transient.** A run is a hundred requests, so one 529 should not
  lose the other ninety-nine — retried with the server's own wait where it names
  one, doubling otherwise. A dropped connection is retried on the same budget,
  whether it drops before the response or while its body is read.

## The evals

Both live outside `npm test`: they cost tokens, need a key, and a model is
allowed to drift in ways a build should not fail on. `tests/features.ts` pins
what gets asked and what gets written; these pin whether the answers are any
good, which only a live model and labelled code can say.

**`evals/represents`** — 100 hand-labelled controls from
`gutenberg/packages/{editor,edit-site}` and `site-foundry/src`, extracted once
and committed so the eval reproduces without either checkout. `labels.json` is
`[answer, ambiguous]`; the 13 flagged ambiguous are ones a careful reader could
defend either way, and the headline number is reported with and without them.
The question is the one `check --judge` sends, so editing the wording in the
vocabulary or in `judge/force.ts` is what this scores.

`destination` is the class that matters: every redirect in the abstract language
fires on it, so a false positive sends an agent to the wrong pattern entirely.
Calibration is scored per picked class, because a redirect acts on one class and
its floor is that class's precision, not the whole question's.

**`evals/values`** — 145 hand-labelled literals, every one `check --judge` asks
about in `vip-digital-asset-manager`: an un-remediated WPDS plugin whose
stylesheets were written against the wp-admin palette (`#1d2327`, `#646970`,
`#2271b1`), so nearly none of its values are exactly a WPDS token and most are
close to one. `tokens.json` is that token set; **candidates are worked out live
by `candidatesFor`**, so a change to how they are narrowed is scored by this
rather than frozen out of it.

`labels.json` lists every answer a careful reader would accept — `10px` of
padding is `padding-sm` or `padding-md`, a scrim is `keep`, a pill's `3px` is
either — so "right" is "one of those", and an item whose right answer was not
among the candidates is **a miss the narrowing made, not the model**, counted
separately as coverage.

The two ways to be wrong cost differently: a wrong token changes the design, a
wrong keep suppresses a mistake for good. Scoring mirrors how `fix --judge`
acts, including the spacing-in-scale case it applies whatever the confidence.

Both runners print where the model disagreed, so the labels stay auditable: on a
real disagreement the label is as likely to be wrong as the model. And both
report stability across three runs — a judgement that flips between runs cannot
be applied unattended.
