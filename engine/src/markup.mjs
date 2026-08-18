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

const PLUGINS = ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'importAttributes'];

/** Every identifier-like token in the source. See note (2) above. */
export function harvestTokens(text, into = new Set()) {
	for (const t of text.match(/[A-Za-z_][\w-]*/g) || []) into.add(t);
	return into;
}

/** `wf-item-${id}` → stem `wf-item-`, so every `.wf-item-*` rule counts as live. */
export function harvestStems(text, into = new Set()) {
	for (const m of text.matchAll(/([A-Za-z_][\w-]*)\$\{/g)) if (m[1].includes('-')) into.add(m[1]);
	return into;
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
		}
	}
	return { known, text, layout };
}

/**
 * @returns {{ bindings, rawEls, referenced, stems, parseError }}
 *   bindings: { cls, tag, isSystem, isText, isLayout, file, line }
 *   rawEls:   { tag, classes, file, line }
 */
export function scanMarkup(text, relPath, ds) {
	const referenced = harvestTokens(text);
	const stems = harvestStems(text);
	const bindings = [];
	const rawEls = [];

	let ast;
	try {
		// errorRecovery keeps one malformed file from blanking the whole run.
		ast = babelParse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: PLUGINS });
	} catch (err) {
		return { bindings, rawEls, referenced, stems, parseError: err.message.split('\n')[0] };
	}

	const { known, text: textLike, layout } = systemImports(ast, ds);

	walkAst(ast.program, (node) => {
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
		for (const attr of node.attributes) {
			if (attr.type !== 'JSXAttribute') continue;
			const an = attr.name?.name;
			if (an !== 'className' && an !== 'class') continue;
			stringsIn(attr.value, strings);
		}
		const classes = classesFrom(strings);

		const root = tag.split('.')[0];
		if (/^[A-Z]/.test(root)) {
			if (!known.has(root)) return;
			const isText = textLike.has(root);
			const isLayout = layout.has(root);
			for (const cls of classes)
				bindings.push({ cls, tag: root, isSystem: true, isText, isLayout, file: relPath, line });
		} else {
			const lower = tag.toLowerCase();
			const mapped = ds.elementMap.get(lower);
			if (!mapped) return;
			if (mapped.styledOnly && !classes.length) return;
			rawEls.push({ tag: lower, classes, file: relPath, line, suggest: mapped.component, styledOnly: mapped.styledOnly });
		}
	});

	return { bindings, rawEls, referenced, stems, parseError: null };
}
