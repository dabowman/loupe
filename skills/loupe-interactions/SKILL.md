---
name: loupe-interactions
description: >-
  Load BEFORE deciding how an agent or a UI should handle a person's request: whether to answer, ask a question, or show UI; which control to use (buttons, picker, checkboxes, form, confirmation, undo); whether a control calls the API directly or asks the agent to act; and how much checking a surface needs. Carries Interaction Redirects, Loupe's framework for interaction-pattern choice: triggers, deciding forces (cardinality, reversibility, reach, stakes, judgment, default and others), first-match decision tables, recipes, the assurance ladder from a system prompt up to review gates, and the rules for compound interactions such as setup flows. Includes a Slack Block Kit profile for chat agents. Triggers on "should this be a modal", "confirm or undo", "dropdown or radios", "how should the agent ask", "what UI should the bot show", "Slack interaction design", "agent UX", "chat UI pattern", "setup flow", "settings in chat", "pattern brief", "interaction redirect", or any design review of how a person and an agent hand work back and forth. Pair with `loupe-patterns` once a composite is chosen and `loupe-authoring` when writing the code.
compatibility: "Any surface: generated UI code, chat agents (Slack profile included), settings pages, agent tool use."
---

# Interaction redirects

Loupe's other skills keep UI on its design system. This one decides *which*
interaction to build before any of that: answer, ask, or show UI; which
control; who acts; and how hard to check the result.

The full spec is in `references/interaction-redirects.md`. The Slack surface
lives in `references/slack-profile.md`. Read the spec before applying it; this
page is only the order of work.

## How to use this

1. **Name the surface.** Conversation, interactive chat UI, saved settings, or
   tool use in another system. That sets Persistence and the default rungs
   (spec §3). Load the matching component profile (Slack: `slack-profile.md`;
   code: the active Loupe profile from `loupe status`).
2. **Screen for triggers.** Run the Stage 1 questions (spec §10). Most requests
   fire none or one or two. Nothing fires without a trigger, and no trigger
   means no brief.
3. **Resolve only the deciding forces** each fired redirect lists, in order:
   metadata → telemetry → judgment (Jev) → the spec's conservative default. A
   redirect whose forces fell back to defaults may suggest, never require.
4. **Decide.**
   - Shape, with Rule 1 (spec §4): answer, confirm, show UI, or ask.
   - The control: the redirect's decision table, mapped through the profile.
   - Who acts, with Rule 3: through the agent, direct, or propose-then-apply.
   - If the request bundles several decisions, apply the compound rules
     (spec §5) first: the whole sets the container, each item sets its control.
5. **Write the pattern brief:** one entry per redirect that didn't end in
   `keep`, each with its `because` line, so a reviewer can correct an input
   rather than argue with the output.
6. **Pick the rung.** How far up the assurance ladder this needs (spec §3):
   brief only, a template, an audit, a gate, or a person.

Always apply the never-break rules (spec §4, Rule 3). The most important: the
agent never applies a change to access or permissions itself.

## Refining the framework

The spec is versioned. When a decision here exposes a gap (a missing force, a
wrong row, a new redirect), edit `references/interaction-redirects.md`:

- Add a force only when a redirect needs it (spec §6).
- A new redirect needs a cheap trigger, at most three deciding forces, a `keep`
  row, and evidence (spec §11).
- Record the change in the "What changed" list at the top and bump the
  version.
- Put a new worked example under spec §12 if it settled something non-obvious.
