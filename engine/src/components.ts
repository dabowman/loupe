/**
 * Component currency — which imports are the current best-practice choice.
 *
 * A design system with two live packages (`@wordpress/components`,
 * `@wordpress/ui`) can have the same name mean two different things at once —
 * `Button` is stable in one and experimental in the other — so the registry keys
 * on `package::name`, never on name alone.
 *
 * An entry may also carry a styling surface: what the component styles itself
 * and the prop that controls each. That is what lets `system/override` tell a
 * class fighting a component from a class doing what `className` is for.
 */

import { propsOverlap } from './styles.ts';
import type { ComponentEntry, StylingSurface } from './types.ts';

/** The shape a registry entry has before anything has vouched for it. */
type MaybeEntry = Partial<ComponentEntry> | null | undefined;

const isEntry = (c: MaybeEntry): c is ComponentEntry => Boolean(c?.name && c?.package && c?.status);

const isControl = (v: unknown): v is string | string[] | null =>
	v === null ||
	(typeof v === 'string' && v !== '') ||
	(Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== ''));

/**
 * A surface as authored, or `undefined` if it is not one. A malformed surface is
 * dropped rather than half-read: no surface fails safe, and a surface claiming
 * ownership nobody wrote down does not.
 */
function readSurface(raw: unknown): StylingSurface | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const { properties, verifiedAgainst, note } = raw as Record<string, unknown>;
	if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
	const entries = Object.entries(properties as Record<string, unknown>);
	if (!entries.every(([, v]) => isControl(v))) return undefined;
	return {
		properties: Object.fromEntries(entries.map(([p, v]) => [p.toLowerCase(), v as string | string[] | null])),
		...(typeof verifiedAgainst === 'string' ? { verifiedAgainst } : {}),
		...(typeof note === 'string' ? { note } : {}),
	};
}

/**
 * Normalize a registry file or inline array into a `package::name` -> entry map.
 *
 * Throws on a registry with no entry list where one belongs: read as empty, it
 * switches the currency rules off and reports clean.
 */
export function loadComponents(raw: unknown): Map<string, ComponentEntry> {
	const found: unknown = Array.isArray(raw) ? raw : (raw as { components?: unknown } | null)?.components;
	if (!Array.isArray(found))
		throw new Error('not a component registry: expected an array of entries, or an object with a "components" array');
	const list: MaybeEntry[] = found;
	const read = list.filter(isEntry).map((c): ComponentEntry => {
		// `surfaced` is the loader's to say, whatever the file claims.
		const { surface, surfaced: _claimed, ...rest } = c;
		const s = surface === undefined ? undefined : readSurface(surface);
		return s ? { ...rest, surface: s } : rest;
	});
	// A registry that records any surface has opted in to reading by surface,
	// and its gaps are gaps. A malformed surface is not a recorded one.
	const surfaced = read.some((c) => c.surface !== undefined);
	const map = new Map<string, ComponentEntry>();
	for (const c of read) map.set(`${c.package}::${c.name}`, surfaced ? { ...c, surfaced: true } : c);
	return map;
}

/**
 * The surface a component's styling is recorded under. A compound part is its
 * own element, so it has its own entry or none: `Card.Content` does not inherit
 * what `Card` records. `Card.Root` is the exception — the root part is the
 * element the namespace's entry describes.
 */
export function surfaceFor(
	registry: ReadonlyMap<string, ComponentEntry>,
	pkg: string | undefined,
	name: string | undefined,
): StylingSurface | undefined {
	if (!pkg || !name) return undefined;
	const exact = registry.get(`${pkg}::${name}`);
	if (exact) return exact.surface;
	const [root, ...parts] = name.split('.');
	return parts.length === 1 && parts[0] === 'Root' ? registry.get(`${pkg}::${root}`)?.surface : undefined;
}

/**
 * Whether the registries a component could come from record styling surfaces
 * at all — answered per component, because several profiles can be active and
 * only some of them record surfaces. Where none does, a missing surface says
 * nothing about this component in particular, and `system/override` keeps the
 * reading it had before surfaces existed: an appearance property on a class
 * bound to a design-system component blocks.
 *
 * Most precise first:
 *   the component's own entry, or its namespace's for a part   → that entry's registry
 *   no entry, but entries from the same package                → whether any of them is surfaced
 *   nothing from its package, or no package to key on          → whether any registry in the run is
 */
export function surfacesRecorded(
	registry: ReadonlyMap<string, ComponentEntry>,
): (pkg: string | undefined, name: string | undefined) => boolean {
	const byPackage = new Map<string, boolean>();
	for (const e of registry.values())
		byPackage.set(e.package, (byPackage.get(e.package) ?? false) || e.surfaced === true);
	const anywhere = [...byPackage.values()].some(Boolean);
	return (pkg, name) => {
		if (!pkg) return anywhere;
		const entry = (name && registry.get(`${pkg}::${name}`)) || (name && registry.get(`${pkg}::${name.split('.')[0]}`));
		if (entry) return entry.surfaced === true;
		return byPackage.get(pkg) ?? anywhere;
	};
}

/**
 * Whether a surface owns `prop`, and through what. `via` names the controlling
 * props, and is empty where the component sets the property and exposes no
 * prop for it. `undefined` where the surface does not own it.
 */
export function ownership(surface: StylingSurface, prop: string): { owned: string; via: string[] } | undefined {
	for (const [owned, control] of Object.entries(surface.properties))
		if (propsOverlap(prop, owned))
			return { owned, via: control === null ? [] : Array.isArray(control) ? control : [control] };
	return undefined;
}
