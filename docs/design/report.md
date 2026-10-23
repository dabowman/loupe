# Design notes: reporting, fixing and the escape hatches

Why the formatters, the message bounding, the baseline, the suppression grammar
and `loupe serve` are shaped the way they are. What each one *does* is in
[the engine README](../../engine/README.md#output).

## The agent format is built around one scarce resource

Context. The report is a nesting, and a per-finding line carries only what
varies inside it. A report that repeats the same remedy 200 times, or the same
path 40 times, costs more to read than the findings are worth.

Which of rule and path heads a block is the reader's choice, and the other
becomes the sub-heading, so neither is ever repeated line by line. **Both orders
answer a real question and neither answers the other's.** Rule first is "what is
wrong with this codebase, and in what order do I fix it" — the remedy is stated
once and every site of it sits underneath. File first is "what do I have to
change in the file I have open", which is the shape of the work when a reader is
already in an editor rather than triaging a repo.

Inside a group, findings are by line and carry the number alone: the path is the
heading two lines up in one mode and the heading itself in the other, and a
reader who has to check whether line 4 of this block is still the same file as
line 3 is paying for the grouping twice. Right-aligned, so a three-digit line
does not push a two-digit one out of column — the message is what the eye scans
down, not the number.

Files sort **worst first**: whatever blocks, then by weight, then by name. A path
has no rank to sort on, and first-seen order is the order the file walker
happened to reach them in, which is neither meaningful nor stable across
platforms.

The budget is spent **round-robin across the groups being shown**. Filling it
first-come buries every other group behind whichever one sorts highest, and an
agent that only ever sees one rule only ever fixes one rule.

**Identical findings print once**, with `×N` and the lines they stand for.
Duplicates are the ordinary case in a real stylesheet — the same `margin-bottom:
8px` seven times in one file — and listed one by one they spent seven of the
hook's twelve lines on one decision and crowded out every other rule. The budget
counts printed lines, so collapsing stretches it rather than replacing it; the
largest batches are spent first, since they say the most per line. Identical
means the same rule, file and *printed* text, not the same `code`: `code` is the
baselining identity and for a margin it is the property alone, so collapsing on
it would print `margin-top: 2px` under the count of a `margin-top: 12px`.

A rule's heading says how its findings concentrate — `(25 in 9 files, 11
distinct)` — because the total alone cannot tell 25 decisions from the same
three repeated, and the two want different remedies: a count says write a
script, singletons say read each one. Distinct is counted repo-wide, so one
declaration copied into nine files is one. JSON and SARIF stay one entry per
finding: their consumers count, fingerprint and fix findings, not lines.

### The lines that are not findings

- **The tally comes first, always, findings or none** — the count, the split,
  and what was read to reach it. A report that opens on a rule group gives a
  reader no way to tell a complete one from a truncated pipe, and the way that
  question gets answered without the line is by running the tool again and
  counting. The scanned count is there for the same reason in the other
  direction: without it, "no `stylesheet/unparsed` findings" and "no stylesheets
  were found" print identically, and only one of them means the CSS was checked.
- **Severity in words on every rule-group heading.** The glyph is unambiguous
  once you know it and invisible until then — a reader who does not decode it
  reaches for `loupe status` and cross-references the table of what blocks,
  which is a second run of the tool to learn something the line already knew.
- **Where the findings sit.** `/loupe-audit`'s first instruction is to say
  whether findings cluster or spread, and the report not answering it meant the
  answer was hand-rolled with `grep` and `awk` — three separate runs in one
  session, one of which silently returned nothing because its character class
  excluded `/`. One file is not a distribution, so that case says nothing.
- **What is already silenced.** This used to be behind an option no caller ever
  passed, so the count was never printed anywhere: a repo could report clean
  with its entire blocking backlog muted by directives, and the report said
  nothing to tell those two states apart. An agent reading one concluded the
  codebase was token-clean and told its user so. The count alone would not have
  stopped that — it is the *rules* that say what the silence is covering — so
  they are named, and the rest is located. It sits outside the findings branch
  on purpose: a clean run with a hundred directives is the exact report the line
  exists to qualify.
- **A prefix declared with no token behind it.** `tokens/unknown-token` is then
  off and every invented name passes. Silent, that reads as a clean repo — it is
  how a `tokenSources` path that stopped resolving went unnoticed.
- **The next-step line names what fixes or explains first.** The escape hatch
  used to be the only action the report named anywhere, which reads as the
  recommended one — and to a reader under a blocked turn, as the fastest one.

### Misplaced directives are reported

`isSuppressed` anchors to the finding's line and the one above it, so a
directive naming the right rule in the right file, a few lines off, mutes
nothing and says nothing. Every failure mode that produces one is silent: a
comment below the element rather than above it, one inside a JSX attribute list,
one on an import specifier whose finding anchors elsewhere.

**A directive for the right rule sitting just too far from its finding is the
single most expensive thing to debug from the report alone**: the hint is
already followed, the finding is still there, and nothing says the placement is
what failed. Retrying blind is what an agent does next, and the retry message is
identical. Naming the two line numbers turns a blind retry into a move.

Where the line a correct directive would occupy is already taken by a directive
for a different rule on the same node, the remedy is the comma list rather than
a move — only the nearest line is consulted, so stacking a second comment does
not work, and displacing one would silence a suppression someone else signed
off.

### The terse (hook) report

Blocking findings handed back mid-turn, to a reader about to spend its retry
budget on exactly those findings — or, on a PostToolUse that blocks nothing,
the findings the edit introduced, handed over as context. Two of the full report's
lines answer questions only somebody auditing a whole repo asks — where findings
cluster, what is already silenced — and the suppression inventory is repo-wide
where a hook run has looked at two files, so under the hook they would be noise
and a non sequitur. The tally, the severity words and the next-step line stay: the
first two cost nothing, and the last is most needed exactly where the reader is
blocked and the only other suggestion on offer is how to silence the thing
blocking it.

### The concise report

`--concise` is the other axis, and it subtracts rather than selects: the tally,
then one heading per group on whichever axis `--group-by` already chose, and
nothing underneath them. The full report always answers "what do I edit", which
is the wrong question at the start of an audit — there, the question is how much
drift there is and where it concentrates, and **the headings already are that
answer**. The lines beneath them are the answer to the next question, and
printing them costs a screen, or a context window, on sites nobody is fixing
this minute.

Two things follow from that framing. The next-step block goes with the findings:
it instructs on lines nobody printed, and `loupe fix` advice under a report with
no findings in it reads as advice about nothing. The diagnostics do **not** go —
parse errors and an empty token set print at either verbosity, because a run
that skipped half the CSS looks exactly like a clean one, and the whole purpose
of those two warnings is to tell those states apart. A concise report is allowed
to say less about findings; it is not allowed to say less about its own
reliability.

`--group-by` therefore decides what concise means. Grouped by file it is a
distribution — which is also why `Densest:` is dropped, since the headings state
it more precisely than a top-three line can. Grouped by rule it is a backlog by
kind, each with its remedy stated once.

## Colour is applied at print time, never at capture

`findingKey` falls back to `message` for a finding carrying no `code`, so a
component name coloured any earlier would land in the baseline key and in the
SARIF fingerprint hashed from it: every accepted finding of those rules would
come back live the first time someone ran the tool in a terminal.

A message names a component two ways — as a JSX tag (`font-size on <Text>`) and
bare, inside a signature or a currency verdict (`Card(CardBody(Stack))`). Bare
names are matched only where a signature puts them, against a bracket, a comma
or an arrow, or at the end, so a stray capitalised word in a CSS value is left
alone.

A judged span is its own fragment rather than a colour laid over the line: the
component names beside it carry their own, and a nested pair would end the green
at the first one.

Headings are painted as spans too — severity carries the mark and the word,
the id carries the colour rules wear everywhere else, and the count is
arithmetic. Painting the whole heading by severity made the id the one thing on
the line that did not look like itself.

## Titles resolve their placeholders in every format

`RULES[id].title` is a template — `replace with a {tokenPrefix} token` — and only
the resolved config knows what fills it. The agent format always interpolated;
JSON and SARIF shipped the raw template, so a consumer read `{tokenPrefix}`
where a human read `--wpds-*`. **Guidance naming a placeholder is worse than no
guidance: it is actionable-looking and wrong.** Binding it per formatter keeps
the obligation in one place, so a fourth format cannot quietly skip it.

## Bounding

One report line per finding, and the split between what is bounded and what
survives is deliberate.

**`tail` is the part that must survive the cap rather than be eaten by it**: the
marker naming which of the three channels a finding came from, or the prose
remedy on a rule whose message leads with an unbounded source-derived signature.
Neither is recoverable from the rest of the line.

**A registry note is shortened from the front too, but by whole clauses, and it
gives way to the message.** A note is read for its last clause — "…it wanted
Stack, not Grid" is the instruction and "planned for deprecation" is the
background — so the clauses kept are the ones that end it. It is cut only after
`. `, `; `, ` -- ` or `: `, and never inside a backtick span: cut by character
count, a `system/superseded-component` note opened on
`` …t` names a typographic scale ``, mid-word inside a name, and no longer
parsed. The note spends what the message leaves of `MESSAGE_MAX`, up to
`TAIL_MAX`; the message is never cut to make room, because the finalize pass has
bounded it already and a second cut lands mid-word just the same. A note no
whole clause of which fits is left off the line, and `--format json` and SARIF
ship it whole.

