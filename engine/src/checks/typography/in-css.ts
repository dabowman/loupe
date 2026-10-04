/**
 * `typography/in-css`: a type property set in CSS on a class bound to a text
 * component, whose size and style props are the remedy.
 *
 * It supersedes the ordinary verdict on the declaration — `font-size: 13px`
 * is otherwise `typography/untokenized` — so it steps aside when it is off.
 *
 * Being declared a text component (`designSystem.components.text`) is itself
 * the claim that the component owns its type. Where the registry records a
 * styling surface the claim gets narrower: `@wordpress/ui`'s `Text` sets
 * family, size, line height and weight through `variant`, and never sets
 * `letter-spacing`, so a class setting that is doing what `className` is for.
 * With no surface recorded the declaration stands, as it always has.
 *
 * Logic, per declaration:
 *   not `font`, `font-size`, `font-weight`, `font-family`,
 *   `line-height` or `letter-spacing`             → not ours, next check
 *   the key class is bound to no text component   → not ours, next check
 *   this rule is off                              → not ours, next check
 *   the component's recorded surface does not
 *   own the property                              → not ours, next check
 *   otherwise                                     → typography/in-css, naming the
 *                                                   prop the surface records
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { ownership } from '../../components.ts';
import { TYPE_PROPS } from '../../styles.ts';
import { viaProps } from '../system/override.ts';

export const typographyInCss: DeclarationCheck = ({ prop }, { boundText, enabled, surfaceOf }) => {
	const text = boundText[0];
	if (!TYPE_PROPS.has(prop) || !text || !enabled('typography/in-css')) return undefined;
	const surface = surfaceOf(text);
	const owned = surface ? ownership(surface, prop) : undefined;
	if (surface && !owned) return undefined;
	const head = `${prop} on <${text.tag}>`;
	return owned?.via.length
		? { rule: 'typography/in-css', message: `${head} — set via ${viaProps(owned.via)}`, code: head }
		: { rule: 'typography/in-css', message: head };
};
