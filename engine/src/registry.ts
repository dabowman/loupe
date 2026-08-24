/**
 * Which registries apply to which projects.
 *
 * Pattern signatures are component *names*, and names are the one thing design
 * systems do not keep to themselves: `Stack`, `Button`, `Modal` and `Text` mean
 * something in almost all of them. So the WPDS `page-header` signature —
 * `Stack(Stack(Text,Text),Stack(Button))` — matches a Chakra page header
 * exactly, and the finding tells the agent to import a WordPress module that
 * project has never heard of. The registry has to say who it is for.
 *
 * A registry that declares `packages` applies only to a project importing at
 * least one of them. One that declares none applies anywhere, which is what a
 * project's own registry wants and what every registry written before this
 * field existed gets.
 */

/** A registry file's optional scoping field. An inline array declares nothing. */
type ScopedRegistry = { packages?: unknown } | null | undefined;

const declaredPackages = (raw: unknown): string[] => {
	const packages = (raw as ScopedRegistry)?.packages;
	return Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string' && p !== '') : [];
};

/**
 * @param raw parsed registry file (or an inline array, which declares nothing)
 * @param dsPackages the active config's `designSystem.packages`
 */
export function registryApplies(raw: unknown, dsPackages: readonly string[] | undefined): boolean {
	const declared = declaredPackages(raw);
	if (!declared.length) return true;
	// A project with no packages of its own has no component layer, so a scoped
	// registry has nothing it could legitimately match.
	return (dsPackages ?? []).some((p) => declared.includes(p));
}

/** The `packages` a registry declares, for reporting why it was skipped. */
export const registryPackages = (raw: unknown): string[] => declaredPackages(raw);
