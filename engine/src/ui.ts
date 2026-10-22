/**
 * `loupe ui` — the findings, live, on the working tree.
 *
 * The other HTML surface is an artifact: taken once, read later, identical to
 * itself when re-run. This one is a window. It renders the same view — see
 * `report-view.ts`, which both hosts share — and adds the four things a file
 * structurally cannot do:
 *
 *   re-run      a watcher over the directories the analysis actually read,
 *               pushed to the page over SSE. The report is a photograph.
 *   navigate    every location is a link into the reader's editor.
 *   write back  `fix`, `baseline` and `suppress`, through the same functions the
 *               CLI and the language server call. Not a second implementation.
 *   say when    the artifact renders no timestamp because a file that differs
 *               from itself cannot be diffed. Nobody diffs a window, so this
 *               says when it last ran, and how long it took.
 *
 * Three decisions are load-bearing.
 *
 * **It writes, so it is not `serve`.** `loupe serve` is read-only and answers
 * anyone (`access-control-allow-origin: *`) because a bookmarklet on some other
 * origin is the whole point. A server that rewrites source files cannot be that.
 * This one binds loopback, sends no CORS header at all, and holds every mutating
 * request to a secret minted at startup and handed only to the page it served.
 * See {@link guard}.
 *
 * **A write names a revision, not just a finding.** Indices address the payload
 * the page is holding, and the tree moves under it — a rebuild, a teammate's
 * rebase, the reader's own editor. A stale index would still name *a* finding.
 * So every run stamps a `rev` and every write carries the one it was aimed at;
 * a mismatch is refused and the page refreshes. `substituteOnLine` would refuse
 * most of these on its own, by finding no declaration on the reported line —
 * this makes the refusal certain rather than likely.
 *
 * `rev` names the state of the tree, not the analysis run: a write this server
 * makes moves it too, at once. A directive spliced in shifts every line below
 * it, so a second mute aimed at the same page before the re-analysis lands
 * would name a line that has moved; it is refused instead, and the page is
 * redrawn from the run that sees the first write.
 *
 * **Watching is reported, never assumed.** Where the watch set cannot be
 * established the page says so and the re-run button stays; it does not display
 * a stale payload under a live-looking dot.
 *
 * Design notes: docs/design/report.md#loupe-ui
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type FSWatcher, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { CSS_FILE, applyTokenFixes, tokenFixes } from './autofix.ts';
import { writeBaseline } from './baseline.ts';
import { analyzeEntryBudget, discover, toPosix } from './discover.ts';
import { body, embed } from './report-view.ts';
import { reportPayload } from './report.ts';
import { messageOf, oneLine } from './text.ts';
import type { AnalyzeResult, BaselinedResult, Config, Finding, ReportPayload } from './types.ts';

/** What a write presents to prove it came from the page this process served. */
export const TOKEN_HEADER = 'x-loupe-token';
/** The payload revision a write was aimed at. See the header note on staleness. */
export const REV_HEADER = 'x-loupe-rev';

/** The comment a suppression directive has to be written in, per file type. Mirrors the language server's. */
const commentFor = (file: string, text: string): string => (CSS_FILE.test(file) ? `/* ${text} */` : `// ${text}`);

/**
 * How many directories the watcher will hold open.
 *
 * One `fs.watch` per directory rather than one recursive watch on the root:
 * recursive is unsupported on Linux before Node 20, and this floor is Node 18.
 * Per-directory is the same code on every platform and it self-heals — a new
 * directory is a new entry in a directory already watched, which fires, which
 * rebuilds the set.
 *
 * The cap is a real ceiling on file descriptors, not a guess at a reasonable
 * project: past it the watch is refused whole and said to be refused, because a
 * watch covering some of the tree reports clean for edits it never saw.
 */
const WATCH_CAP = 2048;

/** Re-analysis is whole-tree, so a burst of saves has to fold into one run. */
const DEBOUNCE_MS = 140;

/** Nothing this server accepts is large. A body past this is refused unread. */
const BODY_LIMIT = 64 * 1024;

/** How much of a file `/source` will hand back around a line. */
const PEEK = 12;

