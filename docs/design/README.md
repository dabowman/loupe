# Design notes

Why the engine is the way it is: alternatives considered, thresholds justified,
measurements, and the war stories behind a guard that looks arbitrary.

It lives here rather than in the code because a reader of a function needs to
know what it does, not how it came to do it. A module whose reasoning moved out
carries a one-line `Design notes: docs/design/<file>.md` pointer, and a
rationale worth keeping goes under a heading that pointer can name by anchor.

Never delete a rationale to shorten a comment — move it.

| | |
| --- | --- |
| [`lsp.md`](lsp.md) | The language server: on-save, repo-wide diagnostics, quick fixes shared with `loupe fix`, framing |
