# The overlay, in WordPress

`loupe serve` hands its findings to a page through a bookmarklet. A bookmarklet
injects into the current document only, so on wp-admin — which is a multi-page
app, one full navigation per screen — it is a click per page.

`loupe-overlay.php` is a development mu-plugin that loads the overlay itself, so
it survives navigation. It needs WordPress 6.3 or later, for the `defer` loading
strategy it enqueues the overlay with.

## Install it

With `loupe serve` running, from your project root:

```bash
mkdir -p .loupe/mu-plugins
curl -o .loupe/mu-plugins/loupe-overlay.php http://localhost:7331/loupe-overlay.php
```

Or copy it out of this directory. There is nothing to build and nothing to add
to `composer.json`.

### wp-env

Two entries in `.wp-env.json`:

```json
{
  "mappings": {
    "wp-content/mu-plugins": ".loupe/mu-plugins"
  },
  "config": {
    "LOUPE_OVERLAY_URL": "http://localhost:7331"
  }
}
```

Then `wp-env start` — the constant is read at boot, so an edit made while the
container is up does nothing until it restarts.

Map the **directory**, not the file. Docker cannot bind-mount a single file into
a parent that does not exist in the container, and `wp-content/mu-plugins/`
usually does not. Mapping the directory creates it.

If you already map `wp-content/mu-plugins` somewhere else, drop the file into
that directory instead and leave `mappings` alone.

### Anything else

Drop the file in `wp-content/mu-plugins/` and define the constant in
`wp-config.php`:

```php
define( 'LOUPE_OVERLAY_URL', 'http://localhost:7331' );
```

## Use it

Signed in as an administrator, add `?loupe=1` to any URL once. The overlay stays
until you visit `?loupe=0`.

```
http://localhost:8888/wp-admin/?loupe=1
```

Only a user with the `manage_options` capability — an administrator — can turn
it on or see it. For anyone else `?loupe=1` does nothing and the overlay never
loads, even in a browser that still holds the cookie, so it stays hidden while
you are signed out.

## Why it is off until you ask

The constant alone does not load anything; a cookie has to be set too, and that
is deliberate rather than fussy.

Browser tests usually drive the same WordPress you are looking at. Playwright
pointed at `localhost:8888`, or at a tunnel that forwards to it, reaches the
same container — so an overlay gated only on the constant would sit over every
page of every test run and intercept the clicks the tests are trying to make.
Turning the constant off for a separate `tests` environment does not help when
that is not the environment being driven, and it usually is not.

A cookie is per browser context. A fresh Playwright context does not have it,
and a stored `storageState` only has it if you logged in with the overlay on.

## What it will not do

**Mixed content.** If WordPress is served over HTTPS — a Jurassic Tube or ngrok
tunnel, say — the browser refuses to load `http://localhost:7331/overlay.js`
from it. Use the local `http://` origin, or put `loupe serve` behind the same
kind of tunnel and point the constant at that. Visitors to the tunnelled site
still get nothing — the mu-plugin only loads the overlay for administrators —
but a tunnel to `loupe serve` answers anyone who has its URL, so keep it to
yourself and close it when you are done.

**Pages it cannot see.** The panel is a view of the rendered page: a finding in
an unopened modal or an unrendered branch is listed and resolves to nothing, and
roughly a third of findings — every JSX-anchored rule — carry no selector at
all. They are labelled, never hidden. The terminal stays the complete report.
