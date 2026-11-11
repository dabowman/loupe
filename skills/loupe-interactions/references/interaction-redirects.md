# Interaction Redirects

*Spec v0.4, Nov 11, 2026. Extends Loupe from design-system conformance to interaction-pattern choice.*
*Supersedes v0.3 (Nov 3). The taxonomy-first v0.2 (`ui-pattern-language-forces.md`) stays as reference vocabulary and evidence.*

**What changed since v0.3**

- Scope widens from generated UI code to **any agent output**: conversation, interactive chat UI, saved settings, and tool use in other systems (code, Figma, MCP).
- **Assurance ladder (§3):** one spec, enforced at whichever rung a surface can afford, from a system prompt to a review gate.
- **Response shapes and wiring (§4):** before choosing a component, decide whether the agent answers, asks, or shows UI, and whether a control calls the API itself or asks the agent to act.
- **Compound interactions (§5):** how to resolve a request that bundles several decisions.
- **Four new forces (§6):** Judgment, Answer holder, Default, and Persistence as a surface setting.
- **Chat redirects (§9)** and a **Slack component profile** (`slack-profile.md`).
- **Worked examples (§12):** skills, tools, and channel setup for Iris.

## 1. Purpose and limits

**Goal:** consistency, plus well-timed redirects in the ~20% of interactions where the obvious implementation is the wrong one. The aim is to replace clunky defaults (dropdowns for everything, confirm dialogs on every delete, one long form, a question for every missing input) with considered, conventional patterns.

**Scope:** anything an agent produces for a person: a chat reply, an interactive message, a change to saved settings, an action in another system.

**Non-goals:** innovation, encoding every design decision, replacing designers.

**Cost test:** a redirect earns its upkeep only if it fires rarely, is right when it fires, and is cheaper to maintain than the drift it prevents.

## 2. How it works

```
Trigger  ──▶  Deciding forces  ──▶  Decision  ──▶  Recipe (or keep)
(cheap code     (1–3 questions,       (first-match     (spec for composing
 or turn         metadata first)       table)           atomic components)
 signal)
```

- **Trigger:** a cheap, mostly static signal that a default pattern was used somewhere it often doesn't fit. Nothing fires without one.
- **Deciding forces:** only the forces this redirect needs, resolved in order: metadata → telemetry → Jev → conservative default.
- **Decision:** a first-match table. Many rows end in `keep`. Most triggers that fire should conclude the default is fine.
- **Recipe:** a versioned spec for composing existing atomic components, mapped to real components by a **component profile** (`wp-components`, `slack-block-kit`, …). It is never a shipped composite component.

**Two modes, one table:**

- **Prevention (before generation):** Jev screens the request for triggers, links it to existing entities, and resolves the deciding forces. The agent gets a short pattern brief before it writes code or replies (§10).
- **Audit (after generation):** triggers scan the output (code, outgoing message payloads, tool calls, transcripts), forces resolve, redirects are suggested or enforced.

## 3. The assurance ladder

The same spec can be enforced with different strength. A surface climbs as far as its stakes justify.

| Rung | What it does | Mechanism | Strength |
|---|---|---|---|
| **1 · Steer** | Standing preferences | System prompt, output style, project instructions, skills | Shapes tendencies; nothing checks it |
| **2 · Brief** | Guidance for this request | Jev pattern brief (§10), context-loaded skills | Targeted, still trust-based |
| **3 · Shape** | Make whole classes of error impossible | Output schemas, typed tools, recipes as templates, component profiles | Deterministic, but only within the format |
| **4 · Check** | Verify after generation | Loupe audit, lint, Jev classifying the output, retry with feedback | Catches drift; suggests fixes |
| **5 · Gate** | Block until fixed or overridden | `require` redirects, CI, blocking a send or a tool call | Enforced; an override needs a reason |
| **6 · Review** | A person decides | Propose-then-apply, PR review | Judgment handed to a person |

Steer and Brief change what the model *tends* to do. Shape changes what it *can* do. Check and Gate verify what it *did*. Review hands the decision to a person.