export interface UiState {
	/**
	 * The state of the tree this payload describes. Moves on every analysis, on
	 * every write this server makes, and on every change the watch sees. Every
	 * write names the one it was aimed at.
	 */
	rev: number;
	ranAt: string;
	ms: number;
	payload: ReportPayload;
	/**
	 * Indices into `payload.findings` that `fix` can rewrite.
	 *
	 * Computed with `tokenFixes` — the predicate `loupe fix` and the quick fix
	 * both use — so the button cannot offer a substitution the writer refuses.
	 * Index-aligned because `reportPayload` maps findings 1:1 and in order.
	 */
	fixable: number[];
	/** Directories under watch, or null where a watch could not be established. */
	watching: number | null;
	baseline: { path: string; found: boolean };
	/**
	 * Why the latest analysis failed, while the payload is the last one that did
	 * not. Absent once an analysis succeeds again.
	 */
	error?: string;
	/**
	 * The config file changed since the server read it. Every run still uses the
	 * config it started with, so the page says a restart is what applies it.
	 */
	configChanged?: boolean;
}

export interface UiHandle {
	url: string;
	close: () => Promise<void>;
}

/** Everything the server needs that only the CLI knows how to resolve. */
export interface UiOptions {
	port: number;
	config: Config;
	root: string;
	/** A fresh whole-tree analysis, with no baseline applied. */
	analyze: () => Promise<AnalyzeResult>;
	/** That result as the reader should see it — the baseline applied, or not, per the flags. */
	present: (fresh: AnalyzeResult) => AnalyzeResult | BaselinedResult;
	/** Where `POST /baseline` writes. */
	baselineTarget: string;
	/** Whether a baseline is in play right now, for the toolbar. */
	baselineFound: () => boolean;
	/** `{path}` and `{line}` are substituted by the page. */
	editor: string;
	/** Stderr, for anything the page is not the right place to say. */
	log?: ((line: string) => void) | undefined;
}

/**
 * Constant-time compare of a presented secret against the real one.
 *
 * `timingSafeEqual` throws on a length mismatch, which is itself an oracle, so
 * the length is checked first and both paths return the same way.
 */
