/**
 * The view both HTML surfaces render: the static report and `loupe ui`.
 *
 * It lives apart from either host because the alternative was two of it. The
 * report is an artifact — a file, taken once, that a reader opens later — and
 * the UI is a window on a working tree. They differ in where the payload comes
 * from and in what a reader may do with a row, and in nothing else. Every count,
 * every rollup, every grouping and every sort is one implementation here, so the
 * page a reader triages from and the file they attach to a ticket cannot
 * disagree about what is wrong with the project.
 *
 * The seam is `window.__loupe`, read once as `HOST`:
 *
 *   absent   the artifact. LIVE is false, the payload comes from the embedded
 *            `<script type="application/json">`, and rows carry no actions. The
 *            page renders exactly what `--format html` has always rendered; what
 *            it adds is inert — `data-when` hooks the live host toggles, and the
 *            unexercised half of each branch, sitting in the script text.
 *   present  the live host. It fetches, calls `load` on every re-analysis, and
 *            listens for the clicks the action cell emits.
 *
 * Design notes: docs/design/report.md#the-html-report
 */

/**
 * Palette and chrome.
 *
 * Every themed value is `light-dark(light, dark)`: `color-scheme` follows the OS
 * setting, and a `data-theme` stamp on the root overrides it either way.
 * Severity uses the reserved status colors, because severity is a state, not an
 * identity — and on the light surface the advisory amber falls below 3:1, so
 * every severity is rendered with its glyph and the word, never colour alone.
 */
const CSS = `
:root {
  color-scheme: light dark;
  --surface: light-dark(#fcfcfb, #1a1a19);
  --plane: light-dark(#f9f9f7, #0d0d0d);
  --ink: light-dark(#0b0b0b, #ffffff);
  --ink-2: light-dark(#52514e, #c3c2b7);
  --ink-muted: #898781;
  --grid: light-dark(#e1e0d9, #2c2c2a);
  --axis: light-dark(#c3c2b7, #383835);
  --hairline: light-dark(rgba(11,11,11,0.10), rgba(255,255,255,0.10));
  --sev-error: #d03b3b;
  --sev-warn: #fab219;
  --seq: light-dark(#2a78d6, #3987e5);
  --track: light-dark(rgba(11,11,11,0.06), rgba(255,255,255,0.08));
}
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--plane);
  color: var(--ink);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1100px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; font-weight: 600; margin: 0 0 14px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--ink-2); }
.sub { color: var(--ink-muted); margin: 4px 0 0; font-size: 13px; }
.card {
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: 10px;
  padding: 20px;
  margin-top: 16px;
}
/* Stat tiles. The lead number is the chart; a one-bar bar chart is not. */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 1px; background: var(--hairline); border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; margin-top: 20px; }
.kpi { background: var(--surface); padding: 16px 18px; }
.kpi .v { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
.kpi.lead .v { font-size: 48px; }
.kpi .k { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
.kpi .v.err { color: var(--sev-error); }
/* Filters: one row, above everything it scopes. */
.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 20px; }
.filters input[type=search] {
  flex: 1 1 200px; min-width: 160px; padding: 7px 10px; font: inherit; font-size: 13px;
  color: var(--ink); background: var(--surface); border: 1px solid var(--hairline); border-radius: 7px;
}
.chip {
  font: inherit; font-size: 12px; padding: 6px 11px; border-radius: 999px; cursor: pointer;
  background: var(--surface); color: var(--ink-2); border: 1px solid var(--hairline);
}
.chip[aria-pressed=true] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.chip:focus-visible, .bar:focus-visible { outline: 2px solid var(--seq); outline-offset: 2px; }
.scope { font-size: 12px; color: var(--ink-muted); margin-left: auto; }
/* Bars: thin marks, rounded at the data end only, anchored to the baseline. */
.bars { display: grid; gap: 8px; }
.bar {
  display: grid; grid-template-columns: minmax(120px, 34%) 1fr auto; align-items: center; gap: 12px;
  width: 100%; text-align: left; font: inherit; background: none; border: 0; padding: 3px 2px; cursor: pointer;
  border-radius: 6px; color: inherit;
}
.bar:hover { background: var(--track); }
.bar .name { font-size: 12.5px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar[aria-pressed=true] .name { color: var(--ink); font-weight: 600; }
.bar .track { height: 10px; background: var(--track); border-radius: 0 5px 5px 0; }
.bar .fill { display: block; height: 10px; border-radius: 0 4px 4px 0; min-width: 2px; }
.bar .val { font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; min-width: 3ch; text-align: right; }
.legend { display: flex; gap: 16px; margin: 0 0 14px; font-size: 12px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
/* Findings table: the table view, and the way every value stays readable without color. */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
tr.grp th { text-align: left; font-weight: 400; padding: 18px 10px 7px 0; border-bottom: 1px solid var(--axis); }
tbody:first-child tr.grp th { padding-top: 0; }
tr.grp .count { font-size: 12px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
td.loc { white-space: nowrap; color: var(--ink-2); font-variant-numeric: tabular-nums; }
td.msg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-word; }
.sev { white-space: nowrap; font-size: 12px; }
.sev.error { color: var(--sev-error); }
.sev.warn { color: var(--ink-2); }
.rule { font-size: 12px; color: var(--ink); font-weight: 600; white-space: nowrap; }
.fix { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }
.note { color: var(--ink-muted); }
.tokens { font-size: 11.5px; color: var(--ink-muted); margin-top: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
/* Composite clusters: one card per defect, not one row per member file. */
.cluster { border: 1px solid var(--hairline); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
.cluster .sig { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-word; }
.cluster ul { margin: 8px 0 0; padding-left: 18px; color: var(--ink-2); font-size: 12.5px; }
.banner { border-left: 3px solid var(--sev-error); background: var(--surface); border-radius: 0 8px 8px 0; padding: 14px 16px; margin-top: 16px; border-top: 1px solid var(--hairline); border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); }
.banner b { color: var(--sev-error); }
.empty { color: var(--ink-muted); font-size: 13px; padding: 8px 0; }
.clean { text-align: center; padding: 56px 20px; }
.clean .v { font-size: 40px; font-weight: 600; }
#tip {
  position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
  background: var(--ink); color: var(--surface); font-size: 12px; padding: 6px 9px;
  border-radius: 6px; max-width: 320px; z-index: 10;
}
#tip.on { opacity: 1; }
@media (prefers-reduced-motion: reduce) { #tip { transition: none; } }
`;
/**
 * Live-only chrome: the toolbar, the action cell, and the source peek.
 *
 * Separate from {@link CSS} rather than merged into it because the artifact must
 * keep rendering the bytes it always has. `body` emits this block only when a
 * live host asked for the page, so a diff of two reports taken a week apart is
 * still a diff of the findings.
 */
