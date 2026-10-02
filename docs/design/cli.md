# Design notes: the CLI, the hook, and getting configured

Why the entry points, the config chain, project detection and the plugin's file
locations are built the way they are. What the commands *do* is in
[the engine README](../../engine/README.md) and [the plugin README](../../README.md).

## Exit codes are a contract

    0  clean, or advisory findings only
    1  blocking findings
    2  could not run (bad usage, not a git worktree, config error)

CI jobs, hooks and quality runners branch on these, so they are part of the
public surface and change like one.

The hook's protocol sits on top of them: `0` with a `systemMessage` for clean,
advisory-only, or gave-up-after-N-attempts; `2` with stderr for blocking
findings, where stderr is what gets handed back to the agent.

**Bounded retry, not an absolute bail on `stop_hook_active`.** Skipping every
hook-triggered turn means the turn that *fixes* a finding is never checked, so
you never confirm the fix. Instead each session gets N gated passes, then the
gate stands down and says so.

## `--format` is a list, not an `if`/`else` chain

The dispatch used to end in `else`, so a typo — `--format sarf` — printed the
agent format and exited 0. That reads as a successful run to a CI job that then
uploads an empty artifact, which is the worst available failure: silent, and
shaped exactly like success.

The same argument is why parsed flags are written out as a type rather than left
as a string-keyed record. `--files` carries a path list and `--all` carries
nothing; a record typing both as `string | boolean` pushes the distinction to
every read site, which is where it used to get lost.

## Two things on stderr, told apart by colour

A **refusal** ends the run; a **note** is a run continuing on a partial answer.
They were already interleaved on one stream in the same `loupe:` voice, and a
reader scanning for the reason a command exited 2 had to read every line to find
which one it was.

The refusal for "no project here" is one constant, because it is said in two
places — the scope resolver, and the guard that runs before inference so the
walk is never paid for on the way to it. A gate that phrases the same refusal
two ways is a gate whose callers cannot match on either.

Usage text stays a plain template and is painted at the print site: it is also
what `--help | grep` gets, and threading colour through forty lines of it would
put an escape sequence in front of every word someone might search for. Commands
and options are matched where the layout already puts them — the first token of
an indented line — so a reworded description cannot accidentally light up.

## Colour is off unless a human is provably watching

Every other consumer of this output is a machine that reads the bytes: the hook
hands its report back to the agent, `--format json|sarif` is parsed, `--format
html` is redirected to a file, and a CI log is a file too. An escape sequence in
any of those is corruption — which is why the bash wrapper this CLI replaced had
to strip ANSI in the first place, and why that stripping is not coming back.

`process.stdout` is the one stream consulted, even for the stderr sites: a run
whose stdout is a pipe is a run being consumed, and the cost of guessing wrong
in that direction is only a colourless error message.

An empty `FORCE_COLOR=` is an *unset* one. Every shell that has ever exported it
to clear the variable means "not set", and reading it as "set to something that
is not 0" turns clearing the switch into throwing it.

The palette is a vocabulary a reader learns once — magenta for a rule id, cyan
for a component or an option, dim for anything the eye should skip, red/yellow/
green for severity, green inside a finding for what a model judged. Three
surfaces name rules and two name components, so severity's colour lives in one
map: the report and `status` both say what a rule will do in different words,
and two independent maps is how a reader's learned association stops being true.

## Is there a project here?

The guard is **deliberately generous**, because the cost of a false negative is
a gate that turns itself off and says so only in a message the hook suppresses.
Five kinds of evidence, cheapest first, none of which walks the tree:

1. **A manifest**, node-shaped or PHP-shaped. `composer.json` is there because a
   WordPress plugin is as likely to carry one as a `package.json`, and this
   plugin's audience is likelier to be in one than in a React app.
2. **A `.git` entry anywhere up the tree.** Searched upwards, because the case
   that needs answering is the subdirectory, which has no `.git` of its own —
   and answered off the filesystem, which survives the two cases where asking
   git fails rather than answers: a dubious-ownership mount (the normal state
   inside a container) and no `git` binary on PATH at all.
3. **git itself**, which still recognises a worktree the filesystem walk cannot
   see — one told by `GIT_DIR`, say. Asked *after* that walk, because it is a
   subprocess and the walk is a handful of `existsSync` calls.
4. **A preset that matches**, which is the engine's own definition of a project.
   A deployed block theme in `wp-content/themes/` has a `theme.json` and a
   `templates/` directory and frequently none of the above, and `detectPreset`
   identifies it at high confidence. Refusing to gate a directory this same
   binary confidently identifies is indefensible. Asked last: it is the dearest
   of the five, though still bounded — manifests three levels down and the
   markers in the root and its immediate children.

`--all` and `--files` name their own scope and never ask git anything, so they
work perfectly well in a directory that is neither a package nor a worktree.
`--changed` is only a scope on the two commands that resolve one: `detect
--changed`, `baseline --changed` and `status --changed` ignore it entirely, and
a guard standing in for a refusal those runs would never have got is a guard
inventing one.

