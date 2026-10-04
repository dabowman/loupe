/**
 * Markup scanning.
 *
 * Two passes with deliberately different characters:
 *
 *   1. Structure — bindings, raw elements, composites — from a real AST.
 *   2. The reference index for dead-class detection: raw-text token harvesting,
 *      which over-collects on purpose. A false "referenced" costs one missed
 *      finding; a false "dead" tells an agent to delete live CSS.
 *
 * Design notes: docs/design/analysis.md
 */

import { parse as babelParse } from '@babel/parser';
import type { ParseResult, ParserPlugin } from '@babel/parser';
import type {
	Expression,
	File,
	JSXAttribute,
	JSXElement,
	JSXOpeningElement,
	Node,
	TaggedTemplateExpression,
} from '@babel/types';
import { keyName, toCssProp, toCssValue, valueSpan } from './inline.ts';
import { isLayoutDecl } from './styles.ts';
import { messageLineOf } from './text.ts';
import { cssInJsLocals, fromPackage, importedName, parseTemplate, templateText } from './cssinjs.ts';
import { depthOf, nodeCount, signatureOf, systemTree } from './patterns.ts';
import { confirmPair } from './checks/detectors/confirm-pair.ts';
import { fewStaticOptions } from './checks/detectors/few-static-options.ts';
import { judgeControl } from './checks/detectors/judge.ts';
import type {
	Binding,
	ComponentImport,
	Composite,
	Control,
	CssInJsTemplate,
	Decl,
	DesignSystem,
	InlineStyleElement,
	PatternRule,
	RawElement,
	RuleHit,
	RuleSpec,
	ScanResult,
} from './types.ts';

const PLUGINS: ParserPlugin[] = ['jsx', 'typescript', 'decorators-legacy', 'classProperties', 'importAttributes'];

/**
 * Narrow reads of the shapes a CSS-in-JS tag can take: `styled.div`,
 * `styled(Button)` and a bare `css` are three different expression types, and an
 * unhandled shape has to be distinguishable from a rejected one.
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
 * The element(s) a component-substitution prop can hand over.
 *
 * `render={ <h4 /> }` is how a design-system text component is told which tag to
 * emit — `as` and `component` are the same idiom elsewhere. Every spelling an
 * ordinary refactor produces resolves the same way: the callback form, a block
 * body returning one element, the `function` spelling, a conditional or a guard
 * choosing between two. Anything opaque — a variable, a call — yields nothing,
 * which is the safe direction: the element still reports.
 *
 * Only the element the prop is given counts. Anything nested *inside* it is
 * markup the author wrote, and stays subject to every rule.
 */
function substitutionTargets(node: Node | null | undefined, out: JSXElement[] = []): JSXElement[] {
	// A type assertion is not a different value: `render={ ( <h4 /> ) as ReactElement }`.
	const expr = node && unwrapTs(node);
	switch (expr?.type) {
		case 'JSXElement':
			out.push(expr);
			break;
		case 'ArrowFunctionExpression':
		case 'FunctionExpression': {
			// `( props ) => <h4 />`, and the same body with braces around it — a
			// `return` of one element is still one element, whatever the block does
			// first. `( { className, ...rest } ) => { … return <h4 /> }` is the shape a
			// callback takes the moment it touches its props.
			if (expr.body.type !== 'BlockStatement') return substitutionTargets(expr.body, out);
			for (const stmt of expr.body.body) if (stmt.type === 'ReturnStatement') substitutionTargets(stmt.argument, out);
			break;
		}
		case 'ConditionalExpression':
			substitutionTargets(expr.consequent, out);
			substitutionTargets(expr.alternate, out);
			break;
		case 'LogicalExpression':
			// Both arms, for the same reason a conditional takes both: `<h4 /> || fb`
			// and `big && <h2 /> || <h4 />` each name an element the prop can receive.
			substitutionTargets(expr.left, out);
			substitutionTargets(expr.right, out);
			break;
		// `render={ <h4 /> }`. JSX also allows the braces to be dropped entirely
		// (`render=<h4 />`), which arrives as the element itself and is caught by
		// the `JSXElement` case above.
		case 'JSXExpressionContainer':
			substitutionTargets(expr.expression, out);
			break;
	}
	return out;
}

