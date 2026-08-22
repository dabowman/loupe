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

/**
 * @param {object} raw parsed registry file (or an inline array, which declares nothing)
 * @param {string[]} dsPackages the active config's `designSystem.packages`
 */
export function registryApplies(raw, dsPackages) {
	const declared = Array.isArray(raw?.packages) ? raw.packages.filter(Boolean) : [];
	if (!declared.length) return true;
	// A project with no packages of its own has no component layer, so a scoped
	// registry has nothing it could legitimately match.
	return (dsPackages || []).some((p) => declared.includes(p));
}

/** The `packages` a registry declares, for reporting why it was skipped. */
export const registryPackages = (raw) =>
	Array.isArray(raw?.packages) ? raw.packages.filter(Boolean) : [];
