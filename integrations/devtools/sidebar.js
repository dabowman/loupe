/**
 * The Elements sidebar: what is wrong with the node you just selected.
 *
 * This is the inversion, and the one surface that could not have been a
 * bookmarklet — it needs the Elements panel's selection, which is a DevTools
 * concept and does not exist in the page.
 *
 * Every other output loupe has starts from the findings and asks where they are.
 * A person in DevTools has already found the thing that looks wrong; the
 * question they actually have is the other one, and until now the only way to
 * answer it was to read a list of two hundred and guess which rows were about
 * this element.
 *
 * `$0` is DevTools' handle on the selection inside an `eval`. The matching is
 * done in the page, where the node is — passing a node back across the boundary
 * is not possible, and reconstructing a selector for it would be a second,
 * worse matcher.
 */

let payload = null;
let port = DEFAULT_PORT;

const el = (id) => document.getElementById(id);
const setStatus = (cls, text) => {
	el('dot').className = `dot ${cls}`;
	el('status').textContent = text;
};

async function load() {
	setStatus('busy', 'loading…');
	try {
		payload = await fetchFindings(port);
		setStatus('on', `${payload.findings.length} findings`);
		await show();
	} catch (err) {
		payload = null;
		setStatus('off', 'not connected');
		el('sel').textContent = '';
		el('rows').innerHTML = offlineHtml(port, err.message);
	}
}

async function show() {
	if (!payload) return;
	try {
		await installMatcher();
		await evalInPage(
			`window.__loupeMatch.load(${JSON.stringify(payload.findings.map((f) => ({ selector: f.selector, media: f.media, severity: f.severity })))}, 'sidebar')`,
		);
		// Two facts in one round trip: what is selected, and what is wrong with it.
		const answer = await evalInPage(
			'(function(){ if (!$0) return null; return { tag: $0.tagName.toLowerCase(),' +
				' cls: ($0.getAttribute("class") || ""), hits: window.__loupeMatch.forElement($0, \'sidebar\') }; })()',
		);
		render(answer);
	} catch (err) {
		el('rows').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
	}
}

function render(answer) {
	if (!answer) {
		el('sel').textContent = '';
		el('rows').innerHTML = '<div class="empty">Select an element in the Elements panel.</div>';
		return;
	}
	el('sel').textContent = answer.tag + (answer.cls ? `.${answer.cls.trim().split(/\s+/).join('.')}` : '');

	const hits = answer.hits || [];
	if (!hits.length) {
		// "Nothing here" is a real answer and has to read as one. A blank pane
		// reads as a broken pane.
		el('rows').innerHTML =
			'<div class="empty">No finding styles this element.<br><br>' +
			'<span class="status">Findings anchored in JSX rather than a stylesheet carry no selector ' +
			'and can never appear here — the panel lists those.</span></div>';
		return;
	}
	el('rows').innerHTML = hits
		.map((h) => {
			const f = payload.findings[h.i];
			if (!f) return '';
			// No hit count: the count is one, and it is the element in the Elements
			// panel above. What varies here is whether the condition holds.
			return `<div class="row${h.on ? '' : ' offwidth'}">${findingBody(f, '', condChip(f, h.on))}</div>`;
		})
		.join('');
}

el('refresh').onclick = () => void load();
// The panel owns the port box; this pane has none, so it follows the stored
// value. Without this it keeps asking the port it read at startup and says the
// server is missing, while the panel next to it is connected to the new one.
try {
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes.port) return;
		const next = Number(changes.port.newValue) || DEFAULT_PORT;
		if (next === port) return;
		port = next;
		void load();
	});
} catch {
	/* a reader whose storage is unavailable still gets the default port */
}
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => void show());
// A navigation invalidates the installed matcher, and the selection with it.
chrome.devtools.network.onNavigated.addListener(() => void show().catch(() => {}));

(async () => {
	port = await readPort();
	await load();
})();
