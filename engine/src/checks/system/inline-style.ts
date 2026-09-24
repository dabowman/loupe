/**
 * `system/inline-style`: a `style` attribute on a design-system component.
 *
 * The remedy is "use the props", not "tokenize that value", so one finding for
 * the attribute supersedes the per-declaration ones — the same way a
 * library-internal override supersedes advice about how to style it. On any
 * other element the declarations go through the ordinary checks.
 *
 * A system can sanction a declaration its component's API has no prop for —
 * WPDS `Text` has no `color`, and its own docs set one through `style`. That
 * is `designSystem.allowedInlineStyles`, keyed by the canonical component name.
 *
 * Logic, per element carrying a `style` attribute:
 *   the element is not a design-system component  → clean; its declarations go
 *                                                   through the ordinary chain
 *   every entry's property is one the system
 *   sanctions on this component, and none is a
 *   spread or an opaque object                     → clean; the declarations go
 *                                                   through the ordinary chain, so a
 *                                                   raw colour is still a hardcoded value
 *   otherwise                                     → system/inline-style, naming the
 *                                                   first three unsanctioned properties
 *                                                   and how many more there are
 */

import type { ClassifiedFinding, InlineStyleElement } from '../../types.ts';

export function inlineStyle(
	el: InlineStyleElement,
	allowed: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): ClassifiedFinding | null {
	if (!el.isSystem) return null;
	const ok = (el.component && allowed.get(el.component)) || new Set<string>();
	const opaque = el.dynamic - el.dynamicProps.length;
	const decls = el.decls.map((d) => d.prop).filter((p) => !ok.has(p));
	const dynamic = el.dynamicProps.filter((p) => !ok.has(p)).length + opaque;
	if (!decls.length && !dynamic) return null;
	const shown = decls.slice(0, 3).join(', ');
	const extra = decls.length + dynamic - Math.min(decls.length, 3);
	return {
		rule: 'system/inline-style',
		message: `<${el.tag}> style={{ ${shown || '…'}${extra > 0 ? `, +${extra}` : ''} }}`,
		code: `<${el.tag}> inline-style`,
	};
}
