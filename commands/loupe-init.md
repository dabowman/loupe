---
description: Configure loupe for this project — settle the design system, namespaces and external prefixes with the user, then write loupe.config.json
argument-hint: "[preset]"
---

Write this project's `loupe.config.json`, confirming with the user what detection
could not settle on its own.

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
and the active profile from the same output.

Then size what the config now reports:

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/bin/loupe.mjs" check --all --format json --profiles "${CLAUDE_PLUGIN_ROOT}/profiles"
```

Give the total and the dominant rules. If the count is large — more than the user
would work through in a sitting — offer `/loupe-baseline` to accept it as a
backlog so only new drift is reported. Otherwise offer `/loupe-audit`.

Tell the user to commit `loupe.config.json`. Do not start fixing.
