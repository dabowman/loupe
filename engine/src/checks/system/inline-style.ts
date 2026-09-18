/**
 * `system/inline-style`: a `style` attribute on a design-system component.
 *
 * The remedy is "use the props", not "tokenize that value", so one finding for
 * the attribute supersedes the per-declaration ones — the same way a
 * library-internal override supersedes advice about how to style it. On any
 * other element the declarations go through the ordinary checks.
 */

import type { ClassifiedFinding, InlineStyleElement } from '../../types.ts';

export function inlineStyle(el: InlineStyleElement): ClassifiedFinding | null {
	if (!el.isSystem) return null;
	const shown = el.decls.map((d) => d.prop).slice(0, 3).join(', ');
	const extra = el.decls.length + el.dynamic - Math.min(el.decls.length, 3);
	return {
		rule: 'system/inline-style',
		message: `<${el.tag}> style={{ ${shown || '…'}${extra > 0 ? `, +${extra}` : ''} }}`,
		code: `<${el.tag}> inline-style`,
	};
}
