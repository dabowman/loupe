/**
 * Which registries apply to which projects.
 *
 * Pattern signatures are component *names*, and names are the one thing design
 * systems do not keep to themselves — the WPDS `page-header` signature matches a
 * Chakra page header exactly. So a registry declaring `packages` applies only to
 * a project importing at least one of them; one declaring none applies anywhere,
 * which is what a project's own registry wants.
 *
 * Design notes: docs/design/cli.md#profiles
 */

/** A registry file's optional scoping field. An inline array declares nothing. */
type ScopedRegistry = { packages?: unknown } | null | undefined;

/** The `packages` a registry declares, for scoping and for reporting why it was skipped. */
export const declaredPackages = (raw: unknown): string[] => {
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
