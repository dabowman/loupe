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
ln -s ~/.claude/plugins/<marketplace>/loupe/bin/loupe ~/.local/bin/loupe
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
code --install-extension loupe-vscode-0.7.0.vsix
```

Cursor and Windsurf are VS Code forks — the same `.vsix` installs with
`cursor --install-extension`.

To work on it instead, open `editors/vscode` in VS Code and press F5.

## What it does

| | |
| --- | --- |
| **Problems panel** | Every finding in the repo, not only the open files. The count moves when a save fixes something two directories away. |
| **Hover** | The rule's guidance — the part the terminal report prints once per group, which is also the part a linter does not give you. |
| **Quick fix** | Where the engine settled the answer on its own, the substitution `loupe fix` would write, byte for byte. It is the same function. |
| **Quick fix** | Suppress this finding — with the reason left blank, on purpose. See below. |

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
