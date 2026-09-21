/**
 * `confirm-pair`: a `container` whose only `button`s are exactly two with
 * consent labels and no form control inside — the modal that should have been
 * a confirm dialog. A hit reports the registry entry that carries the
 * detector, as `patterns/superseded-composite`.
 *
 * Logic, per JSX element:
 *   the element is not the entry's `container` component   → no hit
 *   some descendant takes input — a design-system component
 *   named *Control/Field/Picker/Input/Textarea/Editor, a
 *   DataForm/Field.Root/Fieldset, or a raw input, select
 *   or textarea                                            → no hit, it is a form
 *   its `button` descendants are not exactly two           → no hit
 *   either label is unreadable from the source, or does not
 *   start with a consent word                              → no hit
 *   otherwise                                              → hit, naming both labels
 */

import type { JSXElement } from '@babel/types';
import type { Detector } from '../../markup.ts';
import { stringParam } from '../../patterns.ts';

// Labels a button carries when it is asking for consent rather than input.
// Matched at the start, so 'Delete permanently' and 'Yes, delete' both count;
// 'Close' is left out because a pair of Cancel and Close is a notice, not a
// question.
const CONSENT = '^(cancel|delete|remove|discard|reset|confirm|ok|yes|no|continue|proceed|leave|revert)\\b';
// What makes a modal a form rather than a question: any control that takes
// input. A system component named like one, or a raw input element.
const CONTROLS = '(Control|Field|Picker|Input|Textarea|Editor)$|^(DataForm|Field\\.Root|Fieldset)';

export const confirmPair: Detector = (el, spec, ctx) => {
	if (ctx.canonical !== stringParam(spec, 'container', '')) return null;
	const button = stringParam(spec, 'button', 'Button');
	const consent = new RegExp(stringParam(spec, 'labels', CONSENT), 'i');
	const controls = new RegExp(stringParam(spec, 'controls', CONTROLS));
	const inside = ctx.elementsIn(el);
	const isControl = (c: JSXElement): boolean => {
		const name = ctx.nameOf(c);
		const sys = ctx.canonicalOf(c);
		if (sys) return controls.test(sys) || controls.test(name ?? '');
		return !!name && /^(input|select|textarea)$/.test(name);
	};
	if (inside.some(isControl)) return null;
	const labels = inside.filter((c) => ctx.canonicalOf(c) === button).map(ctx.labelOf);
	if (labels.length !== 2 || !labels.every((l) => l !== null && consent.test(l))) return null;
	return `${ctx.canonical} with two consent buttons (${labels.join(' / ')}) and no form control`;
};