const LIVE_CSS = `
.top {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
  padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--hairline);
  font-size: 12.5px; color: var(--ink-2);
}
.top .grow { flex: 1; }
.conn { width: 8px; height: 8px; border-radius: 50%; background: var(--ink-muted); flex: none; }
.conn.on { background: #2f9e6f; }
.conn.off { background: var(--sev-error); }
.conn.busy { background: var(--sev-warn); }
.btn {
  font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 7px; cursor: pointer;
  background: var(--surface); color: var(--ink); border: 1px solid var(--axis);
}
.btn:hover:not(:disabled) { background: var(--track); }
.btn:disabled { opacity: .5; cursor: default; }
.btn:focus-visible, .act-btn:focus-visible, .jump:focus-visible { outline: 2px solid var(--seq); outline-offset: 2px; }
.act-btn {
  font: inherit; font-size: 11.5px; padding: 2px 8px; margin-left: 4px; border-radius: 5px; cursor: pointer;
  background: none; color: var(--ink-2); border: 1px solid var(--hairline);
}
.act-btn:hover:not(:disabled) { background: var(--track); color: var(--ink); }
.act-btn:disabled { opacity: .45; cursor: default; }
td.act { text-align: right; white-space: nowrap; width: 1%; }
a.jump { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--axis); }
a.jump:hover { color: var(--seq); border-bottom-color: var(--seq); }
/* The flash a write leaves behind: what happened, where the row was. */
.said { padding: 8px 20px; font-size: 12.5px; border-bottom: 1px solid var(--hairline); background: var(--surface); }
.said.err { color: var(--sev-error); }
.said:empty { display: none; }
.wrap.live { padding-top: 20px; }
`;
/**
 * The client. Written without template literals on purpose: this whole string is
 * itself inside one, and a stray `${` would be interpolated by the bundler
 * rather than shipped.
 */
