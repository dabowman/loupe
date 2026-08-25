/**
 * Markup scanning.
 *
 * Two passes with deliberately different characters:
 *
 *   1. Structure (bindings, raw elements) comes from a real AST. The regex this
 *      replaces silently dropped any tag containing a nested brace — `style={{}}`
 *      or a handler with a block body — and the bias ran the wrong way: an
 *      inline-styled component is *more* likely to be an override, not less.
 *
 *   2. The reference index for dead-class detection stays raw-text token
 *      harvesting. It over-collects on purpose. A false "referenced" costs one
 *      missed finding; a false "dead" tells an agent to delete live CSS, so the
 *      asymmetry is worth the imprecision.
 */

import { parse as babelParse } from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import type { Expression, File, JSXAttribute, JSXElement, Node, TaggedTemplateExpression } from '@babel/types';
import { keyName, toCssProp, toCssValue } from './inline.ts';
import { FLEX_PROPS, GAP_PROPS } from './styles.ts';
import { cssInJsLocals, parseTemplate, templateText } from './cssinjs.ts';
import { depthOf, nodeCount, signatureOf, systemTree } from './patterns.ts';
import type {
	Binding,
	ComponentImport,
	Composite,
	CssInJsTemplate,
	Decl,
	DesignSystem,
	InlineStyleElement,
	RawElement,
	ScanResult,
} from './types.ts';

const PLUGINS: ParserPlugin[] = ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'importAttributes'];

/**
 * Narrow reads of the shapes a CSS-in-JS tag can take.
 *
 * `styled.div`, `styled(Button)` and a bare `css` are three different
 * expression types, and the chain of optional reads this replaces returned
 * `undefined` for every mismatch — which `Set.has` then answered `false` to,
 * so a genuinely unhandled tag shape was indistinguishable from a rejected one.
 */
const memberObject = (t: Expression): string | undefined =>
	t.type === 'MemberExpression' && t.object.type === 'Identifier' ? t.object.name : undefined;
const memberProperty = (t: Expression): string | undefined =>
	t.type === 'MemberExpression' && t.property.type === 'Identifier' ? t.property.name : undefined;
const calleeOf = (t: Expression): string | undefined =>
	t.type === 'CallExpression' && t.callee.type === 'Identifier' ? t.callee.name : undefined;
const firstArgOf = (t: Expression): string | undefined => {
	if (t.type !== 'CallExpression') return undefined;
	const arg = t.arguments[0];
	return arg?.type === 'Identifier' ? arg.name : undefined;
};
const identifierOf = (t: Expression): string | undefined => (t.type === 'Identifier' ? t.name : undefined);

/**
 * The element a component-substitution prop was handed, if it was handed one.
 *
 * `render={ <h4 /> }` is how a design-system text component is told which tag to
 * emit — `as` and `component` are the same idiom elsewhere. The callback
 * spelling `render={ ( props ) => <h4 { ...props } /> }` says the same thing and
 * is equally documented, so it resolves to the same element.
 *
 * Only the element the prop is given counts: anything nested inside it is markup
 * the author wrote and React renders as markup, so it stays subject to every
 * rule.
 */
const substitutionTarget = (value: JSXAttribute['value']): JSXElement | null => {
	const expr = value?.type === 'JSXExpressionContainer' ? value.expression : null;
	if (expr?.type === 'JSXElement') return expr;
	if (expr?.type === 'ArrowFunctionExpression' && expr.body.type === 'JSXElement') return expr.body;
	return null;
};

/** `Set.has` for a name that may not exist. */
const held = (set: ReadonlySet<string>, name: string | undefined): boolean =>
	name !== undefined && set.has(name);

