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
after the baseline. Verdicts stay deterministic; only the advice they carry is
judged.

The hook passes `--judge` as well, so write-time advice matches what
`check --judge` gives — but only where a `TYPESAFE_API_KEY` reaches the hook
process. Without one the hook judges nothing, silently, which is why `status`
carries a `judge:` line: a gate that turned a question off has to say so. A
missing key is a refusal when `--judge` was typed by hand and a no-op when it
came from the plugin manifest, because in that case the user never asked.

Each request gives up after 20s. `fetch` has no deadline of its own, and one
socket that never answers is otherwise a hook killed by Claude Code's timeout on
every write; an abort leaves the deterministic findings standing. A server's
`retry-after` is honoured for at most 5s, for the same reason. In the hook the
whole judge phase also shares one deadline, `hook.timeoutMs` (30s by default):
every request goes through a fetch bound to it, so what is still in flight when
it passes is aborted, and the run says it stopped.

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

## What a judged run spends

Batching is ruled out above, so the savings come from not asking.

**One client per run.** The four kinds of question — redirects, variants,
values, renames — write to disjoint findings, so they run side by side through
one `JudgeClient`, whose slots hold the whole run to 6 requests in flight. Wall
time is the slowest pass, not the sum of four pools. Two passes asking the
byte-identical question share one request.

**Answers are cached by the request that bought them.** The key is a hash of the
endpoint and the exact request body — model, element, question — so an answer is
reused only for exactly the question it answered. Context lines are part of the
element, so an edit near what was asked is a new question and an edit anywhere
else is not. The model is in the body, so bumping `MODEL` is a miss, never a
stale answer, and the evals-then-bump rule above holds unchanged. Entries age out
after 30 days, the file keeps the newest 20,000, and a reply missing an answer is
never stored, or the gap would be served forever. A bare key string where a
client is expected builds a private client with no cache: the evals and the unit
tests want every request real.

**The hook pays only for what it prints.** A hook run that does not block prints
a tally, so it judges nothing; one that blocks prints the blocking findings its
`maxFindings` cap has room for, so it judges exactly those (`shownFindings` in
`report.ts` is the same selection the report makes); one that has stood down
prints a summary, so it judges nothing. A redirect configured to block is the
one question asked before the rest, because its answer decides which of those
the run is. A typed `check --judge` prints everything, so it judges everything.