const JS = `
(function () {
  // Two hosts, one view. The static report embeds its payload and renders once;
  // \`loupe ui\` serves this same script with no embedded block and drives it
  // through \`load\`. \`__loupe\` is how the live host announces itself — absent in
  // the artifact, so LIVE is false there and nothing below changes its output.
  var HOST = window.__loupe || {};
  var LIVE = !!HOST.live;
  var COLS = LIVE ? 3 : 2;
  var data = { findings: [], rules: [], summary: {} };
  var byRank = new Map();
  var fixable = new Set();
  var state = { rule: null, severity: null, q: '' };
  var MARK = { error: '\\u2717', warn: '\\u2022' };
  var WORD = { error: 'blocking', warn: 'advisory' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Where a finding is, as the reader's editor addresses it. The host supplies
  // both halves: the absolute root — already slash-led, so the result is a URI
  // path on every platform — and the template, because which scheme opens is the
  // reader's choice.
  function href(f) {
    return String(HOST.editor || '').replace('{path}', (HOST.root || '') + '/' + f.file).replace('{line}', f.line);
  }

  // The live row's third cell. Empty string in the artifact, where COLS is 2 and
  // no host is listening for the clicks.
  //
  // Only a finding the server said it can rewrite offers \`fix\`: the predicate is
  // \`tokenFixes\`, run where the files are, so this cell cannot offer a
  // substitution the writer would refuse.
  function acts(f) {
    if (!LIVE) return '';
    return '<td class="act">' +
      (fixable.has(f.__i) ? '<button class="act-btn" data-act="fix" data-i="' + f.__i + '">fix</button>' : '') +
      '<button class="act-btn" data-act="mute" data-i="' + f.__i + '">mute</button>' +
      '</td>';
  }

  function dirOf(file) {
    var i = String(file).lastIndexOf('/');
    return i === -1 ? '.' : file.slice(0, i);
  }
  function slice() {
    var q = state.q.toLowerCase();
    return data.findings.filter(function (f) {
      if (state.rule && f.rule !== state.rule) return false;
      if (state.severity && f.severity !== state.severity) return false;
      if (q && (f.file + ' ' + f.message + ' ' + f.rule).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function tally(rows, keyOf) {
    var m = new Map();
    rows.forEach(function (r) { var k = keyOf(r); m.set(k, (m.get(k) || 0) + 1); });
    return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1] || String(a[0]).localeCompare(String(b[0])); });
  }

  var tip = document.getElementById('tip');
  function bindTip(el, text) {
    function show(e) {
      tip.textContent = text;
      tip.classList.add('on');
      var x = e.clientX !== undefined ? e.clientX + 14 : el.getBoundingClientRect().left;
      var y = e.clientY !== undefined ? e.clientY + 16 : el.getBoundingClientRect().bottom + 6;
      tip.style.left = Math.min(x, window.innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.min(y, window.innerHeight - tip.offsetHeight - 8) + 'px';
    }
    el.addEventListener('mousemove', show);
    el.addEventListener('mouseenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
    el.addEventListener('blur', function () { tip.classList.remove('on'); });
  }

  // One bar builder for both charts. \`color\` is a CSS custom property name so
  // the mark follows the theme rather than a hex baked in at render time.
  function bars(host, rows, max, color, opts) {
    opts = opts || {};
    host.innerHTML = '';
    if (!rows.length) { host.innerHTML = '<p class="empty">Nothing in this slice.</p>'; return; }
    rows.forEach(function (row) {
      var key = row[0], n = row[1];
      var b = document.createElement('button');
      b.className = 'bar';
      b.type = 'button';
      var fillColor = typeof color === 'function' ? color(key) : color;
      var pct = max > 0 ? Math.max(1.5, (n / max) * 100) : 0;
      b.innerHTML =
        '<span class="name">' + esc(opts.label ? opts.label(key) : key) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct.toFixed(2) + '%;background:var(' + fillColor + ')"></span></span>' +
        '<span class="val">' + n + '</span>';
      if (opts.onClick) {
        b.setAttribute('aria-pressed', String(opts.pressed && opts.pressed(key)));
        b.addEventListener('click', function () { opts.onClick(key); });
      } else {
        b.style.cursor = 'default';
      }
      bindTip(b, opts.tip ? opts.tip(key, n) : key + ' \\u2014 ' + n);
      host.appendChild(b);
    });
  }

  function renderKpis(rows) {
    var err = rows.filter(function (f) { return f.severity === 'error'; }).length;
    var s = data.summary;
    var tiles = [
      { k: 'findings', v: rows.length, lead: true },
      { k: '\\u2717 blocking', v: err, err: err > 0 },
      { k: '\\u2022 advisory', v: rows.length - err }
    ];
    // Only when it hid something: a baseline that accepted nothing and a project
    // with no baseline file both report 0.
    if (s.baselined) tiles.push({ k: 'baselined', v: s.baselined });
    tiles.push({ k: 'suppressions', v: s.suppressions });
    // Next to the unparsed count on purpose: zero unparsed files means nothing
    // until you know how many were read.
    tiles.push({ k: 'files scanned', v: s.filesScanned });
    tiles.push({ k: 'files unparsed', v: s.parseErrors, err: s.parseErrors > 0 });
    document.getElementById('kpis').innerHTML = tiles.map(function (t) {
      return '<div class="kpi' + (t.lead ? ' lead' : '') + '"><div class="v' + (t.err ? ' err' : '') + '">' +
        t.v + '</div><div class="k">' + t.k + '</div></div>';
    }).join('');
  }

  function renderRules(rows) {
    var counts = tally(rows, function (f) { return f.rule; });
  // Frequency order, deliberately not the agent format's rank order: rank is
  // "fix this first", length is "there is the most of this". Rank breaks ties,
  // and severity is carried by the mark's color and by the blocking tile.
    counts.sort(function (a, b) {
      var ra = byRank.get(a[0]), rb = byRank.get(b[0]);
      return b[1] - a[1] || (rb ? rb.rank : 0) - (ra ? ra.rank : 0);
    });
    var max = counts.length ? counts[0][1] : 0;
    var sevOf = new Map();
    rows.forEach(function (f) { sevOf.set(f.rule, f.severity); });
    bars(document.getElementById('rules'), counts, max,
      function (id) { return sevOf.get(id) === 'error' ? '--sev-error' : '--sev-warn'; },
      {
        onClick: function (id) { state.rule = state.rule === id ? null : id; render(); },
        pressed: function (id) { return state.rule === id; },
        tip: function (id, n) {
          var r = byRank.get(id);
          return n + ' \\u00d7 ' + id + (r ? ' \\u2014 ' + r.title : '');
        }
      });
  }

  // Top directories only. Past the cap the tail is folded into one row rather
  // than truncated silently.
  var DIR_CAP = 12;
  function renderPaths(rows) {
    var counts = tally(rows, function (f) { return dirOf(f.file); });
    var shown = counts.slice(0, DIR_CAP);
    var tail = counts.slice(DIR_CAP);
    if (tail.length) {
      var n = tail.reduce(function (t, c) { return t + c[1]; }, 0);
      shown.push([tail.length + ' more director' + (tail.length === 1 ? 'y' : 'ies'), n]);
    }
    var max = shown.reduce(function (m, c) { return Math.max(m, c[1]); }, 0);
    bars(document.getElementById('paths'), shown, max, '--seq', {
      tip: function (dir, n) { return n + ' finding' + (n === 1 ? '' : 's') + ' in ' + dir; }
    });
  }

  // The two rules whose finding is one member of an N-way relation. Grouped on
  // \`group\`, which is the key the engine says the cluster means.
  function renderClusters(rows) {
    var host = document.getElementById('clusters');
    var section = document.getElementById('clusters-section');
    var m = new Map();
    rows.forEach(function (f) {
      if (!f.group) return;
      var k = f.rule + '\\u0000' + f.group;
      if (!m.has(k)) m.set(k, { rule: f.rule, group: f.group, files: [], message: f.message });
      var e = m.get(k);
      if (e.files.indexOf(f.file) === -1) e.files.push(f.file);
    });
    var list = Array.from(m.values()).sort(function (a, b) { return b.files.length - a.files.length; });
    section.hidden = list.length === 0;
    host.innerHTML = list.map(function (c) {
      return '<div class="cluster"><div class="sig">' + esc(c.group) + '</div>' +
        '<div class="fix">' + esc(c.rule) + ' \\u2014 assembled in ' + c.files.length + ' file' +
        (c.files.length === 1 ? '' : 's') + '</div><ul>' +
        c.files.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>';
    }).join('');
  }

  // Grouped by rule, for the same reason the agent format is: the remedy and the
  // severity are properties of the rule, not of the finding. Group order matches
  // the chart above.
  function renderTable(rows) {
    var host = document.getElementById('table');
    if (!rows.length) { host.innerHTML = '<p class="empty">No findings in this slice.</p>'; return; }
    var groups = new Map();
    rows.forEach(function (f) {
      if (!groups.has(f.rule)) groups.set(f.rule, []);
      groups.get(f.rule).push(f);
    });
    var order = Array.from(groups.entries()).sort(function (a, b) {
      var ra = byRank.get(a[0]), rb = byRank.get(b[0]);
      return b[1].length - a[1].length || (rb ? rb.rank : 0) - (ra ? ra.rank : 0);
    });
    var out = order.map(function (entry) {
      var rule = entry[0], group = entry[1];
      var sev = group[0].severity;
      var body = group.map(function (f) {
        var tokens = (f.suggest || []).map(function (s) { return s.tokens.join(' / '); }).filter(Boolean);
        var loc = esc(f.file) + ':' + f.line;
        return '<tr>' +
          '<td class="loc">' + (LIVE ? '<a class="jump" href="' + esc(href(f)) + '">' + loc + '</a>' : loc) + '</td>' +
          '<td class="msg">' + esc(f.message) +
						// Whole, not clipped: the page has room the one-line agent
						// format does not.
            (f.note ? ' <span class="note">(' + esc(f.note) + ')</span>' : '') +
            (tokens.length ? '<div class="tokens">\\u2192 ' + esc(tokens.join(', ')) + '</div>' : '') + '</td>' +
          acts(f) +
          '</tr>';
      }).join('');
      return '<tbody><tr class="grp"><th colspan="' + COLS + '">' +
        '<span class="sev ' + sev + '">' + MARK[sev] + ' ' + WORD[sev] + '</span> ' +
        '<span class="rule">' + esc(rule) + '</span> ' +
        '<span class="count">' + group.length + '</span>' +
        '<div class="fix">' + esc(group[0].fix) + '</div>' +
        '</th></tr>' + body + '</tbody>';
    }).join('');
    host.innerHTML = '<table>' + out + '</table>';
  }

  function render() {
    var rows = slice();
    // Live only: the artifact decides clean once, at generation, and never ships
    // the panels. A live page crosses that line in both directions.
    if (LIVE) {
      var none = data.findings.length === 0;
      var clean = document.getElementById('clean');
      if (clean) clean.hidden = !none;
      Array.prototype.forEach.call(document.querySelectorAll('[data-when="findings"]'), function (el) {
        el.hidden = none;
      });
      if (none) return;
    }
    renderKpis(rows);
    renderRules(rows);
    renderPaths(rows);
    renderClusters(rows);
    renderTable(rows);
    document.querySelectorAll('.chip[data-sev]').forEach(function (c) {
      c.setAttribute('aria-pressed', String(state.severity === c.dataset.sev));
    });
    var filtered = state.rule || state.severity || state.q;
    document.getElementById('scope').textContent =
      filtered ? 'showing ' + rows.length + ' of ' + data.findings.length : '';
    document.getElementById('clear').hidden = !filtered;
  }

  document.querySelectorAll('.chip[data-sev]').forEach(function (c) {
    c.addEventListener('click', function () {
      state.severity = state.severity === c.dataset.sev ? null : c.dataset.sev;
      render();
    });
  });
  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value;
    render();
  });
  document.getElementById('clear').addEventListener('click', function () {
    state.rule = null; state.severity = null; state.q = '';
    document.getElementById('q').value = '';
    render();
  });

  // Replace the payload and redraw. The artifact calls this once, from its own
  // embedded block; the live host calls it on every re-analysis.
  //
  // \`__i\` is stamped here rather than passed around because every renderer below
  // works on the filtered slice, and an action has to name the finding's position
  // in the whole payload. It is written onto the client's own parsed copy and
  // never sent back.
  function load(next, meta) {
    data = next;
    data.findings.forEach(function (f, i) { f.__i = i; });
    byRank = new Map(data.rules.map(function (r) { return [r.id, r]; }));
    fixable = new Set((meta && meta.fixable) || []);
    render();
  }

  var embedded = document.getElementById('loupe-data');
  if (embedded) load(JSON.parse(embedded.textContent));
  window.__loupeView = { load: load, render: render, state: state };
})();
`;
export interface BodyOptions {
	/** The payload, already escaped for a `<script>` block. Omitted by a live host, which fetches. */
	payload?: string | undefined;
	/** Generation-time verdict, for the artifact. A live page decides it per render instead. */
	clean: boolean;
	parseErrors: number;
	/** Emit the live chrome: the toolbar, the action column, the clean card that toggles. */
	live?: boolean | undefined;
}

