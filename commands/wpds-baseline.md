---
description: Record current WPDS findings as an accepted backlog so only new drift is reported
---

Record the existing findings as a baseline, turning the backlog into a ratchet:
what exists now goes quiet, anything new surfaces immediately.

Show the scale of what is being accepted first:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" check --all --format json --patterns "${CLAUDE_PLUGIN_ROOT}/patterns/index.json"
```

Report the count by rule and confirm before writing — a baseline is a decision
to defer real work, and it should be made deliberately rather than as a way to
get to a clean report.

On confirmation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" baseline --patterns "${CLAUDE_PLUGIN_ROOT}/patterns/index.json"
```

Then tell the user to commit `.ds-hygiene-baseline.json`, and note that entries
key on rule + file + normalized code rather than line number, so reformatting
will not resurrect the whole file.

Suggest burning the backlog down one rule at a time with `/wpds-fix <rule-id>`,
and deleting the baseline once it is empty.