**The spend is said.** `judge: 4 asked, 37 from cache` closes a typed run's
stderr and rides on the hook's summary line. `tests/judge-cache.ts` runs the CLI
against a local stand-in endpoint (`LOUPE_JUDGE_ENDPOINT`, accepted only for
`127.0.0.1` or `localhost`, since a project's own settings can put variables in
the hook's environment and this is where the key is sent) and counts requests:
an advisory hook sends none, a repeat run sends none, a blocking hook sends
what it prints.

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
0.90 is one real case in site-foundry, a private WPDS app whose controls are
committed in `evals/represents` so the case reproduces without it:
`onClick={ () => navigate( '#/new' ) }`, at 0.83. **Label pagination into the
eval before lowering it.**

The floor is on the pick's confidence, not the class's own probability. That was
scored as the gate too, on the same answers: at 0.90 it acts on one more
destination and two more commands, one of them wrong. No reason to switch.

## Which token was meant (`judge/token.ts`)

`tokens/unknown-token` renames a name by spelling only where exactly one real
token is a keystroke away. What it leaves is mostly not typos. An agent writing
against a system it half-remembers names tokens in some other system's
vocabulary — `--wpds-color-text-muted`, `--wpds-spacing-lg` — and nothing is a
keystroke from those. Which token the author meant is plain from the name and
the rule, and code cannot read either.

- **The name outranks the rule.** The first wording asked the model to judge
  "by the name and what the rule styles", and it overrode the name wherever the
  descriptions disagreed: `--wpds-radius-md` on `.acme-card` came back
  `border-radius-lg`, because WPDS says `lg` is for cards. That is the right
  answer to a hardcoded value and the wrong one to a rename. The author wrote
  `md`, and whether a card should be `lg` is a different finding. Telling it to
  keep what the name already says (step, emphasis, state) and use the rule only
  for what the name leaves open took the eval from **84% to 88%**, and stability
  from 93% to 99%. Radius names still lean to the description, but they now
  abstain (0.4) instead of acting.
- **The options are the property's family**, by the role table the value
  suggestions use, so `color` is offered foreground tokens and never a stroke. A
  custom property answers as the longest property its name ends in. Sizes
  (`width`, `min-height`, …) have a row in the table for this alone:
  `hardcoded-value` never flags them, so the row is inert there. Without it, 8 of
  the eval's names had no candidates at all.
- **`none` is an answer**, the `not_text` lesson again. A name with no candidates
  at all (`--wpds-z-index-modal`: WPDS has no z-index family and no token shares
  the name's head) is never asked. That is 10 of the eval's 13 `none` items, all
  left alone correctly, and none of them cost a request.

### The rename floor is 0.80

A wrong rename repaints an element from a token that means something else, under
a clean report. That is the same cost as a wrong value, and it rewrites every
line naming the name. Scored over three runs of `evals/renames`:

| floor | renamed | right | wrong |
|---|---|---|---|
| 0.70 | 61% | 97% | 8 |
| **0.80** | **49%** | **99%** | **3** |
| 0.90 | 30% | 98% | 3 |

The three wrong at 0.80 and 0.90 are one item, three times over:
`--wpds-color-background-control-primary-weak-active` read as brand, where the
label says neutral. "Primary" means brand in plenty of systems, so the label is
as arguable as the pick. Below 0.80 the between-step typos start acting: `-xk`
is one keystroke from `-xs` and `-xl`, and no reading of the rule tells which.
At 0.80 none of them does.

## Reporting a judgement

The answer goes where the reader would otherwise have had to put it: `<p> →
<Text>` becomes `<p> → <Text variant="body-sm"> (judged 0.81)`, a heading's
`<Text render={ <h4 /> }>` gains its `variant` in the same tag, and a suggestion
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
  would be said of every value and suppressed by `fix --judge` as fact. Empty
  is reckoned on what the design system's sources yielded: the walk adds what
  the project itself defines under the prefix to the same set, so `analyze`
  hands back no set at all when `diagnostics.tokensKnown` is 0.
- **One failure fails the whole ask.** The pool stops its other workers rather
  than pay for answers that are about to be thrown away — a worker mid-retry
  stops at its next attempt; the caller reports the failure and keeps what it had.
- **Overload is transient.** A run is a hundred requests, so one 529 should not
  lose the other ninety-nine — retried with the server's own wait where it names
  one, doubling otherwise. A dropped connection is retried on the same budget,
  whether it drops before the response or while its body is read; an abort is
  a deadline, and is not. The server's wait is capped at 5s, a little past the
  longest the doubling would pick (4s): a `retry-after: 3600` is not a wait a
  run, or a hook inside Claude Code's timeout, can afford.

## The evals

All three live outside `npm test`: they cost tokens, need a key, and a model is
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
close to one. The plugin is private; its literals are committed here, so the
eval reproduces without it. `tokens.json` is that token set; **candidates are
worked out live by `candidatesFor`**, so a change to how they are narrowed is
scored by this rather than frozen out of it.

`labels.json` lists every answer a careful reader would accept — `10px` of
padding is `padding-sm` or `padding-md`, a scrim is `keep`, a pill's `3px` is
either — so "right" is "one of those", and an item whose right answer was not
among the candidates is **a miss the narrowing made, not the model**, counted
separately as coverage.

The two ways to be wrong cost differently: a wrong token changes the design
under a clean report; a wrong keep leaves a mistake in place, labelled for its
reviewer as a deliberate choice. `fix --judge` no longer suppresses a value
judged deliberate — it is left for a reader to suppress with what the value
actually is — so a wrong keep is a fix missed and a label that invites the
wrong suppression, not a mistake muted for good. Scoring counts an answer over
the floor as acted on, whichever way `fix --judge` then takes it, and includes
the spacing-in-scale case it applies whatever the confidence.

**`evals/renames`** — 158 names no WPDS token defines, each set in a real
declaration from `site-foundry/src` or `gutenberg/packages` where a real token
stood. Real code has almost none to label: Gutenberg's three are test fixtures.
So the names are made, in three kinds. *Invented* (135) swaps the real name for
an agent-style guess at another vocabulary. *Between* (10) typos a size suffix
one keystroke from two steps. *None* (13) names what WPDS lacks, over a real
hardcoded z-index, opacity, shadow or colour. A label accepts the token that
stood there, plus any of its category with the same value, which the invented
name cannot tell apart. Candidates are built live by `renameOptions`, and an
item that is never asked counts as right only when it is labelled `none`.

The names are synthetic, and a system as regular as WPDS makes the guesses easy
to undo. Treat 99% as the ceiling on how well the question works, not a
measurement of agent output, until real hook-time misses can be labelled.

All three runners print where the model disagreed, so the labels stay
auditable: on a real disagreement the label is as likely to be wrong as the
model. And all three report stability across three runs — a judgement that flips between runs cannot
be applied unattended.
