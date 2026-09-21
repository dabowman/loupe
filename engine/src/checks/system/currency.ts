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
 * Every `Name (@package)` a `supersededBy` string names.
 *
 * The field is prose — `Stack (@wordpress/ui, direction="row")`, or a sentence
 * naming two candidates and when each applies — so the components in it are
 * read off rather than parsed. A string that names none ("CSS grid or absolute
 * positioning") yields nothing, which is the honest answer: the remedy there is
 * hand-written, not an import swap.
 */
const namedReplacements = (supersededBy: string | undefined): { name: string; package: string }[] =>
	[...(supersededBy ?? '').matchAll(/([A-Z][\w.]*)\s*\(\s*(@[\w@/.-]+)/g)].map((m) => ({
		name: String(m[1]),
		package: String(m[2]),
	}));

/**
 * Whether a superseded entry's replacement is one the registry would recommend.
 *
 * True when the string names no component at all (the remedy is prose, and the
 * finding is still worth making) or when at least one named candidate is not
 * itself `locked` or `experimental`. False only when every candidate is one the
 * design system's own metadata says not to reach for yet — `DropdownMenu` is
 * the shipped case: `Menu (@wordpress/components)` is core-only and
 * `Menu (@wordpress/ui)` is in flux, so the finding asks for a migration onto
 * an API nobody should adopt, and the only answer available to whoever gets it
 * is a suppression restating what the registry already records.
 *
 * This is the same judgement `experimental` status already earns on the *import*
 * side, applied to the replacement rather than the thing being replaced.
 */
export function usableReplacement(
	registry: ReadonlyMap<string, ComponentEntry>,
	supersededBy: string | undefined,
): boolean {
	const candidates = namedReplacements(supersededBy);
	if (!candidates.length) return true;
	// Unknown to the registry is not a reason to stay silent: the registry
	// records currency, not existence, and a name it has never heard of is far
	// likelier to be a real component than a retracted one.
	return candidates.some((c) => {
		// `Menu.Group` is not its own entry — a compound component's currency is
		// its root's, and the registry keys the root. Without this the dotted
		// subcomponents of a locked component read as unknown, so `MenuGroup` and
		// `MenuItem` went on demanding a migration their parent was spared.
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
		// A replacement the registry itself will not recommend is not a
		// replacement. Firing anyway asks for a migration onto a private or
		// in-flux API, and the only honest answer an agent can give is a
		// suppression restating what the registry already knows.
		if (!usableReplacement(registry, entry.supersededBy)) continue;
		const key = `${ci.file} ${rule} ${ci.canonical} ${ci.package}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const remedy = entry.supersededBy ? ` → ${entry.supersededBy}` : '';
		// The finding anchors at the import and there is one per file, so the
		// count is what says whether this is a one-line edit or a dozen call
		// sites — the question an agent otherwise answers by grepping the file.
		const uses = ci.uses > 1 ? ` ×${ci.uses}` : '';
		out.push({
			rule,
			file: ci.file,
			line: ci.line,
			message: `${ci.canonical} (${ci.package})${uses}${remedy}`,
			// Carried, not concatenated: the finalize pass caps `message`, and a
			// registry note spliced into it lost its own last clause to that cap
			// in every format at once.
			note: entry.note,
			code: `${rule}:${ci.package}:${ci.canonical}`,
			// The declaration line and the one above it: both were live anchors
			// when every specifier reported on the declaration, and a directive
			// someone signed off must not go silent because the reporting moved.
			scopeLines: [ci.declLine, ci.declLine - 1],
		});
	}
	return out;
}
