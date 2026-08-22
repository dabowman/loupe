# Check classes and how they are deployed

Status: draft for iteration. Nothing here is implemented yet.

This spec settles three questions that are currently answered ad hoc:

1. What classes of check does Loupe run, and what distinguishes them?
2. How is each class delivered to the agent?
3. How does a user see, control, and extend them?

## 1. The proposal, and what it gets right

The starting proposal was three classes ordered by scope:

1. **Narrow** — single file. Wrong token, hardcoded value.
2. **Cross-file** — CSS overriding a component, CSS where a prop belongs.
   Needs file relationships and system knowledge.
3. **Subjective** — inconsistent patterns, wrong component choice. Needs
   judgement and broad awareness.

The instinct is right and the third class is genuinely missing today. But the
proposal bundles two properties that move independently, and the deployment
decision hangs on the one it doesn't name.

### Scope and decidability are different axes

**Scope** is how much has to be in view. **Decidability** is whether a
deterministic procedure can produce the verdict. The proposal treats them as
one axis. They agree at the ends and cross in the middle:

| Check | Scope | Decidable? |
| --- | --- | --- |
| `css/dead-class` | cross-file | yes — index lookup |
| `patterns/unregistered-composite` | whole repo | yes — signature count ≥ 3 |
| `system/inline-style` | one file | yes — file + registry |
| "is this `margin-bottom` a deliberate bleed?" | one file | **no** |

`patterns/unregistered-composite` reads the entire repo and is a pure script.
The bleed question reads eight lines and cannot be scripted at all. Scope
predicts *cost*. Decidability predicts *delivery mechanism* — and delivery is
what this spec is about.

### System knowledge is not a file relationship

The proposal puts "requires knowledge of the system" in class 2. But knowing
that `Button` is a locked WPDS private API is a **table lookup**, not a
relationship between two files. Loupe already models this correctly and
separately, as a rule's `needs` — the capability gate in `config.mjs` that
switches a rule off when the active config can't support it.

Keeping reference-data dependency out of the tier is what lets
`system/locked-component` — high stakes, needs the whole component registry —
still run on a single file in a few milliseconds at write time.

So: **three properties, not one.**

- **tier** — what evidence the verdict needs (below)
- **needs** — what reference data must be loaded (exists today, unchanged)
- **channel** — when and where it runs (below)

Severity stays a fourth, orthogonal, policy dial. It must not be derived from
tier: `system/locked-component` is the highest-stakes check in the catalog and
is tier 1; `tokens/hardcoded-value` is cosmetic and is also tier 1.

## 2. The classes

### L1 — Literal

Decidable from the file under inspection plus static reference data.

Deterministic, sub-millisecond per file, no index. Every L1 check is eligible
for every channel including write-time.

### L2 — Relational

Requires a relationship *between* files: a class declared in one and bound in
another, an import graph, a count across the corpus.

Still fully deterministic — the verdict is computed, never judged. The cost is
the index, which Loupe builds repo-wide on every run anyway (~4s on Gutenberg).
This tier is the engine's reason to exist; it is what no per-file linter can do.

### L3 — Judgmental

Not decidable. Requires a model to weigh context, precedent, and intent.

"Six modals that are almost but not quite the same shape — is that drift or
three legitimately different modals?" No procedure answers this. Something has
to read them and form a view.

L3 has no members today. That is the real gap the proposal identifies.

### The current catalog, tiered

**L1 (12):** `suppression/malformed`, `stylesheet/unparsed`,
`tokens/hardcoded-value`, `tokens/unknown-token`, `layout/margin-on-child`,
`layout/negative-margin`, `layout/in-css`, `typography/untokenized`,
`system/inline-style`, `system/raw-element`, `system/locked-component`,
`system/superseded-component`

**L2 (5):** `system/override`, `typography/in-css`, `css/dead-class`,
`patterns/duplicate-composite`, `patterns/unregistered-composite`

**L3 (0).**

One rule straddles: `system/override` fires both on a class the index binds to
a design-system component (L2) and, from a stylesheet alone, on a class in a
declared `external` namespace (L1). Tier it by its expensive path — L2 — and
note that the cheap path is what lets a partial index still catch something.

Two things fall out of writing that down.

First, `patterns/unregistered-composite` — the check that most *looks* like
subjective pattern review — is L2. It is already shipped, already
deterministic, and already answers "you built this shape three times." A large
part of what the proposal wanted from class 3 is available without inference,
and should be pushed into L2 wherever a signature can carry it. **Inference is
the last resort, not the natural home for anything hard.**

Second, `system/override` is L2 and underpowered for a data reason, not a tier
reason: it says "restyle via its props" without naming the prop, because no
prop map exists. That is a missing `needs`, not a missing class. Adding
`needs: ['propMap']` and generating the map from the design-system MCP upgrades
the finding without touching the tier model.

### Two groups for delivery, three for authoring

Honest accounting: **L1 and L2 deliver identically** — both compile to engine
code or declarative rules, both run in the same pass, both produce the same
finding shape. The line that changes delivery is L2/L3.

