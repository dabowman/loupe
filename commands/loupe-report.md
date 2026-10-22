---
description: Render the design-system conformance report as a visual page — beside the chat with --local, or published as an Artifact
argument-hint: "[--changed] [--local] [path]"
---

Publish the conformance report as a page you can look at and share, instead of a
list you have to read.

`--local` stops at the file and hands back its path. In the Claude Code desktop
app a click on that path opens the page in the Browser pane beside the
conversation; in a fullscreen terminal, Cmd/Ctrl-click opens it in the default
browser. That is the quickest way to get the charts next to the transcript, and
it needs no claude.ai login. (The Loupe pane — `/loupe-pane`, or automatic in a
project that opted the hooks in — draws the same report live beside the chat;
this command is the whole page, for reading or sharing.)

This command renders; it does not decide. The engine already produced the page —
the charts, the directory rollup, the composite clusters, the grouped findings
table are all in it. Do not rewrite, restyle, summarize into, or re-author the
HTML. Anything you would change about how it looks is a change to
`engine/src/report-view.ts` — the one renderer this page and `loupe ui` both
draw from — so that every run gets it and two people running this never see two
different reports.

## 1. Render

The page goes to a stable path under the project, `.loupe/report.html`, so a
re-run replaces the last report rather than scattering files, and so the path
is one the desktop app and the terminal can open from the chat. (`.loupe/` is
the directory the WordPress overlay integration already uses; it is for
development files and belongs in the project's `.gitignore`. If it is not
ignored, say so in one line — do not edit `.gitignore` unasked.)

```bash
mkdir -p .loupe
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all \
  --profiles "${CLAUDE_PLUGIN_ROOT}/profiles" \
  --format html > .loupe/report.html
```

Adjust for `$ARGUMENTS`: `--changed` scopes the report to files changed vs. HEAD
(the whole repo is still indexed — scoping the index would make every unchanged
reference look absent), and a path becomes `--files <path>`.

**Exit 1 is the report working**, not a failure: it means blocking findings
exist. Only exit 2 means the engine could not run, and then there is nothing to
publish — say what it printed instead.

The output went to a file, so you are holding an exit code and nothing else. Do
not re-run the check to find out what is in it: the page embeds the exact
`--format json` payload — totals, per-rule list, every finding with file and
line — in its `<script type="application/json" id="loupe-data">` block, which is
where every number steps 3 and 4 ask for comes from.

If `$ARGUMENTS` contains `--local`, stop here. Give the user the **absolute**
path to `.loupe/report.html` on a line of its own, and the shape of the problem
in two or three lines (step 4 says how, from the embedded payload). In the
desktop app the path is clickable and opens beside the chat; in a terminal it
is a Cmd/Ctrl-click. Everything below is the publishing half.

## 2. Cut out the fragment

An Artifact supplies its own `<!doctype>`, `<head>` and `<body>`, so what gets
published is the span between the markers the engine emits — which carries its
own `<style>` and `<script>` for exactly this reason:

```bash
sed -n '/<!-- loupe:begin -->/,/<!-- loupe:end -->/p' .loupe/report.html > /tmp/loupe-report-fragment.html
```

Check the result is non-empty before publishing. If it is empty the markers moved
and the engine and this command have drifted apart — say so rather than
publishing a blank page.

## 3. Publish

Use the same file path every time so a re-run redeploys to the same URL rather
than scattering a new link per run:

- `file_path`: `/tmp/loupe-report-fragment.html`
- `title`: `Loupe Report` — the fragment carries no `<title>`, so this names it
- `favicon`: 🔍 — keep it, across every redeploy
- `description`: one sentence with the real numbers, e.g. "46 findings across 12
  files — 14 blocking, dominated by system/superseded-component."

**Updating a report published in an earlier session:** find it with the Artifact
tool's `list` action and pass its `url`, or the publish creates a second report
and the link the user already has goes stale.

## 4. Hand it back

Give the user the link and the shape of the problem in two or three lines —
which rules dominate, whether the findings cluster or spread, and whether
anything is blocking. Lead with `stylesheet/unparsed` if it appears at all:
those files were not checked, so every number in the report is a floor rather
than a total.

Do not paste the findings. They are in the page, which is the point.

Offer `/loupe-fix` as the next step. Do not start fixing.
