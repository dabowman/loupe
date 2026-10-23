/**
 * Composite conformance — the drift no per-file linter can see, because every
 * instance looks fine on its own and the finding only exists across files.
 *
 * A signature is the design-system component tree with everything else dropped:
 * props, text and raw elements are all transparent, so an intervening `<div>`
 * never hides a match and a prop change never invents one.
 *
 * Matching is containment, not equality: a registered pattern matches when its
 * children appear among the subtree's children *in order*.
 *
 * Design notes: docs/design/analysis.md#composite-signatures
 */

import { listOf } from './json.ts';
import type { Pattern, PatternNode, RuleSpec } from './types.ts';

/**
 * `"Stack"` → any `Stack`; `"@wordpress/components::Stack"` → that package's.
 * Qualifying is opt-in per node, for the project that imports two systems at
 * once; a registry scoped by its own `packages` field needs none of it.
 *
 * A leading `>` pins the node to its parent's direct children — see `matches`.
 */
const split = (raw: string): { name: string; pkg: string | null; direct?: true } => {
	const direct = raw.startsWith('>');
	const spec = direct ? raw.slice(1).trimStart() : raw;
	const i = spec.indexOf('::');
	const named = i === -1 ? { name: spec, pkg: null } : { name: spec.slice(i + 2), pkg: spec.slice(0, i) || null };
	return direct ? { ...named, direct } : named;
};

/** `[name, ...children]` → `{ name, pkg, children }`. A bare string is a leaf. */
export function toNode(spec: unknown): PatternNode | null {
	if (typeof spec === 'string') return { ...split(spec), children: [] };
	if (!Array.isArray(spec) || !spec.length || typeof spec[0] !== 'string') return null;
	return {
		...split(spec[0]),
		children: spec
			.slice(1)
			.map(toNode)
			.filter((n): n is PatternNode => n !== null),
	};
}

export const signatureOf = (node: PatternNode): string =>
	node.children.length ? `${node.name}(${node.children.map(signatureOf).join(',')})` : node.name;

export const nodeCount = (node: PatternNode): number => 1 + node.children.reduce((n, c) => n + nodeCount(c), 0);
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
 * `"Stack"` matches `Stack`; `"Stack|VStack|HStack"` matches any of the three —
 * one shape often has more than one spelling. Only pattern nodes carry
 * alternations; a tree built from real code is always one name.
 */
const nameMatches = (spec: string, actual: string): boolean =>
	spec === actual || (spec.includes('|') && spec.split('|').includes(actual));

/**
 * Does `pattern` occur within `tree`?
 *
 * A registered child has to appear *somewhere* beneath the root, not as a direct
 * sibling in a fixed order — `form-modal` records its footer as a sibling of the
 * body and real code nests it inside.
 *
 * A child written `>Name` is the exception: it must be one of the root's own
 * children in the system tree (raw elements between still don't count). A shape
 * made only of layout primitives, `Text` and `Button` needs it — matched at any
 * depth, a whole screen's outer `Stack` contains a "header" somewhere.
 *
 * Each registered child must claim a distinct node, so `["VStack","Text","Text"]`
 * needs two Texts rather than matching one twice. Assignment is greedy, largest
 * child first, and pinned children before loose ones, so a loose child never
 * takes the only node a pinned one could have had.
 */
