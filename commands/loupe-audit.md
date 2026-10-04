---
description: Run a design-system conformance audit over the repo (or just changed files) and summarize what needs fixing
argument-hint: "[--changed] [--suppressions] [path]"
---

Run the conformance engine and report what it finds, against whatever design
system this project is on.

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Adjust for the arguments given in `$ARGUMENTS`:

- `--changed` — scope the report to files changed vs. HEAD (still indexes the
  whole repo; scoping the index would make every unchanged reference look absent)
- a path — pass as `--files <path>`
- `--suppressions` — run the `suppressions` subcommand instead, listing every
  active directive with its reason, so stale escape hatches surface
- `--format json` — not a user argument; add it when the summary needs more
  than the default report prints: per-file counts past the densest three, or a
  finding's registry note in full. The default report already opens with the
  tally and the files-scanned count, marks each rule group `blocking` or
  `advisory`, names its densest files and says what its suppressions silence —
  read those off it rather than re-running `check` and grepping its prose
- `--severity error` — likewise yours, not the user's: it drops advisory findings
  from the run, so the tally and the densest-files line describe the blocking set
  alone. Only worth it on a backlog too large to read past — each rule heading
  already says `blocking` or `advisory`

Then summarize for the user rather than pasting raw output:

1. **Lead with the shape of the problem** — which rules dominate, and whether
   the findings cluster in a few files or spread across the codebase.
2. **Separate blocking from advisory.** Blocking findings are the ones the hook
   will stop a turn on.
3. **Call out `stylesheet/unparsed` first if present** — those files were not
   checked at all, so the rest of the report is incomplete until they are.
4. **Say so if a baseline is hiding findings.** `N baselined finding(s) hidden`
   below the report (`summary.baselined` under `--format json`) means an
   accepted backlog is being filtered out, so what you
   are looking at is new drift rather than the state of the repo — re-run with
   `--no-baseline` for the real total. Unsaid, a near-empty report reads as a
   clean codebase. Suppression directives hide findings the same way: add
   `--no-suppressions` for the full audit, with nothing muted.
5. **Do not start fixing.** This command reports. Offer `/loupe-fix` as the next
   step, or ask which subset to take on.

Name the design system in the summary — `loupe status` prints it, along with
the active profile. A report that does not say which system it judged against is
a report the reader has to guess at.

If the repo has no config, say so — the run still worked, against one inferred
from what the project imports. `loupe detect` prints that inferred config so the
user can see what was assumed and `loupe init` writes it to `loupe.config.json`;
`loupe presets` lists the bundled rulesets, any of which runs without one
(`--preset <name>`).
