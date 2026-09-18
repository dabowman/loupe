/**
 * CSS-in-JS template literals.
 *
 * The inline pass reads `style={{ … }}` object expressions, and the stylesheet
 * pass reads `.css` files. Between them sits the channel `@wordpress/components`
 * is itself built on: emotion's ``css` ` `` and styled-components' ``styled.div` ` ``.
 * Leaving it unchecked is not a neutral gap — it makes the unchecked channel the
 * attractive one, which is the same trap the inline pass was written to close.
 *
 * The declarations go through the SAME classifier as the other two channels, so
 * `margin-bottom: 16px` cannot mean one thing in a stylesheet and another in a
 * template literal.
 *
 * What this cannot do: an interpolation is opaque. `${({ theme }) => …}` could
 * emit anything, so a template whose structure depends on one is reported as a
 * parse diagnostic rather than guessed at.
 */

import postcss from 'postcss';
import type { Container, Rule } from 'postcss';
import type { File, ImportDeclaration, TemplateLiteral } from '@babel/types';
import type { CssInJsLocals, Decl, TemplateGroup } from './types.ts';

/**
 * The export name an import specifier binds, or `'default'`.
 *
 * `import x from 'y'` and `import { css as x } from 'y'` reach the same local
 * name by different shapes, and the imported half can be a string literal
 * (`import { 'a-b' as x }`), so the three specifier kinds need telling apart
 * rather than a chain of optional reads that silently yields undefined.
 */
const importedName = (spec: ImportDeclaration['specifiers'][number]): string => {
	if (spec.type !== 'ImportSpecifier') return 'default';
	return spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
};

/** Packages whose tagged templates are CSS. Config can extend this. */
export const DEFAULT_CSS_IN_JS_PACKAGES = [
	'styled-components',
	'@emotion/styled',
	'@emotion/react',
	'@emotion/css',
	'@emotion/native',
];

/**
 * Local names bound to a CSS-in-JS tag.
 *
 * `styled` produces `styled.div` and `styled(Button)`; `css` and
 * `createGlobalStyle` are bare tags. `keyframes` is deliberately excluded — its
 * body is animation stops, where a literal is the point and there is no token
 * to reach for.
 */
export function cssInJsLocals(ast: File, packages: readonly string[] | undefined): CssInJsLocals {
	const styled = new Set<string>();
	const bare = new Set<string>();
	if (!packages?.length) return { styled, bare, any: false };
	const fromPackage = (src: string): boolean => packages.some((p) => src === p || src.startsWith(`${p}/`));

	for (const node of ast.program.body) {
		if (node.type !== 'ImportDeclaration' || !fromPackage(node.source.value)) continue;
		for (const spec of node.specifiers) {
			const local = spec.local.name;
			const imported = importedName(spec);
			if (imported === 'default' || imported === 'styled') styled.add(local);
			else if (imported === 'css' || imported === 'createGlobalStyle' || imported === 'injectGlobal') bare.add(local);
		}
	}
	return { styled, bare, any: styled.size + bare.size > 0 };
}

/**
 * The CSS text of a template, with interpolations neutralized.
 *
 * `raw` rather than `cooked`: an escape sequence in `cooked` collapses to one
 * character and every line number after it shifts, which puts findings on the
 * wrong lines.
 *
 * A placeholder has to parse where it sits. After `;`, `{`, `}` or at the start
 * an interpolation stands in for whole statements, so it becomes a comment;
 * anywhere else it is part of a value or selector, so it becomes an identifier.
 * Neither introduces a newline, which is what keeps the line map exact.
 */
export function templateText(quasi: TemplateLiteral): string {
	let out = '';
	for (let i = 0; i < quasi.quasis.length; i++) {
		out += quasi.quasis[i]?.value.raw ?? '';
		if (i < quasi.expressions.length) {
			const prev = out.replace(/\s+$/, '').slice(-1);
			out += prev === '' || prev === ';' || prev === '{' || prev === '}' ? '/*dsh*/' : 'dsh-e';
		}
	}
	return out;
}

const GRID_DECL = (p: string, v: string): boolean =>
	(p === 'display' && /\bgrid\b/.test(v)) || p === 'grid' || p.startsWith('grid-template') || p.startsWith('grid-auto');

/**
 * Declaration groups in a template, each with the selector that owns it.
 *
 * The body is wrapped in a synthetic rule because a styled template's top level
 * is bare declarations, which is not a stylesheet. The wrapper is prepended
 * without a newline so every line number still maps straight back to source.
 *
 */
export function parseTemplate(cssText: string, startLine: number): { groups: TemplateGroup[]; error: string | null } {
	let root;
	try {
		root = postcss.parse(`.dsh-root{${cssText}\n}`, { from: undefined });
	} catch (err) {
		return { groups: [], error: messageOf(err) };
	}
	const groups: TemplateGroup[] = [];
	const at = (node: { source?: { start?: { line: number } } }): number =>
		startLine + ((node.source?.start?.line ?? 1) - 1);

	const collect = (rule: Container, selector: string | null, onTarget: boolean): void => {
		const decls: Decl[] = [];
		const nested: Rule[] = [];
		const walk = (container: Container): void => {
			for (const node of container.nodes ?? []) {
				if (node.type === 'decl') {
					// A value that came from an interpolation is unknowable, and naming a
					// property whose value we cannot see is noise, not a finding.
					if (node.value.includes('dsh-e')) continue;
					decls.push({ prop: node.prop.toLowerCase(), value: node.value, line: at(node) });
				} else if (node.type === 'atrule')
					walk(node); // @media keeps the enclosing selector
				else if (node.type === 'rule') nested.push(node);
			}
		};
		walk(rule);
		const first = decls[0];
		if (first)
			groups.push({
				selector,
				decls,
				isGrid: decls.some((d) => GRID_DECL(d.prop, d.value)),
				onTarget,
				line: first.line ?? startLine,
			});
		for (const child of nested) {
			const sel = child.selectors.join(', ');
			// `&:hover` on a styled(Button) is still that Button; a descendant
			// selector is some other element and must not answer for it.
			collect(child, sel, onTarget && child.selectors.every((s) => /^&[^\s>+~]*$/.test(s.trim())));
		}
	};

	const top = root.nodes.find((n): n is Rule => n.type === 'rule');
	if (top) collect(top, null, true);
	return { groups, error: null };
}

/** First line of an unknown throw. A parser can reject anything, including non-Errors. */
const messageOf = (err: unknown): string =>
	(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'parse failed';