The hook is the exception, and for a different reason: its root falls back to
the process cwd whenever `CLAUDE_PROJECT_DIR` is unset, so it is the one caller
that gets pointed at a directory nobody chose.

## Asking git

`isWorktree` asks git rather than the filesystem on purpose: a linked worktree's
`.git` is a file, a submodule's is a file too, and a subdirectory of a repo has
no `.git` of any kind while still being a perfectly good root to run in.

**The answer is read, not inferred from the exit code.** `rev-parse` exits 0 and
prints `false` inside a bare repo and inside a `.git` directory — neither of
which has a worktree to diff against — so a caller that only checked for a throw
was told yes in exactly the two places the question means no. A `git` that
refuses to answer throws, and that is a "don't know", not a no.

`isRepoPath` is the filesystem fallback for when git will not answer. Checking
only `root` covered the top of a repo and nothing else, which is precisely the
case `isWorktree` was added to catch — so it walks up.

## Detection: inference, budgeted

The hook runs `loupe hook` with no `--preset`, so a project without a
`loupe.config.json` fell through to `generic` — which declares no component
layer, which disables every correlation rule. **The gate stayed green and quiet
on exactly the wp-admin code it exists to check.** A preset that has to be
selected by hand is a preset that mostly isn't.

So inference, treated as the guess it is: `inferred: true` travels with the
result, and the CLI refuses to let an inferred config run a destructive rule at
error severity.

**The budget is 50,000 directory entries.** Inference is a guess, and a guess
does not earn an unbounded walk. The caller that matters is the hook, which has
60s for a PostToolUse and 120s for a Stop, and whose root is sometimes a home
directory. 50,000 is several times the largest project this plugin plausibly
meets — WordPress core is around 7,000 files and Gutenberg around 15,000 once
`node_modules` is pruned — so a real repo reaches its own end long before the
ceiling, and a tree that trips it is one where the answer was never going to be
about a project anyway. It costs about a second of walking.

*Entries*, not files: a home directory is mostly directories that hold almost
nothing — a package cache, a pnpm store, maildirs — and a file-counting budget
walks all of them for free.

**Every `package.json` in the project, shallowest first.** A WordPress repo is
very often a monorepo: the root manifest carries `@wordpress/env` and a build
script, and the plugin that actually imports `@wordpress/components` sits a
directory down. Reading only the root meant those repos detected as `generic`.

**Markers live in the presets, not in the detector.** A preset declares a
`detect` block and the detector walks them by descending priority. That is the
whole difference between "add a design system" meaning a JSON file and meaning a
patch to the engine. Priority matters where two presets both match: `wpds`
outranks any weaker WordPress preset because it extends one and adds the token
prefix and severities the plugin exists to enforce.

A preset declaring neither kind of marker is never inferred —
`wordpress-components` is a parent others extend, not a conclusion, and
`generic` is the fallback rather than a match.

### Namespaces need evidence from both sides

A prefix counts only if it appears in **both** the CSS and the markup. A prefix
present only in CSS is exactly what a dead class looks like, so accepting it on
CSS evidence alone would let `css/dead-class` bootstrap its own false positives.

And a prefix defined by an installed dependency is thrown out. A prefix in both
the project's CSS and its markup looks exactly like a namespace the project owns
— and that is also exactly what styling a third-party library looks like. `rbc-`
(react-big-calendar) passed every test and accounted for every dead-class
finding in a real repo, all of them false; the rule then tells an agent to
delete CSS holding a vendored component together. The distinguishing evidence is
where the class is *defined*: a library ships its own stylesheet, and a
project's own namespace appears nowhere in `node_modules`.

### More detection guards

- **Library prefixes come from *every* shipped preset**, not just the detected
  one, so a project styling only third-party classes yields no namespace rather
  than adopting theirs. Each preset lists the prefixes its design system owns,
  and a prefix owned by any of them is somebody's library whichever preset this
  project turned out to be.
- **A truncated walk demotes `high` only.** The prefixes it did not reach are
  exactly the ones that would have changed the answer, and coverage is measured
  against what was read — which is why it can look convincing and still be
  wrong. `none` is a different and still-true claim, and swallowing it printed
  "(none found) [low confidence]".
- **`--profile <id>` beats a guess.** Inference's own verdict is still returned
  as `preset` so `status` and `init` can report it, but the config extends what
  the flag named — and everything derived from the preset has to follow, or the
  config ends up extending one preset while carrying another's token sources.
- **Token sources resolve against the manifest that asked for the library.** A
  preset writes them relative to the project root; in a monorepo the design
  system is installed beside the nested manifest, so without that the token set
  comes back empty and every finding goes back to naming a namespace.
- **The shallowest manifest declaring the library wins**, so a root that happens
  to list it beats a nested one, and that is also what names where its
  `node_modules` — and therefore the token stylesheet — will be.

