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
budget on exactly those findings. Two of the full report's lines answer
questions only somebody auditing a whole repo asks — where findings cluster,
what is already silenced — and the suppression inventory is repo-wide where a
hook run has looked at two files, so under the hook they would be noise and a
non sequitur. The tally, the severity words and the next-step line stay: the
first two cost nothing, and the last is most needed exactly where the reader is
blocked and the only other suggestion on offer is how to silence the thing
blocking it.

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
Neither is recoverable from the rest of the line. A registry note rides as a
tail too, and is shortened from the front like any other, because a note is read
for its last clause — "…it wanted Stack, not Grid" is the instruction and
"planned for deprecation" is the background.

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
- Every themed value is `light-dark(light, dark)`. Severity uses reserved status
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
says the rest.

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

**Stylesheet channels only.** The same rule fires on `style={{ padding: '13px'
}}` and on CSS-in-JS templates, where the surrounding syntax is JS and a
CSS-shaped substitution would write a syntax error with a clean report.

**A fix that cannot find its declaration exactly once on the line it was
reported at is skipped**, not guessed at: the file has moved under the report,
and a substitution against a stale line number edits the wrong declaration.
Lines are re-read as fixes apply, because two can land on one line and the
second must see what the first wrote. The property boundary matters —
`background` must not match inside `background-color`, `border-radius` must not
match inside `-webkit-border-radius` — and `!important` and the terminator are
left alone.

**Findings cleared, not fixes applied**, is what gets counted. A collapsed
finding holding one settled declaration and one nobody could settle is still
there. Settled means rewritten *or* suppressed: a value `--judge` kept is as
done with as one it replaced.

Suppressions written for a kept value follow the grammar's own constraints. A
directive mutes its whole next line, so one is written only where **every**
flagged value on that line was kept — muting a line that also carries an
unsettled value would hide it along with the one that was. Not above a rule's
opening line, where a directive covers the whole rule, and not between an
existing directive and the line it is for. Only the nearest line above is read,
so an existing directive would be pushed off its line and what it names would
come back.

The directive names **every** rule the kept declarations on that line were
reported under: a minified stylesheet can put a kept colour and a kept
font-weight on the same line, and one naming only the first leaves the second
reported under a comment that claims to cover it. The reason is what the
judgement said, so the comment records that a model made the call, not a person.

Indentation is copied with spaces and tabs only — `\s` would copy a byte-order
mark onto the directive — and the line's own ending, so a CRLF file stays one.

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
