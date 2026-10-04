/**
 * `loupe serve` — the findings, in the running app.
 *
 * Every other output here answers "where in the source". This one answers what
 * the source cannot: *which rendered elements* a finding lands on. A stylesheet
 * finding carries the selector of the rule it sits in, and a selector is a DOM
 * query, so the browser can resolve one finding to the live elements it affects.
 *
 * Three decisions follow, and they are the design:
 *
 * 1. It serves, it does not integrate — a stdlib HTTP server, permissive CORS,
 *    and a bookmarklet. Nothing to install in the app, no bundler config.
 * 2. Re-analyze per request. No watcher, no cache, no invalidation rules to get
 *    wrong.
 * 3. The panel says what it cannot see. A finding matching nothing on this page,
 *    one behind an unsatisfied `@media`, and one with no selector are all shown,
 *    and all three are labelled with which they are.
 *
 * Design notes: docs/design/report.md#loupe-serve
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportPayload } from './report.ts';
import { messageOf } from './text.ts';
import type { AnalyzeResult, BaselinedResult, Config } from './types.ts';

/**
 * The WordPress mu-plugin, served so it can be installed with `curl`.
 *
 * A bookmarklet is one click per navigation, which in wp-admin is every screen.
 * The file that fixes that ships with the plugin — but under an install path
 * nobody knows by heart, so the server that is already running hands it over.
 *
 * ponytail: read from disk, so a single-file binary serves 404 here rather than
 * the file. Embedding it needs a text loader in the bundler; do that if anyone
 * ever installs a WordPress mu-plugin from a CI binary.
 */
const MU_PLUGIN = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'integrations',
	'wordpress',
	'loupe-overlay.php',
);

/**
 * Panel chrome. Lives in a shadow root, so this is the entire cascade it is ever
 * exposed to — no resets, no specificity games against the host app's
 * stylesheet, which in wp-admin is considerable.
 */
const CSS = `
:host { all: initial }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
.panel {
  position: fixed; top: 16px; right: 16px; width: 380px; max-height: calc(100vh - 32px);
  display: flex; flex-direction: column; pointer-events: auto;
  background: #16161a; color: #e8e8ea; border: 1px solid #2c2c33; border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.45); font-size: 12px; line-height: 1.45;
}
.panel.min { max-height: none }
.panel.min .body, .panel.min .search { display: none }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2c2c33 }
.title { font-weight: 600; letter-spacing: .04em; text-transform: uppercase; font-size: 11px; color: #9a9aa4 }
.count { color: #ff6b6b } .count.warn { color: #e2b341 } .count.ok { color: #4ec9a5 }
.grow { flex: 1 }
button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 4px; color: #9a9aa4; font-size: 11px }
button:hover { background: #26262d; color: #e8e8ea }
.search { padding: 8px 12px; border-bottom: 1px solid #2c2c33 }
input { all: unset; width: 100%; padding: 5px 8px; background: #0f0f12; border: 1px solid #2c2c33; border-radius: 5px; color: #e8e8ea; font-size: 12px }
.body { overflow: auto; padding: 4px 0 }
.row { padding: 7px 12px; border-left: 2px solid transparent; cursor: pointer }
.row:hover { background: #1d1d22 }
.row.on { background: #1d1d22; border-left-color: #4ec9a5 }
.row.dead { opacity: .5 }
.row.offwidth { opacity: .78 }
.row.nodom { opacity: .62; cursor: default }
.rule { color: #7aa2f7; font-size: 11px }
.sev { color: #ff6b6b } .sev.warn { color: #e2b341 }
.msg { color: #e8e8ea; word-break: break-word; margin: 1px 0 }
.meta { color: #6b6b76; font-size: 11px; display: flex; gap: 6px; flex-wrap: wrap }
.hits { color: #4ec9a5 } .hits.zero { color: #6b6b76 }
.cond { color: #8d7bb8 } .cond.on { color: #6b6b76 }
.empty { padding: 20px 12px; color: #6b6b76; text-align: center }
.note { padding: 8px 12px; color: #6b6b76; border-top: 1px solid #2c2c33; font-size: 11px }
.marks { position: fixed; inset: 0; pointer-events: none }
.mark { position: absolute; border: 2px solid #4ec9a5; background: rgba(78,201,165,.14); border-radius: 2px }
.tag {
  position: absolute; top: -18px; left: -2px; background: #4ec9a5; color: #06231c;
  font: 600 10px ui-monospace, Menlo, monospace; padding: 1px 5px; border-radius: 3px; white-space: nowrap;
}
`;

