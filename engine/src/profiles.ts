/**
 * Design-system profiles.
 *
 * The engine is design-system agnostic: everything it knows about WPDS arrives
 * as config. The *plugin* was not — it passed the WPDS pattern and component
 * registries on every run, to every project, because there was nowhere else to
 * put them. On a WordPress repo that is invisible. On any other React repo it
 * is a WPDS composite matching by name alone and a finding telling the agent to
 * import a module that does not exist there.
 *
 * A profile is the bundle that makes one design system real: which packages it
 * is, which preset configures it, and the registries that describe its
 * components and composites. Profiles are selected by what the project actually
 * imports, so shipping a second design system is adding a directory — never
 * editing the engine.
 *
 *   profiles/
 *     wpds/
 *       profile.json          { id, name, packages, preset, patterns, components }
 *       patterns/index.json
 *       components/index.json
 *
 * A profile with no `packages` is never selected automatically — there is
 * nothing to recognize it by — and has to be named with `--profile <id>`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadPatterns } from './patterns.ts';
import { loadComponents } from './components.ts';
import { registryApplies, registryPackages } from './registry.ts';
import type { ComponentEntry, Config, InertRegistry, Pattern, Profile, SkippedRegistry } from './types.ts';

export type { InertRegistry, Profile, SkippedRegistry };

/** A registry pair to merge in, labelled for the report. */
export interface RegistrySource {
	label: string;
	patterns?: string | null;
	components?: string | null;
	/**
	 * Merge these registries without asking whether they apply.
	 *
	 * The scope gate asks "is this project on that design system?" — a question
	 * `--profile <id>` has already answered. Asking it again drops the registries
	 * of the profile the user named, which is the whole reason they named it.
	 */
	forced?: boolean;
}

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

/** Resolve a profile-relative path. */
const under = (dir: string, rel: string): string => (isAbsolute(rel) ? rel : join(dir, rel));

const asStrings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** A `profile.json` as authored — every field optional, nothing vouched for. */
interface RawProfile {
	id?: string;
	name?: string;
	preset?: string;
	packages?: unknown;
	skills?: unknown;
	patterns?: string;
	components?: string;
}

/**
 * Every `<root>/<id>/profile.json`. A malformed or unreadable profile is
 * skipped rather than thrown: one bad directory must not take the gate down.
 */
