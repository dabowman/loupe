---
description: Run a WPDS conformance audit over the repo (or just changed files) and summarize what needs fixing
argument-hint: "[--changed] [--suppressions] [path]"
---

Run the WPDS conformance engine and report what it finds.

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" check --all --patterns "${CLAUDE_PLUGIN_ROOT}/patterns/index.json"
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
4. **Do not start fixing.** This command reports. Offer `/wpds-fix` as the next
   step, or ask which subset to take on.

If the repo has no config, say so and note that `--preset wpds` runs the
WordPress Design System ruleset without one.
