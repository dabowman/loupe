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

import { existsSync, readFileSync } from 'node:fs';
import { readDir } from './discover.ts';
import { isAbsolute, join, resolve } from 'node:path';
import { loadPatterns } from './patterns.ts';
import { loadComponents } from './components.ts';
import { registryApplies, registryPackages } from './registry.ts';
import type { ComponentEntry, Config, Pattern, Profile, RegistryNote, SkippedRegistry } from './types.ts';

export type { Profile, RegistryNote, SkippedRegistry };

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

/** A field that has to be a usable string, or nothing. Nothing else is coerced. */
const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Byte order, not collation.
 *
 * `localeCompare` answers a different question on a different machine — it
 * folds case, and treats `-` as ignorable at the primary level — so `acme/`
 * versus `Acme/` can resolve one way under a full-ICU Node and another under a
 * different `LANG`. Which of two directories claiming one id wins has to be a
 * property of the input, not of the host.
 */
const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A `profile.json` as authored — every field optional, nothing vouched for. */
interface RawProfile {
	id?: unknown;
	name?: unknown;
	preset?: unknown;
	packages?: unknown;
	skills?: unknown;
	patterns?: unknown;
	components?: unknown;
	tokenDescriptions?: unknown;
}

/**
 * Every `<root>/<id>/profile.json`. A malformed or unreadable profile is
 * skipped rather than thrown: one bad directory must not take the gate down.
 */
