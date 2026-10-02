/**
 * `system/override`: CSS restyling what a design-system component styles
 * itself. Two forms.
 *
 * On a declaration: an appearance property in a rule whose key class is bound
 * to a component (`<Button className="x">`, `.x { background: … }`), where the
 * registry records that the component owns that property — its styling
 * surface. It supersedes the ordinary verdict on the declaration, so it steps
 * aside when it is off: on a headless library, a class on a component is how
 * you are meant to style it, and the `background: #fff` still owes its token.
 *
 * `className` is a public prop, and a class setting something the component
 * has no opinion about is that prop doing its job — so the property has to be
 * one the surface lists. A component with no recorded surface fails safe: the
 * declaration gets the verdict it would have had on a plain element, which is
 * advisory, rather than a blocking finding promising a prop nobody checked
 * exists. Converting a raw element to a component must not, on its own, turn
 * that element's advisory findings into blocking ones.
 *
 * On a whole rule: a key selector reaching into one of the library's own parts
 * — a class the design system's stylesheets style, or one carrying an
 * external prefix. "Stop styling this" replaces every per-declaration remedy
 * inside it, so it is one finding in their place. That needs no surface: the
 * selector is past the element `className` reached.
 *
 * Logic, per declaration:
 *   the key class is bound to no design-system component  → not ours, next check
 *   not one of `APPEARANCE_PROPS` — colour, border, radius,
 *   type, opacity, filter                                 → not ours, next check
 *   this rule is off                                      → not ours, next check
 *   no bound component's surface owns the property — none
 *   recorded, or recorded without it                      → not ours, next check
 *   owned, through a prop                                 → system/override, naming the prop
 *   owned, with no prop for it                            → system/override, saying so
 */

import type { DeclarationCheck } from '../../analyze.ts';
import { ownership } from '../../components.ts';
import { APPEARANCE_PROPS } from '../../styles.ts';
import type { Binding, ClassifiedFinding, StylingSurface } from '../../types.ts';

/** The first binding whose surface owns `prop`, and how. */
export function owningBinding(
	bound: readonly Binding[],
	prop: string,
	surfaceOf: (b: Binding) => StylingSurface | undefined,
): { binding: Binding; via: string[] } | undefined {
	for (const binding of bound) {
		const surface = surfaceOf(binding);
		const owned = surface && ownership(surface, prop);
		if (owned) return { binding, via: owned.via };
	}
	return undefined;
}

/** `variant` → "its variant prop"; `variant`, `tone` → "its variant and tone props". */
export const viaProps = (via: readonly string[]): string =>
	via.length === 1 ? `its ${via[0]} prop` : `its ${via.slice(0, -1).join(', ')} and ${via.at(-1)} props`;

export const systemOverride: DeclarationCheck = ({ prop }, { boundSystem, enabled, surfaceOf }) => {
	if (!boundSystem[0] || !APPEARANCE_PROPS.has(prop) || !enabled('system/override')) return undefined;
	const owner = owningBinding(boundSystem, prop, surfaceOf);
	if (!owner) return undefined;
	const head = `<${owner.binding.tag}> ← ${prop}`;
	return {
		rule: 'system/override',
		message: owner.via.length
			? `${head} — set via ${viaProps(owner.via)}`
			: `${head} — it sets this itself and has no prop for it`,
		// Identity is the component and the property, as it was before the
		// message said why: a baseline entry must survive the explanation.
		code: head,
	};
};

/**
 * The whole-rule form, for a rule that styles anything at all. A project prefix
 * wins over a library one.
 *
 * Logic, per CSS rule that styles anything at all:
 *   the first key class the library styles or that carries an external
 *   prefix, and that the project's own namespace does not claim  → system/override
 *   no key class is one of those                                 → clean
 */
export function libraryOverride(
	keyClasses: readonly string[],
	isLibrary: (cls: string) => boolean,
	isProject: (cls: string) => boolean,
): ClassifiedFinding | null {
	const part = keyClasses.find((c) => isLibrary(c) && !isProject(c));
	return part ? { rule: 'system/override', message: `.${part} (library internal)` } : null;
}
