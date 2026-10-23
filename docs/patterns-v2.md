# Patterns v2: the pattern-language format

A pattern registry in format 2 is two files.

- **The abstract language**, `patterns/index.json` at the repository root, is
  one file every design system shares. It names the intents a user has, the
  forces that decide between ways of meeting them, and the patterns that meet
  them. It names no component.
- **A realization**, `profiles/<id>/patterns/index.json`, says how one design
  system meets those patterns: which component ships for each, what shape it
  has when built, what it replaces, and how each entry is checked.

Three readers consume them, and every field below names the one that reads it:

- **the loader**, `loadPatterns` in `engine/src/patterns.ts`, which turns a
  realization into the shapes the `patterns/*` rules match and the rule objects
  the scanner runs (`engine/src/markup.ts`, `engine/src/checks/detectors/`);
- **the judge**, `judgeRedirects` in `engine/src/judge.ts`, which embeds the
  abstract file at build time and runs its `resolve` tables under
  `check --judge`;
- **the generator**, `engine/scripts/patterns-doc.ts`, which validates a
  realization against the abstract file and writes the reach-for table into the
  profile's `patterns.md` between `<!-- generated:patterns -->` markers.
  `npm run patterns-doc` in `engine/` rewrites it; `npm run patterns-doc:check`
  fails on a stale table, for CI.

