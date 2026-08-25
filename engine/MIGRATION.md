# Migrating from `css-hygiene.mjs` + `vip-workflow-quality-stop.sh`

## 1. Drop in a config

This reproduces the old hardcoded behaviour. Note `suppression.keyword` — keep
it as `wpds-allow` and every existing suppression comment in the repo keeps
working unchanged, including the `R2,R3` style ids.

```jsonc
// loupe.config.json — repo root
{
  "extends": "wordpress-components",

  "designSystem": {
    "tokenPrefixes": ["--wpds-"],
    "components": {
      "layout": ["Stack", "HStack", "VStack", "Flex", "FlexBlock", "FlexItem", "Grid", "Spacer"],
      "text": ["Text", "Heading", "Truncate"]
    }
  },

  "namespaces": {
    "project": ["vip-workflow-", "wf-"],
    "external": [
      "components-", "react-flow", "rbc-", "wp-", "dashicon", "block-editor-",
      "editor-", "interface-", "edit-post-", "edit-site-", "dataviews-"
    ],
    "neverDead": ["has-*", "is-*", "wp-*", "alignwide", "alignfull", "screen-reader-text"]
  },

  "sources": {
    "styles": ["**/*.css", "**/*.scss"],
    "markup": ["**/src/**/*.{js,jsx,ts,tsx}"],
    "references": [
      "**/*.php", "**/*.html", "**/block.json", "**/theme.json",
      "**/patterns/**/*.php", "templates/**/*.html", "parts/**/*.html"
    ],
    "ignore": ["**/node_modules/**", "**/build/**", "**/vendor/**", "**/dist/**", "**/_tmp/**"]
  },

  "suppression": { "keyword": "wpds-allow", "blanket": ["wpds-allow-file", "wpds-disable"] },

  "rules": {
    "suppression/malformed": "error",
    "css/dead-class": "error"
  },

  "hook": { "maxAttempts": 3, "maxFindings": 12 }
}
```

Two deliberate differences from the old defaults:

- **`references` now includes HTML, `block.json`, and `theme.json`.** The old
  index only read `.php` and JS, so a class used solely in block-theme markup
  read as dead — and `css/dead-class` blocks, with "delete the rule" as its
  remedy.
- **`neverDead`.** WordPress generates `has-text-color`, `is-layout-flex`,
  `wp-elements-<hash>` and friends at render time. They appear in no source file
  and the old checker would call CSS targeting them dead.

If you'd rather not have a delete-CSS instruction blocking turns while you
validate the new reference coverage, set `"css/dead-class": "warn"` for a week
and read what it reports.

## 2. Replace the bash hook

Delete `vip-workflow-quality-stop.sh`. In `.claude/settings.local.json`:

```jsonc
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node /abs/path/to/engine/bin/loupe.mjs hook" }] }
    ]
  }
}
```

If you want the whole existing gate (phpcs, lint-js, unit tests) to keep running
alongside, leave your `quality.mjs` wired as a second `Stop` hook and have it
call loupe as a library rather than reimplementing the exit mapping:

```js
import { analyze } from 'loupe';
import { loadConfig } from 'loupe/config';

const config = await loadConfig({ root });
const { findings, blocking } = analyze(config, { scope: changedFiles });
```

The `2 → couldn't run`, `1 → blocking`, `0 → clean` mapping your shell script
encodes is now the CLI's own contract, so it survives without a wrapper.

## 3. Baseline the backlog

```bash
./bin/loupe baseline          # or pass --profiles <dir> yourself
git add .loupe-baseline.json
```

The advisory backlog stops flooding every run, and anything new surfaces
immediately. Drop the file when you've burned the backlog down.

### Existing suppressions may need re-targeting

Precedence changes mean a declaration can now report under a different rule than
it did before, and a suppression naming the old rule won't match. The common
case: a `wpds-allow R2` on a hardcoded colour whose class is bound to a system
component — that line now reports as `system/override`, because styling it in
CSS at all is the finding.

Audit and re-point in one pass:

```bash
node engine/bin/loupe.mjs suppressions --format json > /tmp/before.json     # canonicalized ids
node engine/bin/loupe.mjs check --all --format json | \
  jq -r '.findings[] | "\(.file):\(.line)\t\(.rule)"'       # what fires now
```

Anything in `before.json` with no finding near it is a suppression that has
stopped matching — either the finding is genuinely gone, or it moved rules.

## What changed in the findings

Expect counts to move. In rough order of impact:

- **`typography/in-css` starts firing.** The old import scanner matched export
  names literally, so `__experimentalText as Text` never registered as a text
  component and every one of these came out as a generic `system/override` with
  the wrong remedy attached.
- **Components with a nested brace in an attribute are now visible.** The old
  tag regex allowed one level of braces, so any element with `style={{…}}` or a
  block-bodied handler was skipped entirely. Their bindings were missing, which
  pushed their CSS into `typography/untokenized` and made `layout/in-css` fire on
  layout that was already on a primitive.
- **Nested CSS is attributed correctly.** postcss's `walkDecls` is recursive, so
  a parent rule was seeing its descendants' declarations: duplicate findings at
  the same line under different ids, a child's `font-size` blamed on the
  parent's component, and a nested `display: grid` marking the whole parent as a
  grid. Selectors now resolve through `&`, and bindings correlate against the
  key selector only.
- **One finding per declaration.** A typed system component used to produce both
  `R8` and `R6` for the same line. Most-specific-wins now, and a rule targeting
  a library internal reports only that, since "stop styling this" supersedes any
  advice about how to style it.
- **`suppression/malformed` no longer fires on prose.** A directive must be the
  first thing in its comment. The old `ANY_ALLOW` matched the keyword anywhere,
  which meant a doc comment describing the grammar was itself a blocking
  violation — `css-hygiene.mjs`'s own header would have blocked the gate had it
  lived under a scanned `src/`.
- **`padding: 0` is no longer a hardcoded-value finding.** Zero has no token to
  reach for; it was previously reported at low rank rather than exempted.
- **Single-word classes bind.** The old class tokenizer required a hyphen, so
  `<Text className="title">` was unbindable.

## Known limitations, carried forward deliberately

- The reference index for `css/dead-class` over-collects: every identifier-like
  token in every scanned file counts as a reference. A false "referenced" costs
  one missed finding; a false "dead" tells an agent to delete live CSS.
- `css/dead-class` is only meaningful repo-wide. On a `--changed` run, a JS edit
  that removes the last reference to a class won't report it, because the CSS
  file isn't in scope. Run `check --all` in CI to catch those.
- CSS Grid is always a keep. Flex primitives can't express it, so `layout/in-css`
  stays quiet on grid rules rather than proposing a conversion that can't work.
