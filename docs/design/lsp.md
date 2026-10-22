# The language server

Design notes for `engine/src/lsp.ts` and `editors/vscode/`.

## Why a language server at all

The terminal report is read by whoever ran it. A diagnostic is read by whoever
has the file open — and, in an editor that hosts a coding agent, by the agent
too, without either of them asking for it. That change in *who hears it* is the
whole reason this surface exists; the findings are the same findings.

The audience question was worth checking rather than assuming, because the
obvious plan — "one channel, editor diagnostics, serves humans and agents
alike" — is only half true:

- Humans get diagnostics reliably. A squiggle is a squiggle in every editor.
- Agents get them inconsistently. Claude Code attaches new IDE diagnostics to
  the turn after an edit tool runs, unasked, and also reads them on request
  through `mcp__ide__getDiagnostics`. That is checked against 2.1.276–2.1.278;
  an earlier note here recorded only the request path, so treat the unasked
  half as a moving target. Copilot agent mode does not act on leftover lint
  errors after editing. Cursor's agent does read them. Three tools, three
  behaviours.

So the architecture is one engine with two deliveries: diagnostics for humans,
and a push hook for agents. Loupe already had the second for Claude Code. This
closes the first, and happens to improve the second for any agent whose editor
surfaces diagnostics.

## Why a server rather than a VS Code extension

The protocol is the same everywhere, so the extension beside it is a launcher
with no opinions in it. Zed, Neovim and Helix need no extension at all. Anything
implemented in the extension would be a second answer that only VS Code users
see, and it would drift silently, because both halves look right read on their
own.

This is also why `editors/vscode/extension.js` is under sixty lines and should
stay that way. The question to ask before adding behaviour there is why every
other editor should not have it.

## Why the plugin does not declare it under `lspServers`

A Claude Code plugin can register a language server of its own — `lspServers` in
the manifest, or a `.lsp.json` beside it — and the host genuinely pushes what
that server publishes: it sends `textDocument/didSave` after an edit and
attaches the new diagnostics to the turn without the agent asking. On the face
of it that is this server reaching agents for ten lines of manifest.

It is declined, because four properties of that channel are wrong for these
findings:

- A server owns a file extension. The binding is `extensionToLanguage`, and a
  second claimant is shadowed with a warning telling the user to disable one of
  the two plugins. Loupe claiming `.tsx` competes with whatever reports type
  errors there, and that is not a trade worth putting in front of anyone.
- It cannot block. An attachment is informational, so the `blocking` option, the
  attempt budget and the stand-down have no equivalent — the Stop hook stays
  either way, and the findings then arrive twice.
- An empty publish is dropped. The explicit clear this server sends so a fixed
  file loses its squiggles is the one message the host discards, so the agent
  would be told what is wrong and never told when it is right.
- Repo-wide is the wrong scope for a context window. Publishing the whole
  backlog is right for a Problems panel and ruinous on Gutenberg, where it is
  thousands of findings attached to a single turn.

What is left is the warm process, and that is a property of staying resident
rather than of speaking LSP: a daemon behind the hook would buy it without any
of the above.

`textDocument/codeAction` is not part of the host's client at all, so the quick
fixes below stay a human surface whatever happens here.

## Why on save, not on keystroke

The engine reads the working tree, and the correlation it exists for spans
files — the JSX that binds a class on disk against the CSS that styles it on
disk. Diagnosing an unsaved buffer means threading a buffer overlay through
every read in the analyzer, which is a real refactor bought for a real but
narrow gain.

It is also the wrong trade for half the audience. An agent's every edit *is* a
save, so on-save is not an approximation of the push channel agents need — it is
exactly it.

The cost to a human is that a dirty buffer shows the previous verdict until it
is written. That is the honest failure mode for an on-save gate, and it is
stated in the extension's README rather than hidden.

## Why re-analyze whole, with no incremental index

The obvious objection to on-save analysis is cost, so it was measured rather
than assumed, on 2026-09-21. site-foundry is a private WPDS app, so its row
cannot be rerun from here; the Gutenberg row can:

| | cold, through the CLI | warm, in the server process |
| --- | --- | --- |
| site-foundry (613 files) | 380ms | ~115ms |
| Gutenberg (9,531 files) | 5.9s | ~2.4s |

Keeping the process warm is most of the win on its own — no Node boot, no preset
or profile re-read, the module already JIT'd. Nothing about an incremental index
is needed to make saving feel immediate on anything but the outlier, and an
index with invalidation rules is a second source of truth about what the repo
contains.

