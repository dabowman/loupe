# ds-hygiene

Design-system conformance checking for front-end codebases.

Linters see one file at a time. This correlates the two sides no single linter
can hold at once: the markup that binds a class to a component, and the CSS that
styles that class. That correlation is what lets it say *"this `font-size` is on
a `<Text>` — use its `variant` prop"* rather than *"this `font-size` isn't a
token."*

Pure analysis. It never edits.

```bash
npx ds-hygiene check --all
```

## Why

An agent writing front-end code will produce CSS that lints clean and still
ignores your design system: hand-rolled flexbox next to your `<Stack>`, a
hardcoded hex next to your token, a `<p>` where the system has a `<Text>`, an
override reaching into a third-party component's internals. None of that is a
syntax error. All of it is drift.

Six of the nine rules need cross-file correlation to decide. The other three
would work as a stylelint plugin, and are included because you want one report.

## Rules

| Rule | Detects |
| --- | --- |
| `suppression/malformed` | A blanket disable, or a directive missing a rule id or reason |
| `css/dead-class` | A project-namespaced class referenced in no markup or reference file |
| `tokens/unknown-token` | A `var()` naming no token any known source defines |
| `patterns/duplicate-composite` | A registered composite reassembled by hand in 2+ files |
| `patterns/unregistered-composite` | The same composite in 3+ files, registered in none |
| `tokens/hardcoded-value` | A literal colour/length where a design token exists |
| `layout/margin-on-child` | Margin, which belongs on the parent's `gap` |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own |
| `typography/untokenized` | Raw type styling with no token and no text component |
| `system/override` | CSS restyling a design-system component, or reaching into a library's internals |
| `system/raw-element` | A raw element that has a design-system analog |
| `typography/in-css` | A text component typed in CSS instead of via its props |

`ds-hygiene explain <rule>` prints the guidance and whether the rule is active
under your config.

Legacy `R0`–`R8` ids are accepted everywhere a rule id is, in config and in
suppression comments, so an existing codebase's suppressions keep working.

### Rules disable themselves

Each rule declares what it needs from the design-system model. A config with no
component layer — a block theme, say — leaves `system/override`,
`system/raw-element`, `typography/in-css` and `layout/in-css` inert rather than
firing on nothing. That is what makes one engine serve very different projects.

## Suppression

```css
/* ds-allow system/override -- Stack exposes no padding prop */
.card { padding: 12px; }
```

Rule id and reason are both mandatory. A directive on the line above, on the
line itself, or on a rule's selector line (which covers that rule's own
declarations) all count.

Anything looser — `ds-disable`, a missing reason, a bare keyword — is not a mute
but its own finding. That inversion is the point: the escape hatch stays
available and stays legible.

The directive must be the first thing in its comment, so documentation *about*
the grammar isn't mistaken for an instance of it.

## Config

`ds-hygiene.config.json` (or `.mjs`, or a `dsHygiene` key in `package.json`),
discovered by walking up from the working directory.

With no config file anywhere, the project is inspected and one is inferred —
preset from project markers (`@wordpress/components` or `@wordpress/ui` in
`package.json` → `wpds`; `theme.json` + `templates/` → `wordpress-block-theme`),
namespaces from the class prefixes that appear in **both** the CSS and the
markup. A prefix present only in CSS is exactly what a dead class looks like, so
CSS evidence alone is never enough to adopt one.

```bash
ds-hygiene detect            # what would be inferred, and why
ds-hygiene init              # write it to ds-hygiene.config.json
ds-hygiene status            # the effective config: rules, severities, what blocks
```

An inferred config is held to a lower bar than one somebody wrote down:
`css/dead-class` is forced to advisory (its remedy is "delete this CSS", and a
guess must not drive that), and in hook mode nothing blocks unless blocking is
turned on explicitly. `check` is unaffected — it still exits 1 on
error-severity findings, so CI behaviour does not depend on this.

```jsonc
{
  "extends": "wordpress-components",

  "namespaces": {
    "project": ["acme-"],           // classes you own; only these can be "dead"
    "external": ["components-"],    // third-party internals; styling them is an override
    "neverDead": ["has-*"]          // generated at runtime, never in source
  },

  "rules": {
    "css/dead-class": "error",
    "layout/margin-on-child": "off",
    "tokens/hardcoded-value": ["warn", { "allowZero": true }]
  }
}
```

Full surface, with defaults, in `presets/generic.json`. The design-system block
is what makes a preset:

```jsonc
{
  "designSystem": {
    "packages": ["@wordpress/components"],
    "tokenPrefixes": ["--wp-admin-theme-"],
    "normalizeExports": "^__(experimental|unstable)",
    "components": { "layout": ["Stack"], "text": ["Text"] },
    "elementMap": {
      "p": "Text",
      "div": { "component": "Stack", "styledOnly": true }
    }
  }
}
```

`normalizeExports` exists because design systems ship components under prefixed
names. `@wordpress/components` publishes `__experimentalText`; without
normalization the text rules never match and quietly degrade into generic
override findings.

