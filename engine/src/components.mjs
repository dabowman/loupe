/**
 * Component currency — which imports are the current best-practice choice.
 *
 * A design system with two live packages (`@wordpress/components`,
 * `@wordpress/ui`) can have the same name mean two different things at once —
 * `Button` is stable in one and experimental in the other — so the registry
 * keys on `package::name`, never on name alone.
 */

/** Normalize a registry file or inline array into a `package::name` -> entry map. */
export function loadComponents(raw) {
	const list = Array.isArray(raw) ? raw : raw?.components || [];
	const map = new Map();
	for (const c of list) {
		if (!c?.name || !c?.package || !c?.status) continue;
		map.set(`${c.package}::${c.name}`, c);
	}
	return map;
}
