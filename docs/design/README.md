# Design notes

Why loupe is built the way it is — the reasoning, the failures that shaped each
decision, and the measurements behind the tuned numbers.

**This is not the documentation of what loupe does.** For that, read
[the plugin README](../../README.md) (install, commands, hooks, remediation) and
[the engine README](../../engine/README.md) (rules, config, presets, output).

These notes exist so the code comments do not have to carry them. A comment in
`engine/src/` states what a thing is and what it decides; when it is shaped that
way for a reason that outlived the change, the reason lives here and the file
points at it.

| file | covers |
|---|---|
| [analysis.md](analysis.md) | the analyzer, the three channels, markup and stylesheet scanning, the token set, composite signatures |
| [checks.md](checks.md) | each rule: why its verdict chain is ordered as it is, and what a simplification would break |
| [cli.md](cli.md) | exit codes, the hook protocol, project detection and its budget, config resolution, profiles, state locations, building and distribution |
| [judge.md](judge.md) | the `--judge` layer: each question, every floor, and the eval numbers behind them |
| [map.md](map.md) | `loupe map`: reading DTCG sources, inferring tiers, ranking counterparts, and what is not yet measured about any of it |
| [lsp.md](lsp.md) | the language server: on-save analysis, repo-wide diagnostics, the quick fix shared with `loupe fix`, JSON-RPC framing |
| [report.md](report.md) | the agent format, message bounding, JSON/SARIF/HTML, baseline, the suppression grammar, `fix`, `loupe serve` |

Two other documents sit outside this set:

- [patterns-v2.md](../patterns-v2.md) — the abstract pattern language: what it is
  for and what was deliberately left out.
- [MIGRATION.md](../../engine/MIGRATION.md) — moving off the bash quality hook
  this replaced.

## The recurring arguments

Most decisions here resolve one of a handful of tensions the same way every
time. They are worth knowing before reading any single file:

**The expensive failure is the false positive, not the miss.** A rule that
misses one override costs one override. A rule that reports a false one sends an
agent to change code that was correct, and on a weaker model that becomes a
loop. Nearly every asymmetry in `checks.md` resolves in that direction.

**Silence is the worst failure a gate can have.** A checker that cannot read a
file, cannot resolve a token source, has been handed a registry it ignored, or
has turned a rule off because its needs went unmet, must say so. "Clean" has to
mean "checked and clean" — so unreadable stylesheets become findings, an empty
token set reports nothing rather than everything, and `status` answers through
the same predicates the gate uses.

**One predicate per fact.** Wherever two places computed the same thing, they
eventually disagreed: `status` against the gate, the JSON payload against the
HTML page, a capture-site bound against a report-site one. The fix is always the
same — one computation, two readers.

**Context is the scarce resource.** The agent format is a nesting because a
report that repeats the same remedy 200 times costs more to read than the
findings are worth. The same reasoning bounds messages, collapses whole-rule
findings, and keeps guidance out of per-finding lines.

**Guesses are held to a lower bar than statements.** An inferred config is
advisory by default, never runs a destructive rule at error severity, and says
when it answered from part of a tree. A config someone wrote is taken at its
word.

**Mechanical gates over conventions.** If a rule can be checked, it is checked;
if it cannot, it belongs in an authoring skill rather than in a check that
guesses.