### Saying when the answer came from part of a tree

Namespaces, precisely. `detectPreset` reads manifests and top-level markers
rather than walking, so the preset line stays as good as it ever was and can
legitimately read `high`. It is the namespace list that came from a prefix — and
one drawn from a prefix looks exactly like one drawn from a whole project, down
to the confident-looking coverage percentage, which is computed over what was
read.

Four surfaces say this — stderr, `status`, `detect`'s `scanned:` line and the
hook's own message — so they are built from two shared fragments rather than
written out four times.

## File discovery

One walk of the tree, matched against the three source globs. Directories are
pruned against the ignore globs *during* traversal rather than filtered
afterwards, so a large `node_modules` is never enumerated.

**The walk is unbounded by default**, because a scan that quietly stopped
halfway would report "clean" for the half it never read. Only a caller that is
merely guessing passes a `limit`, and it reads `truncated` back.

**Dot-directories are pruned unless a glob names one.** With picomatch's `dot:
false`, nothing inside `.venv`, `.cache`, `.cargo`, `.yarn/cache` or a pnpm
store can match a `**` glob anyway, so descending into them buys nothing and
spends both the clock and the entry budget. Only a glob naming a dot segment
ahead of its filename — `.storybook/**/*.css` — can reach inside one, and a
project config may write that as a brace alternative, which is why the test
looks inside the braces rather than only at the first character.

**Byte order, not collation.** `readdirSync` hands back whatever order the
filesystem holds, and that differs between filesystems and between runtimes:
Node and Bun disagree on the same directory, which is how the compiled binary
came to cite a different example file than `node` did for the same project.
`localeCompare` would not fix it — it folds case, treats `-` as ignorable, and
answers differently under a different ICU or `LANG`. An order this engine
reports has to be a property of the input, not of the host.

An unreadable directory yields nothing rather than throwing, in one place rather
than in every caller that noticed.

**A path that cannot contribute is skipped early.** The PostToolUse hook fires on
every Edit and Write, and without that a README edit paid for a whole-repo index
to be told there was nothing to say about a README — on a large repo, past the
hook timeout on its own.

**Entries are counted, directories included.** Counting only files left the
budget blind to the shape a home directory actually has — `~/.cache`,
`~/.cargo/registry`, a pnpm store: hundreds of thousands of directories holding
almost no files at all. The cost being bounded is the cost of reaching an entry.

**Files at each level before the subdirectories below it.** Depth-first on both
at once meant the budget could be swallowed whole by the first subdirectory the
filesystem happened to hand back, and a walk that stopped there reported zero
source files for a project whose own were sitting in the root — an answer that
reads identically to "this project has none".

### `--changed`

`diff HEAD` spans index and worktree, so it already covers staged files. Without
a HEAD it fails outright, and `ls-files --others` does **not** cover the gap:
staging a file stops it being "other", so a fresh repo whose work is staged
reported an empty scope and the gate passed clean. Before the first commit,
every tracked file is new by definition.

**`--relative` is load-bearing.** Findings are keyed relative to the project
root, and `ls-files` is already relative to `cwd` — but `diff --name-only`
answers from the *repository* root, so when the project sits in a subdirectory
of the worktree the two halves of one Set were in different coordinate systems
and nothing in it ever matched a finding. `--changed` is the hook's default
scope, so a gate on a monorepo package reported "clean" without checking
anything.

## Config

Everything project-specific lives in config. The rules and the file walker know
nothing about WordPress, or about any particular design system.

Resolution order, most explicit first:

1. an explicit `--config` path
2. an explicit `--preset`
3. a discovered project config file
4. an inline object (what auto-detection produces)
5. the `generic` preset

`source` records which won, and `inferred` marks a config nobody wrote down.

`extends` resolution is split out so a config that never touched disk — the one
auto-detection produces — goes through the same resolution as a file.

The deep merge **replaces arrays rather than concatenating**, so a preset can be
overridden, and it is declared as returning the base's type: merging *onto*
`DEFAULTS` is what makes every field present, and that is what keeps a settled
config strict downstream.

**A registry that does not resolve leaves itself empty rather than throwing.**
The engine has to keep working in a project that ships no patterns; an unresolved
path disables the rules that need one. The same is true of a registry scoped to
packages this project does not import — it describes some other design system
that happens to name its components the same.

**The compositional rules need the packages and nothing else.** A composite is
built from every name imported out of `designSystem.packages`, whether or not it
is a layout or text primitive — and a headless library (Base UI, Radix) has no
layout or text layer at all, so gating its composites on one meant the only
rules that could ever have fired on it were off by construction.

**Attaching a registry keeps `enabled` in step.** Assigning `config.patterns`
alone leaves the rules that read it off, which looks exactly like "no composite
drift found". One computation serves normalization and a registry attached
afterwards, so the two cannot disagree about what a registry enables.

The suppression vocabulary of every shipped preset is read from the presets
directory rather than kept by hand, for the same reason the preset list is: a
hand-kept list drifts the moment a preset is added, and here the drift is
invisible — a directive written in the missing vocabulary simply stops
suppressing. Both halves matter: a term one preset treats as a blanket disable
must never become a muting keyword somewhere else just because a third preset
names it.

### Coercion throws, because the silent reading is worse

`merge` copies a non-object value from authored JSON verbatim, so the declared
types are a contract with the author, not a check. Every coercion that cannot
mean what it says throws, because the alternative is a config that reports
exactly like a correct one:

- `"substitutionProps": "render"` → `new Set('render')` is a set of four
  characters, and the exemption reads as off with nothing to see. The fallback
  is the *default* rather than `[]`, because this is the one key whose default
  is not empty: `merge` writes an explicit `undefined` straight over the
  default, so `designSystem: { ...opts, substitutionProps: opts.subs }` in a
  `.mjs` config would otherwise turn the exemption off silently. `[]` stays the
  way to ask for that on purpose.
- A bare string where a directory list belongs costs more: it is walked one
  character at a time, `/` is the repo root, and every project stylesheet is
  then skipped as the library's own — a clean report from a gate that read
  nothing.
- `"keyword": ""` makes the parser's `startsWith`/`includes` universally true
  and reports every line of every file as malformed; `"keyword": 12` throws out
  of `escapeRe`; `"blanket": "ds-disable"` spreads into eleven single-character
  prefixes.

An unusable suppression vocabulary falls back to the default for the same reason
an unreadable preset directory does: a broken install still has to run.

**Read aliases keep a recorded reason counting.** The keyword is preset-scoped,
so adopting a preset renames it — and a directive in the old vocabulary is not
read as a directive at all, which loses the suppression and reports nothing.
Every keyword the shipped presets know is read; `keyword` alone is still what
the tool tells people to write, and the only vocabulary a malformed directive is
judged against. A blanket term anywhere in the shipped presets is never an
alias: `wpds` refuses `ds-disable`, and another preset adopting that spelling as
its keyword must not turn it into a mute. Declared aliases are filtered too —
the guard is about the term, not about who named it.

## Presets and data files, compiled in

`dist/loupe.mjs` can reach its presets on disk — it sits one directory below
them, and `bin/loupe.mjs` keeps `dist/` at the same depth as `src/` precisely so
the `import.meta.url` arithmetic lands in the same place from either entry. **A
single-file binary has no such directory.** `import.meta.url` inside one
resolves to a synthetic root, so every `join(HERE, '..', 'presets')` becomes
`/presets`, and the engine comes up unable to name a single design system.

So the data is imported rather than read, which puts a copy inside whatever
artifact the bundler produces. **Disk still wins wherever it exists**: `presets/`
remains a published directory you can read, copy and extend, and a preset dropped
in by hand takes effect in the run that adds it. The import and the disk read
name the same file, so there is one source and two ways of reaching it.

The same `import.meta.url` arithmetic is also how the CLI knows *which* loupe is
answering. Three copies can coexist on one machine — a checkout, a dotfiles clone
on PATH, the marketplace install the hook runs — and the manifest alone cannot
say which one answered. A binary is detected by the absence of that manifest,
which makes the test independent of how any particular compiler spells its
synthetic root.

## Where state lives

Two kinds of state, two different answers.

**The hook's retry counter** is ephemera about one session, and running as a
plugin means writing nothing into the project. It expires after six hours
anyway, so it goes in the plugin's data directory, or a temp directory of this
user's own, keyed by project path. Per user, never shared: on Linux `tmpdir()`
is the one `/tmp`, where a `loupe/` another user made first is not writable, so
every count would be lost and the gate would block at attempt 1 forever.

**The baseline** is the opposite: a statement about *this repo* — which findings
it has agreed to live with — so it lives beside the code, always, and can be
committed. Keying it to plugin data made its location depend on how loupe
happened to be invoked, which is a bug the shape of a mystery: `loupe baseline`
from a shell (no `CLAUDE_PLUGIN_DATA`) recorded a backlog into the project, the
Stop hook then looked in plugin data, found nothing, and blocked on every
finding it had just been told to accept — with nothing in the log to say the two
runs were reading different files.

A named path is honored as given, because someone who names a file wants it
where they named it. When the config names a file that isn't there, the
project's own `.loupe-baseline.json` answers instead and the fallback is
reported: dropping it lost every accepted finding in the window between a config
change landing and the file actually moving.

A `--baseline=` arrives as an empty string and means "nobody named one" —
falsy, not nullish. A writer taking it as a path would put the backlog somewhere
the readers never look, which is the same split the module exists to close. So
it is normalized once, at the top of `main()`, and the writer and every reader
are handed the same `string | null`; an empty config `baseline` is normalized to
the default name once, in `loadConfig`. Nothing downstream re-derives either
rule, so none of them can drift to `??` on its own.

**No writable state directory just means no retry-budget tracking.** Bookkeeping
failure never takes down the gate.

## Turning the gate on

**Off by default.** A gate that fires in every repo the plugin is installed for
lands findings in sessions that are about something else. A project opts in
where Claude Code keeps per-project, per-person switches —
`.claude/settings.local.json` → `"env": { "LOUPE": "on" }`.

Claude Code hands that to the hook as an environment variable, **which a
terminal never sees**, so the same files are read when the environment has
nothing to say. Otherwise `status` typed by hand reports OFF for a project the
hook is gating.

The same applies to plugin options. Claude Code refuses to substitute
`${user_config.*}` into a shell-form hook command, but exports every option to
*hook processes* as `CLAUDE_PLUGIN_OPTION_<KEY>` — to hook processes only. So
`status`, whose entire job is to say what the gate will actually do, could not
see the blocking switch from a terminal. The values are also in the settings
file under the plugin's key; they are read there when the environment has
nothing to say, and the source is reported so a stale answer is recognizable as
one.

**One spelling of "on" for every switch.** The set was written out three times —
plugin options from the environment, the same options from the settings file,
and the `LOUPE_OFF` gate — which is two chances for a switch to mean something
different depending on which door it came through. It also made `status`
disagree with the gate: `LOUPE_OFF=0` reported the hook OFF while the hook went
right on blocking.

**Why the hook can scope to one file.** Scoping a PostToolUse run to the file it
just touched is what turns this from a review-time gate into a write-time one:
the drift is reported while the agent still has the decision in hand, rather than
forty tool calls later once the pattern is load-bearing and every argument for
keeping it has become locally true.

## Profiles

The engine is design-system agnostic: everything it knows about WPDS arrives as
config. **The plugin was not.** It passed the WPDS pattern and component
registries on every run, to every project, because there was nowhere else to put
them. On a WordPress repo that is invisible. On any other React repo it is a
WPDS composite matching by name alone, and a finding telling the agent to import
a module that does not exist there.

A profile is the bundle that makes one design system real: which packages it is,
which preset configures it, and the registries describing its components and
composites. Profiles are selected by what the project actually imports, so
shipping a second design system is adding a directory — never editing the
engine.

**Why a registry must declare who it is for.** Pattern signatures are component
*names*, and names are the one thing design systems do not keep to themselves:
`Stack`, `Button`, `Modal` and `Text` mean something in almost all of them. The
WPDS `page-header` signature — `Stack(Stack(Text,Text),Stack(Button))` — matches
a Chakra page header exactly. A registry declaring `packages` applies only to a
project importing at least one of them; one declaring none applies anywhere,
which is what a project's own registry wants and what every registry written
before the field existed gets.

`--profile <id>` skips the scope question, because that question —"is this
project on that design system?" — is the one the flag already answered. Asking
it again drops the registries of the profile the user named.

**Reading profiles is failure-tolerant by contract.** One bad directory must not
take the gate down, so a malformed or unreadable profile is skipped rather than
thrown. Every field is whatever JSON happened to hold: `id` in particular is a
Set key, the thing `--profile` is matched against, and a sort key — and that
sort runs outside the per-profile `try`, so a manifest carrying `"id": 3` used to
throw past all of it. Under `loupe hook` that is exit 2: a turn blocked by a
stack trace, which is exactly what the contract promises one bad directory
cannot do. An id is claimed only once its entry is on the list, or a directory
that threw on the way locked the id out and a well-formed second directory
claiming it was dropped too.

Sorting, here as in `discover`, is what makes "the first one wins" a fact rather
than a filesystem accident.

**The project always wins a registry merge**: a repo that has written down its
own `page-header` means that one, not the shipped generic. What was applied and
what was skipped both come back, so the CLI can say why a registry it was handed
did nothing — a registry silently ignored looks exactly like a registry with no
findings. Each source is reported with what it actually contributed, not just its
label, or a forced registry whose every id collided with the project's own reads
as fine because some *other* source filled the same list.

Merging a registry by fiat is not the same as its rules coming on: a composite
signature still needs a component layer to match against, and a registry that
contributed no entries enables nothing. Either way it is exactly as invisible as
one that was skipped — so the notes are stated in the order a reader would check
them, and every rule the registry feeds is tested rather than just the first.

## The rule catalog

`title` is one-time fix guidance, printed once per group header. Per-finding
lines carry only what varies — `file:line` plus the offending code — so the
guidance is never repeated across hundreds of lines. The agent reading this
output pays for every duplicated token.

`rank` orders findings within a report and lives in the catalog so severity and
ordering are data rather than scattered magic numbers.

`needs` declares what a rule requires from the design-system model, and a rule
whose needs the active config cannot meet **disables itself**. That is what lets
a component-less preset — a block theme, say — reuse the same engine without
emitting garbage.

Titles interpolate `{placeholders}` from the resolved design system, so guidance
names the components actually in play. **One prefix is a namespace; several are
families within one**, and naming the first of them is a different, wrong
statement: a system whose tokens are `--color-*`, `--space-*` and
`--type-styles-*` told agents to fix `font-size: 18px` with "a `--color-*` type
token", which does not exist. With no single namespace, the title says nothing.

A legacy rule id resolves to a plain string rather than a `RuleId`: the input is
whatever someone typed in a config or a comment, and claiming it is a known rule
is exactly the lie that would let an unknown id reach a lookup unchecked.

## Shaping one run

### The root is the project, not the directory you are standing in

The hook roots at `CLAUDE_PROJECT_DIR`; a typed command used to root at the cwd,
so the same repo had two roots and everything keyed off one of them disagreed.
`loupe baseline` in `packages/app` of a monorepo wrote
`packages/app/.loupe-baseline.json` with subdirectory-relative keys, and the
hook — rooted at the repo — never read it and blocked on the findings that had
just been accepted. Anchoring to the config the run is actually governed by
makes the two agree, because it is the same config file the hook resolves.
`--root` still overrides, for the case where someone means the subdirectory.

Related: an absolute path in `--files` matched nothing, because findings are
keyed repo-relative — and the run reported clean, which is the worst answer a
gate can give.

### Which preset wins

An explicit path or a typed `--preset`; then a discovered project config; then
the plugin's `preset` setting; then whatever the project itself implies.

**The plugin setting sits below the project config on purpose.** Both the README
and the option's own description promise "a project's own `loupe.config.json`
always wins", and it did not: the setting reaches the hook through the
environment and a terminal only through a best-guess read of
`~/.claude/settings.json`, so the two sides loaded different configs — different
severities, a different suppression keyword, and therefore different finding
keys, which means a baseline recorded on one side matched nothing on the other.
A setting naming a default for projects that have not written a config is
useful; one that quietly discards a config they did write is the split that
branch exists to end. `--preset`, typed at the moment of use, is a different
thing and still wins.

**A named profile's preset ranks last among statements about this project** —
`--config`, `--preset`, the plugin option's preset and the project's config file
each outrank it — and first against inference, which is a guess about the design
system `--profile` just named outright. Until that existed it was read by
nothing at all: naming a profile merged its registries into a config that knew
none of its components and left every severity at the generic default.

A profile naming a preset this install does not carry is a broken profile, not a
broken project: its registries still apply, so name what was ignored rather than
failing the run over it.

**An override replaces the preset inference chose, not the run it produced.**
The namespaces are a reading of *this* project and hold whoever picked the
design system; skipping detection to inject the preset instead dropped them,
which switched `css/dead-class` off on a repo where it had been running and left
`init` writing that loss to disk.

### The project-shape guard runs ahead of inference

Inference walks the tree; the scope resolver decides there is no project here.
In the other order the whole walk was paid for on the way to the refusal — and
`hookRoot()` falls back to the process cwd whenever `CLAUDE_PROJECT_DIR` is
unset, so the tree being indexed was sometimes a home directory, on every edit,
past the hook's timeout.

Only where there is nothing but the directory to go on: a config file,
`--config` or `--preset` is somebody stating that *this* directory is a project,
and that statement outranks anything guessed from shape. The `preset` plugin
option is not such a statement — it is set once, for every project its owner
ever opens — so it configures the run without vouching for the root.

### A gate that cannot configure itself stands aside

Under the hook, `EXIT.CANNOT_RUN` is exit 2, which blocks the turn. A mistyped
preset in the plugin settings would otherwise block every turn in every project,
with nothing the agent could do about it.

### Silence, not advisory mode

`LOUPE_OFF` makes the hook say nothing at all. An advisory finding still lands
in the agent's context, and an agent that sees a finding starts fixing it —
which is the whole complaint. Deliberately hook-only: `loupe check` typed by
hand is someone asking, and answering "nothing" would be a lie.

### The payload is drained before anything can return

Claude Code writes it to the hook's stdin, and a hook that exits without
draining leaves the writer holding a pipe nobody is reading. Once the payload
outgrows the pipe buffer — which a Write of a large file does, since
`tool_input.content` carries the whole file — the write fails with EPIPE instead
of completing. Every early return is downstream of that read, the off switch
most of all: silencing the gate must not turn every large write into a broken
pipe.

### Guesses do not drive destructive rules

An inferred namespace list is a guess, and `css/dead-class` tells an agent to
delete code, so an inferred config never runs it at error severity.

More broadly: a config file is a deliberate statement about *this* project, so
its severities stand; an inferred config is a guess about a project the plugin
has just met, and blocking someone's turn on a guess is hostile. A guessed
config is advisory-only unless blocking is explicitly turned on.

**`init` must never launder a truncated answer into an authored one.** A written
config is no longer a guess: `inferred` goes false, which turns blocking back on
by default and lifts the `css/dead-class` demotion. A namespace list drawn from
part of a tree would then block turns and tell an agent to delete classes it
never read the stylesheet for.

### A silently-ignored registry looks exactly like a clean one

Registries reach the engine two ways — named directly, or carried by a profile
the project's own imports selected — and both report what they did. A registry
handed over and then ignored has to say so. The same goes for one merged past
the scope check that still did not do what merging it was for: `--profile`
forcing a registry in does not make its rules run.

A named profile that resolves to nothing used to be a silent no-op — no
registries, no preset, exit 0 — which is indistinguishable from the profile
applying and finding nothing. Worse, it also suppresses the profile *selection*
would have made, so a typo checks strictly less than no flag at all.

### Truncated inference is used, never used silently

A partial answer beats `generic`, which switches every correlation rule off. But
under the hook stderr is the wrong channel — a clean run's is discarded, and a
blocking one's is the agent's report — so the hook says it where it speaks,
appended to the `systemMessage`. The hook is the caller this ceiling exists for;
it cannot be the one caller that never hears about it.

## `status`

`status` exists to say what the gate will actually do, so every answer it prints
comes from the same predicate the gate uses. Reporting on mere truthiness meant
`LOUPE_OFF=0` printed OFF while the hook went on blocking — a diagnostic lying
about the one thing it exists to say. Settings are resolved for every command
for the same reason.

**One conclusion, asked once.** "Do the severities permit blocking" is not the
same question as "will this gate stop a turn", because a silenced hook stops
nothing. Deriving the two separately is what let `status` print `hook: OFF` and
`Turns are blocked by: …` seven lines apart.

Everything it prints is **what will actually happen, not what is configured**: an
error-severity rule under a gate that is not allowed to block is advisory in
practice, and painting it red says otherwise.

It also prints what design system the run thinks it is checking, in the terms
the rules are written against — the rules roster says which checks are live, not
what they will name as the remedy, and that is the half a skill authored for no
design system in particular has to read before it writes a line of UI. **Empty
fields are printed as such**: "no layout primitive" is a fact about the system,
and inferring it from a missing line is how a skill ends up recommending one
that isn't there.

And which profiles are in play, with their directories — "no composite findings"
and "no composite registry" look identical in a report and must not look
identical here. The directory, not just the id, because a profile carries the
authoring prose for its design system beside its registries, and a skill told
only "archer" has to guess where that lives.

The two registry-backed rules get their own explanation, because what they fire
on is a list somebody else authored: a title saying "a current component now
covers this job" without saying whose list decided that leaves a reader with
nothing to check. The count applies the same filter the rule does — counting
every `legacy` entry would overstate it.

## `fix`

Only substitutions the engine resolved to exactly one on-role token. **The
baseline is deliberately ignored**: it exists to stop the gate blocking on an
accepted backlog, and burning that backlog down is the point of the command.

Suppressions are written after the rewrites, which never move a line, and bottom
up within a file, because a directive is a line of its own.

**A declaration acted on is not a finding cleared.** A collapsed finding is
several declarations; what is counted as done is the finding every one of whose
declarations was rewritten or suppressed.

Printed values are flattened but not bounded. Both lines exist to be acted on —
the skip names a value the reader now has to find and edit by hand, and the
applied line is the preview `--dry-run` exists to give — and an elided value is
one neither of them can be matched against. This is the one place flattening
belongs at the print site rather than at capture, because the raw value is what
the substitution matches against.

## `check`

A misspelled flag is rejected **before** the analysis: a run that is going to be
rejected should not first walk the repo. `--group-by` is rejected as loudly as
`--format`, for the same reason — a `--group-by fil` that fell back to the
default would print a perfectly good report in the order the caller did not ask
for, and nothing about it would look wrong.

`--concise` does **not** get that treatment, and the asymmetry is deliberate but
not free. It is a boolean switch, and `parseArgs` runs non-strict, so `--concsie`
is silently ignored and the full report prints. That is the same exposure every
other switch here carries (`--judge`, `--dry-run`, `--all`), and it is the
cheaper failure than the value-flag one: the caller gets more than they asked
for, not a different thing that looks right. A `--verbosity concise|verbose`
enum would close it at the cost of a validation branch for two values; the switch
is the version that shipped, and this is the ceiling it accepts.

**An unparseable baseline is not the same as no baseline.** Treating it as one
puts the whole backlog back with the gate blocking on all of it, silently, which
is how this class of bug stays unfound — and conflict markers in a committed
baseline are the ordinary way to get there. The hook says it too: guarding it on
`!isHook` kept it quiet on the one surface where it bites, where the agent is
handed back a backlog it explicitly accepted, with no reason given, and spends
its retry budget on findings nobody asked it to fix.

**Judgement runs after the baseline**, so accepted findings cost nothing — and a
judged finding never enters a baseline, since its confidence moves between runs
and a baselined finding that comes and goes is noise in both directions.

## The stand-down latches

Clearing the retry counter when the gate stands down reset the budget, so "gate
stood down" lasted exactly one turn: the next fire blocked at attempt 1 of 3
again, and an agent that could not fix a finding was stopped in perpetual bursts
of three for the rest of the session. Leaving the count above `max` keeps the
stand-down standing; the clean-run branch still releases it the moment the
finding goes, and the state ages out either way.

Said once, too. Repeating the stand-down line every fire is the same nagging the
stand-down exists to end.

## `process.exitCode`, never `process.exit()`

`exit()` tears down the process before a large stdout write has drained to a
pipe, which silently truncates JSON and SARIF output when a caller pipes it
anywhere.

## Building and distribution

The engine exists three times, and none of them is a replacement for another.

**`src/` is the real code**: TypeScript, needing its three dependencies and a
Node that strips types (22.18+).

**`dist/loupe.mjs` is that same code bundled and transpiled, and committed.**
Nothing in a Claude Code marketplace install runs `npm install` on a plugin's
behalf, so an engine importing `picomatch` at load time is an engine that throws
on every hook run for anyone who installed it the normal way. Committing the
built artifact is the cost of being installable without a toolchain.

Two things keep that artifact honest rather than a second source of truth:
`bin/loupe.mjs` prefers `src/` wherever the dev toolchain is installed, so a
checkout someone is editing never runs the bundle — pinning it to one would mean
edits to `src/` silently doing nothing until a rebuild, a gate reporting
yesterday's verdict on today's code — and `--check` re-bundles and compares,
which is what CI runs to reject a commit whose `dist/` no longer matches.

esbuild transpiles TypeScript itself; it strips types, it does not check them.
Type checking is `npm run typecheck`, and both run in CI: a bundle that builds
is not a bundle that type-checks, and neither substitutes for the other.

`dist/` sits at the same depth as `src/` so the `import.meta.url` lookups inside
the engine — the preset directory, the plugin manifest — resolve to the same
paths from either entry.

postcss ships CommonJS, and esbuild's ESM output stubs `require` with a shim
that throws on node builtins, so postcss dies on its own `require('path')`
before the first file is read. Handing the bundle a real `createRequire` is what
lets a CJS dependency keep behaving like one inside an ES module. The `import(pkg)`
in `syntax.ts` is deliberately left unresolvable: the two syntaxes not shipped as
deps are the host's to provide.

### The binary

**A third artifact, for the places that have no Node and should not be made to
grow one** — somebody else's CI, a pre-commit hook in a repo that is not
JavaScript, a designer who wants the checker and not a dev environment.

Bun does the compiling because it is the only toolchain that reads the engine's
TypeScript as-is and cross-compiles to every target from one machine. It is a
build-time tool: nothing about the produced binary depends on Bun being
installed anywhere else.

Output is deliberately **not** `dist/`. That directory is committed, and these
are 60–100 MB each — they belong on a release, never in the history.

Linux is built twice on purpose. The default build links against glibc and exits
"not found" on Alpine, which is what a lot of CI actually runs, and the failure
reads like a missing file rather than a missing libc.

**No credential is ever compiled in, and nothing may change that.** The engine
reads `process.env.TYPESAFE_API_KEY` at runtime and `--judge` is the user's own
key or nothing — verified three ways against a canary value: a key in a `.env`
at the checkout, a key exported into the build environment, and a `.env` in the
build's working directory all leave the artifact clean, and a binary run with no
key refuses and says where to put one. That holds because the value is read
through `process.env` at runtime and neither compiler substitutes it. **`--define`
is what would break it** — passing `--define:process.env.TYPESAFE_API_KEY=…`, or
anything inlining the ambient environment, bakes whatever the build machine
exported into an artifact meant to be published. Do not add one.

A compiled Bun executable reads the working directory's `bunfig.toml` at startup
and runs its `preload` scripts, and this binary runs **inside repositories it is
checking**. That would be the scanned repo executing code with the job's
environment, so it is off. The `.env` autoload stays on: it is how the binary
finds a `--judge` key, since Bun has no `process.loadEnvFile`.

### The generated reach-for table

A profile's `patterns.md` used to carry a hand-written table of "about to build
→ reach for → not this" beside a registry saying the same things in JSON, and
the two drifted. The table is what an agent reads before it writes, so it is the
half that matters; generating it makes it a projection of the registry rather
than a second copy.

It validates as it goes: every realization key must name something the abstract
language defines, every `resolve` rule must consult a force its pattern declares
with a value the vocabulary lists, and every redirect must land on a real
pattern. That is as much of the registration rule as a machine can check —
"does this occupy an empty cell" is a judgement, but "does this point at
anything" is not.

A force `check --judge` asks about must define every value it can answer with:
an option missing from the criteria is one the model cannot pick, and the
redirect that needs it never fires.
