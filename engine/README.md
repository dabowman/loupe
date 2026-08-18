# ds-hygiene

Design-system conformance checking for front-end codebases.

Linters see one file at a time. This correlates the two sides no single linter
can hold at once: the markup that binds a class to a component, and the CSS that
styles that class. That correlation is what lets it say *"this `font-size` is on
a `<Text>` — use its `size` prop"* rather than *"this `font-size` isn't a
token."*

Pure analysis. It never edits.

```bash
npx ds-hygiene check --all
```

## Why

An agent writing front-end code will produce CSS that lints clean and still
ignores your design system: hand-rolled flexbox next to your `<HStack>`, a
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
    "components": { "layout": ["HStack", "VStack"], "text": ["Text", "Heading"] },
    "elementMap": {
      "p": "Text",
      "div": { "component": "HStack/VStack", "styledOnly": true }
    }
  }
}
```

`normalizeExports` exists because design systems ship components under prefixed
names. `@wordpress/components` publishes `__experimentalText`; without
normalization the text rules never match and quietly degrade into generic
override findings.

### Bundled presets

- `wordpress-components` — the Gutenberg/admin surface
- `wordpress-block-theme` — `--wp--preset--*` tokens, `templates/`+`parts/` HTML
  as reference sources, no component layer
- `generic` — namespaces and token prefixes only

## Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
ds-hygiene baseline          # writes .ds-hygiene-baseline.json
ds-hygiene check --changed   # only what's new
```

Entries key on rule + file + normalized code, not line number, so reformatting
doesn't resurrect the whole file.

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

## Programmatic use

```js
import { analyze } from 'ds-hygiene';
import { loadConfig } from 'ds-hygiene/config';

const config = await loadConfig({ root: process.cwd() });
const { findings, blocking, directives } = analyze(config, { scope: null });
```

`scope` filters what is *reported*. The index is always built repo-wide —
building it from changed files alone would make every unchanged reference look
absent and every class look dead.

## Tests

```bash
npm test
```

Fixture-driven, one directory per behaviour, each with a note explaining what it
pins down. Once behaviour is config-driven this is the only thing standing
between a preset edit and a rule silently switching itself off.