They differ in *authoring*: an L2 check needs index access, so its declarative
schema exposes different primitives. Three tiers for writing checks, two
delivery paths for running them. The spec keeps three because the tier is what
tells an author which primitives they get, and tells a reader whether a verdict
is reproducible.

## 3. Delivery

### The engine never calls a model

The single most important architectural constraint here.

`engine/` today is pure, dependency-light, synchronous computation. Putting an
inference call inside it would give every hook run a network dependency, a
variable latency, a token cost, and a nondeterministic result — and would make
the L3 tier untestable, because you cannot snapshot a verdict that changes.

Instead the engine **emits review packets** and a caller performs the
inference:

```
loupe review --emit --format json
```

The engine does the deterministic half — select candidates, gather evidence,
formulate the question — and stops. `/loupe-audit` or a `loupe-reviewer`
subagent does the judging. This keeps the L3 pipeline testable at the packet
boundary: the packet is snapshottable even though the verdict is not.

It also preserves the existing property that the engine adds nothing to a
project and needs no credentials.

### Channels

Four intervention points, three of which exist today.

| Channel | Trigger | Budget | Admits |
| --- | --- | --- | --- |
| `prevent` | before the write | free (context) | guidance only, no findings |
| `write` | `PostToolUse`, one file | ~ms | L1, L2 |
| `turn` | `Stop`, changed files | ~seconds | L1, L2 |
| `audit` | `/loupe-audit`, CI | ~minutes | L1, L2, L3 |

**L3 is structurally ineligible for `write` and `turn`.** Not by policy — by
the schema. A 5–30s inference call on every file write is not a gate, it is a
tax. L3 runs on audit and in CI, where batching is possible and latency is
already accepted.

The channel is declared per check and overridable in config, bounded by tier.

### L3 mechanics

An L3 check that runs open-ended over the repo will produce different findings
every run and be switched off within a week. Four constraints keep it honest:

1. **A deterministic candidate selector is mandatory.** An L3 check declares an
   L2 query that narrows the repo to a handful of sites. No selector, no check.
   The expensive, unstable half then operates on a small, stable input.
2. **A bounded evidence packet.** The candidates, the relevant registry
   excerpts, the authoring rule at issue. Never "the codebase."
3. **A fixed output schema with confidence.** Findings below the check's
   threshold are dropped, and the dropped count is reported — a check that
   found six maybes and surfaced none should say so.
4. **Severity capped at `warn`.** Structurally. A nondeterministic verdict must
   never block a turn.

Delivery reuses the fan-out `/loupe-fix` already has for `loupe-fixer`: one
`loupe-reviewer` subagent per candidate cluster, bounded by cluster count.

### Prevention is paired with detection, not separate from it

The proposal's "fed to the agent as context before they write code" is a real
channel, but it is **prevention, not checking**, and today it lives in
hand-written skill prose that restates what the rules check.

That prose has already drifted — the authoring skill's own examples went stale
(`HStack`/`VStack` → `Stack`, `Heading` → `Text` with `variant`) and had to be
corrected against the registry.

Fix: a check carries its own `guidance` string, and the enforceable half of the
authoring skill is **generated** from the catalog:

```
loupe guidance --format md
```

One record, two renderings — the rule that catches the violation and the
sentence that prevents it, unable to disagree. Genuinely un-mechanizable prose
(when a raw `<div>` is legitimately editor content; how to weigh an
`experimental` component) stays hand-written, and stays clearly marked as the
part that is not generated.

This matters most for L3, where the guidance is the primary deliverable and the
check is the backstop.

## 4. The check manifest

Rule metadata is currently spread across `engine/src/rules.mjs` (severity, rank,
needs, title), the presets (severity policy), the README table, and the skills
(prose). Four places, no validation between them.

Consolidate into one declarative catalog. `rules.mjs` is generated from it or
validated against it; `loupe explain`, the README table, and the authoring
skill all read it.

```jsonc
{
  "id": "system/override",
  "tier": "L2",
  "title": "overrides a design-system component — restyle via its props/tokens, not CSS",
  "guidance": "Style a design-system component through its props. A stylesheet rule targeting its class fights the component's own tokens and breaks on any internal change.",
  "remedy": "…",
  "needs": ["components"],
  "defaultSeverity": "warn",
  "channels": ["write", "turn", "audit"],
  "autofixable": false,
  "rank": 11
}
```

An L3 entry adds the inference contract and drops nothing:

```jsonc
{
  "id": "consistency/modal-shape",
  "tier": "L3",
  "title": "modals in this repo don't agree on shape",
  "guidance": "Before adding a modal, read the existing ones. Match the closest, or say why this one differs.",
  "needs": ["components", "patternRegistry"],
  "defaultSeverity": "warn",
  "channels": ["audit"],
  "candidates": { "composite": "Modal(*)", "min": 3 },
  "evidence": ["candidate-source", "pattern-registry"],
  "ask": "…prompt…",
  "minConfidence": 0.7
}
```