**Surviving is not the same as being unbounded.** A tail carrying a selector is
source-derived too, and left to itself would spend the line the body is supposed
to get, so it is held to `TAIL_MAX` and measured in the same unit as the body:
budgeting in UTF-16 units would let one astral character in the tail cost the
body two.

**A composed message is a list, and a list is cut by dropping whole parts.**
Cutting at `MESSAGE_MAX` ends it mid-token — `letter-spacing: 0.02em → v…` —
which is a remedy the reader cannot act on, and says nothing about the parts
that fell off the end entirely. Whole parts and a count is the difference
between a reader who knows to go and look and one who does not know there is
anything to look for.

**Everything is sliced by code point, never by UTF-16 unit.** `slice` splits a
surrogate pair down the middle, and a lone surrogate is not a character a strict
JSON reader will accept — which would trade a broken report line for a payload
SARIF consumers reject outright.

The guarantee is enforced at **one choke point**, the finalize pass in `analyze`
that every finding passes through, and not at each capture site — capture sites
are where a bound would be wrong. See
[capture, dedupe, bound](analysis.md#capture-dedupe-bound--in-that-order). It
lives in `analyze` rather than in a formatter because anything only the agent
formatter honours is not a guarantee `--format json` or SARIF can rely on.

`snippet` is the exception that proves it: it bounds one *contributor* to a
message, so a single long value cannot spend the whole line on its own.
`truncate` bounds an *identity* rather than a display — no ellipsis, no
whitespace collapsing, because `findingKey` normalizes whitespace itself, so
flattening first would only change which characters survive the cut, and with
them every baseline entry written before the change.

## JSON, SARIF, HTML

`--format json` prints one payload and `formatHtml` embeds that same payload
verbatim, so the page and the JSON cannot disagree about what was found — a
divergence that would otherwise be invisible, because each looks correct on its
own.

`rank` and `suffix` are working state, spent by the time there is a payload, and
the payload builder is the last place they can be dropped. The baseline count is
emitted only when a baseline was applied: without that, a consumer cannot tell a
clean repo from one whose whole backlog is accepted.

**SARIF fingerprints hash `findingKey`.** Consumers track an alert across pushes
by its fingerprint, so one that moves when a line moves re-opens every alert in
a reformatted file. `findingKey` is already the identity the baseline ratchets
on — the same question asked by a different consumer — so this hashes it rather
than inventing a second answer. Hashed because the raw key embeds arbitrary CSS
text, and a fingerprint is meant to be compared, not read.

Two findings can share that key: one file declaring `margin-bottom: 16px` three
times is three findings differing only by line, which the key deliberately
drops. A fingerprint has to be unique within a run — a repeated one makes code
scanning fold those three into a single alert, so two of the three vanish from
the Files tab — so occurrences past the first are separated by their position
among the findings sharing the key. Only duplicates pay for it.

No `fullDescription`: the rule catalog holds exactly one line of guidance per
rule, and shipping it twice under two names tells a reader there is more to read
when there is not.

### The HTML report

Every other formatter spends its design budget on brevity, because its reader is
an agent. This one has the opposite constraint: nobody's context pays for it,
and the reader is a person who wants to know where the drift *is* before
deciding what to fix. Two decisions follow, and they are the whole design:

1. **The page renders client-side from the exact `--format json` payload**,
   embedded verbatim. No second selection of fields, no second notion of what a
   finding is, and therefore no way for the page to disagree with the JSON.
2. **It shows the two things a line-per-finding list structurally cannot.** A
   directory rollup answers "is this clustered or is it everywhere", which is
   the first question `/loupe-audit` asks and the one a flat list buries. And the
   composite rules — the only findings that cannot exist in one file — are shown
   as the N-way relations they are, instead of printed N times as if unrelated.

**No timestamp is rendered.** Re-running the same check would otherwise produce
a file that differs from itself, the same trap `writeBaseline` had to climb out
of; the file's mtime records when it was taken.

Other decisions there:

- Embedding escapes every `<`. The block's content is raw text — the only things
  that can end it early are `</script` and `<!--`, and escaping `<` closes both.
  It is safe wholesale because in JSON a `<` can only occur inside a string. A
  finding's message routinely carries CSS-in-JS source, so this is live.
- The client is written **without template literals**: the whole string is itself
  inside one, and a stray `${` would be interpolated by the bundler rather than
  shipped — a failure that shows up as a broken page, not a build error.
- Every themed value is `light-dark(light, dark)`, declared under
  `@supports (color: light-dark(#000, #000))` over plain light values. Unguarded,
  a custom property holding a value the browser cannot compute still wins, and
  every `var()` reading it falls back to nothing. Severity uses reserved status
  colors rather than a series hue, because severity is a state, not an identity.
  On the light surface the advisory amber falls below 3:1, which carries an
  obligation: **every severity is rendered with its glyph and the word, never
  the colour alone.**
- Charts are in **frequency order, deliberately not the agent format's rank
  order**. The two answer different questions — rank is "fix this first", length
  is "there is the most of this" — and a bar chart sorted by neither its own
  lengths nor a natural category order is unreadable.
- **Past the directory cap the tail is folded into one row**, not truncated
  silently: a report that drops rows without saying so reads as though it covered
  everything.
- A zero baseline tile is not shown. A baseline that accepted nothing and a
  project with no baseline file both report 0, so a zero tile states nothing.
- **Unparsed files are named before anything else.** Nothing in them was checked,
  so every count below is a floor rather than a total — and the clean page needs
  it most, since `stylesheet/unparsed` can be off, baselined or out of scope, and
  then a page reading "clean" is reporting that the files it never opened had
  nothing wrong with them.
- `<style>` and `<script>` sit inside the body markers rather than in `<head>`,
  so the fragment is self-sufficient: `/loupe-report` publishes exactly that span
  into an Artifact, which supplies its own document shell.

### The pane

The HTML page is read in a browser tab. Claude Code can now also draw a region
beside the transcript — a *pane*, drawn by a plugin's hooks module — and the
plugin draws the same report there (`hooks/register.tsx`). The pane is a few
dozen cells wide, and the surfaces differ in what they can draw: the desktop
and the editor take an SVG and no pixels, the terminal takes text (and pixels
on a handful of terminals), the phone takes SVG and no input fields.

So the engine ships a third reader's shape, `--format pane`
(`engine/src/report-pane.ts`), rather than letting the mod re-derive the
charts from the JSON on each surface:

- **It is derived from the `json` payload and nothing else** — `panePayload`
  is `paneFromPayload(reportPayload(…))` — for the reason the page embeds the
  payload verbatim: two readers of one run must never see two different
  reports. The test holds the pane's rule counts and directory counts to the
  payload's finding count.
- **The tallies are pre-shaped, and in the page's order.** Rules in frequency
  order with rank breaking ties; directories capped at `DIR_CAP` with the tail
  folded into a counted row; a baseline tile only when it hid something; the
  unparsed count beside the scanned count. The page computes these client-side
  in a script written as a string; the pane cannot share that code, so the
  rules are written down a second time here and pinned by tests, and a change
  to either is a change to both.
- **The charts are SVG strings**, not a drawing instruction set. The desktop
  draws an SVG as an image, so the page's custom properties do not reach it;
  the SVG carries its own `<style>` with a `prefers-color-scheme` query, which
  an SVG image does evaluate. Each bar's `<title>` is what the interactive
  frame shows on hover. Severity keeps its glyph in the bar's label, never the
  color alone. A rule's title reaches the `<title>` escaped, so a finding's own
  text cannot close the document early — the page's `</script>` hazard, again.
- **The terminal draws from the numbers, not the SVG.** The mod turns
  `rules[].count` into block-glyph bars sized to the pane's columns. Same rows,
  same order, same glyphs; only the medium differs.

The pane is for the person. The model keeps the budgeted agent format: a pane
the model read would be the context cost the agent format exists to avoid.

## Resolving a finding to elements

`selector` is the one field on a finding that is not a source location. Every
other consumer anchors on `file`/`line`; a browser has no lines, and a selector
*is* a DOM query. That is the whole basis of `loupe serve` and of the DevTools
extension, and it is the only thing loupe does that no other conformance checker
can.

It lives in `dom-match.ts`, as one source string, because it has two readers that
cannot share a module: the overlay is spliced into a script the server sends, and
the extension is a separate build artifact that may not fetch code at all.

**Two copies would be two answers, and the disagreement would be invisible.**
Both would highlight *something* plausible — the panel would still load, still
list findings, still draw boxes. Nobody would file a bug about boxes on the wrong
nodes; they would conclude the rule was wrong. So the extension's copy is
generated from the same constant and `--check`ed in CI, exactly as `dist/` is,
and for the same reason: a vendored file nobody regenerates is a version behind
and says nothing about it.

### It is a source string, so nothing type-checks it

That is the cost of having one matcher, and it concentrates the risk in one
place: escaping. The string sits inside a template literal, so every regex in it
is written one level up. `[\\w-]` in the source emits `[\w-]` — correct — and
`[\\\\w-]` emits `[\\w-]`, a character class of backslash, w and dash.

Both compile. Both run. The second silently strips `:hover` out of `.a:hovered`
and leaves `.aed`: a valid selector for an element that does not exist, so the
finding reports zero hits and reads as "not on this page". That mistake was made
writing the file and is why `tests/dom-match.ts` compiles the regexes back out of
the emitted source and exercises them, rather than trusting that the file looks
right.

### The extension gets the question the report cannot ask

The panel is the overlay without the bookmarklet, and the two things it gains are
both consequences of living in DevTools rather than in the document: it survives
navigation, and it is not a fixed panel over the app intercepting the clicks of
the thing you are testing.

The Elements pane is the part that could not have been a bookmarklet at all. It
needs the inspector's selection, which does not exist in the page. And it inverts
the interaction: every other output starts from the findings and asks where they
are, but a person who has opened DevTools has already found the thing that looks
wrong. Their question is the other one, and answering it previously meant reading
two hundred rows and guessing which were about this node.

`$0` is DevTools' handle on that selection inside an eval, and the matching is
done in the page because that is where the node is. A node cannot cross the
DevTools boundary, and reconstructing a selector for one on this side would be a
second matcher — worse, and disagreeing with the first.

### It reads `serve`, not `ui`

`serve` sends `access-control-allow-origin: *` because being read from another
origin is its purpose. `ui` sends no CORS header at all, because it rewrites
source files and answers only the page it served. An extension cannot reach `ui`,
and that is the security posture working rather than a gap to close: the DevTools
surface is a reading surface, and the panel says so when a connection is refused
rather than leaving a reader to guess at the port.

## `loupe ui`

The report is a photograph and this is a window. They render the same view —
`report-view.ts`, which both hosts import — and differ in where the payload comes
from and in what a reader may do with a row.

**The view is shared because the alternative was two of it.** A second renderer
would start as a copy and drift, and the drift would be in exactly the numbers
this project spends its discipline keeping consistent: the page a reader triages
from would eventually disagree with the file they attached to a ticket. So every
count, rollup, grouping and sort is one implementation, and the seam between the
hosts is one object:

```js
var HOST = window.__loupe || {};
var LIVE = !!HOST.live;
```

Absent, it is the artifact: the payload comes from the embedded block, rows carry
no actions, and the rendered page is what `--format html` has always rendered.
Present, it is the live host, which fetches and calls `load` on every
re-analysis. The artifact does carry the unexercised half of each branch in its
script text, and inert `data-when` attributes in its markup. That is the price of
one implementation and it is worth paying; the test asserts on the *emitted*
markup rather than the source, because emitting a button nobody can click is the
failure, not shipping the code that would have.

**The timestamp comes back here.** The report renders none because a file that
differs from itself cannot be diffed. Nobody diffs a window, and a live page that
will not say when it last ran is asking to be read as current when it is stale —
so this one says when, and how long the run took.

### It is a separate command from `serve`, and that is the design

`loupe serve` is read-only and answers any origin, because a bookmarklet on some
other origin is the entire point. This one rewrites source files, records
baselines and writes suppressions. Folding them together would put a writer
behind `access-control-allow-origin: *` — which is a page on any site the reader
happens to have open, rewriting this repository.

So the write surface is guarded three ways, and each closes a different door:

- **Loopback bind, and no CORS header anywhere.** The default bind is every
  interface, which on a shared network publishes a writer for this checkout.
  Without a CORS header no cross-origin reader can see a response, so nothing can
  be read back out of it either.
- **A secret minted per run**, handed only to the page this process served.
  Sending it as a custom header also forces a preflight, which this server
  answers for nobody. An `Origin` that is present and not ours is refused before
  either check, because a browser attaches one to any cross-site request.
- **A revision on every write.** An index addresses the payload the page is
  holding, and the tree moves under it — a rebuild, a rebase, the reader's own
  editor. A stale index still names *a* finding, so a write against it would be
  plausible and wrong. Each run stamps a `rev`, each write names the one it was
  aimed at, and a mismatch is a 409 the page recovers from by reloading.
  `substituteOnLine` would refuse most of these anyway by finding no declaration
  on the reported line; this makes the refusal certain rather than likely.
  The revision names the tree, not the run: a write this server makes moves it
  at once, and so does any change the watch sees. A directive spliced in, or a
  line added in an editor, shifts every line below it, so a write aimed at the
  page before the re-analysis lands is refused rather than written above a line
  that has moved. A run whose tree moved while it was reading is dropped for the
  one queued behind it, and a change is not counted twice: an event for a file
  the latest run started after (by mtime, or for a removal its directory's)
  leaves the revision alone. `/run` names nothing, so it is the one write with no
  revision check, and is how a page whose revision fell behind catches up.
- **A failed run is said, not hidden.** The page keeps the last payload that
  worked, and says in the status it otherwise uses for "live" that it is stale
  and why. An edit to the config file is named too: the server read it once, so
  only a restart applies it.

`/source` is allowlisted to the files the current run reported, rather than
checked against the project root. A prefix comparison has to get symlinks,
case-insensitive volumes and `..` all right to be safe, and a set of paths the
analyzer just handed back has none of those questions in it.

### The suppression reason is required here

The language server's quick fix leaves it blank on purpose: a directive with no
reason does not mute, it reports as `suppression/malformed`, so taking that
action trades a finding for a louder one that clears only when somebody writes
down why. That is not a rule about suppressions — it is a consequence of a quick
fix having nowhere to ask.

A page has somewhere to ask. So it asks, and refuses the write on a blank answer.
The two surfaces disagree about the bytes and agree about the principle: no
silence that nobody signed.

### Watching is reported, never implied

One `fs.watch` per directory rather than one recursive watch on the root.
Recursive is unsupported on Linux before Node 20 and this floor is Node 18, so
the choice is between a platform branch and a set that is the same code
everywhere. Per-directory is also self-healing: a new directory is a new entry in
a directory already watched, which fires, which rebuilds the set.

The set is rebuilt after every run rather than once at boot, because a project
grows directories while it is being worked on and a watcher pinned to the tree as
it was at startup goes quiet on exactly the files someone just added.

Past the ceiling the watch is **refused whole, and said to be refused** — a watch
covering part of a tree reports nothing for edits outside it, which reads exactly
like no edit. The page prints the directory count it is actually watching, or
says it is not watching and keeps the re-run button, which is the same discipline
`serve`'s panel follows in labelling what it cannot resolve.

### Baselining needs the unbaselined run

`serve` and `lsp` take one runner that analyzes and applies the baseline in a
single step. This host needs the two halves apart: it *displays* the baselined
result and *baselines* the fresh one.

Collapsed, `accept as baseline` would record only what the page still had on
screen — the findings the existing baseline had not already accepted — and every
previously accepted finding would silently drop out of the file and come back
live on the next run, reported as a successful write. That is why `cli.ts` has a
`presenter` the runner is built from rather than the other way round, and why the
test for it takes two baselines with a new finding in between: one baseline
cannot tell the two implementations apart.

## Baseline

The adoption blocker for a tool like this is the first run on an existing
codebase: hundreds of advisory findings, none of them the work in front of you.
A baseline turns that backlog into a ratchet.

**Entries key on rule + file + normalized code, deliberately not on line
number**, so reformatting or an unrelated edit above doesn't resurrect every
finding in the file.

**Unreadable is not empty.** A file whose `entries` is missing or not an array is
as unreadable as one that doesn't parse: both mean "we cannot tell you what was
accepted". Defaulting to `[]` instead said "nothing was accepted", which reads
to every caller as a healthy empty baseline — so the backlog went live, the gate
blocked on all of it, and the warning that exists for exactly this never fired.
`jq` rewriting the file without `.entries` is enough to get there, and valid
JSON is the case least likely to be suspected. The likeliest corruption for a
file the project is now asked to commit is a merge conflict.

**No fresh timestamp on a re-record.** Re-recording the same backlog rewrites
the same bytes; a fresh timestamp made the file differ from itself, so two
branches that each re-baselined conflicted on line 3 with identical entry lists
— and a conflict-markered baseline is unreadable. The timestamp records when the
backlog was taken, not when the command was run.

**Both counts come back**, because they are different numbers: several findings
collapse into one entry whenever they share a key, and `check` reports the
findings it hid, not the entries that hid them. A file reporting only entries
under a name a reader hears as "findings" is how 194 came to be quoted against
`check`'s 253. `count` keeps its meaning so 0.1.x files still parse; `findings`
says the rest. Nothing reads `count` any more, and it is removed in 0.9.0: the
0.1.x baseline locations, its other reason to stay, are already gone — they are
not read, so a deleted baseline cannot be replaced by one an older version
wrote.

A *configured* baseline may name a directory that doesn't exist yet; the default
one sits in the project root, which the caller already proved exists. The
directory is created via a helper rather than a bare `mkdirSync` so a bad path
fails on the write that wanted it: mkdir on a path whose parent is a file
reports `EEXIST … a.css`, which names the wrong problem, where the write reports
ENOTDIR and names the right one.

`fixed` is only meaningful on a whole-repo run — on a scoped run the absent
entries are mostly just out of scope.

## Suppression

    <keyword> system/override -- Stack exposes no padding prop

Rule ids and a reason are both mandatory. Anything looser — a whole-file
disable, a missing reason, a bare keyword — is not a mute but its own violation
(`suppression/malformed`), **which is the severity inversion that keeps the
escape hatch honest.**

**The directive must be the first thing in its comment.** That is what stops the
checker flagging its own documentation: a line reading `* Suppression: <keyword>
<ids> -- <reason>` is prose about the grammar, not an instance of it. Note the
limit of that defence — an *indented* example inside a doc comment is still
first in its comment once the asterisks are stripped, so a file quoting the
grammar verbatim under a scanned `src/` is writing a live directive.

**Read aliases keep a rename from orphaning written directives.** Every keyword
the engine knows *mutes*, whichever one the active config asks people to write.
What an alias does not widen is prose: a comment that merely opens with another
preset's keyword is left alone, while one carrying a directive's shape reports
as `suppression/malformed` exactly as it would in the active keyword. Both
halves are load-bearing — prose must not become an error, and a directive
someone signed off must never go silent. **Silence is the one outcome a
written-down reason can never have.**

A directive mutes its own line and the one above — the two natural spots for a
trailing or leading comment. `scopeLines` lets a CSS rule's selector line mute
findings on its own declarations, so muting a whole block doesn't require one
comment per declaration, which is precisely the friction that pushes people
toward a blanket disable.

A block comment's continuation lines are covered, but **the closer is searched
for within a bound**: a comment that never closes is a broken file, and
extending a suppression to the end of it would turn a typo into the blanket
disable the grammar exists to refuse.

### Reading a directive

- **The comment opener admits a space before it** (`{ /* … */ }`). WordPress's
  prettier config mandates that form, so refusing it makes the directive
  unwritable in a JSX child position anywhere in a WordPress repo.
- **A block comment covers every line it spans**, not just the one the keyword
  sits on. `isSuppressed` only looks at the finding's line and the one above, so
  a directive whose comment closes two lines higher anchors to nothing — and a
  reason good enough to be worth writing is usually long enough for a formatter
  to wrap it. A continuation line inside a jsdoc block strips to the same shape
  with no opener of its own, and nothing is extended from there: that
  under-covers rather than over-covers, and over-covering is the failure that
  silently mutes a rule nobody signed off.
- **Keywords are matched longest-first, with a word boundary.** Alternation
  takes the first branch that matches, so a keyword that is a prefix of another
  would shadow it, and the boundary is what stops `ds-allowlist` reading as
  `ds-allow`. `ds-allowlist` and `ds-disabled` are other words, not this one
  written badly.
- **The reason may not be the comment terminator.** `<kw> <ids> -- */` records
  `*/` as a signed-off reason and mutes, which is the missing-reason case
  wearing a directive's clothes.
- **The shape gate must be as wide as the grammar it guards.** It is the only
  route by which a read alias can produce a finding, and the shape is what
  separates `ds-allow tokens/hardcoded-value` and `ds-allow -- Stack exposes no
  padding` (directives someone wrote and broke) from `ds-allow is the old
  keyword, write wpds-allow` (a sentence about one). The rename must not cost a
  clean repo its exit code, and a broken directive must not go silent either.
- **An alias never outranks this config's own blanket list.** Which terms are
  offered as aliases is `normalize`'s call — it is the only place that can see
  every preset's vocabulary — so what the parser enforces is the invariant: an
  alias widens what may be *written*, never what a directive is allowed to do.
- **The reason is cut on raw text, by code point**, before any flattening. That
  string is also the finding's `code`, and `findingKey` collapses whitespace on
  `code` itself, so flattening first changes nothing a reader sees and only
  moves the 60-character window — taking every baseline key already written for
  a long directive with it. What a reader sees is flattened by the line bound.
- The original keyword is carried only when it is not the one the config asks
  for, so `loupe suppressions` can name a rename and nothing else has to.

## Fixing

The engine already knows the answer wherever a value matched the design system's
own token definitions on-role. Printing that into prose and paying a model to
read the file back and type the same substitution is the expensive way to apply
a change nobody had to reason about — and those are the highest-volume rules in
most reports, so they crowd out the findings that do need judgement.

**`suggest` is the licence.** Every rule that flags a substitutable declaration
arrives carrying one entry per declaration, which is the same thing a list of
which rules those are would have said, only said once and by the finding itself.

**Only the unambiguous case is applied.** Two on-role tokens carrying the same
value is a semantic choice, and picking one by array order is exactly how you
get the right pixels with the wrong meaning — the failure the token suggestion
machinery exists to prevent.

**So is one token outside its declared scope.** Matching by property and value
made `border-radius: 4px` "unambiguous" on a dialog and on a button alike — `md`,
both times, both wrong: WPDS's radius scale is role-based, and `md` is for menus
and popovers. Where the active profile scopes the single candidate to a kind of
element, it is applied only when every element the declaration is shown to
style is that kind. Off its scope, or with nothing shown, the suggestion carries
`review` and its reason, the message says `(review: …)`, and `fix` prints it as
a `review` line instead of writing it. The judge skips it too: it is a single
candidate, and what it needs is a reader, not a choice among options. A token
that settles one part of a value (`border-radius: 4px 4px 0 0`, `border: 1px
solid #ddd`), or equals the value in another unit (`0.25rem` for a `4px` step),
is one `--judge` would write without a question, so it is held the same way,
with the review naming the token. See [token scopes](analysis.md#token-scopes).

**All three channels, two ways in.** A stylesheet declaration and a CSS-in-JS
one are both matched as text on the line they were reported at: what is inside a
template *is* literal CSS, and a declaration whose value comes from an
interpolation never reaches `fix` at all, because the template parse drops it. A
JSX style object is not CSS in any form. `style={{ paddingBottom: 13 }}` is
reported as `padding-bottom: 13px` and neither half of that is written in the
file — the key is camelCase, and React is what gives the number its unit — so a
CSS-shaped match there finds nothing, or worse, finds a lookalike in the
attribute beside it. The scan records where the value's literal sits instead,
and `fix` splices that span, writing the token as a string in whichever quote
the value was already written in.

**A fix that cannot locate its declaration exactly is skipped**, not guessed at:
the file has moved under the report, and a substitution against a stale line or
column edits the wrong bytes. A match has to hit exactly once on the line it was
reported at. A span is checked against the text the scan recorded there before
anything is written, because a column is not self-checking the way a match is.
Lines are re-read as fixes apply, because two can land on one line and the second
must see what the first wrote, and splices run right to left within a line so one
never moves another. The property boundary matters — `background` must not match
inside `background-color`, `border-radius` must not match inside
`-webkit-border-radius` — and `!important` and the terminator are left alone. A
replacement that would have to be escaped to survive as a JS string is refused
rather than escaped; a token substitution never is one.

**A misspelled token is the same licence without a declaration around it.**
`tokens/unknown-token` holds the known token set at the moment it fires, so
where exactly one known token is a near miss for a name nothing defines, the
check writes that rename onto the finding and `fix` applies it. It rides in a
field of its own rather than in `suggest`, because a `Suggestion` is a
`prop: value` pair and a name is neither half of one — but it is still data on
the finding, resolved into the same `tokenFixes` list, so `loupe fix` and the
editor are acting on one list and not on two fix paths.

**The threshold is one keystroke, and never a digit.** A candidate has to be one
insertion, deletion or substitution from the name as written — a slip, not a
guess — and exactly one known token may be. Two is a question, and answering it
by array order is how a rename lands on a real token with the wrong meaning.
`--judge` is where it gets asked instead
([judge.md](judge.md#which-token-was-meant-judgetokents)). A
transposition is two edits under this rule and so is not offered; it stays
reported, which is the cheap half of the trade.

The digit exclusion is the part that does the real work. Token systems are built
on scales, and `--wpds-dimension-space-20` and `--wpds-dimension-space-30` are
one keystroke apart and mean different amounts, as are `…-red-50` and
`…-red-60`. So a known token counts as a near miss only if it still differs once
every digit is dropped from both names, and a step on a scale is never read as a
spelling. On a digit this failure is both the likeliest and the least visible:
the value is plausible, the file parses, the report goes clean, and the element
is a size nobody asked for.

**The rename covers every line of the file that names it.** The rule reports
once per file and name, however many references there are, so rewriting only the
line it was reported at would leave the file broken and the next run would
report the same name again. The check carries all of those lines; the fix is one
line-substitution per line; the finding clears only once every one of them is
written. In the editor it is one action carrying every edit, for the same
reason — a quick fix that clears the occurrence under the cursor and leaves the
diagnostic standing has not fixed anything.

The match is bounded on both sides by what a reference is. Only inside `var()`,
so a `--name: …` declaration keeps defining whatever it defines; and stopping at
the end of the name, so renaming `--wpds-dimension-space-m` cannot reach into
the `--wpds-dimension-space-md` sitting beside it. Several references on one
line are all rewritten rather than refused as ambiguous: unlike two matching
declarations, they are one misspelling, and the answer for one is the answer for
every one of them.

References are collected from stylesheets and from CSS-in-JS templates, the two
channels that write `var()` as literal text on the line. A JSX style object
contributes none — nothing scans its values for token references — so a rename
is never spliced at a span.

**Findings cleared, not fixes applied**, is what gets counted. A collapsed
finding holding one settled declaration and one nobody could settle is still
there, and so is a misspelled name still written on a line the rewrite could not
reach. Settled means rewritten *or* suppressed: a value suppressed as kept is
as done with as one it replaced. The tally keys on file, line and property; a
rename has no property and takes the empty slot, which no declaration fix can
collide with, because every declaration a fix or a keep names came out of a
parse and a parse has no nameless property.

Only a value kept for a reason that is a fact is suppressed: its property has
no token in the design system at all. One the model judged deliberate is
reported as skipped. `deliberate, no token fits` is the judgement, and what
the value actually is (a scrim, a pill, a brand colour), which is what a
suppression's reason should say, is not something it says.

Suppressions written for a kept value follow the grammar's own constraints. A
directive mutes its whole next line, so one is written only where **every**
flagged value on that line was suppressible — muting a line that also carries an
unsettled value would hide it along with the one that was. Not above a rule's
opening line, where a directive covers the whole rule, and not between an
existing directive and the line it is for. Only the nearest line above is read,
so an existing directive would be pushed off its line and what it names would
come back.

The directive names **every** rule the kept declarations on that line were
reported under: a minified stylesheet can put a kept colour and a kept
font-weight on the same line, and one naming only the first leaves the second
reported under a comment that claims to cover it. The reason is the one the
keep was settled with, so the comment records how it was decided.

Indentation is copied with spaces and tabs only — `\s` would copy a byte-order
mark onto the directive — and the line's own ending, so a CRLF file stays one.

Suppressions are the one half of this that is still stylesheets only. A
substitution replaces bytes that are already there; a directive adds a line, and
a comment line above a JSX element is not a comment at all — it is rendered
text. So a value `--judge` kept outside a stylesheet is reported as skipped, for
a reader to suppress where they can see what the line is.

### Deleting is the editor's alone

`css/dead-class` is the one finding with a quick fix that `loupe fix` will not
apply, and the asymmetry is the design rather than an omission.

Every other fix on this page is a **substitution**. The value that was there is
still legible in the diff, the check that flagged it re-runs against whatever
replaced it, and a wrong one shows up as a wrong colour on the next pass. A
deletion has nothing to compare against afterwards. If the rule was live, the
thing that tells you is a visual regression, in a browser, some weeks later.

And this finding is deliberately the less certain half of a trade. The reference
index over-collects on purpose (see [markup
scanning](analysis.md#markup-scanning-two-passes-two-characters)): a false
"referenced" costs one missed finding, a false "dead" recommends deleting live
CSS. That price is set for a reader who has the rule in front of them — not for
a batch pass rewriting a repo unattended, where nobody reads the diff and both
failures cost the same to produce. So the deletion is offered where a person
sees the code and accepts it, and nowhere else. The extent rides on the finding
as `dead`, which `tokenFixes` does not read; `suggest` and `rename` remain the
only licences the batch path has.

**What is refused outright**, because a missing quick fix is invisible and a
wrong one deletes code:

- **A selector list where another selector does not name the class.**
  `.wf-dead, .wf-live { … }` styles both, and removing the rule takes `.wf-live`
  with it. Editing the prelude instead would be a substitution, with its own
  question about what the remaining list should read as, so the finding stands
  and a person removes the selector. `.wf-dead:hover, .wf-dead:focus` *is*
  offered: every selector there is about the dead class, so nothing else can
  lose its styling.
- **The only child of an `@media`, a `@supports`, or a parent rule.** Deleting
  it leaves an empty block behind, and deleting the parent as well is a bigger
  edit than the finding claims.
- **A rule sharing its first or last line with anything else** — a minified or
  densely-written sheet. Whole lines are the only extent carried, and a
  column-accurate splice into a line that also holds live CSS is exactly where a
  stale position does the most damage.
- **A class several rules in one file declare.** The finding is one per class per
  file; its action has to be the rule it points at, and deleting three scattered
  rules from one diagnostic is more than the diagnostic says.

**What goes with the rule** is a comment directly above it with no blank line
between, and one blank line after it. A comment glued to a rule describes that
rule, and one describing a rule that is gone is its own small mess — and where
the comment is a suppression directive, leaving it behind would silently mute
whatever ends up beneath it. A blank line breaks the attachment, and then the
comment stays. The blank line after keeps the deletion from leaving two where
there was one; where the rule ends the file, the blank line before goes instead.

**The recorded extent is checked against the buffer before the action is
offered.** Braces have to balance across those lines, the last of them has to be
the closing one, and the class has to still be named inside. A substitution
checks itself by matching what it is replacing; a deletion has no such match, so
this stands in for it, and anything that no longer looks like the rule that was
reported is offered nothing at all.

### Moving an import is not a substitution

`system/superseded-component` has no fix, in the CLI or the editor, and the
reason is that the licence for one is empty rather than that the edit is hard.

A `dropIn` entry would be the licence — the registry's recorded claim that
moving a specifier to the package `supersededBy` names changes the import line
and nothing else. None of the WPDS entries carries it; the eight that share a
name across the two packages were each read against Gutenberg trunk and each
one fails, on a renamed prop, a dropped prop, a component that became a
namespace, or a margin that went away. See
[checks.md](checks.md#a-same-name-move-is-not-a-drop-in-move) for the pair-by-pair
verdicts and what it would take to add one.

So the machinery is not built, and the shape of it is worth writing down so the
absence is a decision rather than a gap. It is not a token substitution with a
different name. Every fix above replaces bytes inside one line, and the whole
reason it can be trusted is that it has to match what it is replacing before it
writes. Pulling a specifier out of one import and into another is an edit to a
file's import structure: the old declaration may have to go entirely, the target
declaration may or may not exist, an alias has to survive into the JSX below,
and a file already importing the name from both packages, or importing it as a
default or a namespace, can only be refused. None of that is self-checking. And
the blast radius is not one wrong colour on one line — it is a component
rendering differently everywhere the file uses it, behind a diff that reads like
an import tidy.

That is the same asymmetry `css/dead-class` resolves by going to the editor
alone: an edit whose failure is invisible in the diff is priced for someone
looking at the code. A verified `dropIn` move is not that — it is a
substitution again, just a two-line one, and it would belong in both paths
through one function like every other. But it needs an entry that earns the
claim first, and manufacturing one to give the feature something to do is
exactly the failure the field is shaped to prevent.

## `loupe serve`

Every other output in this codebase answers "where in the source". This one
answers a question the source cannot: **which rendered elements a finding
actually lands on.** A stylesheet finding carries the selector of the rule it
sits in, and a selector is a DOM query, so the browser can resolve one finding
to the live elements it affects, count them, and draw a box around them. A list
of findings in a floating panel would otherwise be the terminal with worse
ergonomics.

Three decisions follow, and they are the design:

1. **It serves, it does not integrate.** The target dev environments are not a
   Vite server with a middleware slot — the shipped one is webpack inside a
   Docker WordPress. So: a stdlib HTTP server, permissive CORS, and a
   bookmarklet to get the script into whatever page the app renders in. Nothing
   to install in the app, no bundler config, and it works the same in all of
   them.
2. **Re-analyze per request.** No watcher, no cache, no invalidation rules to get
   wrong. The analysis is fast and a human presses refresh; the moment that
   stops being true, a watcher can go behind the same endpoint without the
   client noticing.
3. **The panel says what it cannot see.** A finding whose selector matches
   nothing on this page, one behind an `@media` query the viewport is not
   satisfying, and one with no selector at all are all shown, and all three are
   labelled with which they are. The browser view is a view of a *subset* —
   unopened modals, unrendered branches and every JSX-anchored rule are outside
   it — and a panel that quietly dropped those would read as "this page is
   clean", which is a worse answer than the terminal's.

The panel chrome lives in a shadow root, so that is the entire cascade it is
ever exposed to — no resets, no specificity games against the host app's
stylesheet, which in wp-admin is considerable. The client is ES5 and free of
template literals on purpose: it is embedded in a template literal, and a client
that cannot contain a backtick is one nobody has to escape correctly forever.

### Panel details

- **A selector as authored is not always one the DOM will accept**, and one bad
  selector must not take the panel down. Pseudo-elements have no node to match,
  and a state pseudo-class describes *when* a rule applies rather than what it
  applies to, so both are dropped. The strip uses a trailing lookahead rather
  than `\b`: a word boundary sits happily between `focus` and the `-` of
  `:focus-visible`, so `\b` would leave `-visible` welded to the class before
  it — `.components-button-visible`, a perfectly valid selector for an element
  that does not exist, which is the one failure here that stays silent.
- **An unreadable `@media` condition is treated as no condition.** An
  unparseable query normalizes to `not all`, which never matches, and reporting
  that as "inactive at this width" would invent a reason the finding is not
  showing.
- **Ordering is the panel's one opinion**: what this page can actually show you
  comes first. A finding styling live elements right now is the reason to be
  looking in a browser at all; one behind a breakpoint you are not at is real
  but not visible; one that resolves to nothing is a hint the page does not
  exercise it; one with no selector was never a browser question.
- **The condition is shown whenever there is one**, not only when it fails:
  "styling these three elements, and only under this query" is a different fact
  from "styling these three elements".
- **A resize restates the list, not just the boxes.** Crossing a breakpoint
  turns findings on and off. Debounced, because a drag fires continuously and
  each render re-runs every selector.
- The client is **told its own address** rather than guessing from
  `document.currentScript`, which is null once the script has been `eval`'d from
  the console — and the port is read back from the socket, since `--port 0` asks
  the OS to choose and a client told the port it *asked* for fetches from
  nowhere.
- **The permissive CORS header is the feature.** The app under inspection is on
  another port, and under wp-env another host entirely; these are read-only
  findings about the developer's own working tree, served to a page they just
  clicked a bookmarklet on.
- **The bind is what bounds it.** `/findings.json` has no auth, so a server on
  every interface — Node's default when `listen` is given no host — hands every
  path, selector and literal in the tree to the network. Every client runs in
  this machine's browser (the bookmarklet, the WordPress mu-plugin, whose URL is
  printed into the page rather than fetched by the container, and the DevTools
  extension, which reads `127.0.0.1`), so it binds loopback. `--host` is the
  explicit opt-in for a browser on another machine. The URL then names the bound
  address rather than `localhost`, for two reasons: the client is told that URL
  as the one to fetch from, so it must be one the other browser reaches; and the
  banner is where the reader learns what the server is reachable at. An empty
  `--host=` is loopback too, because Node reads an empty host as none.
- **A failed analysis must not read as a clean page**, so the status code keeps
  it out of `.json()` while the client shows the message.

## Shared shapes

The types live in one file rather than beside their producers because most of
them are contracts *between* modules — a `Finding` is built in `analyze.ts`,
grouped in `report.ts`, keyed in `baseline.ts` and rewritten in `autofix.ts`. A
shape that four modules read is not owned by any of them.

Rule ids are the keys of `RULES`, so a typo in one is an error at the place it
was typed rather than a silently-absent lookup somewhere downstream.

**`group` is its own field, not `code`.** The two pattern rules are the only
findings that cannot exist in one file: a composite rebuilt in six files is one
defect reported six times, and only a shared key puts those six back together.
`code` happens to hold the same value today, but `code` is the *baselining*
identity — tying the cluster to it means a future change to what survives a
value tweak silently regroups the report.

**An empty `suggest` array is kept, not dropped.** The entry is still there, one
per flagged declaration, so a consumer can tell "no token for this" from "this
declaration was never flagged" without reading it back out of `message`.

`judged` carries the answer and its confidence **as data** — a later reader,
`fix --judge` or an autofix accepting judged answers above a floor, takes them
from there rather than parsing the prose. `spans` are the parts of `message` the
judgement wrote, which the report paints green.

`hints` and `suffix` are working state: the token pass reads them to rewrite
`message` and drops `hints`, and `suffix` survives just long enough for the
message to be bounded around it. They are optional so deletion is legal, and
absent from anything a formatter sees.