/** First line of an unknown throw — a parser may reject with anything. */
const messageOf = (err: unknown): string =>
	(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'parse failed';

/** Every identifier-like token in the source. See note (2) above. */
export function harvestTokens(text: string, into: Set<string> = new Set()): Set<string> {
	for (const t of text.match(/[A-Za-z_][\w-]*/g) ?? []) into.add(t);
	return into;
}

/**
 * `wf-item-${id}` → stem `wf-item-`, so every `.wf-item-*` rule counts as live.
 *
 * Scans forward for `${` and walks the identifier backwards. The obvious
 * `/([A-Za-z_][\w-]*)\$\{/g` backtracks quadratically on any long run of word
 * characters with no `${` after it, and one 10MB generated file (an emscripten
 * blob checked in as .ts) turned a whole-repo scan into a hundred seconds — past
 * every hook timeout, so the gate silently never ran.
 */
const MAX_STEM = 128;
export function harvestStems(text: string, into: Set<string> = new Set()): Set<string> {
	for (let i = text.indexOf('${'); i !== -1; i = text.indexOf('${', i + 2)) {
		let s = i;
		const floor = Math.max(0, i - MAX_STEM);
		while (s > floor && isWordChar(text.charCodeAt(s - 1))) s--;
		const stem = text.slice(s, i);
		if (stem.includes('-') && /^[A-Za-z_]/.test(stem)) into.add(stem);
	}
	return into;
}

/** [A-Za-z0-9_-] */
function isWordChar(c: number): boolean {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45;
}

/**
 * Every string literal anywhere below a node.
 *
 * Genuinely untyped by design: this runs over whatever a `className` expression
 * turns out to be — a conditional, a `clsx()` call, a template — so it reads
 * shapes rather than node types, and says so in its signature.
 */
function stringsIn(node: unknown, out: string[] = []): string[] {
	if (!node || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const n of node) stringsIn(n, out);
		return out;
	}
	const rec = node as Record<string, unknown>;
	if (rec['type'] === 'StringLiteral') {
		if (typeof rec['value'] === 'string') out.push(rec['value']);
	} else if (rec['type'] === 'TemplateElement') {
		const v = rec['value'] as { cooked?: string; raw?: string } | undefined;
		out.push(v?.cooked ?? v?.raw ?? '');
	}
	for (const key of Object.keys(rec)) {
		if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
		stringsIn(rec[key], out);
	}
	return out;
}

const CLASS_TOKEN = /^[a-z_][\w-]*$/i;
function classesFrom(strings: readonly string[]): string[] {
	const out: string[] = [];
	for (const s of strings) {
		for (const t of s.split(/\s+/)) {
			const c = t.trim();
			// No hyphen requirement: a single-word class is still a binding, and
			// filtering on `-` made `<Text className="title">` unbindable.
			if (c && CLASS_TOKEN.test(c)) out.push(c);
		}
	}
	return out;
}

/**
 * Read a `style={{ … }}` attribute into CSS declarations.
 *
 * `dynamic` counts the parts we cannot evaluate — a spread, a computed key, an
 * identifier value. They produce no per-declaration finding (naming a property
 * whose value is unknown is noise) but they still mean the element carries an
 * inline style, which is what the component-level rule keys on.
 */
function readStyleAttr(value: JSXAttribute['value']): {
	decls: Decl[];
	dynamic: number;
	present: boolean;
} {
	const decls: Decl[] = [];
	let dynamic = 0;
	const container = value?.type === 'JSXExpressionContainer' ? value.expression : value;
	if (!container) return { decls, dynamic, present: false };
	if (container.type !== 'ObjectExpression') {
		// `style={someObject}` — present, entirely opaque.
		return { decls, dynamic: 1, present: true };
	}
	for (const prop of container.properties) {
		if (prop.type !== 'ObjectProperty') {
			dynamic++; // SpreadElement, ObjectMethod
			continue;
		}
		const key = keyName(prop);
		if (!key) {
			dynamic++;
			continue;
		}
		const cssProp = toCssProp(key);
		const cssValue = toCssValue(cssProp, prop.value);
		if (cssValue === null) {
			dynamic++;
			continue;
		}
		decls.push({ prop: cssProp, value: cssValue, line: prop.loc?.start?.line ?? null });
	}
	return { decls, dynamic, present: true };
}

