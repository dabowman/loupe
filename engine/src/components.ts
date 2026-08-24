/**
 * Component currency — which imports are the current best-practice choice.
 *
 * A design system with two live packages (`@wordpress/components`,
 * `@wordpress/ui`) can have the same name mean two different things at once —
 * `Button` is stable in one and experimental in the other — so the registry
 * keys on `package::name`, never on name alone.
 */

import type { ComponentEntry } from './types.ts';

/** The shape a registry entry has before anything has vouched for it. */
type MaybeEntry = Partial<ComponentEntry> | null | undefined;

const isEntry = (c: MaybeEntry): c is ComponentEntry =>
	Boolean(c?.name && c?.package && c?.status);

/** Normalize a registry file or inline array into a `package::name` -> entry map. */
export function loadComponents(raw: unknown): Map<string, ComponentEntry> {
	const list: MaybeEntry[] = Array.isArray(raw)
		? raw
		: ((raw as { components?: MaybeEntry[] } | null)?.components ?? []);
	const map = new Map<string, ComponentEntry>();
	for (const c of list) {
		if (!isEntry(c)) continue;
		map.set(`${c.package}::${c.name}`, c);
	}
	return map;
}
