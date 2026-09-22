/**
 * `system/locked-component` and `system/superseded-component`: whether an
 * import is still the current, recommended choice, independent of any CSS.
 *
 * `locked` is a private API the design system does not support outside its own
 * core; `legacy` is one a current component now covers. `experimental`-status
 * entries never fire: WPDS itself flags those not-yet-safe to recommend, so the
 * call is contextual, not mechanical, and belongs in the authoring skill, not a
 * blocking check.
 *
 * Logic, per component import:
 *   the registry has no entry for `package::name`             → clean
 *   its status is neither `legacy` nor `locked`               → clean
 *   the rule that status maps to is off                       → clean
 *   `supersededBy` names candidates and every one of them is
 *   itself `locked` or `experimental`                         → clean
 *   already reported for this file, component and package     → skipped
 *   status `locked`                                           → system/locked-component
 *   status `legacy`                                           → system/superseded-component
 */

import type { Candidate } from '../../analyze.ts';
import type { ComponentEntry, ComponentImport, RuleId } from '../../types.ts';

/**
 * Every `Name (@package)` a `supersededBy` string names. The field is prose, so
 * components are read off it rather than parsed; a string naming none yields
 * nothing.
 */
const namedReplacements = (supersededBy: string | undefined): { name: string; package: string }[] =>
	[...(supersededBy ?? '').matchAll(/([A-Z][\w.]*)\s*\(\s*(@[\w@/.-]+)/g)].map((m) => ({
		name: String(m[1]),
		package: String(m[2]),
	}));

/**
 * Whether every package carrying this name is stale — so the name itself is no
 * longer something to write. A component that is `legacy` in one package and
 * `recommended` in another (`Text`, in `@wordpress/components` and
 * `@wordpress/ui`) is not: the name is still current somewhere. Unknown to the
 * registry is not stale either; it is unknown.
 */
export const supersededEverywhere = (registry: ReadonlyMap<string, ComponentEntry>, name: string): boolean => {
	const entries = [...registry.values()].filter((e) => e.name === name);
	return entries.length > 0 && !entries.some((e) => e.status === 'recommended');
};

/**
 * Whether a superseded entry's replacement is one the registry would recommend.
 *
 * True when the string names no component at all, or when at least one named
 * candidate is not itself `locked` or `experimental`; false only when every
 * candidate is one the design system says not to reach for yet.
 */
export function usableReplacement(
	registry: ReadonlyMap<string, ComponentEntry>,
	supersededBy: string | undefined,
): boolean {
	const candidates = namedReplacements(supersededBy);
	if (!candidates.length) return true;
	// Unknown to the registry is not a reason to stay silent, and a compound
	// component's currency is its root's (`Menu.Group` is not its own entry).
	return candidates.some((c) => {
		const entry = registry.get(`${c.package}::${c.name}`) ?? registry.get(`${c.package}::${c.name.split('.')[0]}`);
		return !entry || (entry.status !== 'locked' && entry.status !== 'experimental');
	});
}

export function currency(
	imports: readonly ComponentImport[],
	registry: ReadonlyMap<string, ComponentEntry>,
	enabled: (rule: RuleId) => boolean,
): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>(); // one finding per file+component+package, not per usage
	for (const ci of imports) {
		if (ci.file === undefined) continue;
		const entry = registry.get(`${ci.package}::${ci.canonical}`);
		if (!entry || (entry.status !== 'legacy' && entry.status !== 'locked')) continue;
		const rule = entry.status === 'locked' ? 'system/locked-component' : 'system/superseded-component';
		if (!enabled(rule)) continue;
		// A replacement the registry itself will not recommend is not a replacement.
		if (!usableReplacement(registry, entry.supersededBy)) continue;
		const key = `${ci.file} ${rule} ${ci.canonical} ${ci.package}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const remedy = entry.supersededBy ? ` → ${entry.supersededBy}` : '';
		// One finding per file, so the count says how many call sites follow.
		const uses = ci.uses > 1 ? ` ×${ci.uses}` : '';
		out.push({
			rule,
			file: ci.file,
			line: ci.line,
			message: `${ci.canonical} (${ci.package})${uses}${remedy}`,
			// Carried, not concatenated: the finalize pass caps `message`.
			note: entry.note,
			code: `${rule}:${ci.package}:${ci.canonical}`,
			// The declaration line and the one above it are both suppression anchors.
			scopeLines: [ci.declLine, ci.declLine - 1],
		});
	}
	return out;
}
