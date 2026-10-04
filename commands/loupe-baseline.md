---
description: Record current design-system findings as an accepted backlog so only new drift is reported
---

Record the existing findings as a baseline, turning the backlog into a ratchet:
what exists now goes quiet, anything new surfaces immediately.

Show the scale of what is being accepted first. `--dry-run` writes nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" baseline --dry-run --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

It prints what would be recorded, by rule, and — when a baseline already
exists — how each rule's entries differ from it: `+N new` is backlog being
accepted for the first time, `-N fixed` is work done since the last recording.
The last line names the existing baseline's size and the date it was recorded.
(Do not use `check` for this: it applies the existing baseline, so on a repo
that already has one it reports nothing to confirm.)

Report that breakdown — the new/fixed split above all — and confirm before
writing. A baseline is a decision to defer real work, and it should be made
deliberately rather than as a way to get to a clean report. If the dry run says
nothing would change, say so and stop.

On confirmation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" baseline --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Then tell the user to commit `.loupe-baseline.json` — the command's output ends
by saying so. If it warns instead that the file is gitignored, lead with that:
CI and every other clone will run without the baseline and report the whole
backlog, so the file has to be un-ignored or force-added. Note that entries
key on rule + file + normalized code rather than line number, so reformatting
will not resurrect the whole file. Say plainly that every later audit now reports
new drift only, printing `N baselined finding(s) hidden` under it — the backlog
is still there, and `--no-baseline` is what shows it.

Suggest burning the backlog down one rule at a time with `/loupe-fix <rule-id>`,
which works that rule's baselined findings deliberately — naming a rule makes
its check run with `--no-baseline` — while a bare `/loupe-fix` keeps respecting
the baseline and fixes new drift only. Delete the baseline once it is empty.
`check --no-baseline --rule <rule-id>` shows how much of one rule the baseline
is holding; `fix` reads no baseline at all.
