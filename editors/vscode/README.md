# Loupe for VS Code

Design-system conformance in the editor: findings in the Problems panel and the
gutter, the rule's guidance on hover, and its fix as a quick fix.

It is a launcher for `loupe lsp`. Everything it shows is decided by the engine,
which is the same engine the CLI, the hooks and CI run — so the editor cannot
tell you something `loupe check` would not.

## Install

Loupe itself has to be reachable first. From a checkout or a marketplace
install:

```bash
ln -s "$(pwd)/bin/loupe" ~/.local/bin/loupe        # from a checkout
ln -s ~/.claude/plugins/marketplaces/loupe/bin/loupe ~/.local/bin/loupe
```

Use `bin/loupe`, not `engine/bin/loupe.mjs` — the shim is what passes the
shipped design-system profiles, and without them the component and composite
rules are silently off. If you would rather not touch your PATH, set
`loupe.path` to that file instead.

Then the extension:

```bash
cd editors/vscode
npm install
npx @vscode/vsce package
code --install-extension loupe-vscode-*.vsix   # * is the version in package.json
```

Cursor and Windsurf are VS Code forks — the same `.vsix` installs with
`cursor --install-extension`.

## Trying it without installing

`npm install` here, then open **this directory** as the VS Code window root —
not the repository root, or F5 finds no launch configuration — and press F5.
A second window opens with the extension loaded; open a project that uses a
design system in it and save a file.

The server it spawns is whatever `loupe` resolves to, and a checkout with its
dependencies installed runs from `engine/src/` rather than the bundle. So an
edit to `engine/src/lsp.ts` is live on the next **Loupe: Restart Language
Server** — no rebuild.

## What it does

| | |
| --- | --- |
| **Problems panel** | Every finding in the repo, not only the open files. The count moves when a save fixes something two directories away. |
| **Hover** | The rule's guidance — the part the terminal report prints once per group, which is also the part a linter does not give you. |
| **Quick fix** | Where the engine settled the answer on its own, the substitution `loupe fix` would write, byte for byte. It is the same function. |
| **Quick fix** | Suppress this finding — with the reason left blank, on purpose. See below. |
| **Quick fix** | For `css/dead-class`, delete the rule — offered here and never by `loupe fix`. See below. |

## Two things worth knowing

**It reports on save, not as you type.** The engine reads the working tree and
correlates across files — the JSX binding a class against the CSS styling it —
so an unsaved buffer would be a verdict on a tree that does not exist. A dirty
file shows the last saved verdict until you write it.

**The suppress quick fix leaves the reason empty.** That is not an oversight:
a directive with no reason does not silence anything, it reports as
`suppression/malformed`, an error. So taking that action trades a finding for a
louder one that goes away only once you write down why. A quick fix that filled
the reason in for you would be the one way to get a signed-off silence nobody
signed off on.

**Deleting a dead rule is offered in the editor and nowhere else.** `loupe fix`
substitutes values; it will not delete a rule, because a deletion leaves nothing
to compare against afterwards and the reference index behind `css/dead-class`
over-collects on purpose — a false "referenced" costs one missed finding, a
false "dead" deletes live CSS. That trade is priced for someone looking at the
rule, which is what the editor is and a batch pass is not. Where the rule cannot
be removed cleanly — a selector list that also styles a live class, the only
rule inside an `@media`, a class several rules declare — no action is offered
and nothing says why, which is the safe direction for it to fail in.

## Settings

| | |
| --- | --- |
| `loupe.path` | The executable. Default `loupe`, resolved on PATH. |
| `loupe.enable` | Off turns the server off for the workspace. |

`Loupe: Restart Language Server` is in the command palette. Server-side
problems — a failed analysis, an unreadable baseline — go to the **Loupe**
output channel.

## Other editors

There is no extension to install. Point the editor at `loupe lsp`:

```lua
-- Neovim
vim.lsp.config.loupe = {
  cmd = { 'loupe', 'lsp' },
  root_markers = { 'loupe.config.json', '.git' },
  filetypes = { 'css', 'scss', 'less', 'javascriptreact', 'typescriptreact', 'javascript', 'typescript' },
}
vim.lsp.enable('loupe')
```

Zed and Helix take the same command in their own configuration.
