# Slack component profile (`slack-block-kit`)

The surface half of Interaction Redirects for agents that work in Slack. Read `interaction-redirects.md` first: it holds the forces, redirects and rules. This file says how their recipes are built from Slack's own parts, and what Slack won't let you do.

```yaml
component_profile: slack-block-kit
audience: internal
persistence: interaction        # an agent changing its own settings is shared-state; acting elsewhere is other-systems
```

## Platform constraints

These become recipe `requires` / `forbids` lines, so a recipe can't ask for something Slack can't do.

- **A modal only opens from a click.** `views.open` needs a `trigger_id` from a button, shortcut or slash command. An agent can offer a form; it can't open one unprompted.
- **Modals stack at most three views** (`views.push`). Prefer `views.update` within one view over deeper stacks.
- **Ephemeral messages are temporary.** They disappear on reload and can't hold a thread. Use them for one-step offers and private status; use the DM for anything with more than one step or that must survive a reload.
- **Messages update in place** (`chat.update`), so one message can carry progress or reflect a draft without new posts.
- **Buttons are visible to everyone who can see the message.** Check permission on click, or send the control privately to the people who can use it. Never show a control that won't work for the viewer.
- **App Home** is the persistent place to browse or come back to; a **canvas** is for reading, and editing one shouldn't change settings.

## Element mapping

| Recipe atom | Block Kit element | Use for |
|---|---|---|
| Button (primary / danger + `confirm`) | `button` | Yes / no, up to 5 next steps, Apply, Undo |
| Entity picker | `users_select`, `conversations_select`, `external_select` | People, channels, anything searched from another system (Matticspace groups, a skills directory) |
| Multi entity picker | `multi_users_select`, `multi_external_select` | Several from a large or growing set |
| Checkbox group | `checkboxes` | Several from up to about 10 |
| Segmented / radio group | `radio_buttons`, or a short row of buttons in a message | One of a few modes with consequences (Off / Look up / Act) |
| Select | `static_select` | One of many, known and bounded |
| Text input | `plain_text_input` (`multiline` for long text) | Text the person will own; prefill with a draft |
| Date / time | `datepicker`, `timepicker` | Dates for scheduling; keep text entry as an alternative |
| Form | modal (`views.open`, `views.update`) | One section of a larger change; keep each modal to one job |
| Status or settings view | Message with a View button; App Home | Seeing what's on without making a request |
| Progress | `chat.update` on one message; details in its thread | Work longer than a few seconds |
| Private note | `chat.postEphemeral` | Offers and status for one person |
| Channel note | `chat.postMessage` | Changes that affect everyone in the channel |

## Recipes in Slack terms

| Recipe | Built as | Wiring |
|---|---|---|
| **undo-toast** | A short channel note naming the change, who made it, and anything that stops working, with an Undo button | direct |
| **confirm-dialog** | A card stating what will happen and who will see it; primary button names the action, plus Cancel; `danger` + `confirm` when it can't be undone | direct |
| **proposal card** (compound) | A private card with one section per item, defaults filled in, a button per section that opens a small modal, and one Apply. Edits update the card in place; conversation edits the same draft | propose |
| **status card** | A private card listing what's on, grouped by what matters (e.g. "Can look things up in" / "Can act in"), with per-row controls only for people who can use them | direct |
| **entity question** | The question plus a picker or up to 5 buttons, never a prose list | direct, or agent when the choice needs judgment |
| **access-explainer** | Says what's missing and who can change it, with "Ask a manager" when a request flow exists | agent |
| **access-change proposal** (C3) | A private card: "Let Iris do X here? Anyone in the channel will be able to ask for it. What it does stays done." Buttons apply under the clicker's own permissions | propose |
| **progress in place** | One message updated as work proceeds; steps in its thread; a final update with the result | agent |
| **suggested replies** | 2–4 buttons under an agent message; a click posts as the person's reply so the thread still reads as a conversation | agent |

## Surface split with MC (or any settings page)

The same API behind both surfaces; each gets the modes it's good at.

| Mode | Slack | MC |
|---|---|---|
| Lookup ("turn on PR review") | Conversation plus a picker when ambiguous | Search |
| Audit ("what's on here?") | Private status card | Sortable table |
| Browse a vast set | Hand off with a link | Search-first table with filters |
| Batch at setup | Proposal card | Sectioned page |

Every change posts the same channel note, wherever it was made.

## Prototype

`iris-lightning-week.space.fast/iris-channel-setup.html` builds these recipes in a Slack mock, with a side panel naming the redirect or rule behind every step. `chat-interaction-patterns.html` beside it has an interactive version of Rule 1.
