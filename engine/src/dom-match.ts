/**
 * Resolving a finding to the elements it styles — the one piece of loupe that
 * only makes sense inside a page.
 *
 * A stylesheet finding carries the `selector` of the rule it sits in, and a
 * selector is a DOM query. That is the whole basis of `loupe serve` and of the
 * DevTools extension, and it is the only thing loupe does that no other
 * conformance checker can. It lives here, as one source string, because it now
 * has two readers:
 *
 *   `serve.ts`            injects it under the bookmarklet's overlay
 *   editors/devtools      vendors it and evaluates it in the inspected page
 *
 * Two copies of this would be two answers to "does this rule reach anything on
 * screen", and the disagreement would be invisible — both would highlight
 * *something* plausible. So it is written once, as ES5 free of template literals
 * (it is embedded in one, and a client that cannot contain a backtick is one
 * nobody has to keep escaping correctly), and the extension's copy is generated
 * from this constant and checked in CI.
 *
 * It installs `window.__loupeMatch` and is idempotent: evaluating it twice
 * against the same page keeps the first install, because a DevTools panel
 * re-evaluates on every navigation and has no way to know whether it is the
 * first.
 *
 * Design notes: docs/design/report.md#resolving-a-finding-to-elements
 */

/** Bumped when the shape of `window.__loupeMatch` changes. A reader checks it. */
export const MATCH_VERSION = 1;

