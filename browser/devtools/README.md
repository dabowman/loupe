# Loupe for DevTools

Design-system conformance in the browser's own inspector. Two surfaces:

**The Loupe panel** — every finding, resolved against the page in front of you.
Each row says how many elements it currently styles and, where the rule sits
under an `@media` query, whether that query holds at the width you are at.
Hover to outline; click to pin and scroll to the first.

**The Loupe pane in Elements** — select a node, see the findings that style
*that node*. Every other output loupe has starts from the findings and asks
where they are. This asks the other question, which is the one you actually have
when you are already looking at the thing that seems wrong.

## Install

Unpacked, for now — it is not in any store.

```bash
node browser/devtools/build.mjs        # generate vendor/match.js
```

Then in Chrome or any Chromium browser: `chrome://extensions` → **Developer
mode** on → **Load unpacked** → pick `browser/devtools/`.

Open DevTools on the app you are developing. The extension reads a `loupe serve`
running against that app's project:

```bash
loupe serve                            # port 7331
```

If yours is on another port, type it in the panel's **port** box; both surfaces
share it.

## Why `serve` and not `ui`

`loupe serve` is read-only and publishes to any origin, because being read from
somewhere else is its entire purpose. `loupe ui` writes to your source files, so
it binds loopback and answers only the page it served — an extension cannot
reach it, and that is deliberate rather than an oversight.

So this is a reading surface. To fix something from a page, use `loupe ui`.

## What it can and cannot see

The same two limits the injected overlay has, and they matter as much here:

- **It can only see the page you are on.** A finding in an unopened modal, an
  unrendered branch or an error state resolves to nothing. It is still real.
- **Roughly a third of findings have no selector at all** — every JSX-anchored
  rule, `system/raw-element` most of all. The panel lists them and labels them;
  the Elements pane can never show them, because there is no selector to match
  against a node.

The panel's footer says how much of the report the current page accounts for,
for exactly this reason. The terminal remains the complete report.

## Development

```
manifest.json      MV3, devtools_page only — no content script, no background
devtools.js        registers the panel and the Elements pane, and nothing else
panel.js           the findings list, resolved against the page
sidebar.js         the inversion: findings for the selected node
common.js/.css     the connection, and chrome that follows the DevTools theme
vendor/match.js    GENERATED — do not edit
```

`vendor/match.js` is generated from `engine/src/dom-match.ts`, which is the one
answer to "does this rule reach anything on screen" and is shared with the
overlay `loupe serve` injects. Two copies of it would be two answers, and the
disagreement would be invisible — both would highlight *something* plausible.

The extension carries a copy rather than fetching it because Manifest V3
prohibits remote code, and an extension that downloaded and evaluated a script
would deserve to be rejected. Regenerate after any change to the matcher:

```bash
node browser/devtools/build.mjs           # write it
node browser/devtools/build.mjs --check   # what CI runs
```

`engine/tests/dom-match.ts` covers the matcher itself and is in `npm test`.
The surfaces are driven end-to-end by:

```bash
node browser/devtools/check.mjs
```

which starts a `loupe serve` over a throwaway project, loads both panes against
a real page with `chrome.devtools` shimmed onto it, and asserts on what they
render. It needs Playwright, which this repo deliberately does not depend on —
nothing else here needs a browser — so it is not part of `npm test`. Run it when
you change the matcher or either pane.

Firefox implements `devtools_page`, `inspectedWindow.eval` and
`createSidebarPane` compatibly enough that this should load there; it has not
been tried.
