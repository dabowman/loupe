---
description: Fix design-system conformance findings, working upward through the rule layers
argument-hint: "[rule-id] [path]"
---

Fix design-system conformance findings.

**Load the `loupe-remediation` skill first** — it carries the per-rule remedy and
the checks that stop a fix from silently changing how the UI renders. It starts
by reading `loupe status` for which design system is in play, which is what the
remedies name components and tokens from.

## 1. Apply what needs no judgement

The engine resolved some findings to exactly one on-role token when it ran. Let
it apply those itself rather than reading files back to retype them:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" fix
```

Add `--dry-run` first if the repo has uncommitted work. This only substitutes
values the engine matched unambiguously; anything with two candidate tokens, or
in a JS channel, is left for the passes below.

If `TYPESAFE_API_KEY` is set (in the environment or loupe's `.env`), offer the
judged pass for the values no single token matches — hardcoded values and the
type properties of `typography/untokenized` alike: the near-misses, the
ambiguous ones, and the values that are either a mistake or a deliberate
choice. Review it first, and show the user the list:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" fix --judge --dry-run --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Each line is either a rewrite to a token or a `keep` that becomes a suppression.
Apply it only after the user agrees, with the same command minus `--dry-run`.
`--profiles` is what supplies the token descriptions the judgement is scored
with. Whatever stays under the confidence floor is left for the passes below.

## 2. Get the current state

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all --format json --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

If `$ARGUMENTS` names a rule id, pass it as `--rule <id>` — to this check and to
the `fix` in step 1 — and a path as `--files <path>`; both repeat. Don't filter
the JSON yourself. Add `--severity error`
to cut the run down to what the hook actually blocks on, which is the subset to
clear first when the backlog is too large for one pass. Otherwise work upward
through the layers, because lower fixes change what the higher findings say:
unparsed files, then malformed suppressions, then component overrides, then
layout, then values, then dead classes. Re-run between stages rather than
working from a stale list.

## 3. Fix — inline, or fan out

Count the files holding findings for the stage you are on.

**Fewer than five files:** fix them yourself. Dispatch overhead exceeds the
saving.

**Five or more:** dispatch one `loupe-fixer` agent per file, in batches of about
six so they run concurrently. Give each agent:

- the one file it owns,
- that file's findings verbatim from the JSON — rule id, line, and message, the
  message included because it carries the token the engine already resolved,
- the absolute path to
  `${CLAUDE_PLUGIN_ROOT}/skills/loupe-remediation/SKILL.md`, which it reads for
  the remedy,
- the absolute path to the active profile's `remediation.md` — the `profile:`
  line of `loupe status` names the directory it is in — which carries the
  design-system half of every remedy. Without it the agent has the shape of the
  fix and no component or token names to write,
- the suppression keyword from `loupe status`'s `suppress:` line. The agent has
  no shell and cannot look it up, and a directive in the wrong vocabulary
  suppresses nothing and reports as malformed.

One agent per file, never per rule: two agents editing one file collide.

**Never dispatch `css/dead-class` or `patterns/*`.** Both are cross-file
judgements — whether a class is built at runtime somewhere else, whether three
composites are really the same thing — and a single-file agent cannot see what
it would need to see. Handle those yourself.

## Rules for this pass

- **Never silence a finding by deleting styling that was doing something.**
  Moving a child's margin to the parent's gap is a fix; deleting the margin is a
  regression with a clean report.
- **Suppress only with a real reason** naming the constraint that makes the
  finding wrong here. "Legacy code" and "matches existing style" are not reasons.
- **Never suppress `stylesheet/unparsed`** — it hides a blind spot rather than
  muting a finding.
- If the backlog is large, propose `/loupe-baseline` instead of a giant diff.

## 4. Verify

Re-run the check once, repo-wide — not once per file; every run re-indexes the
whole repo regardless of scope. Report what changed. If any fix could have
altered rendering, say which ones and why, rather than folding it into a cleanup
summary. Agents report their own rendering risks; carry those through instead of
dropping them.