export function matches(pattern: PatternNode, tree: PatternNode): boolean {
	if (!nameMatches(pattern.name, tree.name)) return false;
	// Only when both sides know: an unqualified pattern node matches any package,
	// and a tree node whose import could not be resolved is not evidence of a
	// mismatch. Qualification narrows a match, it never invents one.
	if (pattern.pkg && tree.pkg && pattern.pkg !== tree.pkg) return false;
	if (!pattern.children.length) return true;
	const pool = descendants(tree);
	const own = new Set(tree.children);
	const used = new Set<PatternNode>();
	const wanted = [...pattern.children].sort(
		(a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct)) || nodeCount(b) - nodeCount(a),
	);
	for (const want of wanted) {
		const hit = pool.find((n) => !used.has(n) && (!want.direct || own.has(n)) && matches(want, n));
		if (!hit) return false;
		used.add(hit);
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

/**
 * A registry entry as authored: keyed by `pattern` (`confirm`, `id.variant` or
 * `id#part`), it may nest `parts`, may carry a second shape as
 * `rendered_signature`, and says in `detector` how it is checked at all.
 */
interface RawPattern {
	pattern?: string;
	note?: string;
	canonical?: string | null;
	signature?: unknown;
	rendered_signature?: unknown;
	instead_of_signature?: unknown;
	detector?: unknown;
	parts?: Record<string, RawPattern>;
}

/**
 * `canonical` is matched against a file's local import names, so it has to be
 * the name the code binds. A part written as `Navigator.Button` can never be
 * one; the import that produces it is `Navigator`.
 */
const bindName = (c: unknown): string | null => (typeof c === 'string' && c ? (c.split('.', 1)[0] ?? c) : null);

/**
 * The rule objects in `detector`. A bare string (`"signature"`, `"import"`,
 * `"declared"`, `"rule:name"`) is documentation of how the entry is checked and
 * nothing here acts on it: a signature present is matched, a canonical present
 * is honoured, and a `rule:` string names a rule that is specified but not
 * shipped. Only an object carries the parameters a shipped rule runs with.
 */
const ruleSpecs = (detector: unknown): RuleSpec[] => {
	return listOf(detector).filter(
		(d): d is RuleSpec => typeof d === 'object' && d !== null && typeof (d as RuleSpec).rule === 'string',
	);
};

/** A detector's parameter that has to be a non-empty string, or the default. */
export const stringParam = (spec: RuleSpec, key: string, fallback: string): string =>
	typeof spec[key] === 'string' && spec[key] ? (spec[key] as string) : fallback;
export const numParam = (spec: RuleSpec, key: string, fallback: number): number =>
	typeof spec[key] === 'number' ? (spec[key] as number) : fallback;
export const listParam = (spec: RuleSpec, key: string): string[] =>
	Array.isArray(spec[key]) ? (spec[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [];

/** The fix for a registry written in the removed version-1 form, carried in its error. */
const KEY_BY_PATTERN = 'key each entry by "pattern", the pattern it realizes ("confirm", "choose.segmented")';

/**
 * Normalize a registry file or inline array into matchable patterns.
 *
 * Throws on a registry with no entry list where one belongs: read as empty, it
 * switches the `patterns/*` rules off and reports clean. Version 1's flat
 * `patterns` list keyed by `id` throws too, for the same reason, and says what
 * replaced it.
 */
export function loadPatterns(raw: unknown): Pattern[] {
	const rec = raw as { patterns?: unknown; realizations?: unknown } | null;
	if (!Array.isArray(raw) && rec?.realizations === undefined && Array.isArray(rec?.patterns))
		throw new Error(
			`a flat "patterns" list keyed by "id" is the version-1 registry, removed in 0.8.0: list the entries under "realizations" and ${KEY_BY_PATTERN}`,
		);
	const found: unknown = Array.isArray(raw) ? raw : rec?.realizations;
	if (!Array.isArray(found))
		throw new Error('not a pattern registry: expected an array of entries, or an object with a "realizations" array');
	const list: RawPattern[] = found;
	for (const p of list) {
		const v1 = p as { id?: unknown } | null;
		if (v1 && typeof v1 === 'object' && p.pattern === undefined && v1.id !== undefined)
			throw new Error(`entry ${JSON.stringify(v1.id)} is keyed by "id", removed in 0.8.0: ${KEY_BY_PATTERN}`);
	}
	const out: Pattern[] = [];
	const load = (p: RawPattern, id: string | null, inheritedCanonical: string | null): void => {
		// An explicit null opts a part out of its parent's canonical: a toolbar
		// above a DataViews is not "using DataViews" the way a row of
		// Navigator.Buttons is using Navigator.
		const canonical = 'canonical' in (p ?? {}) ? bindName(p.canonical) : inheritedCanonical;
		const shapes = [toNode(p?.signature), toNode(p?.rendered_signature)].filter((n): n is PatternNode => n !== null);
		// A list of shapes, or — because `signature` next to it takes exactly one — a
		// single shape written directly. A list never starts with a string, so the
		// leading element settles it.
		const authored: unknown = p?.instead_of_signature;
		const antiShapes: unknown[] = !Array.isArray(authored)
			? []
			: typeof authored[0] === 'string'
				? [authored]
				: authored;
		// An anti-shape below the floor would fire on half a codebase: a bare
		// `SelectControl` is one node and says nothing about the choice it presents.
		const avoid = antiShapes
			.map((shape) => toNode(shape))
			.filter((n): n is PatternNode => n !== null && nodeCount(n) >= SUBSTANTIAL.minNodes);
		const rules = ruleSpecs(p?.detector);
		const summary = p?.note ?? '';
		const own = id ?? (shapes[0] ? signatureOf(shapes[0]) : null);
		if (own) {
			// One entry per shape, all under one id: `rendered_signature` is the same
			// part with a force applied, not a second pattern, so the two group as
			// one when the duplicate rule counts files. An entry with no shape still
			// loads — it is checked by its canonical import, by a rule, or not at
			// all — because the file that names it may need it as a remedy.
			const nodes: (PatternNode | null)[] = shapes.length ? shapes : [null];
			nodes.forEach((node, i) => {
				out.push({
					id: own,
					summary,
					canonical,
					node,
					size: node ? nodeCount(node) : 0,
					avoid: i === 0 ? avoid : [],
					rules: i === 0 ? rules : [],
				});
			});
		}
		const parts = p?.parts;
		if (own && parts && typeof parts === 'object')
			for (const [name, part] of Object.entries(parts)) load(part, `${own}#${name}`, canonical);
	};
	for (const p of list) load(p, p?.pattern ?? null, null);
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
/**
 * Floors that keep the rules from firing on every two-component pairing.
 *
 * A three-node signature like `HStack(Button,Button)` is a true description of
 * an action bar and a useless finding — it matched 48 files in one repo. Below
 * this size a registry entry is documentation for a person, not a check.
 */
export const SUBSTANTIAL = { minNodes: 4, minDepth: 2 };

/** One row of an abstract pattern's `resolve` table, as `patterns/index.json` writes it. */
export interface ResolveRule {
	when?: Record<string, unknown>;
	variant?: string;
	redirect?: string;
	because?: string;
	default?: string;
}

/**
 * Run a `resolve` table on the forces that are known, in order, first match.
 *
 * Known means read with enough certainty to act on; an unknown force is left
 * out of `forces`, not guessed. A row one known force contradicts is skipped,
 * whatever else it asks. A row that needs a force nobody knows stops the walk
 * and returns null: it might have matched, so any row below it answering
 * instead would be answering a question the table never reached. That is what
 * keeps a partial reading sound — with only `represents` known, the redirects
 * at the top of `choose` decide, and the variant rows under them stay silent.
 */
export function resolveRule(
	rules: readonly ResolveRule[],
	forces: Readonly<Record<string, unknown>>,
): ResolveRule | null {
	for (const r of rules) {
		if (!r.when) return r;
		const conds = Object.entries(r.when);
		if (conds.some(([f, v]) => f in forces && forces[f] !== v)) continue;
		if (conds.every(([f, v]) => forces[f] === v)) return r;
		return null;
	}
	return null;
}