/**
 * An export name with the design system's experimental/unstable prefix stripped.
 * WPDS ships `__experimentalText`, and it is the same component as `Text`.
 */
const canonicalName = (name: string, normalize: RegExp | null): string =>
	normalize ? name.replace(normalize, '') : name;

/** `Set.has` for a name that may not exist. */
const held = (set: ReadonlySet<string>, name: string | undefined): boolean => name !== undefined && set.has(name);

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
 * characters with no `${` after it.
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

const CLASS_TOKEN = /^[a-z_][\w-]*$/i;
function classesFrom(strings: readonly string[]): string[] {
	const out: string[] = [];
	for (const s of strings) {
		for (const t of s.split(/\s+/)) {
			const c = t.trim();
			// No hyphen requirement: a single-word class is still a binding.
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
	dynamicProps: string[];
	present: boolean;
} {
	const decls: Decl[] = [];
	const dynamicProps: string[] = [];
	let dynamic = 0;
	const container = value?.type === 'JSXExpressionContainer' ? value.expression : value;
	if (!container) return { decls, dynamic, dynamicProps, present: false };
	if (container.type !== 'ObjectExpression') {
		// `style={someObject}` — present, entirely opaque.
		return { decls, dynamic: 1, dynamicProps, present: true };
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
			dynamicProps.push(cssProp);
			continue;
		}
		const line = prop.loc?.start?.line ?? null;
		decls.push({ prop: cssProp, value: cssValue, line, span: valueSpan(prop.value, line) });
	}
	return { decls, dynamic, dynamicProps, present: true };
}

function walkAst(node: unknown, visit: (n: Node) => void): void {
	if (!node || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const n of node) walkAst(n, visit);
		return;
	}
	const rec = node as Record<string, unknown>;
	if (typeof rec.type === 'string') visit(node as Node);
	for (const key of Object.keys(rec)) {
		if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments')
			continue;
		walkAst(rec[key], visit);
	}
}

/**
 * Local names imported from a design-system package, classified as layout or
 * text. Export names are normalized first: `@wordpress/components` publishes
 * `__experimentalText`, which never matches a raw specifier of `Text`.
 */
function systemImports(
	ast: File,
	ds: DesignSystem,
): {
	text: Set<string>;
	layout: Set<string>;
	componentImports: ComponentImport[];
	packages: Map<string, string>;
	canonicals: Map<string, string>;
} {
	// local name -> canonical name, so a rule written against `SelectControl`
	// finds it under whatever alias the file bound.
	const canonicals = new Map<string, string>();
	const text = new Set<string>();
	const layout = new Set<string>();
	// One entry per imported local: which package it actually came from, since
	// the same canonical name can mean a stable component in one package and an
	// experimental one in the other (Button, Notice, Popover, ...).
	const componentImports: ComponentImport[] = [];
	// local name -> the package it came from, so a composite signature can say
	// *whose* `Stack` this is. Names are the one thing design systems share.
	const packages = new Map<string, string>();
	const canonical = (name: string): string => canonicalName(name, ds.normalizeExports);

	for (const node of ast.program.body) {
		if (node.type !== 'ImportDeclaration' || !fromPackage(ds.packages, node.source.value)) continue;
		for (const spec of node.specifiers) {
			const local = spec.local.name;
			const c = canonical(spec.type === 'ImportSpecifier' ? importedName(spec) : local);
			canonicals.set(local, c);
			if (ds.textComponents.includes(c)) text.add(local);
			if (ds.layoutComponents.includes(c)) layout.add(local);
			packages.set(local, node.source.value);
			// The specifier's line, not the declaration's: the placement a reader
			// reaches for is the comment above the offending name, and one directive
			// on the `import {` line mutes every other name in the declaration.
			componentImports.push({
				canonical: c,
				package: node.source.value,
				uses: 0, // the JSX walk counts them; this pass has only read the imports
				line: spec.loc?.start?.line ?? node.loc?.start?.line ?? 1,
				declLine: node.loc?.start?.line ?? 1,
			});
		}
	}
	return { text, layout, componentImports, packages, canonicals };
}