### Bundled presets

- `wpds` — extends `wordpress-components` with `--wpds-*` tokens, the
  `wpds-allow` suppression keyword, and a severity policy that blocks
- `wordpress-components` — the Gutenberg/admin surface
- `wordpress-block-theme` — `--wp--preset--*` tokens, `templates/`+`parts/` HTML
  as reference sources, no component layer
- `generic` — namespaces and token prefixes only

## Fixing

```bash
ds-hygiene fix              # apply; --dry-run to preview
```

Applies only `tokens/hardcoded-value` findings the engine already resolved to
exactly **one** on-role token, and only in stylesheets. Two candidate tokens is
a semantic choice — the right pixels with the wrong meaning is the failure the
suggestion machinery exists to prevent — and the JS channels (`style={{ … }}`,
CSS-in-JS) are left alone because a CSS-shaped substitution there writes a
syntax error with a clean report.

A declaration that is not on its reported line exactly once is skipped and
named: the file moved under the report, and substituting against a stale line
number edits the wrong declaration. `!important` and the terminator survive.

The baseline is ignored here. It exists to stop the gate blocking on an accepted
backlog; burning that backlog down is what this command is for.

## Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
ds-hygiene baseline          # record the current findings
ds-hygiene check --changed   # only what's new
```

Entries key on rule + file + normalized code, not line number, so reformatting
doesn't resurrect the whole file.

Under a plugin the baseline goes to `${CLAUDE_PLUGIN_DATA}/projects/<project>/`,
so carrying the tool between repos writes nothing into them. Outside one it
falls back to the project. An existing project-local baseline always wins — a
committed baseline is a deliberate choice — and `--baseline <path>` always
writes where you name it. `ds-hygiene status` prints the location in use.

## Claude Code hook

```jsonc
// .claude/settings.local.json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "npx ds-hygiene hook" }] }
    ]
  }
}
```

Hook mode reads the payload on stdin, scopes to changed files, and emits the
hook protocol directly — no `jq`, no wrapper script.

On blocking findings it exits 2 and hands a budgeted report back to the agent:
guidance printed once per rule, a sample of each rule rather than a flood of
the first one. On a clean run it exits 0 with a one-line tally.

Installed as a Claude Code plugin, the hook reads its settings from
`CLAUDE_PLUGIN_OPTION_*` — whether it may block, which preset to force, the
class prefixes the project owns, and the attempt and finding caps. (Claude Code
won't substitute `${user_config.*}` into a shell-form hook command, since the
value would reach a shell, but it does export the options to the hook process.)

Each session gets `hook.maxAttempts` gated passes (default 3), then the gate
stands down and says so. Bailing out entirely on `stop_hook_active` — the
obvious loop guard — means the turn that *fixes* a finding is never checked, so
you never confirm the fix.

## Output

```bash
ds-hygiene check --all --format json     # stable, versioned schema
ds-hygiene check --all --format sarif    # GitHub code scanning
ds-hygiene check --changed --max-findings 20
ds-hygiene suppressions                  # audit every active directive
```

Exit codes are a contract: `0` clean or advisory-only, `1` blocking findings,
`2` could not run.

JSON findings carry `suggest` when the engine matched a value against the token
set: `[{ prop, value, tokens }]`, most specific first. The prose message says the
same thing for a reader; `suggest` is there so a consumer does not have to parse
it back out of a sentence. `ds-hygiene fix` is that consumer for the
single-token case.

## Programmatic use

```js
import { analyze } from 'ds-hygiene';
import { loadConfig } from 'ds-hygiene/config';

const config = await loadConfig({ root: process.cwd() });
const { findings, blocking, directives } = analyze(config, { scope: null });
```

### Config keys added for these rules

| key | |
| --- | --- |
| `designSystem.tokenSources` | Paths (file or directory) holding the token definitions. Read even under `node_modules`, which the project walk prunes — that is where a design system's tokens live. Missing paths are skipped. |
| `designSystem.cssInJsPackages` | Packages whose tagged templates are CSS. Defaults cover styled-components and emotion. |
| `patterns` | A composite registry: an inline array, or a path. `--patterns` merges a second registry over it, the config's own winning on `id`. |

`scope` filters what is *reported*. The index is always built repo-wide —
building it from changed files alone would make every unchanged reference look
absent and every class look dead.

Two guards bound the cost: a hook payload naming a file no source glob matches
returns before indexing, and any file over 1.5MB is skipped as generated (a
stylesheet skipped this way still reports `stylesheet/unparsed`, so the hole is
never silent).

## Tests

```bash
npm test
```

Five suites: `tests/run.mjs` (fixtures, one directory per behaviour),
`tests/detect.mjs` (inference), `tests/regressions.mjs` (failures that reported
success), `tests/features.mjs` (the three channels and the two cross-file rules),
`tests/autofix.mjs` (the fix path, where a wrong substitution is invisible).
Once behaviour is config-driven, these are the only thing standing between a
preset edit and a rule silently switching itself off.
