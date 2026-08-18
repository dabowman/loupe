---
description: Fix WPDS conformance findings, working upward through the rule layers
argument-hint: "[rule-id] [path]"
---

Fix WPDS conformance findings.

**Load the `wpds-remediation` skill first** — it carries the per-rule remedy and
the checks that stop a fix from silently changing how the UI renders.

Get the current state:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/ds-hygiene.mjs" check --all --format json
```

If `$ARGUMENTS` names a rule id or a path, narrow to that. Otherwise work upward
through the layers, because lower fixes change what the higher findings say:
unparsed files, then malformed suppressions, then component overrides, then
layout, then values, then dead classes. Re-run between stages rather than
working from a stale list.

Rules for this pass:

- **Never silence a finding by deleting styling that was doing something.**
  Moving a child's margin to the parent's gap is a fix; deleting the margin is a
  regression with a clean report.
- **Suppress only with a real reason** naming the constraint that makes the
  finding wrong here. "Legacy code" and "matches existing style" are not reasons.
- **Never suppress `stylesheet/unparsed`** — it hides a blind spot rather than
  muting a finding.
- If the backlog is large, propose `/wpds-baseline` instead of a giant diff.

Finish by re-running the check and reporting what changed. If any fix could have
altered rendering, say which ones and why, rather than folding it into a cleanup
summary.
