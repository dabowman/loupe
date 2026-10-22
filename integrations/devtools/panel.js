/**
 * The panel: every finding, resolved against the page in front of you.
 *
 * This is `loupe serve`'s overlay with the bookmarklet taken off. Two things
 * change by being in DevTools rather than injected into the document, and they
 * are the reasons the extension exists at all:
 *
 *   it survives navigation  — a bookmarklet injects into the current document
 *                             and is gone on the next one. This re-resolves.
 *   it is not in the page   — no fixed panel over the app, nothing intercepting
 *                             the clicks of the thing you are testing.
 *
 * What it does *not* do is write. `loupe ui` is the surface that rewrites files,
 * and it answers only the page it served; this reads `loupe serve`, which
 * publishes to any origin because that is what it is for.
 */

let payload = null;
let port = DEFAULT_PORT;
let pinned = null;
let filter = '';
let snapshot = [];

const el = (id) => document.getElementById(id);
const setStatus = (cls, text) => {
	el('dot').className = `dot ${cls}`;
	el('status').textContent = text;
};

/**
 * Re-ask the page. One eval for the whole list: a call per finding would cost a
 * round trip each across the DevTools boundary, and a 200-finding project would
 * spend a visible second on it.
 */
async function resolve() {
	if (!payload) return;
	await installMatcher();
	await evalInPage(`window.__loupeMatch.load(${JSON.stringify(payload.findings.map((f) => ({ selector: f.selector, media: f.media, severity: f.severity })))}, 'panel')`);
	snapshot = (await evalInPage("window.__loupeMatch.snapshot('panel')")) || [];
	render();
}

async function load() {
	setStatus('busy', 'loading…');
	try {
		payload = await fetchFindings(port);
	} catch (err) {
		payload = null;
		snapshot = [];
		setStatus('off', 'not connected');
		el('rows').innerHTML = offlineHtml(port, err.message);
		el('note').textContent = '';
		return;
	}
	pinned = null;
	// Separately, because a page that cannot be evaluated is not a server that is
	// not there. `inspectedWindow.eval` refuses on a restricted origin and while a
	// navigation is in flight, and reporting that as "no loupe server on port N"
	// sends the reader to restart a server that answered — and nulls the payload,
	// so `onNavigated` can no longer recover on its own.
	try {
		await resolve();
		const s = payload.summary;
		setStatus('on', `${s.error} error · ${s.warn} warn · ${s.filesScanned} files`);
	} catch (err) {
		snapshot = [];
		setStatus('busy', 'cannot read the page');
		el('rows').innerHTML = `<div class="empty">${esc(err.message)}<br><br><span class="status">The findings loaded; the page could not be asked about them. Reload the page, or press refresh.</span></div>`;
		el('note').textContent = '';
	}
}

/** The sorted, filtered list. Ordering is the matcher's `bucket`; this only breaks its ties. */
function rows() {
	const needle = filter.toLowerCase();
	return snapshot
		.map((r) => ({ ...r, f: payload.findings[r.i] }))
		.filter((r) => r.f && (!needle || `${r.f.file} ${r.f.message} ${r.f.rule}`.toLowerCase().includes(needle)))
		.sort((a, b) => {
			if (a.bucket !== b.bucket) return a.bucket - b.bucket;
			if (a.f.severity !== b.f.severity) return a.f.severity === 'error' ? -1 : 1;
			return b.n - a.n;
		});
}

function render() {
	if (!payload) return;
	const rs = rows();
	const live = rs.filter((r) => r.n > 0 && r.on).length;
	const offwidth = rs.filter((r) => r.n > 0 && !r.on).length;

	el('rows').innerHTML = rs.length
		? rs
				.map((r) => {
					const f = r.f;
					const kind = r.n > 0 ? (r.on ? '' : ' offwidth') : r.n === 0 ? ' dead' : ' nodom';
					const hit =
						r.n > 0
							? `<span class="hits${r.on ? '' : ' zero'}">${r.n} on page</span>`
							: r.n === 0
								? '<span class="hits zero">0 on page</span>'
								: '<span class="hits zero">no selector</span>';
					return (
						`<div class="row${kind}${pinned === r.i ? ' on' : ''}" data-i="${r.i}">` +
						findingBody(f, hit, condChip(f, r.on)) +
						'</div>'
					);
				})
				.join('')
		: '<div class="empty">No findings match.</div>';

	// The same sentence the overlay closes on, and for the same reason: a panel
	// that shows six of two hundred findings has to say so, or it reads as a
	// verdict on the project rather than a view of this page.
	el('note').textContent =
		`${live} of ${rs.length} are styling elements here` +
		(offwidth ? `, ${offwidth} more only at another width` : '') +
		'. The rest are in source this page does not render — the terminal still has them all.';

	// Rendered from `rs` in order, so the row is its position — not a scan of `rs`
	// per node, which is quadratic on a render that runs on every keystroke.
	for (const [k, node] of [...el('rows').querySelectorAll('.row')].entries()) {
		const row = rs[k];
		const i = row.i;
		node.onmouseenter = () => {
			if (pinned === null) void evalInPage(`window.__loupeMatch.highlight(${i}, 'panel')`).catch(() => {});
		};
		node.onmouseleave = () => {
			if (pinned === null) void evalInPage('window.__loupeMatch.clear()').catch(() => {});
		};
		node.onclick = () => {
			if (!row || row.n <= 0) return;
			pinned = pinned === i ? null : i;
			const expr =
				pinned === null
					? 'window.__loupeMatch.clear()'
					: `(function(){window.__loupeMatch.highlight(${i}, 'panel');window.__loupeMatch.scrollTo(${i}, 'panel');})()`;
			void evalInPage(expr).catch(() => {});
			render();
		};
	}
}

el('refresh').onclick = () => void load();
el('q').oninput = (e) => {
	filter = e.target.value;
	pinned = null;
	render();
};
el('port').onchange = async (e) => {
	port = Number(e.target.value) || DEFAULT_PORT;
	el('port').value = String(port);
	await writePort(port);
	void load();
};

// A navigation replaces the document, so the matcher and its findings are gone
// with it. The payload is still good — it describes the source, not the page —
// so only the resolving is redone.
chrome.devtools.network.onNavigated.addListener(() => {
	pinned = null;
	if (payload) void resolve().catch(() => {});
});

(async () => {
	port = await readPort();
	el('port').value = String(port);
	await load();
})();