/** An expression with any type assertion peeled off; the value is the same. */
const unwrapTs = (e: Node): Node =>
	e.type === 'TSAsExpression' ||
	e.type === 'TSSatisfiesExpression' ||
	e.type === 'TSNonNullExpression' ||
	e.type === 'TSTypeAssertion'
		? unwrapTs(e.expression)
		: e;

/**
 * The text a JSX element would render as its label, when that text is static.
 *
 * A literal child, a string in braces, a template with no holes, or one of
 * WordPress's translation calls around a string (`__( 'Delete' )`, `_x( … )`).
 * Anything computed is null: a rule that reads labels must not guess one.
 * Elements among the children (an icon) are ignored rather than disqualifying.
 */
function staticLabel(el: JSXElement): string | null {
	const parts: string[] = [];
	for (const c of el.children) {
		if (c.type === 'JSXText') {
			parts.push(c.value);
			continue;
		}
		if (c.type === 'JSXElement' || c.type === 'JSXFragment') continue;
		if (c.type !== 'JSXExpressionContainer') return null;
		if (c.expression.type === 'JSXEmptyExpression') continue;
		const text = staticString(c.expression);
		if (text === null) return null;
		parts.push(text);
	}
	return parts.join('').replace(/\s+/g, ' ').trim();
}

/** A string the source states outright, through a translation call if any; null when computed. */
function staticString(node: Node): string | null {
	const e = unwrapTs(node);
	if (e.type === 'StringLiteral') return e.value;
	if (e.type === 'TemplateLiteral' && !e.expressions.length) return e.quasis.map((q) => q.value.cooked ?? '').join('');
	if (e.type === 'CallExpression' && e.callee.type === 'Identifier' && /^_[_xn]$/.test(e.callee.name)) {
		const arg = e.arguments[0];
		return arg?.type === 'StringLiteral' ? arg.value : null;
	}
	return null;
}

/** What a registry detector can read about the element it runs on, and around it. */
export interface DetectorContext {
	/** The registry's name for the element's component, alias resolved. */
	canonical: string;
	/** Any element's name as written: `Menu.Item`, `div`. */
	nameOf(el: JSXElement): string | null;
	/** Any element's registry name, or null for anything not from the design system. */
	canonicalOf(el: JSXElement): string | null;
	/** Every JSX element below `el`, through containers and callbacks alike. */
	elementsIn(el: JSXElement): JSXElement[];
	/** A static option array, each entry reduced to its label; null when it is not static. */
	optionsIn(e: Node): (string | null)[] | null;
	/** The text `el` renders as its label, when the source states it. */
	labelOf(el: JSXElement): string | null;
	/** The component function `el` sits in, when the parse found a name. */
	enclosingOf(el: JSXElement): string | null;
	/** `el` as written, opening tag to close. */
	sourceOf(el: JSXElement): string;
}

/**
 * A registry detector: the finding's detail — `SelectControl with 4 short
 * static options` — when `el` makes the choice the entry exists to replace,
 * else null. Each lives in `checks/detectors/`, parameterised by the `spec`
 * the registry writes for it.
 */
export type Detector = (el: JSXElement, spec: RuleSpec, ctx: DetectorContext) => string | null;

const DETECTORS = new Map<string, Detector>([
	['few-static-options', fewStaticOptions],
	['confirm-pair', confirmPair],
]);

/** Named, capitalised scopes: the components a control can sit in. */
function componentRanges(program: Node): { start: number; end: number; name: string }[] {
	const out: { start: number; end: number; name: string }[] = [];
	walkAst(program, (n) => {
		const [name, body]: [string | undefined, Node | null | undefined] =
			n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration'
				? [n.id?.name, n]
				: n.type === 'VariableDeclarator' && n.id.type === 'Identifier'
					? [n.id.name, n.init]
					: [undefined, null];
		if (name && /^[A-Z]/.test(name) && typeof body?.start === 'number' && typeof body.end === 'number')
			out.push({ start: body.start, end: body.end, name });
	});
	return out;
}