**One redirect, many rungs.** A redirect is written once; each layer of its recipe feeds one rung.

| Recipe layer | Feeds | `remove-friction` example |
|---|---|---|
| `brief` text | Brief | "Removing Iris is recoverable. Do it, then offer Undo." |
| `template` | Shape | The undo-toast recipe as a fixed layout: outcome line and an Undo button wired to the API |
| `signature` | Check | Flags a confirm step attached to a reversible removal |
| `enforcement` | Gate | At `require`, the message, merge or tool call is blocked |

Steer is general guidance, not tied to one redirect. Review hands the decision to a person, so there's nothing to compile. A rung can only use what the spec has written for it, so "how far up can this redirect go" is "how complete is its spec".

**Choosing the rung.** Use QA in proportion to the cost of an error against the cost of checking. Stakes, Reversibility and Reach measure the first; **Persistence** (a passing reply, saved state, an action in another system) separates the surfaces; **Frequency** is the cost side, since checking every chat turn costs more than checking once per PR.

| Surface (what the output touches) | Typical rungs |
|---|---|
| Conversation (only the reader) | Steer; Brief only when a trigger fires (e.g. interrogation) |
| Chat UI (this interaction) | + Shape (message-layout recipes); light Check on transcripts |
| Settings (shared state the agent owns) | + Gate for access changes; Review (propose-then-apply) |
| Tool use (other systems: code, Figma, MCP) | All six: Loupe audit, CI or approvals, PR or file review |

This column order is Reach (self → others → outside world), so forces derive it rather than a hand-made list. Forces can also pull an interaction **below** its column's default: managing skills is a settings change, but undoable and trivial, so it stops at Check.

**Rules carried from §7:** promote a redirect up a rung on evidence (acceptance high, overrides rare). Precision matters more the higher you go: a noisy Brief costs a little context, a noisy Gate teaches everyone to override.

| Rung | Failure mode | Metric |
|---|---|---|
| Steer | Drifts silently | Sampled conformance |
| Brief | Ignored | Acceptance when fired |
| Shape | Too rigid | Escape-hatch use |
| Check | Noisy | Fire and acceptance rates |
| Gate | Overridden | Override rate and reasons |
| Review | Rubber-stamped | Approved-without-change rate |

**Coverage report:** for each redirect, the highest rung it is actually enforced at on each surface.

## 4. Response shapes and wiring

Before choosing a component, two decisions: **what shape the response takes** and **who acts**.

### Shapes

| Shape | Flow | Fits when | Goes wrong when |
|---|---|---|---|
| **Answer** | prompt → output | The agent can act on what it can read or reasonably assume, and a mistake is cheap to fix | It guesses at something expensive, like who gets access |
| **Ask** | prompt → questions → output | The missing input is intent only the person holds, with no safe default | The answer is really a pick from a list the system knows |
| **Show UI** | prompt → UI → output | The input comes from a known set, has several fields, must be exact, or needs review before it takes effect | The UI rebuilds a settings page for something one sentence could handle |

**The edges**, each settled by one question:

- **Answer or ask:** can the agent make a reasonable guess and say what it assumed? If yes, answer and offer the change in one tap.
- **Ask or show UI:** is the answer a pick from something the system knows, or more than one field? If yes, show UI. A picker returns the exact entity; typed names have to be matched.
- **Through the agent or direct:** would the same click always do the same thing? If yes, wire it to the API.

### Rule 1 · Pick the shape (first match)

1. The agent has what it needs and a mistake is cheap to fix → **answer**; state any assumption.
2. It has what it needs but the action is hard to undo or others will see it → **confirm** before acting.
3. The missing input is a choice from a known set, several related fields, or an exact value → **show UI**.
4. The missing input is intent or judgment → **ask**, one question at a time, likely answers as buttons.
5. After two rounds of questions → stop asking; propose a default the person can change.

For several decisions at once, see §5.

### Rule 2 · Pick the UI

Use the smallest element that holds the input exactly. The component profile maps each recipe to real components; for Slack see `slack-profile.md`. Stay inline where possible; open a form when the input needs room.

