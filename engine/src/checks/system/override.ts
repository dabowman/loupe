/**
 * `system/override`: CSS restyling a design-system component, whose props and
 * tokens are the remedy. Two forms.
 *
 * On a declaration: an appearance property in a rule whose key class is bound
 * to a component (`<Button className="x">`, `.x { background: … }`). It
 * supersedes the ordinary verdict on the declaration, so it steps aside when
 * it is off: on a headless library, a class on a component is how you are
 * meant to style it, and the `background: #fff` still owes its token.
 *
 * On a whole rule: a key selector reaching into one of the library's own parts
 * — a class the design system's stylesheets style, or one carrying an
 * external prefix. "Stop styling this" replaces every per-declaration remedy
 * inside the rule, so it is one finding in their place.
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { APPEARANCE_PROPS } from '../../styles.ts';
import type { ClassifiedFinding } from '../../types.ts';

export const systemOverride: DeclarationCheck = ({ prop }, { boundSystem, enabled }) =>
	boundSystem[0] && APPEARANCE_PROPS.has(prop) && enabled('system/override')
		? { rule: 'system/override', message: `<${boundSystem[0].tag}> ← ${prop}` }
		: undefined;

/**
 * The whole-rule form, for a rule that styles anything at all.
 *
 * A project prefix wins over a library one. `wp-parsely-*` matches the `wp-`
 * external prefix, and reporting a project's own class as a library internal
 * sends the agent to fix something it does not own.
 */
export function libraryOverride(
	keyClasses: readonly string[],
	isLibrary: (cls: string) => boolean,
	isProject: (cls: string) => boolean,
): ClassifiedFinding | null {
	const part = keyClasses.find((c) => isLibrary(c) && !isProject(c));
	return part ? { rule: 'system/override', message: `.${part} (library internal)` } : null;
}
