/**
 * `judge`: every element named in `components` is an instance of the entry's
 * pattern, and is collected as a control for `check --judge` to ask about
 * (`judge.ts`, `judge/force.ts`). Not a finding by itself: only a redirect the
 * answers resolve to is, as `patterns/judged-redirect`. The scanner runs it
 * only under `--judge`.
 *
 * Logic, per JSX element:
 *   its canonical name, member and all (`Menu.Item`), is not in the entry's
 *   `components`                                          → not a control
 *   it carries an attribute the entry's `unless` names,
 *   or any spread, which could carry one                  → not a control
 *   otherwise                                             → collect it: the component
 *                                                           name, the enclosing
 *                                                           component and its source
 */

import type { DetectorContext } from '../../markup.ts';
import { listParam } from '../../patterns.ts';
import type { JSXElement } from '@babel/types';
import type { Control, RuleSpec } from '../../types.ts';

// A control is a few lines. The cap is for the one that wraps a whole panel,
// which would spend a request's tokens on markup the question is not about.
const MAX_CONTROL_SOURCE = 2000;

export function judgeControl(
	el: JSXElement,
	spec: RuleSpec,
	ctx: DetectorContext,
): Pick<Control, 'component' | 'enclosing' | 'source'> | null {
	// `Menu.Item` is the registry's name for it; the file binds `Menu`,
	// maybe under an alias, and the member is written as-is.
	const name = ctx.nameOf(el) ?? '';
	const component = name.includes('.') ? `${ctx.canonical}${name.slice(name.indexOf('.'))}` : ctx.canonical;
	if (!listParam(spec, 'components').includes(component)) return null;
	// A spread could carry any of `unless` — Gutenberg's revisions button
	// spreads an `href` in one branch — so it is enough to not ask.
	const unless = listParam(spec, 'unless');
	const realized =
		unless.length > 0 &&
		el.openingElement.attributes.some(
			(a) => a.type === 'JSXSpreadAttribute' || (a.name.type === 'JSXIdentifier' && unless.includes(a.name.name)),
		);
	if (realized) return null;
	return { component, enclosing: ctx.enclosingOf(el), source: ctx.sourceOf(el).slice(0, MAX_CONTROL_SOURCE) };
}