This is the same decision `serve` made for the same reason, and it keeps the
same escape hatch: if a Gutenberg-sized repo has to feel instant, split
`analyze` into index and check phases and keep the index warm. Nothing in
`lsp.ts` changes — `run` just gets faster. The `ponytail:` marker in the module
names that ceiling.

## Why diagnostics are published repo-wide

The engine indexes the whole repo regardless of what it reports on, so scoping
the report to open files would throw away work already paid for and make the
Problems panel a view of which tabs happen to be open. Published whole, it is
the backlog — and the count moves when a save fixes something two directories
away, which is the part a single-file linter can never show.

The consequence is that clearing has to be explicit. A client holds the last set
it was sent forever, so every URI that had findings and no longer does needs an
empty publish. Without it a fixed file keeps its squiggles until the editor
restarts, which reads as "the tool is wrong" rather than "the tool is stale".

## Why the quick fix goes through `substituteOnLine`

`loupe fix` and the editor quick fix must write the same bytes. They now share
one function, extracted from `applyTokenFixes` for that purpose. A second
implementation in the server would be a second answer to "what does fixing this
write", and the two would be compared by nobody, since each looks correct read
on its own. `engine/tests/lsp.ts` asserts the agreement against the CLI path
rather than against a fixture string.

A declaration fix is one action for one line, because that is what one is. A
misspelled token is not: `tokens/unknown-token` reports once per file and name,
so its action carries an edit for every line that names it. Offering the line
under the cursor alone would clear one occurrence, leave the file broken and
leave the diagnostic standing — a quick fix that visibly does nothing. Each of
those edits is still the line `substituteOnLine` wrote, so the agreement with
`loupe fix` holds per line as well as in total.

## Why one quick fix has no `loupe fix` behind it

`css/dead-class` offers to delete the rule, and the batch path does not. That
is the one place the two deliberately write different bytes, and the reasoning
is in [deleting is the editor's
alone](report.md#deleting-is-the-editors-alone): a deletion cannot be checked
against what replaced it, and this check over-collects references precisely
because a false "dead" is its expensive failure. The editor is where a person
sees the rule before accepting it; `loupe fix` is where nobody does.

It is not marked `isPreferred`, unlike the substitutions — the action a client
may apply on its own is not the one that removes code. The rule's own
suppression action stays beside it, which is the answer for the case where the
class is live and the index simply could not see it.

Refusals are silent here, on purpose. Where the rule cannot be removed on its
own — a selector list with a live class in it, the only child of an `@media`, a
minified line, a class several rules declare — the finding is published with no
delete action and nothing says why. A missing quick fix is invisible; a wrong
one deletes code.

## Why the suppress quick fix leaves the reason blank

A directive with no reason does not mute — `suppressions.ts` reports it as
`suppression/malformed`, an error. So taking the action trades a finding for a
louder one that clears only once somebody writes down why.

That is deliberate and it is the whole point of the grammar. A quick fix that
pre-filled the reason would be the one available route to a signed-off silence
nobody signed off on, and one-click convenience is exactly the pressure the
severity inversion exists to resist.

## Why text is tracked for open documents

Findings come from disk, but ranges must be valid against what the editor holds.
A range past the end of its line is rejected by the client, and a rejected range
takes its diagnostic with it — silently. Tracking open buffers with full sync is
what keeps a diagnostic from disappearing because somebody shortened a line
without saving.

Full sync rather than incremental: patching ranges would be bookkeeping in
exchange for nothing, given the findings themselves only move on save.

## Framing

The JSON-RPC header counts *bytes*, not characters. Slicing the buffer before
decoding is what keeps a multi-byte character straddling a chunk boundary from
truncating a message. Decoding first and counting string length is the classic
way to lose one message in a thousand — on exactly the files whose content is
not ASCII. `engine/tests/lsp.ts` drives a real server over a real pipe with a
split message and a multi-byte body, because framing and dispatch are where a
protocol implementation actually breaks.

## Why stdout is protocol-only

Anything but a framed message on stdout desynchronizes the peer. The `lsp`
command therefore runs before any reporting path in `cli.ts` can print, and
everything the server has to say — a failed analysis, an unreadable baseline —
goes to stderr, which the extension surfaces as the **Loupe** output channel.
A failed analysis deliberately leaves the last good diagnostics standing rather
than clearing them: a clean workspace is the one thing a failure must not look
like.