## 5. Config

Today a user can set severity, namespaces, and preset. They cannot scope a
check to paths, move it between channels, or add one of their own without
editing the engine.

One `checks` block, uniform across tiers:

```jsonc
{
  "extends": "wpds",
  "checks": {
    // shorthand: severity only — unchanged from today
    "tokens/hardcoded-value": "error",

    // scoped off, rather than off everywhere
    "css/dead-class": { "severity": "off", "paths": ["legacy/**"] },

    // moved out of the write-time gate because it is noisy mid-edit
    "patterns/unregistered-composite": { "channels": ["audit"] },

    // a house rule, declared as data
    "acme/no-raw-brand-color": {
      "tier": "L1",
      "severity": "warn",
      "match": {
        "files": ["**/*.css", "**/*.scss"],
        "declaration": { "property": "/color$/", "value": "/#(0af|00aaff)/i" }
      },
      "title": "brand colour hardcoded — use var(--acme-color-brand)",
      "guidance": "The brand colour is themed. Always reach it through the token."
    },

    // a house judgement call
    "acme/empty-state-consistency": {
      "tier": "L3",
      "channels": ["audit"],
      "candidates": { "composite": "*(Icon,Text,Button)", "min": 3 },
      "ask": "Do these empty states present the same way? Flag any that differ in voice, in whether they offer an action, or in icon treatment.",
      "minConfidence": 0.7
    }
  }
}
```

### User checks are data, not code

Deliberate. Loading user JavaScript into a process that runs on every file
write is a stability and trust problem, most real house rules are pattern
assertions, and a declarative check is inspectable by `loupe status` and
`loupe explain` for free.

Escape hatch: an `exec` check type that shells out, opt-in, never eligible for
the `write` channel.

### Where checks live, and who wins

Same precedence the registries already use — project over profile over builtin,
keyed on `id`:

```
engine/checks/*.json         builtin catalog
profiles/<id>/checks/*.json  a design system ships its own
.loupe/checks/*.json         project-local, or inline in loupe.config.json
```

A profile's checks are subject to the same package gate as its registries: they
apply only to a project that actually imports the design system, so an
`acme/*` check never fires on a Chakra repo.

### Visibility

`loupe status` gains a per-tier breakdown — which checks are active, which are
inert and why (`needs` unmet, scoped out, tier ineligible for this channel).
The existing principle holds and extends to L3:

> A clean run should mean *checked and clean*, never *couldn't read it*.

An L3 check whose model call failed, or whose evidence packet came back empty,
reports **not checked**. It never reports clean.

## 6. Baseline and suppression at L3

Baseline entries key on rule + file + normalized code. An L3 finding has no
offending code — it is a verdict about a site.

Key L3 baseline entries on **rule + file + candidate signature**, which is
deterministic (the selector produced it) even though the verdict is not. The
same key serves suppression:

```jsx
{/* acme-allow consistency/modal-shape -- deliberately terse, this is a
    confirm-and-go path */}
```

## 7. Staging

1. **Manifest + tiering.** Move the existing 17 rules into the catalog with
   tiers, channels and guidance. No behaviour change; `loupe status` gains the
   tier breakdown. Pure refactor, fully testable.
2. **Generated guidance.** `loupe guidance` renders the catalog; the authoring
   skill's enforceable section becomes generated. Kills the drift class.
3. **Channel enforcement.** Honour `channels` in the hook, so
   `patterns/unregistered-composite` can leave the write-time gate.
4. **Declarative user checks.** The `checks` block, `match` primitives for L1,
   index queries for L2. This is the extensibility deliverable.
5. **L3.** `loupe review --emit`, the packet schema, `loupe-reviewer`, and one
   real L3 check shipped in the wpds profile as the reference implementation.
6. **Prop map.** Generate from the design-system MCP; upgrade `system/override`
   to name the prop.

Steps 1–3 are refactors with no new surface. Step 4 is the one users feel. Step
5 is the one that needs the most care and should ship with exactly one check,
not a suite.

## 8. Open questions

- **Should `tier` be author-facing at all,** or an internal property the config
  never mentions? Argument for hiding it: users care about "what does it check
  and when does it run," not about decidability theory. Argument for exposing
  it: a user writing a check needs to know which primitives they get, and a
  user reading a finding needs to know whether it is reproducible.
- **Does L3 need per-run caching?** Re-judging unchanged modals on every audit
  is pure cost. Keying a cached verdict on the candidate signature would work,
  but a stale verdict on code that changed around it is exactly the failure
  mode the write-time gate exists to avoid.
- **How does a project register an L3 check without a prompt-engineering
  burden?** `ask` as a free-text prompt is powerful and easy to write badly. A
  small set of parameterized question templates ("are these N sites consistent
  in X?") may cover most of the real demand.
- **CI as a distinct channel from `audit`?** They differ in whether a human is
  present to triage, which may warrant different confidence thresholds.
