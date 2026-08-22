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
import { keyName, toCssProp, toCssValue } from './inline.mjs';
import { FLEX_PROPS, GAP_PROPS } from './styles.mjs';
import { cssInJsLocals, parseTemplate, templateText } from './cssinjs.mjs';
import { depthOf, nodeCount, signatureOf, systemTree } from './patterns.mjs';

const PLUGINS = ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'importAttributes'];

/** Every identifier-like token in the source. See note (2) above. */
export function harvestTokens(text, into = new Set()) {
	for (const t of text.match(/[A-Za-z_][\w-]*/g) || []) into.add(t);
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
export function harvestStems(text, into = new Set()) {
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
function isWordChar(c) {
	return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 45;
}

function stringsIn(node, out = []) {
	if (!node || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const n of node) stringsIn(n, out);
		return out;
	}
	if (node.type === 'StringLiteral') out.push(node.value);
	else if (node.type === 'TemplateElement') out.push(node.value?.cooked ?? node.value?.raw ?? '');
	for (const key of Object.keys(node)) {
		if (key === 'loc' || key === 'type' || key === 'start' || key === 'end') continue;
		stringsIn(node[key], out);
	}
	return out;
}

const CLASS_TOKEN = /^[a-z_][\w-]*$/i;
function classesFrom(strings) {
	const out = [];
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
function readStyleAttr(value) {
	const decls = [];
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
export const isLayoutDecl = ({ prop, value }) =>
	FLEX_PROPS.has(prop) ||
	GAP_PROPS.has(prop) ||
	(prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value)) ||
	prop.startsWith('grid-template') ||
	prop.startsWith('grid-auto');

function walkAst(node, visit) {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) walkAst(n, visit);
		return;
	}
	if (typeof node.type === 'string') visit(node);
	for (const key of Object.keys(node)) {
		if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments')
			continue;
		walkAst(node[key], visit);
	}
}

/**
 * Local names imported from a design-system package, classified as layout or
 * text. Export names are normalized first: `@wordpress/components` publishes
 * `__experimentalText`, so matching the raw specifier against `Text` never hits
 * and the typography-in-CSS rule silently degrades into a generic override.
 */
function systemImports(ast, ds) {
	const known = new Set();
	const text = new Set();
	const layout = new Set();
	// One entry per imported local: which package it actually came from, since
	// the same canonical name can mean a stable component in one package and an
	// experimental one in the other (Button, Notice, Popover, ...).
	const componentImports = [];
	// local name -> the package it came from, so a composite signature can say
	// *whose* `Stack` this is. Names are the one thing design systems share.
	const packages = new Map();
	const canonical = (name) => (ds.normalizeExports ? name.replace(ds.normalizeExports, '') : name);
	const fromPackage = (src) => ds.packages.some((p) => src === p || src.startsWith(`${p}/`));

	for (const node of ast.program.body) {
		if (node.type !== 'ImportDeclaration' || !fromPackage(node.source.value)) continue;
		for (const spec of node.specifiers) {
			const local = spec.local.name;
			const imported =
				spec.type === 'ImportSpecifier'
					? spec.imported.name || spec.imported.value
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

/**
 * @returns {{ bindings, rawEls, inlineStyles, cssInJs, composites, imports, referenced, stems, componentImports, parseError }}
 *   bindings:         { cls, tag, isSystem, isText, isLayout, file, line }
 *   rawEls:           { tag, classes, file, line, inlineStyled }
 *   inlineStyles:     { tag, isSystem, isText, isLayout, decls, dynamic, file, line }
 *   componentImports: { canonical, package, line } — every system import, package-qualified
 */
export function scanMarkup(text, relPath, ds) {
	const referenced = harvestTokens(text);
	const stems = harvestStems(text);
	const bindings = [];
	const rawEls = [];
	const inlineStyles = [];
	const cssInJs = [];
	const composites = [];
	const imports = new Set();

	let ast;
	try {
		// errorRecovery keeps one malformed file from blanking the whole run.
		ast = babelParse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: PLUGINS });
	} catch (err) {
		return { bindings, rawEls, inlineStyles, cssInJs, composites, imports, referenced, stems, componentImports: [], parseError: err.message.split('\n')[0] };
	}

	const { known, text: textLike, layout, componentImports, packages } = systemImports(ast, ds);
	const tags = cssInJsLocals(ast, ds.cssInJsPackages);
	// `<Button css={css`…`}>` binds a template to an element the walk sees
	// first, so the owner is recorded before the template is reached.
	const cssPropOwner = new Map();
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
	const jsxChildElements = (el) => {
		const out = [];
		const dig = (n) => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(dig);
			if (n.type === 'JSXElement') return void out.push(n);
			for (const k of Object.keys(n)) if (k !== 'loc' && k !== 'start' && k !== 'end') dig(n[k]);
		};
		for (const c of el.children || []) dig(c);
		return out;
	};

	// `Card.Root`, `Card.Header`, `Card.Content`, … are distinct nodes in a
	// composite tree even though only `Card` is ever imported — keep the full
	// dotted name so they don't collapse into one indistinguishable node, but
	// test import membership against the object half.
	const jsxName = (el) => {
		const n = el?.openingElement?.name;
		if (n?.type === 'JSXIdentifier') return n.name;
		if (n?.type === 'JSXMemberExpression') return n.object?.name ? `${n.object.name}.${n.property?.name ?? '?'}` : null;
		return null;
	};
	const baseOf = (name) => name.split('.', 1)[0];

	const readComposite = (el) => {
		const name = jsxName(el);
		if (!name || !known.has(baseOf(name))) return;
		const tree = systemTree(
			{ ...el, line: el.loc?.start?.line ?? 1 },
			(n) => known.has(baseOf(n)),
			jsxChildElements,
			jsxName,
			(n) => packages.get(baseOf(n)) || null
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

	const readTaggedTemplate = (node) => {
		if (!tags.any) return;
		const t = node.tag;
		const owner = cssPropOwner.get(node.start);
		let target = null;
		let isSystem = false;
		if (owner) {
			({ target, isSystem } = owner);
			if (!tags.bare.has(t.name) && !tags.styled.has(t.object?.name) && !tags.styled.has(t.callee?.name)) return;
		} else if (t.type === 'MemberExpression' && tags.styled.has(t.object?.name)) {
			target = t.property?.name ?? null; // styled.div
		} else if (t.type === 'CallExpression' && tags.styled.has(t.callee?.name)) {
			target = t.arguments?.[0]?.name ?? null; // styled(Button)
			isSystem = Boolean(target && known.has(target));
		} else if (t.type === 'Identifier' && tags.bare.has(t.name)) {
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
			isText: isSystem && textLike.has(target),
			isLayout: isSystem && layout.has(target),
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
					? `${name.object?.name ?? '?'}.${name.property?.name ?? '?'}`
					: null;
		if (!tag) return;
		const line = node.loc?.start?.line ?? 1;

		const strings = [];
		let style = null;
		let cssAttr = null;
		for (const attr of node.attributes) {
			if (attr.type !== 'JSXAttribute') continue;
			const an = attr.name?.name;
			if (an === 'className' || an === 'class') stringsIn(attr.value, strings);
			else if (an === 'style') style = readStyleAttr(attr.value);
			else if (an === 'css') cssAttr = attr.value;
		}
		const classes = classesFrom(strings);

		const root = tag.split('.')[0];
		const isComponent = /^[A-Z]/.test(root);
		const isSystem = isComponent && known.has(root);

		const owned = cssAttr?.type === 'JSXExpressionContainer' ? cssAttr.expression : null;
		if (owned?.type === 'TaggedTemplateExpression')
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
