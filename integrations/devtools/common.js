/**
 * What the panel and the sidebar both need: a connection to `loupe serve`, and
 * a way to ask the inspected page a question.
 *
 * Both surfaces are separate documents with separate lifetimes, so this is
 * duplicated state by construction — each holds its own payload. They agree
 * because they read the same endpoint and install the same matcher, not because
 * they share an object.
 */

/** Where `loupe serve` listens unless told otherwise. */
const DEFAULT_PORT = 7331;

/**
 * Evaluate in the inspected page.
 *
 * `inspectedWindow.eval` reports two different kinds of failure and they mean
 * opposite things: `isException` is the page's own error, worth showing, while
 * an `isError` result is DevTools refusing to evaluate at all — usually because
 * the page is still loading or is a restricted origin. Collapsing them would
 * report a page bug as a tooling bug.
 */
function evalInPage(expression) {
	return new Promise((resolve, reject) => {
		chrome.devtools.inspectedWindow.eval(expression, (result, info) => {
			if (info && info.isException) return reject(new Error(String(info.value || 'the page threw')));
			if (info && info.isError) return reject(new Error(String(info.description || info.code || 'cannot evaluate here')));
			resolve(result);
		});
	});
}

/**
 * Put the matcher in the page, if it is not already there.
 *
 * Called before every question rather than once: a DevTools panel outlives the
 * page it is looking at, and after a navigation the page is a new one with
 * nothing installed. The matcher's own guard makes the repeat free.
 */
async function installMatcher() {
	await evalInPage(globalThis.LOUPE_MATCH_SRC);
	const version = await evalInPage('window.__loupeMatch && window.__loupeMatch.version');
	if (version !== globalThis.LOUPE_MATCH_VERSION)
		throw new Error(`the page has matcher v${version}, this extension speaks v${globalThis.LOUPE_MATCH_VERSION}`);
}

/** The port the reader last used, shared between the two surfaces. */
async function readPort() {
	try {
		const got = await chrome.storage.local.get('port');
		return Number(got.port) || DEFAULT_PORT;
	} catch {
		return DEFAULT_PORT;
	}
}
async function writePort(port) {
	try {
		await chrome.storage.local.set({ port: Number(port) || DEFAULT_PORT });
	} catch {
		/* a reader who cannot persist a port can still type one */
	}
}

/**
 * The findings, from the server.
 *
 * `loupe serve` and `loupe ui` both publish `/findings.json`, and `serve` sends
 * `access-control-allow-origin: *` because being read from another origin is its
 * whole purpose. `ui` deliberately does not — it rewrites files, so it answers
 * only the page it served — which is why this asks for `serve` by default and
 * says so when the request is refused.
 */
async function fetchFindings(port) {
	const res = await fetch(`http://127.0.0.1:${port}/findings.json`, { cache: 'no-store' });
	if (!res.ok) throw new Error(`the server answered ${res.status}`);
	const payload = await res.json();
	if (!payload || !Array.isArray(payload.findings)) throw new Error('that is not a loupe payload');
	return payload;
}

const esc = (s) =>
	String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One finding's two-line body, shared so the panel and the sidebar read alike. */
function findingBody(f, hitHtml, condHtml) {
	const glyph = f.severity === 'error' ? '✗' : '•';
	return (
		`<div class="top"><span class="sev ${f.severity === 'error' ? 'error' : 'warn'}">${glyph}</span>` +
		`<span class="rule">${esc(f.rule)}</span></div>` +
		`<div class="msg">${esc(f.message)}</div>` +
		`<div class="meta"><span>${esc(f.file)}:${f.line}</span>${hitHtml}${condHtml}</div>`
	);
}

/** The `@media` chip, shown whenever there is one — not only when it fails. */
function condChip(f, on) {
	if (!f.media) return '';
	return `<span class="cond${on ? ' on' : ''}">@media ${esc(f.media)}${on ? '' : ' — not at this width'}</span>`;
}

/** What to say when the server is not there. It is the likeliest state, so it is the clearest. */
function offlineHtml(port, message) {
	return (
		`<div class="empty"><b>No loupe server on port ${esc(port)}.</b><br><br>` +
		`Start one in the project:<br><code>loupe serve --port ${esc(port)}</code><br><br>` +
		`<span class="status">${esc(message)}</span></div>`
	);
}
