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

Then summarize for the user rather than pasting raw output:

1. **Lead with the shape of the problem** — which rules dominate, and whether
   the findings cluster in a few files or spread across the codebase.
2. **Separate blocking from advisory.** Blocking findings are the ones the hook
   will stop a turn on.
3. **Call out `stylesheet/unparsed` first if present** — those files were not
   checked at all, so the rest of the report is incomplete until they are.
4. **Do not start fixing.** This command reports. Offer `/loupe-fix` as the next
   step, or ask which subset to take on.

Name the design system in the summary — `loupe status` prints it, along with
the active profile. A report that does not say which system it judged against is
a report the reader has to guess at.

If the repo has no config, say so and note that `loupe presets` lists the
bundled rulesets, any of which runs without one (`--preset <name>`).
