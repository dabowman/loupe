# Patterns v2: what we are building, and why not the rest

Status: in progress, 2026-09-17. This captures the reasoning behind the
registry rewrite so the next session does not re-derive it or re-grow the
parts that were cut.

## The two jobs

Loupe has two customers that want different things from the same engine.

1. **Forward.** A fresh project, agent-written. The wrong choice is made at the
   moment of reaching for a control, so the levers are what is in the agent's
   context when it writes (the reach-for table in the skill), what it is
   allowed to import, and a mechanical finding on the Stop hook while the file
   is still open.
2. **Remediation.** An inherited MVP that is internally consistent and wrong by
   the system's conventions. Consistency is the good case: few shapes, many
   instances. The loop is discover, decide, record, burn down, ratchet. Most of
   it exists; what is missing is workflow, not vocabulary.

Both share the per-file rules, the component currency registry, and a decision
table that says which shape answers which intent.

## What the v1 registry got wrong

One flat list per profile, and "pattern" meant four things: a compound
component's anatomy, a superseded-composite rule, a house composition nobody
had shipped, and a design judgement stored as prose. Every entry had to reach
four nodes to be checkable, so one idea ("render it, don't name it") became
four entries. Three entries sat under the floor and checked nothing
(`action-bar`, `notice-stack`, `entity-dataform`), and `entity-dataform` could
never match anyway because `Page` and `DataForm` come from packages the preset
did not list.

## What the proposal got right

- Split the layers: an abstract pattern language shared across systems, and a
  per-profile realization that says what ships and how it is checked.
- Pattern ids are user needs (`confirm`, `choose.segmented`), so WPDS and
  Archer realize the same id differently.
- `resolve` redirects catch the wrong *pattern*, which is where the drift is: a
  select for four icons, a button that navigates, tabs for levels, a confirm on
  a reversible action.
- `detector` lets an entry say how it is checked instead of inflating a
  signature past the floor.
- Fold `value-preview-row` into `navigate-hierarchy#descend` plus a force, and
  `modal-with-tabs` into a container plus `switch-view.tabs`.

## What the proposal got wrong, and the decisions taken

| Claim or feature | Decision | Why |
| --- | --- | --- |
| "The matcher keeps working" | False; loader rewritten | Entries are keyed by `pattern`, not `id`, and `parts` nest signatures. Loaded as-is, seven checkable shapes go dark. |
| Twenty forces, facets, `related`, scales grid as schema | Cut to what the generator reads | Nothing in the workflow consumed `facets`, `related`, per-part `facet` or `contains`. Unread fields are what the next agent bulks up. The grid stays as a doc-authoring aid, not a schema. |
| `resolve` as a runtime the agent calls | Generator only | An agent does not reliably call a CLI before writing. What shapes its choice is the table already in the skill it loaded. `resolve` generates that table. |
| Missing-force semantics | Ask only on redirects | A redirect rule that consults an undeclared force asks; a variant rule that does is skipped. The proposal's own worked example fails under "always ask", and "never ask" silently picks defaults. Only matters if a runtime resolver is ever built. |
| `declared` detector and `@pattern` tags | Deferred | A commitment device the agent controls. The one case it exists for, confirm versus form dialog, is decided by the label rule. Revisit when a shape appears that no rule can decide. |
| `patterns/extract-candidate` | Dropped | `unregistered-composite` with threshold two instead of three. The code explains why three. |
| Five AST rules | Two now, three specified | `few-static-options` and `confirm-pair` cover the two rows the old doc said carried most drift. The other three need handler-body or state tracing. |
| Archer anatomy to `components[].parts` | Deferred | Cosmetic for the engine; anatomy-as-pattern already works. Do it when Archer moves to v2. |
| Abstract file location | `patterns/index.json` at the repo root | One shared file, which is what `extends` implies. Archer stays on v1 until the loader is proven; the loader accepts both. |
| Component names marked `verify: true` | Kept, surfaced | The generator marks those rows unverified. Verification is against Gutenberg source, not the index, and is separate work. `Spinner` corrected to `@wordpress/ui` per the index. |

## Slices

Phase 1, this session:

1. Preset lists `@wordpress/dataviews`, `@wordpress/admin-ui`,
   `@wordpress/global-styles-ui` so their components enter composite trees.
2. Loader accepts v2: `pattern` as id, `parts` flattened to `id#part`,
   `rendered_signature` as a second shape under the same id, `detector`
   honoured (`import` loads with no tree; `rule:*` carried to the scanner;
   `declared` loads as documentation), `canonical` normalised to the name the
   code binds. v1 files still load unchanged.
3. Two AST rules, parameterised from the registry so the engine names no
   component: `few-static-options` (a select-like component whose option prop
   is a static array of two to five) and `confirm-pair` (a modal whose only
   buttons are two with consent labels and no form control inside). Both
   report `patterns/superseded-composite` against the one file, skip when the
   canonical is already imported, and read `__()`-wrapped labels.
4. A generator that validates the realization against the abstract file
   (every `pattern` key resolves, every `resolve` force is declared, every
   redirect target exists) and writes the reach-for and redirect tables into
   the profile's `patterns.md` between markers. `--check` for CI.
5. Verification: old build versus new build on the Gutenberg checkout,
   `patterns/*` findings only, before trusting tests.

Phase 2, remediation, not started:

- A planner view: the most repeated shapes in the repo with counts, registered
  or not. The discover step.
- Fix batched by shape across the repo, not by file. Purge one convention
  completely so it cannot be copied.
- Baselined findings shown as advisory in touched files, so an agent learns the
  surrounding code is not the standard. Open question: whether that matches
  how an inherited codebase is actually worked, or whether remediation is
  driven from a separate audit run with the baseline fully silent.
- One-command registry entry from a finding, for the record step.

Phase 2, forward, not started:

- Autofix for `few-static-options` where the option objects are `{label,
  value}` literals.
- Import-surface guidance: a project barrel that re-exports only sanctioned
  components makes the wrong choice unimportable; `locked-component` from a
  project registry enforces it today with no engine change.
- An eval over fixed prompts to measure whether the skill text produces the
  right reach. That is the feedback loop the tool lacks.

## Judged forces

`resolve` was generator-only because nothing could read a force off code. A
System One model can, for one force so far: `represents`, scored by
`engine/evals/represents`. So a realization entry may carry a `judge` detector
naming the elements that are instances of its pattern, the vocabulary gives the
force a `judge` block (question and per-value criteria, the wording the eval
scores), and `check --judge` runs the abstract table in code on what it reads. A
redirect is `patterns/judged-redirect`: advisory by default, after the baseline.
The hook passes `--judge` too, so with a key it can fire at write time, asked
there only when the rule is set to `error`, since the hook prints only what
blocks. A row that needs a force nobody has read stops the walk, so a partial
reading never answers past a question the table did not reach.

The next force is data plus an eval, not code: a `judge` block on the force, a
`judge` detector on the entries whose tables consult it, and labelled controls
for the eval. Label pagination first; it is what `represents` gets wrong on
Gutenberg.

## Blind spot

An MVP built from divs and utility classes has no composite tree. Nor does one
written with `createElement` (`el( SelectControl, … )`): the scanner reads JSX,
so vip-digital-asset-manager's controls are invisible to every JSX rule and to
the judge alike. The entry
point there is `system/raw-element` and the CSS rules; the conversion is not
mechanical. The tool finds and counts; it does not fix.