export function readProfiles(root: string | null | undefined): Profile[] {
	if (!root || !existsSync(root)) return [];
	const out: Profile[] = [];
	// Sorted, and one profile per id: two directories claiming the same id would
	// otherwise both be selected, and `--profile <id>` would apply each of them.
	// Sorting is what makes "the first one wins" a fact rather than a filesystem
	// accident.
	const seen = new Set<string>();
	for (const e of readDir(root)) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		const manifest = join(dir, 'profile.json');
		if (!existsSync(manifest)) continue;
		try {
			const raw = readJson(manifest) as RawProfile;
			// Every field is whatever JSON happened to hold. `id` in particular is
			// a Set key, the thing `--profile` is matched against and a sort key
			// three lines from the end of this function — and that sort runs
			// outside every `try` here, so a manifest carrying `"id": 3` used to
			// throw past all of this. Under `loupe hook` that is exit 2: a turn
			// blocked by a stack trace, which is exactly what this function's
			// contract promises one bad directory cannot do.
			const id = asString(raw.id) ?? e.name;
			if (seen.has(id)) continue;
			const patterns = asString(raw.patterns);
			const components = asString(raw.components);
			const tokenDescriptions = asString(raw.tokenDescriptions);
			out.push({
				id,
				name: asString(raw.name) ?? asString(raw.id) ?? e.name,
				preset: asString(raw.preset),
				packages: asStrings(raw.packages),
				skills: asStrings(raw.skills),
				patterns: patterns ? under(dir, patterns) : null,
				components: components ? under(dir, components) : null,
				tokenDescriptions: tokenDescriptions ? under(dir, tokenDescriptions) : null,
				dir,
			});
			// Claimed only once the entry is on the list. Reserving it above meant a
			// directory that threw on the way to `push` locked the id out, and a
			// well-formed second directory claiming it was dropped too — leaving
			// `--profile <id>` matching neither.
			seen.add(id);
		} catch {
			/* a profile that cannot be parsed contributes nothing */
		}
	}
	// Output order only — which duplicate won was settled by directory name above.
	return out.sort((a, b) => byBytes(a.id, b.id));
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
): { applied: string[]; skipped: SkippedRegistry[]; notes: RegistryNote[]; errors: string[] } {
	const applied: string[] = [];
	const skipped: SkippedRegistry[] = [];
	const errors: string[] = [];
	// The sources merged by fiat, for the notes below — with what each one
	// actually contributed, not just its label. Reading the merged totals instead
	// answered a different question: a forced registry whose every id collided
	// with the project's own added nothing and was reported as fine, because some
	// *other* source had filled the same list.
	const forced: { label: string; kind: 'patterns' | 'components'; added: number; offScope: string[] }[] = [];

	let patterns: Pattern[] = config.patterns ?? [];
	const components = new Map<string, ComponentEntry>(config.componentRegistry ?? []);
	let sawPatterns = false;
	let sawComponents = false;

	for (const src of sources) {
		let used = false;
		if (src.patterns) {
			try {
				const raw = readJson(resolve(src.patterns));
				const inScope = registryApplies(raw, config.designSystem.packages);
				if (src.forced || inScope) {
					const own = new Set(patterns.map((p) => p.id));
					const fresh = loadPatterns(raw).filter((p) => !own.has(p.id));
					patterns = [...patterns, ...fresh];
					sawPatterns = true;
					used = true;
					if (src.forced)
						forced.push({
							label: src.label,
							kind: 'patterns',
							added: fresh.length,
							offScope: inScope ? [] : registryPackages(raw),
						});
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
				const inScope = registryApplies(raw, config.designSystem.packages);
				if (src.forced || inScope) {
					const before = components.size;
					for (const [key, entry] of loadComponents(raw)) if (!components.has(key)) components.set(key, entry);
					sawComponents = true;
					used = true;
					if (src.forced)
						forced.push({
							label: src.label,
							kind: 'components',
							added: components.size - before,
							offScope: inScope ? [] : registryPackages(raw),
						});
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
	// registry that contributed no entries enables nothing. Either way it is
	// exactly as invisible as one that was skipped — the thing the skip
	// reporting exists to prevent, reached by the other road.
	//
	// Each note is stated once, in the order a reader would check it, rather than
	// left to emerge from which `if` happens to fall through. "A rule the config
	// turns off is not reported" comes first, because that one was asked for —
	// testing `config.enabled` instead conflated it with the cases below and
	// sent someone after a component layer they had nothing wrong with.
	// Every rule the registry feeds, not just the first: with `duplicate-composite`
	// turned off and `superseded-composite` left on, testing only the first said
	// "nothing to report here" about a registry that had in fact enabled nothing.
	const registryRules = [
		'patterns/duplicate-composite',
		'patterns/superseded-composite',
		'patterns/judged-redirect',
	] as const;
	const patternsNote = (added: number): string | null =>
		registryRules.every((rule) => config.severityOf(rule) === 'off')
			? null
			: !added
				? 'merged but enabled nothing — it added no patterns this config did not already have'
				: // A composite is only ever built from names imported out of
					// `designSystem.packages` (see markup.ts), so with none declared
					// there is nothing for a signature to be compared against.
					!config.designSystem.packages.length
					? 'merged but enabled nothing — this config declares no designSystem.packages, so no composite is ever built to compare'
					: // `knownComponents` is `designSystem.components.layout` + `.text`.
						// A merged component *registry* does not feed it, so naming
						// "components" here without saying which pointed at the wrong file.
						!config.designSystem.knownComponents.size
						? 'merged but enabled nothing — this config declares no designSystem.components for its signatures to match'
						: null;
	const componentsNote = (added: number): string | null =>
		added ||
		(config.severityOf('system/locked-component') === 'off' &&
			config.severityOf('system/superseded-component') === 'off')
			? null
			: 'merged but enabled nothing — it added no entries this config did not already have';

	const notes: RegistryNote[] = [];
	for (const f of forced) {
		// Merged past the scope gate onto a config that names a different design
		// system. The registry still applies — that is what `--profile` asked for
		// — but composite signatures are bare component names, so this is the one
		// state in which they match a codebase they describe nothing about, and
		// the finding tells the agent to import a module that is not there.
		if (f.offScope.length)
			notes.push({
				label: f.label,
				kind: f.kind,
				// Named against what the *config* declares, not what the project
				// imports — those differ on an inferred config, and blaming the
				// imports is what sent people hunting through source that was fine.
				note: `forced past the scope check — it is scoped to ${f.offScope.join(', ')} and this config declares ${
					config.designSystem.packages.length
						? `${config.designSystem.packages.join(', ')} — so its findings name a design system this config does not declare`
						: 'no design-system packages, so nothing here says which design system its findings are about'
				}`,
			});
		const note = f.kind === 'patterns' ? patternsNote(f.added) : componentsNote(f.added);
		if (note) notes.push({ label: f.label, kind: f.kind, note });
	}

	return { applied, skipped, notes, errors };
}