/**
 * The page body — everything between the markers, so a host that supplies its
 * own shell can lift it out whole.
 */
export function body(opts: BodyOptions): string {
	const { payload, clean, parseErrors, live = false } = opts;
	// `<style>`/`<script>` sit inside the markers rather than in `<head>` so the
	// fragment is self-sufficient: `/loupe-report` publishes exactly this span into
	// an Artifact, which supplies its own document shell.
	//
	// Unparsed files are named before anything else: nothing in them was checked,
	// so every count below is a floor rather than a total.
	const banner = parseErrors
		? `  <div class="banner"><b>${parseErrors} file(s) could not be parsed</b> and were skipped entirely — ${
				clean ? 'a clean result covers only what could be read' : 'every number below is a floor, not a total'
			}. See <code>stylesheet/unparsed</code>.</div>\n`
		: '';
	// A live page ships both and toggles, because it crosses between them; the
	// artifact ships whichever one its run produced and never the other.
	const cleanCard = `  <div class="card clean" id="clean"${live ? ' hidden' : ''}><div class="v">clean</div><p class="sub">No findings.</p></div>`;
	const panels = `  <div class="kpis" id="kpis" data-when="findings"></div>

  <div class="filters" data-when="findings">
    <input type="search" id="q" placeholder="Filter by file, rule or value…" aria-label="Filter findings">
    <button class="chip" data-sev="error" aria-pressed="false">✗ blocking</button>
    <button class="chip" data-sev="warn" aria-pressed="false">• advisory</button>
    <button class="chip" id="clear" hidden>clear</button>
    <span class="scope" id="scope"></span>
  </div>

  <div class="card" data-when="findings">
    <h2>By rule</h2>
    <p class="legend">
      <span><i class="dot" style="background:var(--sev-error)"></i> ✗ blocking</span>
      <span><i class="dot" style="background:var(--sev-warn)"></i> • advisory</span>
    </p>
    <div class="bars" id="rules"></div>
  </div>

  <div class="card" data-when="findings">
    <h2>Where it is</h2>
    <div class="bars" id="paths"></div>
  </div>

  <div class="card" id="clusters-section" hidden>
    <h2>Composites rebuilt across files</h2>
    <div id="clusters"></div>
  </div>

  <div class="card" data-when="findings">
    <h2>Findings</h2>
    <div id="table"></div>
  </div>`;
	// The artifact renders one branch and omits the view entirely when clean —
	// there is nothing for it to do and no way to reach a state where there is.
	const main = live
		? `${cleanCard}\n${panels}\n</div>\n<div id="tip" role="status" aria-live="polite"></div>\n<script>${JS}</script>`
		: clean
			? `${cleanCard}\n</div>`
			: `${panels}
</div>
<div id="tip" role="status" aria-live="polite"></div>
<script>${JS}</script>`;
	const data = payload === undefined ? '' : `\n<script type="application/json" id="loupe-data">${payload}</script>`;
	return `<!-- loupe:begin -->
<style>${CSS}${live ? LIVE_CSS : ''}</style>${data}
<div class="wrap${live ? ' live' : ''}">
  <h1>Loupe</h1>
  <p class="sub">Design-system conformance report</p>
${banner}${main}
<!-- loupe:end -->`;
}
