/**
 * Composite conformance.
 *
 * Component-level drift is the cheap half. The expensive half is
 * compositional: a codebase ends up with six page headers and four modal
 * footers, each individually defensible, collectively a maintenance tax nobody
 * chose. No per-file linter can see it, because every instance looks fine on
 * its own — the finding only exists across files.
 *
 * A signature is the design-system component tree with everything else dropped:
 * props, text and raw elements are all transparent, so an intervening `<div>`
 * never hides a match and a prop change never invents one.
 *
 * Matching is containment, not equality. A registered pattern matches when its
 * children appear among the subtree's children *in order* — a header with one
 * extra button is still that header, and demanding equality would mean the
 * rules only ever fired on code that already came from the pattern.
 */

/** `[name, ...children]` → `{ name, children }`. A bare string is a leaf. */
export function toNode(spec) {
	if (typeof spec === 'string') return { name: spec, children: [] };
	if (!Array.isArray(spec) || !spec.length || typeof spec[0] !== 'string') return null;
	return { name: spec[0], children: spec.slice(1).map(toNode).filter(Boolean) };
}

export const signatureOf = (node) =>
	node.children.length ? `${node.name}(${node.children.map(signatureOf).join(',')})` : node.name;

export const nodeCount = (node) => 1 + node.children.reduce((n, c) => n + nodeCount(c), 0);
export const depthOf = (node) => (node.children.length ? 1 + Math.max(...node.children.map(depthOf)) : 1);

/** Every node below `tree`, nearest first. */
function descendants(tree, out = []) {
	for (const c of tree.children) {
		out.push(c);
		descendants(c, out);
	}
	return out;
}

/**
 * Does `pattern` occur within `tree`?
 *
 * A registered child has to appear *somewhere* beneath the root, not as a
 * direct sibling in a fixed order. `form-modal` records its footer as a sibling
 * of the body; real code nests the footer inside the body, and both are the
 * same composition. Requiring the recorded shape exactly meant the rule only
 * ever matched code that had already been generated from the pattern — the one
 * case where there is nothing to report.
 *
 * Each registered child must claim a distinct node, so `["VStack","Text","Text"]`
 * needs two Texts rather than matching one twice. Assignment is greedy, largest
 * child first; a registered pattern is a handful of nodes, so the cases where
 * greedy loses to a smarter assignment do not arise in practice.
 */
export function matches(pattern, tree) {
	if (pattern.name !== tree.name) return false;
	if (!pattern.children.length) return true;
	const pool = descendants(tree);
	const used = new Set();
	const wanted = [...pattern.children].sort((a, b) => nodeCount(b) - nodeCount(a));
	for (const want of wanted) {
		const idx = pool.findIndex((n, i) => !used.has(i) && matches(want, n));
		if (idx === -1) return false;
		used.add(idx);
	}
	return true;
}

/** Normalize a registry file or inline array into matchable patterns. */
export function loadPatterns(raw) {
	const list = Array.isArray(raw) ? raw : raw?.patterns || [];
	const out = [];
	for (const p of list) {
		const node = toNode(p.signature);
		if (!node) continue;
		out.push({
			id: p.id || signatureOf(node),
			summary: p.summary || '',
			canonical: p.canonical || null,
			node,
			size: nodeCount(node),
		});
	}
	return out;
}

/**
 * The design-system component tree rooted at a JSX element.
 *
 * Raw elements are transparent: their system-component descendants are lifted
 * to the nearest system ancestor, so `<HStack><div><Button/></div></HStack>`
 * and `<HStack><Button/></HStack>` have the same signature — which is the point,
 * since they are the same composition.
 */
export function systemTree(el, isSystemName, childrenOf, nameOf) {
	const name = nameOf(el);
	if (!name || !isSystemName(name)) return null;
	return { name, children: systemChildren(el, isSystemName, childrenOf, nameOf), line: el.line };
}

function systemChildren(el, isSystemName, childrenOf, nameOf) {
	const out = [];
	for (const child of childrenOf(el)) {
		const cname = nameOf(child);
		if (cname && isSystemName(cname)) out.push(systemTree(child, isSystemName, childrenOf, nameOf));
		else out.push(...systemChildren(child, isSystemName, childrenOf, nameOf));
	}
	return out.filter(Boolean);
}

/**
 * Floors that keep the rules from firing on every two-component pairing.
 *
 * A three-node signature like `HStack(Button,Button)` is a true description of
 * an action bar and a useless finding: it matched 48 files in one repo, and
 * "you have 48 action bars" is not a defect anyone can act on. Below this size a
 * registry entry is documentation for a person, not a check.
 */
export const SUBSTANTIAL = { minNodes: 4, minDepth: 2 };