/**
 * Does this declaration lay anything out?
 *
 * `<div>` maps to a layout primitive, so the suggestion is only true when the
 * div is actually laying something out. A `<div className="acme-card">` whose
 * class sets a border and a colour has no layout primitive analog, and telling
 * an agent to make it an `HStack` is wrong advice at scale — it was the single
 * largest source of findings in a real repo.
 */
export const isLayoutDecl = ({ prop, value }: Decl): boolean =>
	FLEX_PROPS.has(prop) ||
	GAP_PROPS.has(prop) ||
	(prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value)) ||
	prop.startsWith('grid-template') ||
	prop.startsWith('grid-auto');

function walkAst(node: unknown, visit: (n: Node) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) walkAst(n, visit);
		return;
	}
	const rec = node as Record<string, unknown>;
	if (typeof rec['type'] === 'string') visit(node as Node);
	for (const key of Object.keys(rec)) {
		if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments')
			continue;
		walkAst(rec[key], visit);
	}
}

/**
 * Local names imported from a design-system package, classified as layout or
 * text. Export names are normalized first: `@wordpress/components` publishes
 * `__experimentalText`, so matching the raw specifier against `Text` never hits
 * and the typography-in-CSS rule silently degrades into a generic override.
 */
function systemImports(
	ast: File,
	ds: DesignSystem,
): {
	known: Set<string>;
	text: Set<string>;
	layout: Set<string>;
	componentImports: ComponentImport[];
	packages: Map<string, string>;
} {
	const known = new Set<string>();
	const text = new Set<string>();
	const layout = new Set<string>();
	// One entry per imported local: which package it actually came from, since
	// the same canonical name can mean a stable component in one package and an
	// experimental one in the other (Button, Notice, Popover, ...).
	const componentImports: ComponentImport[] = [];
	// local name -> the package it came from, so a composite signature can say
	// *whose* `Stack` this is. Names are the one thing design systems share.
	const packages = new Map<string, string>();
	const canonical = (name: string): string =>
		ds.normalizeExports ? name.replace(ds.normalizeExports, '') : name;
	const fromPackage = (src: string): boolean => ds.packages.some((p) => src === p || src.startsWith(`${p}/`));

	for (const node of ast.program.body) {
		if (node.type !== 'ImportDeclaration' || !fromPackage(node.source.value)) continue;
		for (const spec of node.specifiers) {
			const local = spec.local.name;
			const imported =
				spec.type === 'ImportSpecifier'
					? spec.imported.type === 'Identifier'
						? spec.imported.name
						: spec.imported.value
					: local;
			const c = canonical(imported);
			known.add(local);
			if (ds.textComponents.includes(c)) text.add(local);
			if (ds.layoutComponents.includes(c)) layout.add(local);
			packages.set(local, node.source.value);
			componentImports.push({ canonical: c, package: node.source.value, line: node.loc?.start?.line ?? 1 });
		}
	}
	return { known, text, layout, componentImports, packages };
}

