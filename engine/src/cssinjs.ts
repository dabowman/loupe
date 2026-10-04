/**
 * CSS-in-JS template literals — emotion's ``css` ` `` and styled-components'
 * ``styled.div` ` ``, the channel `@wordpress/components` is itself built on.
 *
 * The declarations go through the SAME classifier as the stylesheet and inline
 * passes, so one declaration cannot mean different things in different channels.
 *
 * An interpolation is opaque: a template whose structure depends on one is
 * reported as a parse diagnostic rather than guessed at.
 *
 * Design notes: docs/design/analysis.md
 */

import postcss from 'postcss';
import type { Container, Root, Rule } from 'postcss';
import type { File, ImportDeclaration, TemplateLiteral } from '@babel/types';
import { isGridDecl } from './styles.ts';
import { messageLineOf } from './text.ts';
import type { CssInJsLocals, Decl, TemplateGroup } from './types.ts';

/**
 * The export name an import specifier binds, or `'default'`. The three specifier
 * kinds are told apart rather than read through a chain of optional lookups: the
 * imported half can itself be a string literal (`import { 'a-b' as x }`).
 */
export const importedName = (spec: ImportDeclaration['specifiers'][number]): string => {
	if (spec.type !== 'ImportSpecifier') return 'default';
	return spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
};

/** Is `src` one of `packages`, or a subpath of one? */
export const fromPackage = (packages: readonly string[], src: string): boolean =>
	packages.some((p) => src === p || src.startsWith(`${p}/`));

/**
 * Local names bound to a CSS-in-JS tag. `styled` produces `styled.div` and
 * `styled(Button)`; `css` and `createGlobalStyle` are bare tags. `keyframes` is
 * excluded — its body is animation stops, where a literal is the point.
 */
export function cssInJsLocals(ast: File, packages: readonly string[] | undefined): CssInJsLocals {
	const styled = new Set<string>();
	const bare = new Set<string>();
	if (!packages?.length) return { styled, bare, any: false };

	for (const node of ast.program.body) {
		if (node.type !== 'ImportDeclaration' || !fromPackage(packages, node.source.value)) continue;
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
 * `raw` rather than `cooked`, which collapses an escape sequence to one
 * character and shifts every line number after it.
 *
 * A placeholder has to parse where it sits: after `;`, `{`, `}` or at the start
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

/**
 * Declaration groups in a template, each with the selector that owns it.
 *
 * A styled template's top level is bare declarations, so the body is wrapped in
 * a synthetic rule — prepended without a newline, so every line number still
 * maps straight back to source.
 */
export function parseTemplate(cssText: string, startLine: number): { groups: TemplateGroup[]; error: string | null } {
	let root: Root;
	try {
		root = postcss.parse(`.dsh-root{${cssText}\n}`, { from: undefined });
	} catch (err) {
		return { groups: [], error: messageLineOf(err) };
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
					// A value from an interpolation is unknowable, and naming a property
					// whose value we cannot see is noise.
					if (node.value.includes('dsh-e')) continue;
					decls.push({ prop: node.prop.toLowerCase(), value: node.value, line: at(node) });
				} else if (node.type === 'atrule')
					walk(node); // @media keeps the enclosing selector
				else if (node.type === 'rule') nested.push(node);
			}
		};
		walk(rule);
		if (decls.length)
			groups.push({ selector, decls, isGrid: decls.some((d) => isGridDecl(d.prop, d.value)), onTarget });
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