A field marked *note* is read by none of them. It is there for the person or
agent reading the file, and the format keeps such fields few on purpose — see
[what was deliberately left out](#what-was-deliberately-left-out).

## Why two layers

The v1 registry was one flat list per profile, and "pattern" meant four things:
a compound component's anatomy, a superseded-composite rule, a house
composition nobody had shipped, and a design judgement stored as prose. Every
entry had to reach four nodes to be checkable, so one idea ("render it, don't
name it") became four entries, and the entries under the floor checked nothing.

Format 2 separates what a pattern *is* from how a system *ships* it. Pattern ids
are user needs (`confirm`, `choose.segmented`), so two systems can realize the
same id differently. A `resolve` redirect catches the wrong *pattern*, which is
where most drift is: a select for four icons, a button that navigates, tabs for
levels, a confirm on a reversible action. And `detector` lets an entry say how
it is checked instead of inflating a signature past the floor.

There is one abstract file, which is what `extends` implies. Profiles realize
its patterns and never add abstract patterns of their own. The registration
rule is in the file's `note`: a new abstract pattern must occupy an
(intent, scale) cell nothing else does, or differ from its nearest neighbour on
a named force; a new variant must be selected by a `when` no sibling already
matches; anything else is a realization and belongs in a profile. Whether
something occupies an empty cell is a judgement; whether every name points at
something is not, and that half the generator checks.

## The abstract file

### Top level

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `version` | `2` | note | The format version. |
| `scope` | `"abstract"` | note | Which layer the file is. |
| `note` | string | note | The resolve semantics and the registration rule, for whoever adds an entry. |
| `vocabulary` | object | generator, judge | The names every pattern is written in. |
| `patterns` | array | generator, judge | The patterns. |

### `vocabulary`

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `intents` | `{ [name]: string }` | generator | What the user is trying to do — `view`, `choose`, `enter`, `act`, `confirm`, `navigate`, `report`, `group` — each with its definition. A pattern's `intent` must be a key here. |
| `scales` | `{ [name]: string }` | generator | How much of the interface the pattern spans — `control`, `composite`, `region`, `screen`, `flow`. A pattern's `scale` must be a key here. |
| `forces` | `{ [name]: Force }` | generator, judge | A property of the situation that decides between variants, or between patterns: `represents`, `cardinality`, `fit`, `reversibility`, … |
| `containers` | `{ [name]: string }` | generator | Where a pattern happens — `screen`, `region`, `modal`, `drawer`, `popover`, `menu` — and when each is right. The generator prints the definition beside the component a realization's `containers` maps it to. The `note` key is a comment, not a container. |

A **force** is:

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `values` | array | generator, judge | Every value the force can take. A `resolve` condition must use one of them. |
| `about` | string | note | What the force is and what it decides. |
| `judge` | `{ question, criteria }` | judge, generator | How `check --judge` asks a model for this force. `question` follows a fixed lead sentence naming the control; `criteria` defines each of `values`, plus `none` for the answer "not a control at all". The generator fails if a value has no criterion: an option missing from the criteria is one the model cannot pick, and the redirect that needs it never fires. Only `represents` has one. See [judged forces](#judged-forces). |

### `patterns[]`

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `id` | string | generator, judge | The pattern's name, and the head of every key a realization writes for it. |
| `intent` | string | generator | A key of `vocabulary.intents`. Printed beside the id in the redirect table. |
| `scale` | string | generator | A key of `vocabulary.scales`. Validated; not printed. |
| `problem` | string | generator | The need, in a sentence. Its first sentence describes a reach-for row when nothing more specific does. |
| `forces` | string[] | generator | The forces this pattern's `resolve` may consult, each a key of `vocabulary.forces`. A `when` naming a force not listed here fails the run. |
| `parts` | `{ role, note? }[]` | generator | The pieces of the pattern a realization can realize on their own (`navigate-hierarchy#descend`). A realization key's `#part` must be one of the `role`s, and the part's `note` describes that row. |
| `resolve` | Rule[] | generator, judge | The ordered decision table — see [below](#resolve). |
| `variants` | `{ [name]: { summary, consequences? } }` | generator | The ways of meeting the need. A realization key's `.variant` must be one of them. `summary` describes the variant's row; `consequences`, what the variant costs and buys, is a note. A variant the profile does not realize, alone or through the whole pattern, is listed under the generated table as a gap. |

The generator uses the first sentence of `problem`, a part's `note` and a
variant's `summary`, so each should open with a sentence that stands alone.

### `resolve`

Every row but the last has a `when` and either a `variant` or a `redirect`. The
last row is `{ "default": "<variant>" }`, and there is exactly one.

| field | type | meaning |
| --- | --- | --- |
| `when` | `{ [force]: value }` | The condition: every listed force has that value. Each force must be in the pattern's `forces`, each value in that force's `values`. |
| `variant` | string | The variant the condition picks. Must exist. |
| `redirect` | key | The condition means this is a different pattern: `id`, `id.variant` or `id#part`, which must resolve. |
| `because` | string | Why, for a redirect. Printed in the redirect table, and carried as the note of a `patterns/judged-redirect` finding. |
| `and` | key | A second pattern that applies alongside the pick: `action-cluster` with `prominence: destructive` picks `overflow` *and* `confirm`. Must resolve; nothing else reads it. |
| `default` | string | The last row alone: the variant when nothing above matched. |

The generator writes every redirect row into the profile's "Before choosing a
shape" table, ahead of the reach-for rows, because most bad choices are the
wrong pattern rather than the wrong variant.

The judge runs a table with `resolveRule`, on the forces that are *known* — read
with enough confidence to act on. An unknown force is left out, not guessed.
Walking the rows in order:

- a row with no `when` (the default) answers;
- a row a known force contradicts is skipped;
- a row whose every force is known and matches answers;
- a row that needs a force nobody knows stops the walk, with no answer.

The last rule keeps a partial reading sound. With only `represents` known, the
redirects at the top of `choose` decide, and the variant rows under them stay
silent rather than answering a question the table never reached. Only a
redirect becomes a finding: the realization already chose a variant, and a
different pick is not something the judge reports.

## The realization file

### Top level

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `version` | `2` | note | The format version. |
| `scope` | `"realization"` | note | Which layer the file is. |
| `extends` | path | generator | The abstract file, relative to this one (`../../../patterns/index.json`). The generator fails a profile whose registry has none, since there is nothing to check it against; a project's own registry needs none, because nothing generates a table from it. The judge does not follow it: it reads the copy of the root file embedded at build. |
| `packages` | string[] | engine | The packages the registry is about (`engine/src/registry.ts`). It applies only to a project importing one of them, because signatures are component names and names are the one thing design systems do not keep to themselves. A registry declaring none applies everywhere. |
| `note` | string | note | The format in brief, for whoever edits the file. |
| `detectors` | `{ [kind]: string }` | note | A definition of each detector kind. The kinds themselves are fixed — see [detectors](#detectors). |
| `rules` | `{ [name]: string }` | generator | Every rule a detector object may name, with what it does. A description beginning "Shipped" lists the rule under "Checked by rule" as one the engine runs; any other lists it as specified but not shipped. A detector object naming a rule missing here fails the run. |
| `containers` | `{ [name]: { import?, canonical?, note? } }` | generator | The component this system realizes each abstract container with, printed as the Containers table beside the vocabulary's definition. |
| `realizations` | Entry[] | loader, generator | The entries. An inline array of them, in a config's `patterns`, loads the same. A file holding a `patterns` list instead, or an entry keyed by `id`, is the flat version-1 form: removed in 0.8.0, and a config error naming the file and what replaced it. |

### `realizations[]`

| field | type | read by | meaning |
| --- | --- | --- | --- |
| `pattern` | key | loader, generator | What the entry realizes: an abstract id (`confirm`), a variant (`choose.segmented`) or a part (`navigate-hierarchy#descend`), which the profile may subdivide after a dot as it does under `parts` (`screen#header.breadcrumb`). The generator fails the run when it names nothing in the abstract file. The loader uses it as the entry's id: findings name it, a project's own registry wins over the shipped one on it, and the judge finds the abstract pattern by cutting it at the first `#` or `.`. |
| `import` | string | generator | The package `canonical` comes from, printed beside it. Parts inherit it. |
| `canonical` | string or `null` | loader, generator | The component that is the answer. The loader cuts a dotted name to its root (`Navigator.Button` → `Navigator`), because it is compared with the names a file imports: a file that imports it is using it rather than rebuilding it, and is not reported, and a finding's remedy names it. An entry whose `canonical` is the root of its own `signature` records anatomy, so a composite made only of that component's parts is never reported as unregistered. Absent or `null`, the generated row reads "not shipped; extract the project's own". Parts inherit it; a part that sets `null` opts out. |
| `verify` | boolean | generator | `true` marks a component name taken from the abstract layer and not yet checked against the system's source. The generated row says "(unverified)". |
| `signature` | shape | loader | The component tree the pattern has when built — see [shapes](#shapes). Checked only at four nodes or more. A registered shape rebuilt by hand in two or more files is `patterns/duplicate-composite`. An entry with no shape still loads, checked by its import or a rule, or not at all, because a finding elsewhere may need it as a remedy. |
| `rendered_signature` | shape | loader | A second shape under the same id: the same part with a force applied (a row whose leading element renders the value it picks), not a second pattern, so the two count as one when files are counted. |
| `instead_of` | string[] | generator | What the entry replaces, in prose: the table's "Not this" column. |
| `instead_of_signature` | shape, or a list of shapes | loader | What the entry replaces, as trees. Matching one is `patterns/superseded-composite`, in one file, unless that file already imports `canonical`. A shape under four nodes is dropped on load: an anti-shape below the floor would fire on half a codebase. |
| `detector` | detector, or a list | loader, generator | How the entry is checked — see [detectors](#detectors). |
| `note` | string | loader, generator | Whatever the reader needs that the fields do not say. The generator takes its first sentence for the row's description when the abstract file has none for the key, and always for a profile's own sub-part. The loader keeps it as the entry's summary. |
| `parts` | `{ [role]: Entry }` | loader, generator | The entry's parts, each loaded as `pattern#role`. A part takes every field above but `pattern` and `parts`, and inherits `import` and `canonical`. The `role`, up to its first `.`, must be one of the abstract pattern's parts; after the dot it is the profile's own subdivision (`browse-collection.list#toolbar.filter`). |

### Shapes

A shape is a component tree in JSON: `[name, ...children]`, with a bare string
for a leaf.

- A name is the component as the code writes it, namespaced parts included
  (`Navigator.Screen`, `Dropdown.Item`).
- `A|B` matches either spelling. One shape usually has more than one, and an
  entry that knows only the newest reports every file still writing the old one.
- `pkg::Name` matches only that package's `Name`, for a project importing two
  systems at once. An unqualified name matches any package, and an import the
  scanner could not resolve is never evidence of a mismatch.
- `>Name` pins a child to its parent's own children. A shape made only of
  layout primitives, `Text` and `Button` needs it: matched at any depth, a whole
  screen's outer `Stack` contains a header somewhere.

Matching is containment. The root must match, and each child must appear
somewhere beneath it, each claiming a node of its own — not as direct siblings
in a fixed order. Props, text and raw elements are transparent, so an
intervening `<div>` never hides a match and a prop change never invents one.
The design note is
[analysis.md#composite-signatures](design/analysis.md#composite-signatures).

### Detectors

`detector` is one value or a list of them.

A **string** documents how the entry is checked. The generator accepts only the
four below, and the loader acts on none of them: a signature present is matched
and a canonical present is honoured whatever the string says.

| string | meaning |
| --- | --- |
| `"signature"` | Tree containment against `signature`. |
| `"import"` | The whole implementation is one component: a file importing `canonical` is satisfied, and the tree is not inspected. |
| `"declared"` | Checkable only where a file declares the pattern, so documentation until a declaration tag exists. |
| `"rule:<name>"` | A rule that is specified but not shipped, described under `rules`. |

An **object**, `{ "rule": "<name>", …params }`, is a rule the engine ships,
parameterised by the registry so the engine names no component. The loader
carries it to the scanner, which runs it on every JSX element whose component
comes from the design system. The generator fails if `<name>` is not a key of
`rules`. Three ship, in `engine/src/checks/detectors/`:

| rule | params (default) | what it finds |
| --- | --- | --- |
| `few-static-options` | `components`; `prop` (`"options"`); `min` (2); `max` (5); `maxLabelChars` (32) | A component in `components` whose `prop` is a static array — inline, or a same-file `const` — of `min` to `max` options whose labels the source states and that total at most `maxLabelChars`. The select that should have been a segmented control. |
| `confirm-pair` | `container` (required); `button` (`"Button"`); `labels` and `controls`, two regexes with defaults for consent words and form controls | A `container` whose only `button`s are exactly two, both labelled with a consent word (`Cancel`, `Delete`, `Confirm`, …, literal or `__()`-wrapped), and with no form control inside. The modal that should have been a confirm dialog. |
| `judge` | `components`; `unless` | Not a finding by itself. Each element named in `components`, member names included (`Menu.Item`), is collected as an instance of the entry's pattern for `check --judge` to ask about — unless it carries a prop in `unless`, which means it already realizes the target, or a spread, which might. Runs only under `--judge`. |

A hit from the first two reports `patterns/superseded-composite` against the
entry that carries the rule, unless the file already imports its `canonical`.

## Judged forces

A signature cannot see what a control stands for — a value, a command or a
destination — and that is the force the redirects most often turn on. A model
can read it, for one force so far: `represents`, scored by
`engine/evals/represents`. Three fields carry it:

- a `judge` block on the force in `vocabulary.forces`, holding the question and
  per-value criteria — the wording the eval scores;
- a `judge` detector on each realization whose pattern's table consults that
  force, naming the components that are instances of it;
- the abstract `resolve` table, which `check --judge` runs in code.

For each control collected, the judge asks every force its pattern's table
consults that has a `judge` block. An answer under the redirect floor, 0.90,
stays unknown. `resolveRule` then runs the table, and a redirect is
`patterns/judged-redirect`: advisory by default, and written after the
baseline, so a judged finding never enters one. Both hooks pass `--judge` too,
so with a key it can fire at write time, but the hook asks the redirect
question only when the rule is set to `error`, since the hook prints only what
blocks. The design note is
[judge.md#which-force-judgeforcets](design/judge.md#which-force-judgeforcets).

The next force is data plus an eval, not code: a `judge` block on the force, a
`judge` detector on the entries whose tables consult it, and labelled controls
for the eval. Label pagination first; it is what `represents` gets wrong on
Gutenberg.

## Limits

An interface built from divs and utility classes has no composite tree. Nor
does one written with `createElement` (`el( SelectControl, … )`): the scanner
reads JSX, so those controls are invisible to every JSX rule and to the judge
alike. The way in there is `system/raw-element` and the CSS rules, and the
conversion is not mechanical. The tool finds and counts; it does not fix.

## What was deliberately left out

The format was cut down from a larger proposal. What was dropped or deferred,
and why, so that it is not grown back by accident:

| proposed | decision | why |
| --- | --- | --- |
| `facets`, `related`, a per-part `facet` and `contains`; the scales grid as schema | Cut | Nothing in the workflow read them, and unread fields are the ones that grow. The grid stays an aid for writing the language, not a schema. |
| `resolve` as a runtime the agent calls | Generator only | An agent does not reliably call a CLI before writing. What shapes its choice is the table already in the skill it loaded, and `resolve` generates that table. Under `--judge` the engine runs the table itself, on forces a model read — which is not the agent calling it. |
| Asking for every missing force, or for none | Ask only for redirects | "Always ask" fails the proposal's own worked example, and "never ask" silently picks defaults. The judge asks only the forces a table consults, reports only redirects, and stops at a row that needs a force still unknown. |
| A `declared` detector and `@pattern` tags | Deferred | A commitment device the agent controls. The one case it exists for, confirm versus form dialog, is decided by `confirm-pair`'s label rule. `declared` loads as documentation; revisit when a shape appears that no rule can decide. |
| `patterns/extract-candidate` | Dropped | It was `unregistered-composite` at a threshold of two. Two is a coincidence; three is house style. |
| Five AST rules | Two shipped, three specified | `few-static-options` and `confirm-pair` cover the two cases that carried most drift. `button-that-navigates`, `unconditional-optional-controls` and `hand-managed-selection` need handler-body or state tracing, and stay under `rules` as specified. `judge` came later, for the force no rule can read. |
| Archer's anatomy as `components[].parts` | Deferred | Cosmetic for the engine, since anatomy-as-pattern already works. When Archer moved to v2, each anatomy entry became the realization of the pattern its component realizes (`Dialog` is `screen.overlay`, `Table` is `browse-collection#items`), and the components that had none to stand under — Autocomplete, Accordion and Popover, NavigationMenu, List — added `choose.autocomplete`, `disclose`, `navigate-sections` and `group.list` to the language. Revisit if anatomy turns up that no pattern could honestly hold. |
| v2 files through the v1 matcher | Loader rewritten | The proposal said the matcher would keep working. It would not: entries are keyed by `pattern`, not `id`, and `parts` nest signatures, so loaded as-is seven checkable shapes went dark. |
| Reading v1 beside v2 | Removed in 0.8.0 | Two formats were two things to document and keep working, and the v1 profiles' hand-written tables were the ones that drifted. Every shipped registry is a realization now, and a v1 file is refused with the fix in the error rather than read as empty, which would switch the rules off and report clean. |
