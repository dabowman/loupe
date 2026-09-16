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

import type { Pattern, PatternNode } from './types.ts';

/**
 * `"Stack"` → any `Stack`; `"@wordpress/components::Stack"` → that package's.
 *
 * Qualifying is opt-in per node. A registry scoped by its own `packages` field
 * (see registry.ts) needs none of this; qualification is for the project that
 * imports two systems at once and needs `Stack` to mean one of them.
 */
const split = (spec: string): { name: string; pkg: string | null } => {
	const i = spec.indexOf('::');
	return i === -1 ? { name: spec, pkg: null } : { name: spec.slice(i + 2), pkg: spec.slice(0, i) || null };
};

/** `[name, ...children]` → `{ name, pkg, children }`. A bare string is a leaf. */
export function toNode(spec: unknown): PatternNode | null {
	if (typeof spec === 'string') return { ...split(spec), children: [] };
	if (!Array.isArray(spec) || !spec.length || typeof spec[0] !== 'string') return null;
	return {
		...split(spec[0]),
		children: spec.slice(1).map(toNode).filter((n): n is PatternNode => n !== null),
	};
}

export const signatureOf = (node: PatternNode): string =>
	node.children.length ? `${node.name}(${node.children.map(signatureOf).join(',')})` : node.name;

export const nodeCount = (node: PatternNode): number =>
	1 + node.children.reduce((n, c) => n + nodeCount(c), 0);
export const depthOf = (node: PatternNode): number =>
	node.children.length ? 1 + Math.max(...node.children.map(depthOf)) : 1;

/** Every node below `tree`, nearest first. */
function descendants(tree: PatternNode, out: PatternNode[] = []): PatternNode[] {
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
/**
 * `"Stack"` matches `Stack`; `"Stack|VStack|HStack"` matches any of the three.
 *
 * One shape often has more than one spelling — `ToggleGroupControlOption` and
 * `ToggleGroupControlOptionIcon` are the same segmented control, and the same
 * modal footer is written with `Stack` in new code and `VStack` in old. Without
 * this, each spelling needs its own registry entry, and the ones nobody wrote
 * come back as `unregistered-composite` noise against code that is in fact
 * using the pattern. Only pattern nodes carry alternations; a tree built from
 * real code is always one name.
 */
const nameMatches = (spec: string, actual: string): boolean =>
	spec === actual || (spec.includes('|') && spec.split('|').includes(actual));

export function matches(pattern: PatternNode, tree: PatternNode): boolean {
	if (!nameMatches(pattern.name, tree.name)) return false;
	// Only when both sides know: an unqualified pattern node matches any package,
	// and a tree node whose import could not be resolved is not evidence of a
	// mismatch. Qualification narrows a match, it never invents one.
	if (pattern.pkg && tree.pkg && pattern.pkg !== tree.pkg) return false;
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

/**
 * Is every node of `tree` a part of the component `root`?
 *
 * A part is the root's name followed by a `.` (`Menu.Item`) or by a new
 * PascalCase word (`MenuItem`). A lowercase continuation is another component
 * that happens to share the spelling — `Menubar`, `Fieldset`.
 */
export function partsOf(root: string, tree: PatternNode): boolean {
	return (
		tree.name.startsWith(root) &&
		/^([.A-Z]|$)/.test(tree.name.slice(root.length)) &&
		tree.children.every((c) => partsOf(root, c))
	);
}

/** A registry entry as authored: only `signature` is load-bearing. */
interface RawPattern {
	id?: string;
	summary?: string;
	canonical?: string | null;
	signature?: unknown;
	instead_of_signature?: unknown;
}

/** Normalize a registry file or inline array into matchable patterns. */
export function loadPatterns(raw: unknown): Pattern[] {
	const list: RawPattern[] = Array.isArray(raw)
		? raw
		: ((raw as { patterns?: RawPattern[] } | null)?.patterns ?? []);
	const out: Pattern[] = [];
	for (const p of list) {
		const node = toNode(p?.signature);
		if (!node) continue;
		// A list of shapes, or — because `signature` next to it takes exactly one —
		// a single shape written directly. A list never starts with a string, so
		// the leading element settles it. Without this, `["Modal", ["VStack", …]]`
		// read as four separate anti-shapes: the `"Modal"` that gave the rest its
		// context dropped under the floor, and the nested child survived as a
		// standalone shape far broader than anything the author asked for.
		const authored: unknown = p?.instead_of_signature;
		const shapes: unknown[] = !Array.isArray(authored)
			? []
			: typeof authored[0] === 'string'
				? [authored]
				: authored;
		out.push({
			id: p.id || signatureOf(node),
			summary: p.summary ?? '',
			canonical: p.canonical ?? null,
			node,
			size: nodeCount(node),
			// An anti-shape below the floor would fire on half a codebase: a bare
			// `SelectControl` is one node and says nothing about whether the
			// choice it presents wanted a segmented control instead.
			avoid: shapes
				.map((shape) => toNode(shape))
				.filter((n): n is PatternNode => n !== null && nodeCount(n) >= SUBSTANTIAL.minNodes),
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
export function systemTree<E extends object>(
	el: E,
	isSystemName: (name: string) => boolean,
	childrenOf: (el: E) => E[],
	nameOf: (el: E) => string | null,
	packageOf: (name: string) => string | null = () => null,
	/** Only the root carries one; the walk descends into the host AST's own nodes. */
	line?: number,
): PatternNode | null {
	const name = nameOf(el);
	if (!name || !isSystemName(name)) return null;
	return {
		name,
		pkg: packageOf(name),
		children: systemChildren(el, isSystemName, childrenOf, nameOf, packageOf),
		...(line === undefined ? {} : { line }),
	};
}

function systemChildren<E extends object>(
	el: E,
	isSystemName: (name: string) => boolean,
	childrenOf: (el: E) => E[],
	nameOf: (el: E) => string | null,
	packageOf: (name: string) => string | null,
): PatternNode[] {
	const out: (PatternNode | null)[] = [];
	for (const child of childrenOf(el)) {
		const cname = nameOf(child);
		if (cname && isSystemName(cname)) out.push(systemTree(child, isSystemName, childrenOf, nameOf, packageOf));
		else out.push(...systemChildren(child, isSystemName, childrenOf, nameOf, packageOf));
	}
	return out.filter((n): n is PatternNode => n !== null);
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