export const MATCH_JS = `
(function () {
  if (window.__loupeMatch && window.__loupeMatch.version === ${MATCH_VERSION}) return;

  // Marks live in a shadow root of their own. The host page's stylesheet is the
  // adversary here — in wp-admin it is considerable — and an outline drawn into
  // the ordinary cascade is one \`* { box-sizing }\` away from being the wrong
  // size and one \`div { display: none }\` away from being invisible.
  var host = null, layer = null;
  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-loupe-marks', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    var root = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent =
      ':host { all: initial }' +
      '.marks { position: fixed; inset: 0; pointer-events: none }' +
      '.mark { position: absolute; border: 2px solid #4ec9a5; background: rgba(78,201,165,.14); border-radius: 2px }' +
      '.tag { position: absolute; top: -18px; left: -2px; background: #4ec9a5; color: #06231c;' +
      ' font: 600 10px ui-monospace, Menlo, monospace; padding: 1px 5px; border-radius: 3px; white-space: nowrap }';
    layer = document.createElement('div');
    layer.className = 'marks';
    root.appendChild(style);
    root.appendChild(layer);
    document.documentElement.appendChild(host);
  }

  // A selector as authored is not always one the DOM will accept, and one bad
  // one must not take the caller down. Pseudo-elements have no node to match,
  // and a state pseudo-class says *when* a rule applies, not what to.
  //
  // The trailing lookahead, not \b: a word boundary sits happily between
  // 'focus' and the '-' of ':focus-visible', so \\b would leave '-visible'
  // welded to the class before it — a valid selector for an element that does
  // not exist.
  var STATE = /:(?:hover|focus-within|focus-visible|focus|active|visited|target|checked|disabled|enabled|indeterminate|placeholder-shown|autofill|default|read-only|read-write|link|any-link|user-invalid|user-valid|valid|invalid|required|optional)(?![\\w-])/g;
  function domSelector(sel) {
    var parts = String(sel).split(',').map(function (s) {
      return s.replace(/::[a-zA-Z-]+(\\([^)]*\\))?/g, '').replace(STATE, '').trim();
    }).filter(Boolean);
    return parts.join(', ');
  }

  /** Loupe's own furniture is never a finding's target. */
  function ours(el) {
    return !!(el.closest && (el.closest('[data-loupe-marks]') || el.closest('[data-loupe-overlay]')));
  }

  function elementsFor(f) {
    if (!f || !f.selector) return null;
    var sel = domSelector(f.selector);
    if (!sel) return [];
    try {
      return Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function (el) {
        return !ours(el);
      });
    } catch (e) { return []; }
  }

  // Whether the rule's own @media condition holds at this moment. An unparseable
  // query normalizes to 'not all', which never matches, so an unreadable
  // condition is treated as no condition rather than as one that never holds.
  function active(f) {
    if (!f || !f.media) return true;
    try {
      var mq = window.matchMedia(f.media);
      if (mq.media === 'not all' && f.media.indexOf('not all') === -1) return true;
      return mq.matches;
    } catch (e) { return true; }
  }

  /**
   * The page's opinion about ordering, shared so both readers list the same way:
   * what this page can actually show you first, then what is real but not at
   * this width, then what resolves to nothing, then what was never a browser
   * question at all.
   */
  function bucket(n, on) { return n > 0 ? (on ? 0 : 1) : n === 0 ? 2 : 3; }

  var loaded = [];

  var api = {
    version: ${MATCH_VERSION},

    /** Hand over the findings. Only \`selector\`, \`media\` and \`severity\` are read. */
    load: function (findings) {
      loaded = (findings || []).map(function (f) {
        return { selector: f.selector || null, media: f.media || null, severity: f.severity || 'warn' };
      });
      return loaded.length;
    },

    domSelector: domSelector,
    active: function (i) { return active(loaded[i]); },

    /**
     * One row per loaded finding: how many elements it reaches and whether its
     * condition holds. One eval for the whole list — a call per finding would
     * cost a round trip each across the DevTools boundary.
     */
    snapshot: function () {
      return loaded.map(function (f, i) {
        var els = elementsFor(f);
        var n = els ? els.length : -1;
        var on = active(f);
        return { i: i, n: n, on: on, bucket: bucket(n, on) };
      });
    },

    /**
     * Which loaded findings style this element.
     *
     * The inversion the panel is for: not "where are these 200 findings" but
     * "what is wrong with *this*". \`matches\` rather than re-querying, because
     * the question is about one node.
     */
    forElement: function (el) {
      if (!el || el.nodeType !== 1) return [];
      var out = [];
      for (var i = 0; i < loaded.length; i++) {
        var f = loaded[i];
        if (!f.selector) continue;
        var sel = domSelector(f.selector);
        if (!sel) continue;
        try {
          if (el.matches(sel)) out.push({ i: i, on: active(f) });
        } catch (e) { /* a selector the DOM refuses matches nothing */ }
      }
      return out;
    },

    /** Outline what finding \`i\` reaches. Returns how many boxes were drawn. */
    highlight: function (i) {
      ensure();
      layer.innerHTML = '';
      var els = elementsFor(loaded[i]);
      if (!els || !els.length) return 0;
      var drawn = 0;
      els.forEach(function (el, k) {
        var r = el.getBoundingClientRect();
        if (!r.width && !r.height) return;
        drawn++;
        var box = document.createElement('div');
        box.className = 'mark';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
        if (k === 0) {
          var tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = el.tagName.toLowerCase() +
            (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
          box.appendChild(tag);
        }
        layer.appendChild(box);
      });
      return drawn;
    },

    /** Outline one element, for the Elements sidebar's own hover. */
    highlightElement: function (el) {
      ensure();
      layer.innerHTML = '';
      if (!el || el.nodeType !== 1) return 0;
      var r = el.getBoundingClientRect();
      if (!r.width && !r.height) return 0;
      var box = document.createElement('div');
      box.className = 'mark';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      layer.appendChild(box);
      return 1;
    },

    clear: function () { if (layer) layer.innerHTML = ''; },

    /** Take the marks layer out of the page entirely. For a caller shutting down. */
    teardown: function () {
      if (host) host.remove();
      host = null;
      layer = null;
    },

    scrollTo: function (i) {
      var els = elementsFor(loaded[i]);
      if (!els || !els.length) return false;
      els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },

    /** Marks are absolutely positioned against the viewport, so a scroll moves them. */
    reposition: function (i) { return i === null || i === undefined ? api.clear() : api.highlight(i); },
  };

  window.__loupeMatch = api;
})();
`;
