---
description: Configure loupe for this project — settle the design system, namespaces and external prefixes with the user, write loupe.config.json, then offer to turn the hooks on
argument-hint: "[preset]"
---

Write this project's `loupe.config.json`, confirming with the user what detection
could not settle on its own, then offer to turn the hooks on.

The config is what decides which rules run, and it is sticky: once the file
exists the engine never re-infers, so a wrong guess written here stays wrong.
Detection is good at *surfacing* evidence and bad at *ranking* it — that is your
part.

## 1. Detect

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" detect --format json
```

Read four things off it:

- `preset` and `presetConfidence` — the design system, and how sure detection is
- `presetEvidence` — what it saw but could not rank (filled only when the preset
  is a guess)
- `namespaces.project`, `coverage` and `namespaceConfidence`, plus
  `namespaceNotes` — the class prefixes the project owns, and anything that made
  that answer weaker than it looks
- `possibleExternal` — prefixes that look like somebody else's CSS

If a `loupe.config.json` already exists, say so and ask before going further:
replacing it needs `--force`, and a hand-written config may carry decisions this
flow would drop.

## 2. Settle the design system

If `$ARGUMENTS` names a preset, that is the answer — skip to step 3.

At `high` confidence, name the preset and the evidence (`presetReasons`) and move
on.

At `low` or `none`, **stop. Do not accept `generic`** because detection fell back
to it — `generic` turns most rules off, and is right only for a project with no
design system at all. Resolve it from evidence instead:

- `presetEvidence` first. A `@wordpress/scripts` build rewrites `@wordpress/*`
  imports to `wp.*` globals, so nothing lands in `dependencies` and no preset
  matches — while source imports, `@types/wordpress__*`, `build/*.asset.php`
  dependencies (`wp-components`, …), `.wp-env.json` and `composer.json` all say
  what the project is built on.
- Look further where that is thin: the imports in the main entry points, the
  `package.json` of each workspace, how styles are enqueued.
- `loupe presets` lists the choices, and
  `loupe status --preset <name> --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"` shows
  what each one means — `system:`, `packages:`, and which rules it turns on.

Propose one preset with the evidence for it, and let the user confirm.

## 3. Confirm namespaces and external prefixes

Show `namespaces.project` with its coverage and confidence. A low confidence, or
a `namespaceNotes` line, means the list is drawn from part of the CSS — say which
part. Ask the user to confirm or correct it: only these prefixes can be reported
as dead CSS, so a wrong one either hides dead code or reports live code as dead.

Then go through `possibleExternal`, one reason at a time:

- **CSS-module output, hashed class names** — compiled class names from a bundle.
  Nearly always third-party; find where it is loaded to be sure.
- **defined in node_modules** — an installed dependency ships this prefix.
- **no markup or reference names it** — either vendored CSS, or the project's own
  dead code. Read the stylesheet and how it is enqueued. Vendored goes in
  `external`; dead stays out, because reporting it is `css/dead-class`'s job.

Confirm the list with the user. A class under an external prefix is somebody
else's markup: tokenizing or deleting its CSS cannot pay off, and
`system/override` reports styling it as an override instead.

## 4. Write

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" init --preset <name>
```

`--preset` keeps the inferred namespaces. Only if the user agreed the project has
no design system, use `init --force` instead, which writes `generic`. Add
`--force` as well when replacing an existing config the user agreed to replace.

`init` writes no `external` list and only the namespaces it inferred, so edit
`loupe.config.json` for what step 3 changed:

```json
{
  "extends": "<name>",
  "namespaces": {
    "project": ["acme-"],
    "external": ["ChatFooter-module_"]
  }
}
```

## 5. Show the effect

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" status --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Report which rules the choice turned on and which stayed off, with the reason
each off rule gives (`needs componentRegistry`, …) — the decision's effect should
be visible at the moment it is made, not discovered later. Name the design system
and the active profile from the same output. Leave its `hook:` line to step 6.

Then size what the config now reports:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all --format json --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Give the total and the dominant rules. If the count is large — more than the user
would work through in a sitting — offer `/loupe-baseline` to accept it as a
backlog so only new drift is reported. Otherwise offer `/loupe-audit`.

## 6. Turn the hooks on

The hooks say nothing in a project until it opts in with
`"env": { "LOUPE": "on" }` in its Claude Code settings, and writing the config
does not do that. Ask once where to put it.

From the directory this session started in, which is where Claude Code reads the
project's settings:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || echo "not a git repository"
git check-ignore .claude/settings.json .claude/settings.local.json 2>/dev/null
echo "LOUPE=${LOUPE-(unset)}"
```

and read `.claude/settings.json` and `.claude/settings.local.json` where they
exist. The hook takes `LOUPE` from the environment first, then
`.claude/settings.local.json`, then `.claude/settings.json`; `1`, `true`, `yes`
and `on` are on. If a project file already turns it on and nothing that
outranks it says otherwise, say which, and skip to the `status` run below.

Otherwise ask — with the AskUserQuestion tool if you have it, else in one plain
question — offering three answers:

- **`.claude/settings.json`** — committed, so everyone who works on the project
  gets the hooks. The default in a git repository that does not ignore the file.
- **`.claude/settings.local.json`** — this machine only. The default anywhere
  else.
- **Neither** — the hooks stay off, and the snippet above in either file turns
  them on later.

Put the default first and mark it as the recommendation. Say in the question
what would override the answer: a `LOUPE` in `.claude/settings.local.json` that
is not on outranks the committed file on this machine, and one in the
environment outranks both for the rest of this session. If step 5 found a large
backlog, add that until `/loupe-baseline` records it, `Stop` reports what each
UI file a turn changes already had.

Write the chosen file by merging: every key it has stays, `env` gains
`"LOUPE": "on"`, and a missing `.claude/` or file is created. A file that is not
valid JSON stops this before anything is written; say so, and leave the fix to
the user.

```bash
node -e '
const fs = require("fs"), path = require("path"), f = process.argv[1];
const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "{}";
const settings = JSON.parse(text);
settings.env = { ...settings.env, LOUPE: "on" };
fs.mkdirSync(path.dirname(f), { recursive: true });
const indent = (text.match(/^[ \t]+/m) || ["  "])[0];
fs.writeFileSync(f, JSON.stringify(settings, null, indent) + "\n");
' .claude/settings.json   # or .claude/settings.local.json
```

In a git repository, when the answer is `.claude/settings.local.json` and
`git check-ignore` did not list it, add it to `.gitignore` as well: a
this-machine-only file that gets committed opts in everyone.

Say what was written: which file, whether it was created, and that `env.LOUPE`
was the only key touched. Then, whatever the answer:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" status --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

`status` prints a `hook: OFF` line, with the reason, whenever the hook will say
nothing; no `hook:` line means it is on. Tell the user which. The hook reads the
setting on every run, so the next edit is checked; the pane opens itself from
the next session, and `/loupe-pane` opens it now.

Tell the user to commit `loupe.config.json`, and `.claude/settings.json` or
`.gitignore` if this step changed them. Do not start fixing.