/**
 * The client. ES5 and free of template literals on purpose: it is embedded in a
 * template literal, and a client that cannot contain a backtick is one nobody
 * has to escape correctly forever.
 */
const JS = `
(function () {
  if (window.__loupe) { window.__loupe.toggle(); return; }
  var ORIGIN = '__ORIGIN__';
  var host = document.createElement('div');
  host.setAttribute('data-loupe-overlay', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  var root = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = __CSS__;
  root.appendChild(style);
  var marks = document.createElement('div');
  marks.className = 'marks';
  var panel = document.createElement('div');
  panel.className = 'panel';
  root.appendChild(marks);
  root.appendChild(panel);
  document.body.appendChild(host);

  var data = null, pinned = null, q = '';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A selector as authored is not always one the DOM will accept, and one bad one
  // must not take the panel down. Pseudo-elements have no node to match, and a
  // state pseudo-class says when a rule applies, not what to.
  //
  // The trailing lookahead, not \b: a word boundary sits happily between 'focus'
  // and the '-' of ':focus-visible', so \b would leave '-visible' welded to the
  // class before it — a valid selector for an element that does not exist.
  var STATE = /:(?:hover|focus-within|focus-visible|focus|active|visited|target|checked|disabled|enabled|indeterminate|placeholder-shown|autofill|default|read-only|read-write|link|any-link|user-invalid|user-valid|valid|invalid|required|optional)(?![\\w-])/g;
  function domSelector(sel) {
    var parts = String(sel).split(',').map(function (s) {
      return s.replace(/::[a-zA-Z-]+(\\([^)]*\\))?/g, '').replace(STATE, '').trim();
    }).filter(Boolean);
    return parts.join(', ');
  }
  function match(f) {
    if (!f.selector) return null;
    var sel = domSelector(f.selector);
    if (!sel) return [];
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) {
        return !host.contains(el) && el !== host;
      });
    } catch (e) { return []; }
  }

  function draw(els) {
    marks.innerHTML = '';
    if (!els || !els.length) return;
    els.forEach(function (el, i) {
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      var box = document.createElement('div');
      box.className = 'mark';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      if (i === 0) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
        box.appendChild(tag);
      }
      marks.appendChild(box);
    });
  }

  // Whether the rule's own @media condition holds at this moment. An unparseable
  // query normalizes to 'not all', which never matches, so an unreadable
  // condition is treated as no condition.
  function active(f) {
    if (!f.media) return true;
    try {
      var mq = window.matchMedia(f.media);
      if (mq.media === 'not all' && f.media.indexOf('not all') === -1) return true;
      return mq.matches;
    } catch (e) { return true; }
  }

  // Ordering is the panel's one opinion: what this page can actually show you
  // comes first, then what is real but not visible at this width, then what
  // resolves to nothing, then what was never a browser question.
  function rows() {
    var needle = q.toLowerCase();
    return data.findings.map(function (f) {
      var els = match(f);
      return { f: f, els: els, n: els ? els.length : -1, on: active(f) };
    }).filter(function (r) {
      if (!needle) return true;
      return (r.f.file + ' ' + r.f.message + ' ' + r.f.rule).toLowerCase().indexOf(needle) !== -1;
    }).sort(function (a, b) {
      var ga = a.n > 0 ? (a.on ? 0 : 1) : a.n === 0 ? 2 : 3;
      var gb = b.n > 0 ? (b.on ? 0 : 1) : b.n === 0 ? 2 : 3;
      if (ga !== gb) return ga - gb;
      if (a.f.severity !== b.f.severity) return a.f.severity === 'error' ? -1 : 1;
      return b.n - a.n;
    });
  }

  function render() {
    if (!data) { panel.innerHTML = '<div class="head"><span class="title">loupe</span></div><div class="empty">Loading\\u2026</div>'; return; }
    var rs = rows();
    var live = rs.filter(function (r) { return r.n > 0 && r.on; }).length;
    var offwidth = rs.filter(function (r) { return r.n > 0 && !r.on; }).length;
    var s = data.summary;
    var cls = s.error ? 'count' : s.warn ? 'count warn' : 'count ok';
    var head =
      '<div class="head">' +
        '<span class="title">loupe</span>' +
        '<span class="' + cls + '">' + s.error + ' error \\u00b7 ' + s.warn + ' warn</span>' +
        '<span class="grow"></span>' +
        '<button data-act="refresh">refresh</button>' +
        '<button data-act="min">\\u2013</button>' +
        '<button data-act="close">\\u00d7</button>' +
      '</div>' +
      '<div class="search"><input placeholder="filter\\u2026" value="' + esc(q) + '"></div>';
    var body = rs.length
      ? rs.map(function (r, i) {
          var f = r.f;
          var k = r.n > 0 ? (r.on ? '' : ' offwidth') : r.n === 0 ? ' dead' : ' nodom';
          var hit = r.n > 0
            ? '<span class="hits' + (r.on ? '' : ' zero') + '">' + r.n + ' on page</span>'
            : r.n === 0
              ? '<span class="hits zero">0 on page</span>'
              : '<span class="hits zero">no selector</span>';
          // Shown whenever there is one, not only when it fails: "styling these
          // three elements, and only under this query" is a different fact from
          // "styling these three elements".
          var cond = f.media
            ? '<span class="cond' + (r.on ? ' on' : '') + '">@media ' + esc(f.media) +
              (r.on ? '' : ' \\u2014 not at this width') + '</span>'
            : '';
          return '<div class="row' + k + (pinned === i ? ' on' : '') + '" data-i="' + i + '">' +
            '<div><span class="sev ' + (f.severity === 'warn' ? 'warn' : '') + '">' +
              (f.severity === 'error' ? '\\u2717' : '\\u2022') + '</span> ' +
              '<span class="rule">' + esc(f.rule) + '</span></div>' +
            '<div class="msg">' + esc(f.message) + '</div>' +
            '<div class="meta"><span>' + esc(f.file) + ':' + f.line + '</span>' + hit + cond + '</div>' +
          '</div>';
        }).join('')
      : '<div class="empty">No findings match.</div>';
    var note = '<div class="note">' + live + ' of ' + rs.length + ' are styling elements here' +
      (offwidth ? ', ' + offwidth + ' more only at another width' : '') +
      '. The rest are in source this page does not render \\u2014 the terminal still has them all.</div>';
    panel.innerHTML = head + '<div class="body">' + body + '</div>' + note;

    panel.querySelectorAll('button').forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute('data-act');
        if (a === 'close') { destroy(); }
        else if (a === 'min') { panel.classList.toggle('min'); }
        else { load(); }
      };
    });
    var input = panel.querySelector('input');
    if (input) {
      input.oninput = function () { q = input.value; pinned = null; render(); input.focus(); };
      if (q) { input.focus(); input.setSelectionRange(q.length, q.length); }
    }
    panel.querySelectorAll('.row').forEach(function (el) {
      var i = Number(el.getAttribute('data-i'));
      el.onmouseenter = function () { if (pinned === null) draw(rs[i].els); };
      el.onmouseleave = function () { if (pinned === null) draw(null); };
      el.onclick = function () {
        if (!rs[i].els || !rs[i].els.length) return;
        pinned = pinned === i ? null : i;
        draw(pinned === null ? null : rs[i].els);
        if (pinned !== null) rs[i].els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
        render();
      };
    });
  }

  function reposition() { if (pinned !== null) { var rs = rows(); if (rs[pinned]) draw(rs[pinned].els); } }
  // A resize changes the answers themselves: crossing a breakpoint turns findings
  // on and off, so the boxes move *and* the list is restated. Debounced, because
  // a drag fires this continuously and each render re-runs every selector.
  var resizeTimer = null;
  function onResize() {
    reposition();
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = null; if (data) render(); }, 150);
  }
  function load() {
    fetch(ORIGIN + '/findings.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { data = j; pinned = null; render(); })
      .catch(function (e) {
        panel.innerHTML = '<div class="head"><span class="title">loupe</span></div><div class="empty">' +
          esc(String(e && e.message || e)) + '<br>Is \\u0060loupe serve\\u0060 still running?</div>';
      });
  }
  function destroy() {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', onResize);
    if (resizeTimer) clearTimeout(resizeTimer);
    host.remove();
    delete window.__loupe;
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', onResize);
  window.__loupe = { reload: load, destroy: destroy, toggle: function () { panel.classList.toggle('min'); } };
  render();
  load();
})();
`;