export function scanMarkup(
	text: string,
	relPath: string,
	ds: DesignSystem,
	rules: readonly PatternRule[] = [],
): ScanResult {
	const referenced = harvestTokens(text);
	const stems = harvestStems(text);
	const bindings: Binding[] = [];
	const rawEls: RawElement[] = [];
	const inlineStyles: InlineStyleElement[] = [];
	const cssInJs: CssInJsTemplate[] = [];
	const composites: Composite[] = [];
	const ruleHits: RuleHit[] = [];
	const controls: Control[] = [];
	const imports = new Set<string>();
	const result: ScanResult = {
		controls,
		bindings,
		rawEls,
		inlineStyles,
		cssInJs,
		composites,
		ruleHits,
		imports,
		referenced,
		stems,
		componentImports: [],
		parseError: null,
	};

	let ast: ParseResult<File>;
	try {
		// errorRecovery keeps one malformed file from blanking the whole run.
		ast = babelParse(text, { sourceType: 'unambiguous', errorRecovery: true, plugins: PLUGINS });
	} catch (err) {
		return { ...result, parseError: messageLineOf(err) };
	}

	const { text: textLike, layout, componentImports, packages, canonicals } = systemImports(ast, ds);
	const tags = cssInJsLocals(ast, ds.cssInJsPackages);
	// `<Button css={css`…`}>` binds a template to an element the walk sees
	// first, so the owner is recorded before the template is reached.
	const cssPropOwner = new Map<number, { target: string; isSystem: boolean; isText: boolean }>();
	// Opening elements handed to a substitution prop. Recorded while the carrying
	// element's attributes are read, which the walk reaches first, and held by
	// node identity — `walkAst` visits these very objects, so nothing has to be
	// keyed on a source offset.
	const substituted = new Set<JSXOpeningElement>();
	// canonical name -> how many elements render it, so a currency finding
	// anchored at an import can say how many call sites the migration touches.
	const uses = new Map<string, number>();
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
			if (Array.isArray(n)) {
				n.forEach(dig);
				return;
			}
			const rec = n as Record<string, unknown>;
			if (rec.type === 'JSXElement') return void out.push(n as JSXElement);
			for (const k of Object.keys(rec)) if (k !== 'loc' && k !== 'start' && k !== 'end') dig(rec[k]);
		};
		for (const c of el.children ?? []) dig(c);
		return out;
	};

	// `Card.Root`, `Card.Header`, `Card.Content`, … are distinct nodes in a
	// composite tree even though only `Card` is ever imported — keep the full
	// dotted name so they don't collapse into one indistinguishable node, but
	// test import membership against the object half.
	const jsxName = (el: JSXElement | JSXOpeningElement): string | null => {
		const n = ('openingElement' in el ? el.openingElement : el).name;
		if (n.type === 'JSXIdentifier') return n.name;
		if (n.type === 'JSXMemberExpression')
			return n.object.type === 'JSXIdentifier' ? `${n.object.name}.${n.property.name}` : null;
		return null;
	};
	const baseOf = (name: string): string => name.split('.', 1)[0] ?? name;

	const readComposite = (el: JSXElement): void => {
		const name = jsxName(el);
		if (!name || !canonicals.has(baseOf(name))) return;
		const tree = systemTree(
			el,
			(n) => canonicals.has(baseOf(n)),
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

	/** The canonical name of a design-system element, or null for anything else. */
	const canonicalOf = (el: JSXElement): string | null => {
		const name = jsxName(el);
		return name ? (canonicals.get(baseOf(name)) ?? null) : null;
	};
	/** Every JSX element below `el`, through containers and callbacks alike. */
	const allElements = (el: JSXElement, out: JSXElement[] = []): JSXElement[] => {
		for (const c of jsxChildElements(el)) {
			out.push(c);
			allElements(c, out);
		}
		return out;
	};
	// Top-level `const options = [ … ]`, by name, so a prop bound to one is as
	// static as the literal written inline. Only the module's own bindings: a
	// prop or a store selector could hold anything.
	const constArrays = new Map<string, (string | null)[] | null>();
	for (const node of ast.program.body) {
		const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
		if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
		for (const d of decl.declarations)
			if (d.id.type === 'Identifier' && d.init) constArrays.set(d.id.name, staticOptions(d.init));
	}
	/**
	 * The entries of a static option array, each reduced to its label; null
	 * when the array is not static. A label the source does not state is
	 * recorded as null: the count is still known, the width is not.
	 */
	function staticOptions(e: Node): (string | null)[] | null {
		const v = unwrapTs(e);
		if (v.type === 'Identifier') return constArrays.get(v.name) ?? null;
		if (v.type !== 'ArrayExpression') return null;
		// A spread could hold anything; one is enough to make the count unknown.
		if (v.elements.some((x) => !x || x.type === 'SpreadElement')) return null;
		return v.elements.map((x) => {
			if (x?.type !== 'ObjectExpression') return null;
			const label = x.properties.find(
				(pr) => pr.type === 'ObjectProperty' && !pr.computed && pr.key.type === 'Identifier' && pr.key.name === 'label',
			);
			return label?.type === 'ObjectProperty' ? staticString(label.value) : null;
		});
	}

	// Built on the first control a `judge` rule names, so a file with none, and
	// every run without `--judge`, never walks for it.
	let scopes: { start: number; end: number; name: string }[] | null = null;
	const enclosingOf = (el: JSXElement): string | null => {
		scopes ??= componentRanges(ast.program);
		const at = el.start ?? 0;
		let best: { start: number; name: string } | null = null;
		for (const s of scopes) if (s.start <= at && s.end >= (el.end ?? at) && (!best || s.start > best.start)) best = s;
		return best?.name ?? null;
	};

	const reading: Omit<DetectorContext, 'canonical'> = {
		nameOf: jsxName,
		canonicalOf,
		elementsIn: (el) => allElements(el),
		optionsIn: staticOptions,
		labelOf: staticLabel,
		enclosingOf,
		sourceOf: (el) => text.slice(el.start ?? 0, el.end ?? 0),
	};
	const readRules = (el: JSXElement): void => {
		if (!rules.length) return;
		const canonical = canonicalOf(el);
		if (!canonical) return;
		const line = el.loc?.start?.line ?? 1;
		const ctx = { ...reading, canonical };
		for (const { patternId, spec } of rules) {
			if (spec.rule === 'judge') {
				const control = judgeControl(el, spec, ctx);
				if (control) controls.push({ file: relPath, line, ...control, patternId });
				continue;
			}
			const detail = DETECTORS.get(spec.rule)?.(el, spec, ctx);
			if (detail) ruleHits.push({ patternId, rule: spec.rule, line, detail });
		}
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
			isSystem = Boolean(target && canonicals.has(target));
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
			groups,
			error,
		});
	};

	walkAst(ast.program, (node) => {
		if (node.type === 'TaggedTemplateExpression') return readTaggedTemplate(node);
		if (node.type === 'JSXElement') {
			readComposite(node);
			readRules(node);
		}
		if (node.type !== 'JSXOpeningElement') return;
		// `<UI.Card.Header>` has no name jsxName will vouch for, but its inline
		// style is still an inline style: read it as the plain element `?.Header`.
		const tag = jsxName(node) ?? (node.name.type === 'JSXMemberExpression' ? `?.${node.name.property.name}` : null);
		if (!tag) return;
		const line = node.loc?.start?.line ?? 1;

		const root = tag.split('.')[0] ?? tag;
		const isComponent = /^[A-Z]/.test(root);
		const isSystem = isComponent && canonicals.has(root);
		if (isSystem) {
			const c = canonicals.get(root) ?? root;
			uses.set(c, (uses.get(c) ?? 0) + 1);
		}

		// Which carriers can earn the substitution exemption: the components whose
		// job is emitting a tag, which is exactly the text and layout sets. Not every
		// export of a design-system package — `@wordpress/components` ships
		// `FormFileUpload`, whose `render` is an ordinary render callback.
		const member = tag.includes('.') ? tag.slice(tag.indexOf('.') + 1) : null;
		const emitsTag = member
			? // `<UI.Text render={ <h4 /> }>` — the namespace is what was imported,
				// so the component name is the member.
				canonicals.has(root) &&
				(ds.textComponents.includes(canonicalName(member, ds.normalizeExports)) ||
					ds.layoutComponents.includes(canonicalName(member, ds.normalizeExports)))
			: textLike.has(root) || layout.has(root);

		const strings: string[] = [];
		let style: ReturnType<typeof readStyleAttr> | null = null;
		let cssAttr: JSXAttribute['value'] = null;
		for (const attr of node.attributes) {
			if (attr.type !== 'JSXAttribute') continue;
			const an = attr.name.type === 'JSXIdentifier' ? attr.name.name : attr.name.name.name;
			if (an === 'className' || an === 'class')
				walkAst(attr.value, (n) => {
					if (n.type === 'StringLiteral') strings.push(n.value);
					else if (n.type === 'TemplateElement') strings.push(n.value.cooked ?? n.value.raw);
				});
			else if (an === 'style') style = readStyleAttr(attr.value);
			else if (an === 'css') cssAttr = attr.value;
			// Only a tag-emitting design-system component's substitution prop earns the
			// exemption. `render` is not a name WPDS reserved — react-router, Formik and
			// Downshift all spell a render prop exactly that.
			//
			// The name must be a plain identifier: `attr.name` collapses a namespace, so
			// `xlink:render` would otherwise read as `render`.
			else if (emitsTag && attr.name.type === 'JSXIdentifier' && ds.substitutionProps.has(an))
				for (const target of substitutionTargets(attr.value)) substituted.add(target.openingElement);
		}
		const classes = classesFrom(strings);

		const owned = cssAttr?.type === 'JSXExpressionContainer' ? cssAttr.expression : null;
		if (owned?.type === 'TaggedTemplateExpression' && typeof owned.start === 'number')
			cssPropOwner.set(owned.start, {
				target: isComponent ? root : tag.toLowerCase(),
				isSystem,
				isText: isSystem && textLike.has(root),
			});

		if (style?.present)
			inlineStyles.push({
				tag: isComponent ? root : tag.toLowerCase(),
				component: isSystem ? (canonicals.get(root) ?? root) : null,
				isSystem,
				isText: isSystem && textLike.has(root),
				decls: style.decls,
				dynamic: style.dynamic,
				dynamicProps: style.dynamicProps,
				file: relPath,
				line,
			});

		if (isComponent) {
			if (!isSystem) return;
			const isText = textLike.has(root);
			for (const cls of classes) bindings.push({ cls, tag: root, isSystem: true, isText, file: relPath, line });
		} else {
			// `render={ <h4 /> }` is not markup being rendered — it is the argument
			// telling a design-system component which tag to emit. Its children are
			// ordinary markup and still count.
			if (substituted.has(node)) return;
			const lower = tag.toLowerCase();
			const mapped = ds.elementMap.get(lower);
			if (!mapped) return;
			// `<input type="checkbox">` has its own analog and `type="hidden"` has
			// none. A computed or absent value falls back to the element's own.
			let suggest: string | null = mapped.component;
			let render = mapped.render;
			if (mapped.attribute && mapped.values) {
				const attr = node.attributes.find(
					(a) => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === mapped.attribute,
				);
				const v = attr?.type === 'JSXAttribute' ? attr.value : null;
				const raw =
					v?.type === 'StringLiteral'
						? v.value
						: v?.type === 'JSXExpressionContainer' && v.expression.type !== 'JSXEmptyExpression'
							? staticString(v.expression)
							: null;
				const value = raw?.trim().toLowerCase();
				if (value !== undefined && Object.hasOwn(mapped.values, value)) {
					suggest = mapped.values[value] ?? null;
					// `render` is the element's own analog's; a picked one renders itself.
					render = undefined;
				}
				if (suggest === null) return;
			}
			// An inline style is styling too: a bare <div> laid out with
			// style={{ display: 'flex' }} and no className is the shape agents write most.
			if (mapped.styledOnly && !classes.length && !style?.present) return;
			rawEls.push({
				tag: lower,
				classes,
				file: relPath,
				line,
				suggest,
				render,
				styledOnly: mapped.styledOnly,
				inlineStyled: Boolean(style?.present),
				inlineLayout: Boolean(style?.decls?.some(isLayoutDecl)),
			});
		}
	});

	return { ...result, componentImports: componentImports.map((ci) => ({ ...ci, uses: uses.get(ci.canonical) ?? 0 })) };
}