function secretEquals(presented: string, real: string): boolean {
	const a = Buffer.from(presented);
	const b = Buffer.from(real);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The client. ES5 and free of template literals, for the reason `serve.ts` gives:
 * it is embedded in one, and a client that cannot contain a backtick is one
 * nobody has to keep escaping correctly.
 */
const CLIENT = `
(function () {
  var TOKEN = '__TOKEN__';
  var view = window.__loupeView;
  var rev = -1;
  var busy = false;

  function el(id) { return document.getElementById(id); }
  function say(msg, isErr) {
    var s = el('said');
    s.textContent = msg || '';
    s.className = 'said' + (isErr ? ' err' : '');
  }
  function conn(cls, text) {
    el('conn').className = 'conn ' + cls;
    el('status').textContent = text;
  }

  function paint(s) {
    rev = s.rev;
    view.load(s.payload, { fixable: s.fixable });
    var when = new Date(s.ranAt).toLocaleTimeString();
    el('ran').textContent = when + ' \\u00b7 ' + s.ms + 'ms \\u00b7 ' + s.payload.summary.filesScanned + ' files';
    // The panel says what it cannot see: a watch that could not be established
    // is named, so a stale page never sits under a live-looking dot.
    conn(s.watching === null ? 'busy' : 'on',
      s.watching === null ? 'not watching \\u2014 re-run by hand' : 'watching ' + s.watching + ' directories');
    // A failed run leaves the last good payload on screen, and says so in the
    // place that otherwise reads as live.
    if (s.error) conn('off', 'analysis failed \\u2014 ' + s.error + ' \\u2014 showing the last run that worked');
    if (s.configChanged) say('the config file changed \\u2014 restart loupe ui to apply it', true);
    el('accept').disabled = s.payload.summary.total === 0;
    el('accept').textContent = s.baseline.found ? 're-baseline' : 'accept as baseline';
  }

  function load() {
    return fetch('/state').then(function (r) { return r.json(); }).then(paint);
  }

  // Every mutating request carries the secret and the revision it was aimed at.
  // A 409 means the tree moved under the page; reload and let the reader retry
  // against what is actually there.
  function post(path, payload) {
    if (busy) return Promise.resolve(null);
    busy = true;
    say('');
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', '${TOKEN_HEADER}': TOKEN, '${REV_HEADER}': String(rev) },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; });
    }).then(function (res) {
      if (!res.ok) {
        say(res.body && res.body.error ? res.body.error : 'request failed (' + res.status + ')', true);
        if (res.status === 409) return load();
        return null;
      }
      return res.body;
    }).catch(function (e) {
      say(String(e && e.message ? e.message : e), true);
      return null;
    }).then(function (out) {
      busy = false;
      return out;
    });
  }

  el('rerun').addEventListener('click', function () {
    conn('busy', 'analyzing\\u2026');
    post('/run');
  });

  el('accept').addEventListener('click', function () {
    post('/baseline').then(function (b) {
      if (b) say('baselined ' + b.findings + ' finding(s) as ' + b.entries + ' entr' + (b.entries === 1 ? 'y' : 'ies') + ' \\u2014 ' + b.path);
    });
  });

  // Delegation, because the table is replaced wholesale on every render.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var i = Number(b.getAttribute('data-i'));
    if (b.getAttribute('data-act') === 'fix') {
      post('/fix', { findings: [i] }).then(function (r) {
        if (!r) return;
        if (r.applied) say('rewrote ' + r.applied + ' declaration(s)');
        else say(r.skipped && r.skipped.length ? r.skipped[0].why : 'nothing to rewrite', true);
      });
      return;
    }
    if (b.getAttribute('data-act') === 'mute') {
      // The reason is asked for rather than left blank. A directive without one
      // reports as suppression/malformed by design, and this is the one surface
      // that can put the question to a person instead of writing the silence.
      var reason = window.prompt('Why is this one allowed? (a directive with no reason is itself an error)');
      if (reason === null) return;
      if (!reason.trim()) { say('a suppression needs a reason', true); return; }
      post('/suppress', { finding: i, reason: reason.trim() }).then(function (r) {
        if (r) say('suppressed at ' + r.file + ':' + r.line);
      });
    }
  });

  var es = new EventSource('/events');
  es.onmessage = function (m) { paint(JSON.parse(m.data)); };
  es.onerror = function () { conn('off', 'disconnected \\u2014 is the server still running?'); };

  load().catch(function (e) { conn('off', String(e)); });
})();
`;

/** The page: the shared view, the live chrome around it, and the bootstrap. */
function page(opts: { token: string; root: string; editor: string }): string {
	// `__loupe` must exist before the view script runs — that object is how the
	// view learns it is live rather than an artifact.
	//
	// The root is normalized to start with a slash so that `{path}` substituted
	// into an editor template is a URI path on both platforms. A POSIX root
	// already does; a Windows one is `C:/proj`, and `vscode://file/C:/proj/x.css`
	// — authority `file`, path `/C:/proj/x.css` — is the form the handler wants.
	// Doing it here rather than in the client keeps the one platform question in
	// the one process that knows the answer.
	const abs = toPosix(opts.root).replace(/^(?!\/)/, '/');
	// Through `embed` for the reason the artifact's payload goes through it: a
	// `</script` in a root path or an `--editor` template would end this block
	// early, and `JSON.stringify` does not escape `<`.
	const host = embed(JSON.stringify({ live: true, root: abs, editor: opts.editor }));
	const toolbar = `<div class="top">
  <span class="conn" id="conn"></span>
  <span id="status">connecting…</span>
  <span class="grow"></span>
  <span class="ran" id="ran"></span>
  <button class="btn" id="rerun">re-run</button>
  <button class="btn" id="accept" disabled>accept as baseline</button>
</div>
<div class="said" id="said"></div>`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loupe</title>
<!-- Declared empty so the browser does not ask for /favicon.ico. A page whose
     whole job is to report what is wrong should not open with a 404 of its own. -->
<link rel="icon" href="data:,">
</head>
<body>
<script>window.__loupe = ${host};</script>
${toolbar}
${body({ clean: false, parseErrors: 0, live: true })}
<script>${CLIENT.replace('__TOKEN__', opts.token)}</script>
</body>
</html>
`;
}

export async function ui(opts: UiOptions): Promise<UiHandle> {
	const { port, config, root, analyze, present, baselineTarget, baselineFound, editor } = opts;
	const log = opts.log ?? (() => {});
	// Minted per run and never written to disk: a page that was not served by
	// this process cannot have it.
	const token = randomBytes(24).toString('hex');
	let url = `http://127.0.0.1:${port}`;

	let rev = 0;
	let fresh: AnalyzeResult | null = null;
	let shown: AnalyzeResult | BaselinedResult | null = null;
	let state: UiState | null = null;
	let watching: number | null = null;
	const clients = new Set<import('node:http').ServerResponse>();

	// ── analysis ──────────────────────────────────────────────────────────────

	// The config is read once, at startup, and every run uses it. The file sits
	// in the watched root, so an edit to it re-runs the analysis with the old
	// one — a fresh timestamp over findings that do not reflect the edit. Its
	// bytes are kept so the page can say a restart is what applies it.
	const configFile = config.source.kind === 'file' ? config.source.path : null;
	const readConfig = (): string | null => {
		try {
			return configFile ? readFileSync(configFile, 'utf8') : null;
		} catch {
			return null;
		}
	};
	const configAtStart = readConfig();

	const snapshot = (): UiState => {
		if (!fresh || !shown) throw new Error('no analysis yet');
		const payload = reportPayload(shown, config);
		return {
			rev,
			ranAt: new Date().toISOString(),
			ms: 0,
			payload,
			fixable: shown.findings.flatMap((f, i) => (tokenFixes([f]).length > 0 ? [i] : [])),
			watching,
			baseline: { path: baselineTarget, found: baselineFound() },
			...(configFile && readConfig() !== configAtStart ? { configChanged: true } : {}),
		};
	};

	const push = (): void => {
		if (!state) return;
		const frame = `data: ${JSON.stringify(state)}\n\n`;
		for (const res of clients) res.write(frame);
	};

	/**
	 * One analysis, then the watch set rebuilt from what it could have read.
	 *
	 * The set is rebuilt every time rather than once at startup because a project
	 * grows directories while it is being worked on, and a watcher pinned to the
	 * tree as it was at boot goes quiet on exactly the files someone just added.
	 */
	/**
	 * After a write lands: the page's payload no longer describes the tree, so
	 * the revision moves before anything else can be aimed at it. Synchronous
	 * with the write — no await between the check and here — so nothing slips in.
	 */
	const wrote = (): void => {
		rev++;
		schedule(0);
	};
	/**
	 * When the latest analysis began reading the tree. A watch event can arrive
	 * after the run that already read its change — an editor's save is several
	 * events, and one of this server's writes is heard a moment late — and moving
	 * the revision for it would refuse the page's next write against a run that
	 * has seen everything. A file written before this, by its mtime, has been.
	 */
	let readFrom = 0;
	const alreadyRead = (path: string): boolean => {
		// A file that is gone was removed from its directory, which a removal
		// stamps: that directory's mtime says when.
		for (const p of [path, dirname(path)]) {
			try {
				return statSync(p).mtimeMs < readFrom;
			} catch {
				/* gone: ask its directory */
			}
		}
		return false;
	};

	const runOnce = async (): Promise<void> => {
		const started = Date.now();
		readFrom = started;
		const at = rev;
		const result = await analyze();
		// The tree moved while it was read — a write here, or a change the watch
		// saw — so this describes a state that is gone. Published, it would carry a
		// new and valid revision over old line numbers. The move queued a run of
		// its own, which `drain` takes next.
		if (rev !== at) return;
		fresh = result;
		shown = present(fresh);
		rev++;
		rewatch();
		state = { ...snapshot(), ms: Date.now() - started };
		push();
	};

	let running = false;
	let queued = false;
	let timer: NodeJS.Timeout | null = null;
	const drain = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			while (queued) {
				queued = false;
				try {
					await runOnce();
				} catch (err) {
					// A failed analysis must not read as a clean page, nor as a current
					// one: the last good payload stays, and the page says it is stale
					// and why. The terminal hears it too.
					log(`loupe: analysis failed — ${messageOf(err)}\n`);
					if (state) {
						state = { ...state, error: messageOf(err) };
						push();
					}
				}
			}
		} finally {
			running = false;
		}
	};
	const schedule = (delay = DEBOUNCE_MS): void => {
		queued = true;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void drain();
		}, delay);
	};

	// ── the watch ─────────────────────────────────────────────────────────────

	const watchers = new Map<string, FSWatcher>();
	function rewatch(): void {
		let dirs: Set<string>;
		try {
			// The analysis's own ceiling, so the two walks agree on what the tree is.
			const found = discover({ root, sources: config.sources, limit: analyzeEntryBudget(config.maxEntries) });
			dirs = new Set([root]);
			// Every directory between a file and the root as well: a folder created
			// under one that holds no file of its own is seen only from its parent.
			for (const f of [...found.styles, ...found.markup, ...found.references])
				for (let d = dirname(f.abs); d.length > root.length && !dirs.has(d); d = dirname(d)) dirs.add(d);
		} catch (err) {
			log(`loupe: cannot establish a watch — ${messageOf(err)}\n`);
			watching = null;
			return;
		}
		if (dirs.size > WATCH_CAP) {
			// Refused whole rather than partially: a watch over some of the tree
			// reports nothing for edits outside it, which reads exactly like no edit.
			log(`loupe: ${dirs.size} directories is past the watch ceiling of ${WATCH_CAP} — watching nothing.\n`);
			for (const w of watchers.values()) w.close();
			watchers.clear();
			watching = null;
			return;
		}
		for (const [dir, w] of watchers) {
			if (dirs.has(dir)) continue;
			w.close();
			watchers.delete(dir);
		}
		for (const dir of dirs) {
			if (watchers.has(dir)) continue;
			try {
				// `persistent: false`: the server holds the process open, and a watcher
				// that also did would keep it alive after the server closed.
				// The tree moved, so the page's payload no longer describes it: the
				// revision moves now, not when the run lands, or a write aimed at it
				// in between would name lines the editor has already shifted.
				const w = watch(dir, { persistent: false }, (_event, name) => {
					if (!name || !alreadyRead(join(dir, String(name)))) rev++;
					schedule();
				});
				w.on('error', () => {
					w.close();
					watchers.delete(dir);
					// The count goes with it. A watcher that died after `rewatch` set
					// the number — a directory removed under the reader, or inotify
					// hitting its ceiling — would otherwise leave the page reporting a
					// live watch it no longer has, which is the one thing this server
					// promises never to do.
					watching = watchers.size || null;
					if (state) state.watching = watching;
					push();
				});
				watchers.set(dir, w);
			} catch {
				// A directory that vanished between the walk and the watch is not an
				// error; the next run will not list it.
			}
		}
		watching = watchers.size;
	}

	// ── request plumbing ──────────────────────────────────────────────────────

	const send = (res: import('node:http').ServerResponse, status: number, value: unknown): void => {
		const text = JSON.stringify(value);
		res.writeHead(status, {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'content-length': Buffer.byteLength(text),
		});
		res.end(text);
	};

	const readBody = (req: import('node:http').IncomingMessage): Promise<unknown> =>
		new Promise((done, bad) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (c: Buffer) => {
				size += c.length;
				if (size > BODY_LIMIT) {
					bad(new Error('body too large'));
					req.destroy();
					return;
				}
				chunks.push(c);
			});
			req.on('end', () => {
				const raw = Buffer.concat(chunks).toString('utf8');
				if (!raw.trim()) return done({});
				try {
					done(JSON.parse(raw));
				} catch {
					bad(new Error('body is not JSON'));
				}
			});
			req.on('error', bad);
		});

	/**
	 * What a mutating request has to prove.
	 *
	 * Three checks, each closing a different door:
	 *
	 *   origin    a browser attaches `Origin` to any cross-site request. One that
	 *             is present and not ours is refused outright, whatever else it
	 *             carries.
	 *   token     the secret was handed only to the page this process served, and
	 *             a cross-origin reader cannot see a response to go and fetch it.
	 *             Sending it as a custom header also forces a preflight, which
	 *             this server answers for nobody.
	 *
	 * The revision — that the page's payload is the one still on disk — is each
	 * route's own check, made after its body is read: `/run` addresses nothing,
	 * so it has none, and is how a page whose revision fell behind catches up.
	 *
	 * Returns null when the request may proceed, or the refusal to send.
	 */
	const guard = (req: import('node:http').IncomingMessage): { status: number; error: string } | null => {
		const origin = req.headers.origin;
		if (typeof origin === 'string' && !isOurs(origin)) return { status: 403, error: 'cross-origin request refused' };
		const presented = req.headers[TOKEN_HEADER];
		if (typeof presented !== 'string' || !secretEquals(presented, token))
			return { status: 403, error: 'this page was not served by this process' };
		return null;
	};

	/**
	 * Is this origin the page we served?
	 *
	 * By the bound port and a loopback hostname, not by string equality with our
	 * own spelling of the URL. `localhost` and `127.0.0.1` are the same server and
	 * different origins, and a reader who typed the other one is not an attacker —
	 * they would otherwise load the page, watch it go live, and have every button
	 * refused as cross-origin.
	 */
	// `[::1]` as `URL` spells it, brackets and all.
	const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
	const isOurs = (origin: string): boolean => {
		try {
			const them = new URL(origin);
			const us = new URL(url);
			return them.protocol === 'http:' && them.port === us.port && LOOPBACK.has(them.hostname);
		} catch {
			return false;
		}
	};

	/**
	 * The revision a write was aimed at, re-read at the moment it is used.
	 *
	 * Checked again after the body has been read, not only in {@link guard}: the
	 * read is an await, and a re-analysis completing inside it swaps `shown` and
	 * bumps `rev` after the first check passed — which is exactly the plausible,
	 * wrong write the revision exists to refuse.
	 */
	const revCheck = (req: import('node:http').IncomingMessage): { status: number; error: string } | null => {
		const named = Number(req.headers[REV_HEADER]);
		if (!Number.isInteger(named) || named !== rev)
			return { status: 409, error: 'the tree moved since this page was drawn — reloading' };
		return null;
	};

	/** The finding an index names, or null. Bounds-checked because the index came off the wire. */
	const findingAt = (value: unknown): Finding | null => {
		if (!shown || !Number.isInteger(value)) return null;
		const i = value as number;
		return i >= 0 && i < shown.findings.length ? (shown.findings[i] ?? null) : null;
	};

	// ── routes ────────────────────────────────────────────────────────────────

	const routes: Record<
		string,
		(
			req: import('node:http').IncomingMessage,
			res: import('node:http').ServerResponse,
			q: URLSearchParams,
		) => void | Promise<void>
	> = {
		'GET /': (_req, res) => {
			const html = page({ token, root, editor });
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(html);
		},

		'GET /state': (_req, res) => {
			if (!state) return send(res, 503, { error: 'still analyzing' });
			send(res, 200, state);
		},

		// Byte-for-byte what `--format json` writes, exactly as `loupe serve`
		// answers it, so anything already pointed at that endpoint works here.
		// The payload `state` is already holding for this revision, not a second
		// build of it: `reportPayload` walks the findings four times and clones
		// every one, and the answer for a given `rev` cannot differ.
		'GET /findings.json': (_req, res) => {
			if (!state) return send(res, 503, { error: 'still analyzing' });
			send(res, 200, state.payload);
		},

		'GET /events': (_req, res) => {
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store',
				connection: 'keep-alive',
			});
			res.write(': open\n\n');
			clients.add(res);
			if (state) res.write(`data: ${JSON.stringify(state)}\n\n`);
			res.on('close', () => clients.delete(res));
		},

		/**
		 * A window of source around a finding.
		 *
		 * The allowlist is the current run's own findings rather than a path check
		 * against the root: a comparison of resolved prefixes has to get symlinks,
		 * case-insensitive volumes and `..` all right to be safe, and a set of
		 * paths the analyzer just reported has none of those questions in it.
		 */
		'GET /source': (_req, res, q) => {
			const want = q.get('file');
			if (!shown || !want) return send(res, 400, { error: 'name a file' });
			const known = new Set(shown.findings.map((f) => f.file));
			if (!known.has(want)) return send(res, 404, { error: 'not a file in this run' });
			const asked = Number(q.get('line') ?? 1);
			const at = Number.isInteger(asked) && asked > 0 ? asked : 1;
			try {
				const lines = readFileSync(join(root, want), 'utf8').split('\n');
				const from = Math.max(1, at - PEEK);
				const to = Math.min(lines.length, at + PEEK);
				send(res, 200, { file: want, from, to, lines: lines.slice(from - 1, to) });
			} catch (err) {
				send(res, 404, { error: messageOf(err) });
			}
		},

		'POST /run': async (_req, res) => {
			send(res, 200, { rev });
			schedule(0);
		},

		'POST /fix': async (req, res) => {
			const payload = (await readBody(req)) as { findings?: unknown } | null;
			const stale = revCheck(req);
			if (stale) return send(res, stale.status, { error: stale.error });
			const asked = Array.isArray(payload?.findings) ? payload.findings : [];
			const picked = asked.map(findingAt).filter((f): f is Finding => f !== null);
			if (!picked.length) return send(res, 400, { error: 'no finding named' });
			const { applied, skipped } = applyTokenFixes(root, picked);
			send(res, 200, {
				applied: applied.length,
				skipped: skipped.map((s) => ({ file: s.file, line: s.line, why: s.why })),
			});
			if (applied.length) wrote();
		},

		'POST /baseline': async (req, res) => {
			const stale = revCheck(req);
			if (stale) return send(res, stale.status, { error: stale.error });
			if (!fresh) return send(res, 503, { error: 'still analyzing' });
			try {
				send(res, 200, writeBaseline(baselineTarget, fresh));
			} catch (err) {
				return send(res, 500, { error: messageOf(err) });
			}
			wrote();
		},

		/**
		 * Write a suppression directive above the finding.
		 *
		 * The reason is required here, where the language server's quick fix leaves
		 * it blank. That is not a disagreement: a quick fix has nowhere to ask, so
		 * it writes a directive that reports as `suppression/malformed` until a
		 * person fills it in. A page can ask, so it does, and refuses the write
		 * rather than committing a silence nobody signed.
		 */
		'POST /suppress': async (req, res) => {
			const payload = (await readBody(req)) as { finding?: unknown; reason?: unknown } | null;
			const stale = revCheck(req);
			if (stale) return send(res, stale.status, { error: stale.error });
			const finding = findingAt(payload?.finding);
			const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
			if (!finding) return send(res, 400, { error: 'no finding named' });
			if (!reason) return send(res, 400, { error: 'a suppression needs a reason' });
			// As `applyKeeps` refuses it: a directive line in markup lands among JSX
			// children, where it renders as text or breaks the parse.
			if (!CSS_FILE.test(finding.file))
				return send(res, 409, { error: 'only a stylesheet finding is muted from here — suppress markup by hand' });
			// A reason spanning lines would end the comment early on the first one.
			const flat = oneLine(reason);
			const full = join(root, finding.file);
			try {
				const lines = readFileSync(full, 'utf8').split('\n');
				const target = lines[finding.line - 1];
				if (target === undefined) return send(res, 409, { error: 'that line is no longer in the file' });
				// The two refusals `applyKeeps` makes, made here for the same reasons —
				// this endpoint writes the same directive into the same place, so it has
				// to decline the same writes or the two surfaces disagree about what a
				// mute means.
				//
				// A directive above a rule's opening line covers the rule's whole scope,
				// so muting one row would mute every row in that rule.
				if (/(?:^|[^#])\{/.test(target))
					return send(res, 409, {
						error: "on the rule's opening line, where a directive would mute the whole rule — suppress it by hand",
					});
				// Only the nearest line above is read, so splicing in front of a
				// directive already there pushes it off what it names, and the finding
				// somebody already accepted comes back.
				if ((shown?.directives ?? []).some((d) => d.file === finding.file && d.line === finding.line - 1))
					return send(res, 409, {
						error: 'the line above already carries a directive — add the rule to it by hand',
					});
				// Spaces and tabs only, and the line's own ending, so a CRLF file stays
				// one. Both as `applyKeeps` does it.
				const indent = /^[ \t]*/.exec(target)?.[0] ?? '';
				const eol = target.endsWith('\r') ? '\r' : '';
				const directive = commentFor(finding.file, `${config.suppression.keyword} ${finding.rule} -- ${flat}`);
				lines.splice(finding.line - 1, 0, `${indent}${directive}${eol}`);
				writeFileSync(full, lines.join('\n'));
				wrote();
				send(res, 200, { file: finding.file, line: finding.line, rule: finding.rule });
			} catch (err) {
				return send(res, 500, { error: messageOf(err) });
			}
		},
	};

	// ── the server ────────────────────────────────────────────────────────────

	const server = createServer((req, res) => {
		// No `access-control-allow-origin`, anywhere, on purpose: this server
		// rewrites files, and a reader on another origin has no business here.
		//
		// The parse is guarded because a request target is not a URL: `GET //` is
		// well-formed HTTP and `new URL('//', base)` throws, and a throw here is in
		// the server's own callback — uncaught, which ends the process.
		let parsed: URL;
		try {
			parsed = new URL(req.url ?? '/', url);
		} catch {
			return send(res, 400, { error: 'not a request this server can address' });
		}
		// Loopback by `Host`, not only by bind address. A name that resolves to
		// 127.0.0.1 reaches this server and is a different origin to the browser, so
		// an attacker page that rebinds its own hostname is same-origin with it and
		// can read the answers — including `GET /`, which carries the write token.
		// The GET surface has no other guard, so this is the one that covers it.
		if (!isOurs(`http://${req.headers.host ?? ''}`))
			return send(res, 403, { error: 'this server answers loopback only' });
		const key = `${req.method ?? 'GET'} ${parsed.pathname}`;
		const route = routes[key];
		if (!route) {
			// A refused method on a path that exists is not a missing path.
			const exists = Object.keys(routes).some((k) => k.endsWith(` ${parsed.pathname}`));
			return send(res, exists ? 405 : 404, { error: exists ? 'method not allowed' : 'not found' });
		}
		if (req.method === 'POST') {
			const refusal = guard(req);
			if (refusal) return send(res, refusal.status, { error: refusal.error });
		}
		Promise.resolve(route(req, res, parsed.searchParams)).catch((err: unknown) => {
			if (!res.headersSent) send(res, 500, { error: messageOf(err) });
		});
	});

	// A dead client on a loopback socket is detected by the write failing, but an
	// idle proxy or a slept laptop can leave one hanging. The comment costs
	// nothing and keeps the page's own dot honest.
	const beat = setInterval(() => {
		for (const res of clients) res.write(': beat\n\n');
	}, 25_000);
	beat.unref();

	await new Promise<void>((done, bad) => {
		server.on('error', bad);
		// Loopback explicitly. The default binds every interface, which on a shared
		// network would publish a writer for this repository.
		server.listen(port, '127.0.0.1', () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') url = `http://127.0.0.1:${addr.port}`;
			done();
		});
	});

	const close = (): Promise<void> =>
		new Promise((done) => {
			clearInterval(beat);
			if (timer) clearTimeout(timer);
			for (const w of watchers.values()) w.close();
			watchers.clear();
			for (const res of clients) res.end();
			clients.clear();
			server.close(() => done());
		});

	// The first analysis runs before the URL is handed back, so the page a reader
	// opens has something to draw rather than a spinner that may never resolve.
	//
	// It is also the one `runOnce` outside `drain`'s catch, so its failure has to
	// give the socket back by hand: the caller only reports what it is thrown, and
	// a listening server nobody holds a handle to keeps the process alive — `loupe
	// ui` would print that it could not start and then never exit, still serving
	// the write token on a port the retry now cannot bind.
	try {
		await runOnce();
	} catch (err) {
		await close();
		// Re-thrown without whatever `code` the analysis error carried: the caller
		// reads that field to explain a *bind* failure, and an EACCES from reading a
		// source file would otherwise be reported as a port it may not bind.
		throw new Error(`the first analysis failed — ${messageOf(err)}`);
	}

	return { url, close };
}