/** The landing page: how to get the overlay into a page this server does not control. */
const INDEX = (origin: string): string => `<!doctype html><meta charset="utf-8">
<title>loupe serve</title>
<style>
  body { font: 14px/1.6 ui-monospace, Menlo, monospace; background: #16161a; color: #e8e8ea; margin: 0; padding: 48px 32px; }
  main { max-width: 760px; margin: 0 auto }
  h1 { font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: #9a9aa4; font-weight: 600 }
  a.bm { display: inline-block; background: #4ec9a5; color: #06231c; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: 600 }
  code, pre { background: #0f0f12; border: 1px solid #2c2c33; border-radius: 6px }
  code { padding: 2px 6px } pre { padding: 12px; overflow: auto }
  p { color: #b6b6bd } .dim { color: #6b6b76 }
</style>
<main>
<h1>loupe serve</h1>
<p>Drag this to your bookmarks bar, then click it on any page of the app you are developing:</p>
<p><a class="bm" href="javascript:(function(){var s=document.createElement('script');s.src='${origin}/overlay.js?'+Date.now();document.body.appendChild(s);})();">loupe</a></p>
<p>Or paste this once in the devtools console of that page:</p>
<pre>fetch('${origin}/overlay.js').then(r=&gt;r.text()).then(eval)</pre>
<p class="dim">The panel lists every finding. The ones with a CSS selector resolve to the
elements they actually style on the page you are looking at &mdash; hover to outline them, click to pin
and scroll. Findings in source this page does not render, and every JSX-anchored rule, are listed but
cannot be located; the terminal remains the complete report.</p>
<h1 style="margin-top:36px">WordPress</h1>
<p>wp-admin is a full navigation per screen, so the bookmarklet is a click per page. This loads the
overlay itself &mdash; from your project root, with this server running:</p>
<pre>mkdir -p .loupe/mu-plugins
curl -o .loupe/mu-plugins/loupe-overlay.php ${origin}/loupe-overlay.php</pre>
<p>Then in <code>.wp-env.json</code>, and restart:</p>
<pre>"mappings": { "wp-content/mu-plugins": ".loupe/mu-plugins" },
"config":   { "LOUPE_OVERLAY_URL": "${origin}" }</pre>
<p>Visit any page with <code>?loupe=1</code> to turn it on, <code>?loupe=0</code> to turn it off.
It is off until you ask because browser tests usually drive the same WordPress you are looking at,
and a panel over every page eats their clicks.</p>
<p class="dim">Endpoints: <code>/findings.json</code> &middot; <code>/overlay.js</code> &middot; <code>/loupe-overlay.php</code></p>
</main>`;