export function scanMarkup(text: string, relPath: string, ds: DesignSystem): ScanResult {
	const referenced = harvestTokens(text);
	const stems = harvestStems(text);
	const bindings: Binding[] = [];
	const rawEls: RawElement[] = [];
	const inlineStyles: InlineStyleElement[] = [];
	const cssInJs: CssInJsTemplate[] = [];
	const composites: Composite[] = [];
	const imports = new Set<string>();

	let ast;
	try {
		// errorRecovery keeps one malformed file from blanking the whole run.
		ast = babelParse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: PLUGINS });
	} catch (err) {
		return { bindings, rawEls, inlineStyles, cssInJs, composites, imports, referenced, stems, componentImports: [], parseError: messageOf(err) };
	}

	const { known, text: textLike, layout, componentImports, packages } = systemImports(ast, ds);
	const tags = cssInJsLocals(ast, ds.cssInJsPackages);
	// `<Button css={css`…`}>` binds a template to an element the walk sees
	// first, so the owner is recorded before the template is reached.
	const cssPropOwner = new Map<
		number,
		{ target: string; isSystem: boolean; isText: boolean; isLayout: boolean }
	>();
	// Elements handed to a substitution prop, by offset. Recorded while the
	// carrying element's attributes are read, which the walk reaches first — the
	// same ordering `cssPropOwner` relies on.
	const substituted = new Set<number>();
	for (const node of ast.program.body)
		if (node.type === 'ImportDeclaration') for (const sp of node.specifiers) imports.add(sp.local.name);

	/**
 * A CSS-in-JS tagged template, resolved to the thing it styles.
 *
 * `styled(Button)` styles a design-system component, so its declarations get
 * that component's binding and the "use the props" remedy — the same verdict
 * the stylesheet pass reaches for a class bound to the same component.
 */
	/**
 * Direct design-system children of a JSX element.
 *
 * Descends through anything that is not itself an element — expression
 * containers, fragments, conditionals — because `{items.map((i) => <Button />)}`
 * is a child in every sense that matters here, and stopping at the container
 * would make a mapped list look empty.
 */
	const jsxChildElements = (el: JSXElement): JSXElement[] => {
		const out: JSXElement[] = [];
		const dig = (n: unknown): void => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(dig);
			const rec = n as Record<string, unknown>;
			if (rec['type'] === 'JSXElement') return void out.push(n as JSXElement);
			for (const k of Object.keys(rec)) if (k !== 'loc' && k !== 'start' && k !== 'end') dig(rec[k]);
		};
		for (const c of el.children ?? []) dig(c);
		return out;
	};

	// `Card.Root`, `Card.Header`, `Card.Content`, … are distinct nodes in a
	// composite tree even though only `Card` is ever imported — keep the full
	// dotted name so they don't collapse into one indistinguishable node, but
	// test import membership against the object half.
	const jsxName = (el: JSXElement): string | null => {
		const n = el.openingElement.name;
		if (n.type === 'JSXIdentifier') return n.name;
		if (n.type === 'JSXMemberExpression')
			return n.object.type === 'JSXIdentifier' ? `${n.object.name}.${n.property.name}` : null;
		return null;
	};
	const baseOf = (name: string): string => name.split('.', 1)[0] ?? name;

	const readComposite = (el: JSXElement): void => {
		const name = jsxName(el);
		if (!name || !known.has(baseOf(name))) return;
		const tree = systemTree(
			el,
			(n) => known.has(baseOf(n)),
			jsxChildElements,
			jsxName,
			(n) => packages.get(baseOf(n)) ?? null,
			el.loc?.start?.line ?? 1,
		);
		// A lone component is not a composition, and reporting one would drown
		// every real finding in the file.
		if (!tree || nodeCount(tree) < 2) return;
		composites.push({
			file: relPath,
			line: el.loc?.start?.line ?? 1,
			signature: signatureOf(tree),
			tree,
			size: nodeCount(tree),
			depth: depthOf(tree),
		});
	};

	const readTaggedTemplate = (node: TaggedTemplateExpression): void => {
		if (!tags.any) return;
		const t = node.tag;
		const owner = typeof node.start === 'number' ? cssPropOwner.get(node.start) : undefined;
		let target: string | null = null;
		let isSystem = false;
		if (owner) {
			({ target, isSystem } = owner);
			if (!held(tags.bare, identifierOf(t)) && !held(tags.styled, memberObject(t)) && !held(tags.styled, calleeOf(t)))
				return;
		} else if (held(tags.styled, memberObject(t))) {
			target = memberProperty(t) ?? null; // styled.div
		} else if (held(tags.styled, calleeOf(t))) {
			target = firstArgOf(t) ?? null; // styled(Button)
			isSystem = Boolean(target && known.has(target));
		} else if (held(tags.bare, identifierOf(t))) {
			target = null; // css`…`, createGlobalStyle`…`
		} else {
			return; // gql`…`, html`…`, keyframes`…` — not CSS we own
		}

		const line = node.quasi.quasis[0]?.loc?.start?.line ?? node.loc?.start?.line ?? 1;
		const { groups, error } = parseTemplate(templateText(node.quasi), line);
		cssInJs.push({
			file: relPath,
			line,
			target,
			isSystem,
			isText: isSystem && target !== null && textLike.has(target),
			isLayout: isSystem && target !== null && layout.has(target),
			groups,
			error,
		});
	};

	walkAst(ast.program, (node) => {
		if (node.type === 'TaggedTemplateExpression') return readTaggedTemplate(node);
		if (node.type === 'JSXElement') readComposite(node);
		if (node.type !== 'JSXOpeningElement') return;
		const name = node.name;
		const tag =
			name.type === 'JSXIdentifier'
				? name.name
				: name.type === 'JSXMemberExpression'
					? `${name.object.type === 'JSXIdentifier' ? name.object.name : '?'}.${name.property.name}`
					: null;
		if (!tag) return;
		const line = node.loc?.start?.line ?? 1;

		const strings: string[] = [];
		const substitutions: JSXElement[] = [];
		let style: ReturnType<typeof readStyleAttr> | null = null;
		let cssAttr: JSXAttribute['value'] = null;
		for (const attr of node.attributes) {
			if (attr.type !== 'JSXAttribute') continue;
			const an = attr.name.type === 'JSXIdentifier' ? attr.name.name : attr.name.name.name;
			if (an === 'className' || an === 'class') stringsIn(attr.value, strings);
			else if (an === 'style') style = readStyleAttr(attr.value);
			else if (an === 'css') cssAttr = attr.value;
			else if (ds.substitutionProps.has(an)) {
				const target = substitutionTarget(attr.value);
				if (target) substitutions.push(target);
			}
		}
		const classes = classesFrom(strings);

		const root = tag.split('.')[0] ?? tag;
		const isComponent = /^[A-Z]/.test(root);
		const isSystem = isComponent && known.has(root);

		// Only a component takes a substitution prop. `render` on a DOM element is
		// an attribute React does not know either, so an element under one there is
		// markup like any other.
		if (isComponent)
			for (const target of substitutions) {
				const at = target.openingElement.start;
				if (typeof at === 'number') substituted.add(at);
			}

		const owned = cssAttr?.type === 'JSXExpressionContainer' ? cssAttr.expression : null;
		if (owned?.type === 'TaggedTemplateExpression' && typeof owned.start === 'number')
			cssPropOwner.set(owned.start, {
				target: isComponent ? root : tag.toLowerCase(),
				isSystem,
				isText: isSystem && textLike.has(root),
				isLayout: isSystem && layout.has(root),
			});

		if (style?.present)
			inlineStyles.push({
				tag: isComponent ? root : tag.toLowerCase(),
				isSystem,
				isText: isSystem && textLike.has(root),
				isLayout: isSystem && layout.has(root),
				decls: style.decls,
				dynamic: style.dynamic,
				file: relPath,
				line,
			});

		if (isComponent) {
			if (!isSystem) return;
			const isText = textLike.has(root);
			const isLayout = layout.has(root);
			for (const cls of classes)
				bindings.push({ cls, tag: root, isSystem: true, isText, isLayout, file: relPath, line });
		} else {
			// `render={ <h4 /> }` is not markup being rendered — it is the argument
			// telling a design-system component which tag to emit, and it is the
			// documented way to keep an element's semantics through exactly the
			// conversion this rule asks for. Flagging it leaves nothing to do but
			// undo the fix. Its children are ordinary markup and still count.
			if (typeof node.start === 'number' && substituted.has(node.start)) return;
			const lower = tag.toLowerCase();
			const mapped = ds.elementMap.get(lower);
			if (!mapped) return;
			// An inline style is styling too. Requiring a CSS-styled class here
			// exempted exactly the shape agents write most: a bare <div> laid
			// out with style={{ display: 'flex' }} and no className at all.
			if (mapped.styledOnly && !classes.length && !style?.present) return;
			rawEls.push({
				tag: lower, classes, file: relPath, line,
				suggest: mapped.component, styledOnly: mapped.styledOnly,
				inlineStyled: Boolean(style?.present),
				inlineLayout: Boolean(style?.decls?.some(isLayoutDecl)),
			});
		}
	});

	return { bindings, rawEls, inlineStyles, cssInJs, composites, imports, referenced, stems, componentImports, parseError: null };
}
