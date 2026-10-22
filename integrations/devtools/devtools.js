/**
 * Registration, and nothing else.
 *
 * Two surfaces, because they answer opposite questions:
 *
 *   panel     "where are these findings" — the list, resolved against the page
 *   sidebar   "what is wrong with *this*" — the inversion, on the selected node
 *
 * The sidebar is the one that could not exist as a bookmarklet: it needs the
 * Elements panel's selection, which is a DevTools concept.
 */

chrome.devtools.panels.create('Loupe', '', 'panel.html');

chrome.devtools.panels.elements.createSidebarPane('Loupe', (pane) => {
	pane.setPage('sidebar.html');
});