/**
 * Start the server. Resolves once it is listening, with the URL it actually
 * bound and a way to stop it; the CLI then simply never stops it, which is what
 * a dev-loop server is for.
 */
export function serve(opts: {
	port: number;
	config: Config;
	run: () => Promise<AnalyzeResult | BaselinedResult>;
}): Promise<{ url: string; close: () => Promise<void> }> {
	const { port, config, run } = opts;
	// The client is served from this origin and fetches from it, so it is told its
	// own address — `document.currentScript` is null once the script has been
	// `eval`'d from the console.
	const client = (origin: string): string => JS.replace('__ORIGIN__', origin).replace('__CSS__', JSON.stringify(CSS));
	// Read back from the socket rather than trusting the request: `--port 0` asks
	// the OS to choose.
	let url = `http://localhost:${port}`;

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const origin = url;
			// The app under inspection is on another port, and in wp-env another host
			// entirely. The permissive header is the feature, not an oversight.
			res.setHeader('access-control-allow-origin', '*');
			const path = (req.url ?? '/').split('?')[0];

			if (path === '/overlay.js') {
				res.setHeader('content-type', 'text/javascript; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				res.end(client(origin));
				return;
			}
			if (path === '/findings.json') {
				run()
					.then((result) => {
						res.setHeader('content-type', 'application/json; charset=utf-8');
						res.setHeader('cache-control', 'no-store');
						res.end(JSON.stringify(reportPayload(result, config)));
					})
					.catch((err: unknown) => {
						// A failed analysis must not read as a clean page. The client
						// shows the message; the status keeps it out of `.json()`.
						res.statusCode = 500;
						res.setHeader('content-type', 'application/json; charset=utf-8');
						res.end(JSON.stringify({ error: messageOf(err) }));
					});
				return;
			}
			if (path === '/loupe-overlay.php') {
				let php: string;
				try {
					php = readFileSync(MU_PLUGIN, 'utf8');
				} catch {
					res.statusCode = 404;
					res.end(
						'loupe: the WordPress mu-plugin is not readable from this build — copy it from integrations/wordpress/.\n',
					);
					return;
				}
				// text/plain, not application/x-httpd-php: this is handed to `curl -o`
				// and to people reading it, and nothing here should tempt a browser
				// into treating it as anything but bytes.
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.setHeader('cache-control', 'no-store');
				res.end(php);
				return;
			}
			if (path === '/') {
				res.setHeader('content-type', 'text/html; charset=utf-8');
				res.end(INDEX(origin));
				return;
			}
			res.statusCode = 404;
			res.end('not found');
		});
		server.on('error', reject);
		server.listen(port, () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') url = `http://localhost:${addr.port}`;
			resolve({
				url,
				close: () =>
					new Promise((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}