export function readProfiles(root: string | null | undefined): Profile[] {
	if (!root || !existsSync(root)) return [];
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: Profile[] = [];
	// Sorted, and one profile per id: two directories claiming the same id would
	// otherwise both be selected, and `--profile <id>` would apply each of them.
	// Sorting is what makes "the first one wins" a fact rather than a filesystem
	// accident.
	const seen = new Set<string>();
	for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		const manifest = join(dir, 'profile.json');
		if (!existsSync(manifest)) continue;
		try {
			const raw = readJson(manifest) as RawProfile;
			const id = raw.id || e.name;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({
				id,
				name: raw.name || raw.id || e.name,
				preset: raw.preset ?? null,
				packages: asStrings(raw.packages),
				skills: asStrings(raw.skills),
				patterns: raw.patterns ? under(dir, raw.patterns) : null,
				components: raw.components ? under(dir, raw.components) : null,
				dir,
			});
		} catch {
			/* a profile that cannot be parsed contributes nothing */
		}
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The profiles that apply to `config`.
 *
 * Selection is by package: the project imports `@wordpress/components`, so the
 * profile that claims it is the one whose composites can legitimately match.
 * `force` names a profile explicitly and skips the question.
 */
export function selectProfiles(
	profiles: readonly Profile[],
	// Narrower than `Config` on purpose: selection reads the package list and
	// nothing else, and a caller holding just that should not have to build a
	// whole config to ask which profiles apply.
	config: { designSystem?: { packages?: readonly string[] } },
	force: string | null = null,
): Profile[] {
	if (force) return profiles.filter((p) => p.id === force);
	const pkgs = config.designSystem?.packages ?? [];
	if (!pkgs.length) return [];
	return profiles.filter((p) => p.packages.some((pkg) => pkgs.includes(pkg)));
}

/**
 * Merge registries from `sources` into `config`.
 *
 * The project always wins: a repo that has written down its own `page-header`
 * means that one, not the shipped generic. Returns what was applied and what
 * was skipped, so the CLI can say why a registry it was handed did nothing —
 * a registry silently ignored looks exactly like a registry with no findings.
 *
 */
export function applyRegistries(
	config: Config,
	sources: readonly RegistrySource[],
	{
		setPatterns,
		setComponentRegistry,
	}: {
		setPatterns: (config: Config, patterns: Pattern[]) => Config;
		setComponentRegistry: (config: Config, registry: Map<string, ComponentEntry>) => Config;
	},
): { applied: string[]; skipped: SkippedRegistry[]; inert: InertRegistry[]; errors: string[] } {
	const applied: string[] = [];
	const skipped: SkippedRegistry[] = [];
	const errors: string[] = [];
	// Labels of the sources that were merged by fiat, for the inert check below.
	const forcedPatterns: string[] = [];
	const forcedComponents: string[] = [];

	let patterns: Pattern[] = config.patterns ?? [];
	const components = new Map<string, ComponentEntry>(config.componentRegistry ?? []);
	let sawPatterns = false;
	let sawComponents = false;

	for (const src of sources) {
		let used = false;
		if (src.patterns) {
			try {
				const raw = readJson(resolve(src.patterns));
				if (src.forced || registryApplies(raw, config.designSystem.packages)) {
					const own = new Set(patterns.map((p) => p.id));
					patterns = [...patterns, ...loadPatterns(raw).filter((p) => !own.has(p.id))];
					sawPatterns = true;
					used = true;
					if (src.forced) forcedPatterns.push(src.label);
				} else {
					skipped.push({ label: src.label, kind: 'patterns', packages: registryPackages(raw) });
				}
			} catch (err) {
				errors.push(`could not read ${src.label} patterns — ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (src.components) {
			try {
				const raw = readJson(resolve(src.components));
				if (src.forced || registryApplies(raw, config.designSystem.packages)) {
					for (const [key, entry] of loadComponents(raw)) if (!components.has(key)) components.set(key, entry);
					sawComponents = true;
					used = true;
					if (src.forced) forcedComponents.push(src.label);
				} else {
					skipped.push({ label: src.label, kind: 'components', packages: registryPackages(raw) });
				}
			} catch (err) {
				errors.push(`could not read ${src.label} components — ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (used) applied.push(src.label);
	}

	// Only reattach what actually changed: the setters recompute rule
	// availability, and reattaching an untouched registry is a no-op that reads
	// like one that did something.
	if (sawPatterns) setPatterns(config, patterns);
	if (sawComponents) setComponentRegistry(config, components);

	// Merging a registry by fiat is not the same as its rules coming on: a
	// composite signature still needs a component layer to match against, and a
	// registry that carried no entries enables nothing. Either way it is exactly
	// as invisible as one that was skipped — the thing the skip reporting exists
	// to prevent, reached by the other road. A rule the config turns off is not
	// reported: that one was asked for.
	const inert: InertRegistry[] = [];
	for (const label of forcedPatterns) {
		if (config.enabled['patterns/duplicate-composite']) continue;
		if (!config.patterns.length) inert.push({ label, kind: 'patterns', reason: 'it carries no patterns' });
		else if (!config.designSystem.knownComponents.size)
			inert.push({ label, kind: 'patterns', reason: 'this config names no components for its signatures to match' });
	}
	for (const label of forcedComponents)
		if (!config.componentRegistry.size) inert.push({ label, kind: 'components', reason: 'it carries no entries' });

	return { applied, skipped, inert, errors };
}