### Rule 3 · Pick who acts (wiring)

| Wiring | Flow | Use when |
|---|---|---|
| **Through the agent** | click → message → agent → output | The result depends on judgment: suggested next steps, "Draft from channel" |
| **Direct** | click → API → result; agent told | The same click always does the same thing: turn a skill on, add a manager, undo |
| **Propose, then apply** | agent drafts → person reviews → Apply → API | The change matters and the agent's help building it is worth having |

Wiring is a field on each recipe; Judgment (§6) chooses between recipes that look the same but are wired differently.

**Never break these** (they ship as `require` redirects or recipe constraints):

- Changes to access, permissions, or who manages something run under the person's own authorization. The agent may propose them and never applies them itself. A message or a linked document can't quietly change them.
- Apply commits exactly what was reviewed. Nothing is regenerated between review and commit.
- Every direct action is recorded with who did it, can be undone, and the agent is told.
- A control that can't work here isn't shown. When something lives elsewhere, link to it.

## 5. Compound interactions

Some requests bundle several decisions: setting up an agent in a channel covers managers, instructions, tools and skills at once. Resolve the forces twice, once for the whole and once for each item.

1. **The whole decides the shape and the container.** Run rule 1 on the compound. If every item has a default, the compound is a proposal, not a list of questions.
2. **Each item keeps its own control and wiring.** Rules 2 and 3 run per item, inside the container.
3. **Friction stays local.** The riskiest item gets its own confirmation. The rest doesn't inherit it, so applying the defaults stays one click.
4. **Edits change a draft until one Apply.** Inside the compound, a direct control changes the draft. After Apply, the same controls change live state.
5. **Ask only for items with no default.** Ask inline, in the container, and let the person skip it.
6. **Conversation and UI edit the same draft.** A typed instruction and the form change the same proposal.

Move the container somewhere persistent (a DM, a task list) only when the compound can't finish in one sitting, for example while waiting on someone's approval. That is R5's multi-session row.

## 6. Core forces

**Rule: a force exists only if a redirect asks for it.** Each force has a definition, example values, where its value comes from (in order of preference), and the fallback when it can't be determined. C = classified by Jev, A = authored.

**Loupe alignment.** `cardinality`, `reversibility` and `persistence` already exist in the pattern language's vocabulary (`patterns/index.json`). Use those names when these forces are encoded there, and extend their value sets rather than adding near-duplicates.

#### What the thing is

**Cardinality**: how many items someone has to choose from or look through.
- *few* (≤~7): a T-shirt size · *many* (≤~100s): a country · *vast*: a customer in a CRM, a skills directory
- Resolve: static option count → API total / pagination meta → C · Default: don't fire

**Domain**: the kind of value a field accepts.
- *binary* · *small set* · *large set* · *date* · *email* · *tel / url / number* · *free text* · *entity* (a person, channel, group, tool or skill the system knows)
- Resolve: schema type / format → component props · Default: don't fire

**Space**: how much room the control has where it's rendered.
- *compact*: a toolbar filter, a table cell, a chat message · *regular*: a settings page, a form
- Resolve: render context · Default: regular

#### What is being done

**Effect**: what an action does to data.
- *read* · *create* · *modify* · *remove* · *execute* (a side effect outside the app: sending, charging, publishing) · *grant* (changes what someone, or an agent, may do)
- Resolve: HTTP method · MCP annotations · handler name · Default: taken from the trigger

**Reversibility**: whether, and how easily, an action can be taken back.
- *undoable* · *recoverable* (trash, 30 days) · *permanent*
- An undoable *setting* can still enable *actions* that are permanent (an agent filing issues while a tool is on); classify the actions it enables, not just the switch.
- Resolve: API metadata (soft delete, trash, `destructiveHint`) → C · Default: **permanent**

**Reach**: what else the action affects beyond the item itself.
- *self* · *own-bulk* · *dependents* (skills that need a tool, menus that need a category) · *others* (a channel, a team-wide setting) · *outside world*
- Resolve: dependency / cascade count · `openWorldHint` → C · Default: self

