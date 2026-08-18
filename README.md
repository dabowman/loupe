# wpds-quality

Keeps agent-written wp-admin interfaces on the WordPress Design System.

An agent writing UI produces code that compiles, renders correctly, passes
review, and quietly reimplements things WPDS already provides: a hand-rolled
flex row beside `HStack`, a `font-size` beside `Text`'s `size` prop, a
`margin-bottom` where the parent has a `gap`. None of it is an error. All of it
is drift, and it is expensive to unwind once the pattern is load-bearing —
because by then every argument for keeping it is locally true.

This plugin works at two moments: **before** the code is written (skills that
set the rules and the sanctioned compositions) and **as** it is written (hooks
that report drift on the file just touched, not forty tool calls later).

## What's in it

| | |
| --- | --- |
| `skills/wpds-authoring` | The authoring rules — order of resort, gap over margin, props over CSS, tokens by role. Load before writing UI. |
| `skills/wpds-patterns` | Registry of sanctioned composites. Load before assembling a header, modal, action bar, sidebar. |
| `skills/wpds-remediation` | Per-rule remedies, and the checks that stop a "fix" from silently changing rendering. |
| `commands/` | `/wpds-audit`, `/wpds-fix`, `/wpds-baseline` |
| `hooks/hooks.json` | `PostToolUse` on the file just written, `Stop` across changed files |
| `patterns/index.json` | The composite registry |
| `engine/` | `ds-hygiene` — the conformance engine |

## The engine

Linters see one file at a time. This correlates the two sides no single linter
holds at once: the JSX that binds a class to a component, and the CSS that
styles that class. That correlation is what lets it say *"this `font-size` is on
a `<Text>` — use its `size` prop"* rather than *"this `font-size` isn't a
token."*

```bash
node engine/bin/ds-hygiene.mjs check --all --preset wpds
node engine/bin/ds-hygiene.mjs explain layout/margin-on-child
```

Pure analysis — it never edits. Fixing is `wpds-remediation`'s job, because the
fixes need judgment that a codemod does not have.

### Rules

| Rule | Detects | wpds preset |
| --- | --- | --- |
| `stylesheet/unparsed` | A stylesheet nothing could read — a hole in coverage | error |
| `suppression/malformed` | A blanket disable, or one missing a rule id or reason | error |
| `layout/margin-on-child` | Spacing margin, which belongs on the parent's `gap` | error |
| `layout/in-css` | Flexbox in CSS that a layout primitive should own | error |
| `typography/in-css` | A text component typed in CSS instead of via props | error |
| `system/override` | CSS restyling a WPDS component, or reaching into a library's internals | error |
| `layout/negative-margin` | A bleed — confirm it is deliberate | warn |
| `typography/untokenized` | Raw type styling with no token and no text component | warn |
| `system/raw-element` | A raw element that has a WPDS analog | warn |
| `tokens/hardcoded-value` | A literal colour or length where a token exists | warn |
| `css/dead-class` | A namespaced class referenced in no markup or reference file | warn |

Rules disable themselves when the config cannot support them — a block theme
with no component layer leaves the component rules inert rather than firing on
nothing.

### Config

`ds-hygiene.config.json` at the repo root, discovered by walking up:

```jsonc
{
  "extends": "wpds",
  "namespaces": {
    "project": ["acme-"],        // classes you own; only these can be "dead"
    "external": ["components-"], // third-party internals; styling them is an override
    "neverDead": ["has-*"]       // generated at runtime, never in source
  }
}
```

Presets: `wpds` (WPDS tokens + a severity policy that actually blocks),
`wordpress-components` (the older admin surface), `wordpress-block-theme`,
`generic`. Without a config, pass `--preset wpds`.

### Sass, Less

Parsed through `postcss-scss` / `postcss-less`, declared as optional deps. When
one is missing the file reports as `stylesheet/unparsed` rather than being
skipped in silence — a clean run should mean *checked and clean*, never
*couldn't read it*.

```bash
cd engine && npm install     # installs the optional syntaxes
```

### Suppression

```css
/* wpds-allow system/override -- Stack exposes no padding prop at this size */
.acme-panel { padding: var(--wpds-dimension-padding-lg); }
```

Rule id and reason are both mandatory; anything looser is its own finding. That
inversion keeps the escape hatch available and legible. Audit with
`ds-hygiene suppressions`.

### Baseline

The first run on an existing codebase is the adoption blocker. Record the
backlog and ratchet from there:

```bash
node engine/bin/ds-hygiene.mjs baseline    # writes .ds-hygiene-baseline.json
```

Entries key on rule + file + normalized code, not line number, so reformatting
does not resurrect the whole file.

## Hooks

The plugin ships both. `PostToolUse` scopes to the file just written, which is
what makes this a write-time gate rather than a review-time one. `Stop` covers
everything changed in the turn.

Each gets `hook.maxAttempts` gated passes (default 3, budgeted per file for
`PostToolUse`), then the gate stands down and says so. Bailing out entirely on
`stop_hook_active` — the obvious loop guard — means the turn that *fixes* a
finding is never checked, so you never confirm the fix.

The index is always built repo-wide even when the report is scoped; building it
from changed files alone would make every unchanged reference look absent and
every class look dead. On a large repo that makes `PostToolUse` the more
expensive of the two — drop it to `Stop` only if it drags.

## Status

Working: the engine, all three skills, commands, hooks, the registry.

Not yet built, in rough priority order:

1. **JSX and inline styles are not checked for violations.** JS is parsed only
   to build the binding index, so `style={{ marginBottom: 16 }}` passes through
   invisibly. This matters more than its size suggests: tightening the CSS gate
   pushes agents toward the unchecked channel.
2. **Composite rules.** `patterns/index.json` carries signatures, but
   `patterns/duplicate-composite` and `patterns/unregistered-composite` are not
   implemented. Until they are, `wpds-patterns` is the enforcement.
3. **Token and prop maps.** Findings name a namespace, not a token, so an agent
   told "13px is hardcoded" will invent `--wpds-font-size-13`. Generating a map
   from the WPDS MCP would let findings name the exact replacement.
4. `tokenPrefixes` is currently cosmetic — it shapes the message but nothing
   validates a `var()` against the known token set.

## Tests

```bash
cd engine && npm test
```

Fixture-driven, one directory per behaviour, each with a note explaining what it
pins down. Since behaviour is config-driven, this is the only thing standing
between a preset edit and a rule silently switching itself off.