**Stakes**: how much would be lost if the action were done by mistake.
- *trivial* · *moderate* · *high* · *critical*
- Resolve: proxies (environment, money, cascade size) → C · Default: moderate

**Frequency**: how often people perform this action.
- *rare* · *occasional* · *frequent*
- Resolve: telemetry → C · Default: occasional

**Latency**: how long the action takes to finish.
- *brief* (<1 s) · *noticeable* (1–10 s) · *long* (>10 s) · *deferred*
- Resolve: telemetry p95 → endpoint metadata (async, `202 Accepted`) → C · Default: brief

**Judgment** *(new)*: whether carrying the action out needs the agent's reasoning.
- *none*: one API call, every argument supplied by the control · *some*: the agent interprets, drafts or chooses
- Decides Rule 3: none → direct; some → through the agent, or propose-then-apply when Stakes or Reach are high.
- Resolve: can a single tool call be fully filled from the control's values? (tool schema) → C · Default: some

#### What the person is trying to do

**Mode**: *lookup* · *browse* · *monitor* · *compare* · *create* · *edit* · *configure* · *audit* (see what's on and why)
- Resolve: C · Default: don't fire

**Span**: *session* · *multi-session*
- Resolve: telemetry (leave and return) → C · Default: session

**Sequence**: *free* · *ordered* · *dependent*
- Resolve: C / A · Default: free

**Answer source** (dates only): *memory* · *document* · *scheduling* · *uncertain*
- Resolve: C / A · Default: memory

**Answer holder** *(new)*: who can supply a missing input.
- *system*: it can be listed (people, channels, tools, skills, dates) · *person*: only they know (audience, tone, what "done" means)
- Separates Ask from Show UI. It may fold into Domain (*entity* vs *free text*) once both are encoded.
- Resolve: Domain → C · Default: person

**Default** *(new)*: whether a missing input already has an answer.
- *safe*: a conservative value nobody needs to approve (lookup tools: all; action tools: off) · *draftable*: the agent can write a first version from context · *none*: only the person knows
- Decides propose versus ask: safe and draftable → fill it in; none → ask for that item only. This used to hide inside "has what it needs".
- Resolve: metadata (a declared default) → available context (topic, pins, history) → C · Default: none

#### Who is doing it, and what the system is saying

**Access**: *allowed* · *no permission* · *not in plan*
- Resolve: where the capability check comes from (role vs. billing) · Default: don't fire

**Blocking**: *no* · *needs attention* · *halts flow*
- Resolve: handler control flow · Default: no

#### Product and surface defaults (set once, overridable)

**Audience**: *public* (clarity first) · *internal* (speed and density first)

**Emphasis**: *promote* · *neutral* · *deliberate* (make consequences clear; never hide the way out). Per action type, e.g. `{ upgrade: promote, cancel: deliberate, grant-action-tool: deliberate }`.

**Persistence** *(surface-level)*: what the output touches. *conversation* · *interaction* · *shared state* · *other systems*. Sets the default rungs in §3.

**Unresolved forces.** If a deciding force falls back to its default, a redirect may *suggest* but never *require*. Defaults lean safe (an unresolved Reversibility is permanent).

**Jev usage.** One question per force, fixed options with a one-line description each, and the context bundle (UI label, entity type, product description, nearby code or conversation summary). Accept the answer at p ≥ 0.7 (tune per force); otherwise use the default.

```yaml
force: stakes
question: "If this action were done by mistake, what would be lost?"
options:
  trivial:  "Nothing meaningful; easy to redo"
  moderate: "Some work or data, recoverable with effort"
  high:     "Significant work, money, or other people affected"
  critical: "Irreplaceable data, legal, financial or safety consequences"
threshold: 0.7
```

## 7. Spec formats

### Redirect

```yaml
id: remove-friction
version: 1
triggers:
  - id: confirm-on-remove
    signal: confirmation step opened in a handler or turn that calls a remove operation
  - id: unguarded-remove
    signal: remove operation called directly, with no confirm and no undo
forces: [reversibility, reach, stakes, frequency]
decide:                      # first match wins
  - when: { reversibility: [undoable, recoverable], stakes: [trivial, moderate], frequency: [occasional, frequent] }
    recipe: undo-toast
  - when: { reversibility: permanent, reach: [dependents, others, outside-world] }
    recipe: type-to-confirm
  - when: { reversibility: permanent, stakes: [high, critical] }
    recipe: type-to-confirm
  - otherwise: confirm-dialog
enforcement: suggest          # suggest | require
rationale: >
  Confirming a frequent, reversible action trains people to click through it;
  undo is safer and faster. Permanent cascading removals need deliberate friction.
evidence: v0.2 §8 (Mobbin delete patterns; GOV.UK interruption pages; Carbon danger modal)
```

### Recipe

```yaml
id: undo-toast
version: 2
composes: [Snackbar, Button:link]          # mapped to real components by the profile
wiring: direct                              # agent | direct | propose
requires:
  - action runs immediately; no confirmation step
  - message names the object and the outcome ("'Q3 plan' moved to trash")
  - an Undo action that fully restores the previous state
  - when reach is dependents, the message names what stops working
forbids:
  - confirmation step in the same flow
layers:                                     # one per rung (§3)
  brief: "This removal is reversible: do it, then offer Undo. Don't ask first."
  template: profiles/<profile>/recipes/undo-toast   # Shape
  signature:                                # Check
    present: [Snackbar with action labelled Undo|Restore]
    absent:  [ConfirmDialog in handler]
```

Designers change patterns by editing recipes. Bumping a recipe's `version` makes the next audit list implementations that no longer match its signature, so drift turns into a migration list.

### Product and surface config

```yaml
product: iris
audience: internal
emphasis: { grant-action-tool: deliberate, cancel: deliberate }
surfaces:
  slack:   { persistence: interaction, component_profile: slack-block-kit }
  mc:      { persistence: shared-state, component_profile: wp-components }
```

### Override

```js
// loupe-override remove-friction reason="Bulk admin cleanup; recovery handled by audit log"
```

An override needs a reason. Overrides are collected in the audit report, not hidden.

## 8. The core redirects

Example signals use `@wordpress/components` names; the profile maps them for other systems.

### R1 · few-options-dropdown
- **Trigger:** `SelectControl` / `<select>` with 2–5 static options; or any `<select multiple>`.
- **Forces:** Domain, Space.
- **Decide:** Space compact → **keep** · `multiple` → **checkbox-group** · 2–3 short options → **segmented-control** · otherwise → **radio-group**.
- **Why:** government design systems prefer radios and treat select as a last resort for short lists; multi-select is hard to use and checkboxes replace it.

### R2 · long-list-no-search
- **Trigger:** select or menu with >15 options, or options from an unbounded source, and no filter input.
- **Forces:** Cardinality, Space.
- **Decide:** many → **searchable-combobox** · vast → **async-autocomplete** · before either, check whether an earlier question could narrow the list (*reduce before accommodating*).

### R3 · remove-friction
- Specified in §7. Triggers: confirm-on-remove, unguarded-remove.
- **Recipes:** undo-toast · confirm-dialog (states consequences; names the recovery window) · type-to-confirm (names what cascades and the environment).

### R4 · blocking-wait
- **Trigger:** busy state bound to a mutation that blocks the surface.
- **Forces:** Latency, Blocking.
- **Decide:** brief → **keep** · noticeable → **inline-progress** · long or deferred → **background-job** (status in place plus a completion notice).

### R5 · long-form
- **Trigger:** one form render with >10 visible inputs and no sections.
- **Forces:** Audience, Span, Sequence, Default.
- **Decide:** multi-session → **task-list** · every input has a default → **proposal card** (§5) · public and ordered → **question-pages** · otherwise → **sectioned-form**.

### R6 · unexplained-disabled
- **Trigger:** disabled control, or a refused request, with no explanation.
- **Forces:** Access (+ Emphasis for plan gating).
- **Decide:** no permission → **access-explainer** (why, plus who can grant it or a request action) · not in plan → **upgrade-prompt** · allowed but blocked by state → **state-explainer** (say what's missing).

### R7 · message-weight-mismatch
- **Trigger:** modal on success; toast for an error that stops submission; page or channel-wide message for a local event.
- **Forces:** Blocking, Stakes, Reach.
- **Decide:** success and not blocking → **flag** · form error that halts → **error-summary + inline-errors** · system-wide loss → **banner** · needs a response to continue → **dialog** · reach self → private to the person · reach others → visible to everyone affected.

### R8 · unfiltered-collection
- **Trigger:** a collection with >50 items (or unbounded) and no search, filter or pagination; or a card grid of records when Mode is compare.
- **Forces:** Cardinality, Mode.
- **Decide:** many → **paged-list + search** · vast → **search-first + filters** · compare or audit → **sortable-table**.

### R9 · untyped-input
- **Trigger:** plain text input bound to a field whose type is date, email, tel, url, number or enum.
- **Forces:** Domain, Answer source (dates only).
- **Decide:** email / tel / url / number → **typed-input** · enum → hand off to R1/R2 · date: memory → **date-fields** · document → **match-source-format** · scheduling → **date-picker + text entry** · uncertain → **approximate-date**.

## 9. Chat redirects

Agent turns are output too. Triggers read the outgoing message, its interactive elements and its tool calls. R1–R9 apply to chat with the mappings in `slack-profile.md`; these are specific to conversation.

### C1 · entity-question
- **Trigger:** the agent asks a question whose answer is an entity the system knows, or lists options in prose.
- **Forces:** Answer holder, Cardinality.
- **Decide:** answer holder person → **keep** · few → **buttons** · many → **select** · vast or external → **async search select**.
- **Why:** a picker returns the exact entity; typed names have to be matched to IDs, and two people called Sam break the match.

### C2 · interrogation
- **Trigger:** the agent is about to ask a second clarifying question in a row.
- **Forces:** Default, Stakes, Reversibility.
- **Decide:** every missing input has a default → **proposal card** (§5) · stakes trivial or moderate and undoable → **answer with a stated default** and a one-tap change · three or more fields → **sectioned form** · otherwise → **keep**.

### C3 · agent-applies-access-change · `require`
- **Trigger:** the agent calls a write tool whose Effect is *grant*: managers, permissions, or tools that let it act in other systems.
- **Forces:** Effect, Reach.
- **Decide:** always → **propose-then-apply**: the agent drafts the change and stops; the person's own click applies it under their authorization.
- **Why:** the never-break rule in §4, enforced.

### C4 · agent-blocked-silently
- **Trigger:** a request fails because a tool, skill or permission is missing, and the reply doesn't say so.
- **Forces:** Access.
- **Decide:** R6's table, in the reply: name what's missing, who can turn it on, and offer the next step only if it can work here.

**Mappings onto the core set:** R3 → remove a skill or tool immediately with Undo in the change note (the note names dependents). R4 → **progress in place** (one message updated as work proceeds, details in its thread). R5 → multi-step setup becomes one proposal card. R7 → reach self is a private message; reach others is a short note to the channel.

## 10. Prevention: classifying requests with Jev

Prevention runs on the request before any output exists. It uses Jev and metadata only: no text generation and no parsing into a schema. Every step returns a typed answer with a probability.

### Stage 1: Trigger screen

One question per redirect, run in parallel. Questions ask what the **feature or request** does, not what the UI looks like. Most requests fire zero to two redirects; a request that fires none goes to the agent with no brief.

| Redirect | Question | Fires when |
|---|---|---|
| R1 / R2 | Will people choose from a set of options? *(none · a few · many · a large or growing list)* | a few → R1 · many / large → R2 |
| R3 | Will people be able to delete or remove things? | yes |
| R4 | Does any action involve processing that could take a while? | yes |
| R5 / C2 | Does it collect more than about ten pieces of information, or several decisions at once? | yes |
| R6 / C4 | Will some people be blocked from parts of this by role, plan or missing tools? | yes |
| R7 | Will the system need to report success, failure or problems? | yes |
| R8 | Does it show a collection that could grow beyond a few dozen items? | yes |
| R9 | Does it ask for dates, emails, phone numbers, URLs or numbers? | yes |
| C3 | Could it change who can do what, or let the agent act in another system? | yes |

Fire only if p ≥ threshold (start at 0.7, tune per question).

**Chat runtime.** Prevention runs per turn, not per prompt, so it costs more. Run Stage 1 only on turns that ask a question or call a write tool, and cache answers as below.

### Stage 2: Link to existing entities

For each redirect that fires, ask: *"Which existing entity does this act on?"*

- **Options** come from an **entity registry**: REST routes, post types, Abilities and DataViews fields for code; the agent's own **tool list** for chat, where MCP annotations (`destructiveHint`, `openWorldHint`) and Abilities metadata already carry Reversibility, Reach and Effect. Plus **"something new."**
- Jev caps a choice question at 255 options; larger registries go area first, then entity.
- **Linked:** derived forces come from metadata. **Something new:** resolve in Stage 3, and record the answers as suggested annotations so future audits can read them.

### Stage 3: Deciding forces

Ask Jev only for forces Stages 1 and 2 left unresolved, using the §6 question templates. Below threshold, use the §6 default; that redirect can then only suggest.

### Output: the pattern brief

One entry per redirect that fired, with the forces that decided it. `keep` emits nothing.

```yaml
pattern_brief:
  - redirect: R8 unfiltered-collection
    recipe: search-first + filters
    because: { cardinality: vast (linked: subscriber endpoint, unbounded) }
  - redirect: R3 remove-friction
    recipe: confirm-dialog (with count for bulk)
    because: { reversibility: permanent (linked: DELETE has no trash), stakes: moderate (p=0.81), reach: own-bulk }
```

The `because` lines let the agent keep the reasoning, and let a reviewer correct a wrong *input* instead of arguing with the output.

**Granularity:** prevention is coarse (one entry per feature or turn); audit is precise (each call site, component or message). **Determinism:** cache every answer under a hash of (request, product config, registry version); put the brief and its probabilities in the PR description or the turn log; log every Stage 1–3 answer as evaluation data.

## 11. Governance and rollout

- **Adding a force:** only when a redirect needs it. Remove forces nothing uses.
- **Adding a redirect:** a cheap trigger, at most 3 deciding forces, a decision table that includes `keep` wherever the default is sometimes right, and evidence.
- **Favor precision over recall.** A redirect that's wrong when it fires teaches people to ignore all of them.
- **Enforcement:** start every redirect at `suggest`; promote to `require` once acceptance is high and overrides are rare and explained. C3 starts at `require` because it encodes a never-break rule.

| Metric | Healthy | Unhealthy means |
|---|---|---|
| Fire rate | low | trigger too broad |
| Acceptance rate | high | decision table or forces wrong |
| Override rate + reasons | low, varied | clustered reasons = missing force or bad rule |
| Unresolved-force rate | low | add metadata or improve the Jev question |
| Drift per recipe version | falling | migration not happening |
| Highest rung per surface | rising where stakes justify | spec layers missing (§3) |

**Rollout:**

1. **Derived forces only (no Jev):** R1, R2, R9 (minus dates), R6, and R3 from API reversibility metadata. Audit mode on one product; review every firing by hand.
2. **Add Jev:** Stakes, Frequency fallback, Mode, Span, Sequence, Answer source, Default → R4, R5, R7, R8, full R3 / R9, and C1, C2. Measure Jev against hand-labelled forces first.
3. **Prevention:** evaluate on ~100 real requests from agent logs, labelled by hand. Expect Stage 1 to be strong and prompt-only Stage 3 mixed, which makes Stage 2 linking and safe defaults the backbone.
4. **Chat surface:** C3 at `require` from day one; the rest at `suggest`, audited from transcripts in the Self-Improvement review.

## 12. Worked examples (Iris in Slack)

A clickable prototype of all three lives at `iris-lightning-week.space.fast/iris-channel-setup.html`; the patterns page beside it has an interactive version of Rule 1.

### Managing skills in a channel

| Force | Value |
|---|---|
| Cardinality | vast (the directory); few (skills already on) |
| Mode | lookup, browse, audit |
| Access | owner and managers only |
| Reversibility / Stakes | undoable / trivial |
| Reach | others: everyone Iris answers in the channel |
| Judgment | none |

**Fires:** R2 → search the directory, never list it; suggestions shown when the query is empty. R8 → channel skills as a sortable table (MC) or a status card (Slack). R3 → turn off immediately with Undo; no confirmation. R6 → non-managers see who can change it. R7 → a status card only the asker sees; one note to the channel per change. **Who acts:** direct. **Not fired:** C3, because skills only use tools the channel already allows. **Rungs:** Steer, Brief, Shape, Check. Slack handles lookup and audit; browsing a vast directory hands off to MC.

### Managing tools in a channel

The difference from skills is Effect. Some tools only look things up; others act in other systems (Linear issues, Spacefast publishes, draft PRs), and what the agent does with them can't be undone.

**Fires:** R1 → **keep** checkboxes for lookup tools (few options). R1 per tool → Off / Look up / Look up and act where a tool has both. C3 → the agent never turns on an action tool itself; it proposes, and a manager's click applies it. R3 → turning a tool off is immediate with Undo; the note names skills that stop working (Reach: dependents). R3 inverse → turning on an action tool shows a confirmation that says what anyone in the channel can now ask for (Emphasis: deliberate). R6 / C4 → a blocked request names the tool that's off and who can turn it on.

**Design change it produced:** remove "all approved tools, including future additions". New lookup tools may be added automatically; new action tools never are.

### Setting up Iris in a channel (compound)

| Level | Forces | Decision |
|---|---|---|
| **The whole** | every item has a default · activating reaches the channel · undoable · ~14 inputs · internal, one sitting, any order | One proposal card, private to the person who added Iris, every section filled in, one Activate. Not a step-by-step form (no required order). Not a question-by-question walkthrough (C2: the defaults already answer). |
| Managers | entity · grant · default safe (just the owner) | People picker in a small form · direct |
| Instructions | intent · default draftable, or none | Draft shown in the card; Edit opens a text box · asked inline when there's nothing to draft from |
| Lookup tools | few · low stakes · default safe (all) | Checkboxes in a small form · direct |
| Action tools | permanent effects · reach others · default safe (off) | Off / Look up / Act with its own confirmation · the only friction in the card |
| Skills | vast · undoable · default safe (suggested) | Search-first picker in a small form · direct |

## 13. Open questions

1. **Semantic triggers.** Is a handler a remove? Is a list unbounded? Is a tool call a grant? Decide where force metadata lives so it's written once (REST args, Abilities metadata, MCP annotations).
2. **Thresholds** (5 options, 15 options, 10 inputs, 50 items) are starting points. Make them per-product config and tune from override data.
3. **Recipe ownership.** Who approves recipe version bumps, and how are migration lists assigned?
4. **CI posture.** Should `require` redirects block merges, or only report? For chat: block the send, or rewrite the message?
5. **Entity registry.** Build step vs. on demand; what counts as an entity; the area/entity split past 255 entities.
6. **Direct actions in shared spaces.** Should a direct action post anything visible, or only tell the agent?
7. **Surfaces without UI.** How do these patterns degrade where there are no buttons or forms (P2, email)? Probably a link to a page for anything that needs UI.
8. **Persistence.** Product-level, surface-level, or a per-interaction force?
9. **Action tools.** Does turning one on also need permission in the target system? Does every action tool really separate looking up from acting?

## Appendix: vocabulary

The full force vocabulary and its validation evidence live in `ui-pattern-language-forces.md` (v0.2). The encoded pattern language lives in Loupe's `patterns/index.json` (see `docs/patterns-v2.md`). Use those names when proposing new forces, so the vocabulary stays consistent while the operational set stays small.
