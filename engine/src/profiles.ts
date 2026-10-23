/**
 * Design-system profiles.
 *
 * A profile is the bundle that makes one design system real: which packages it
 * is, which preset configures it, and the registries that describe its
 * components and composites. Profiles are selected by what the project actually
 * imports, so shipping a second design system is adding a directory — never
 * editing the engine.
 *
 *   profiles/
 *     wpds/
 *       profile.json          { id, name, packages, preset, patterns, components,
 *                               tokenDescriptions, tokenScopes, delivery }
 *       patterns/index.json
 *       components/index.json
 *       delivery.json         how its packages and tokens reach a page (delivery.ts)
 *
 * A profile with no `packages` is never selected automatically — there is
 * nothing to recognize it by — and has to be named with `--profile <id>`.
 * `packages` is a list, claiming each package at any version, or an object
 * mapping each to the range it describes: `{ "@acme/ui": "<3" }`.
 *
 * Profiles come from two places. The shipped set is the `profiles/` directory
 * beside the engine, and every `--profiles` adds one more after it; the project
 * adds its own, from the directories its config lists under `profiles` and from
 * `.loupe/profiles/`. A project's own profile outranks a shipped one claiming
 * the same id or the same package: a design system rebuilt under its old
 * package name ships the profile that describes it *now*, and the shipped one
 * describes what it used to be.
 *
 * Design notes: docs/design/cli.md#profiles
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { byBytes, readDir } from './discover.ts';
import { join, resolve } from 'node:path';
import { loadPatterns } from './patterns.ts';
import { loadComponents } from './components.ts';
import { mergeDeliveries, readDelivery } from './delivery.ts';
import { setComponentRegistry, setPatterns } from './config.ts';
import { asString, asStrings, isRecord } from './json.ts';
import { under } from './paths.ts';
import { declaredPackages, registryApplies } from './registry.ts';
import { rulesNeeding } from './rules.ts';
import { parseTokenScopes } from './scopes.ts';
import { overlaps, parseRange } from './semver.ts';
import { messageOf } from './text.ts';
import type {
	ComponentEntry,
	Config,
	DeclaredVersion,
	Delivery,
	OutOfRange,
	Pattern,
	Profile,
	ProfileOrigin,
	RegistryNote,
	SkippedRegistry,
} from './types.ts';

export type { DeclaredVersion, OutOfRange, Profile, ProfileOrigin, RegistryNote, SkippedRegistry };

/** Where a project keeps its own profiles when its config does not say. */
export const PROJECT_PROFILES = join('.loupe', 'profiles');

/** The `profile` / `--profile` value that pins selection to no profile at all. */
export const NO_PROFILE = 'none';

/** One directory of profiles, and whose they are. */
export interface ProfileRoot {
	dir: string;
	origin: ProfileOrigin;
}

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

/** A JSON file, or a throw — the callers here catch it and name the file. */
const readJsonStrict = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The profiles a run selected, which is what every reader of a profile's
 * registries, scopes, descriptions or delivery block iterates. Empty until the
 * CLI has attached them, and for a library caller that never does.
 */
export const activeProfiles = (config: Pick<Config, 'profiles'>): Profile[] => config.profiles?.active ?? [];

/** How the active profiles say their packages and tokens reach a page, merged. */
export const activeDelivery = (config: Pick<Config, 'profiles'>): Delivery | null =>
	mergeDeliveries(activeProfiles(config).map((p) => p.delivery));

/** A `profile.json` as authored — every field optional, nothing vouched for. */
interface RawProfile {
	id?: unknown;
	name?: unknown;
	preset?: unknown;
	packages?: unknown;
	patterns?: unknown;
	components?: unknown;
	tokenDescriptions?: unknown;
	tokenScopes?: unknown;
	delivery?: unknown;
}

/**
 * A profile's `tokenScopes`: the block inline, or a profile-relative path to a
 * file holding it. A file that cannot be read is a problem with the profile,
 * named like any other, not a reason to drop the profile's registries.
 */
function readScopes(dir: string, raw: unknown): ReturnType<typeof parseTokenScopes> {
	// Inline too: a throw from parsing would otherwise reach `readProfiles`'s
	// catch and drop the whole profile, where the same block by path is kept.
	try {
		return parseTokenScopes(typeof raw === 'string' ? readJsonStrict(under(dir, raw)) : raw);
	} catch (err) {
		return {
			scopes: null,
			errors: [`tokenScopes: could not read ${typeof raw === 'string' ? raw : 'the inline block'} — ${messageOf(err)}`],
		};
	}
}

/**
 * A profile's `packages`: a list claims each package at any version, an object
 * maps each to the range of versions it describes. A range that does not read
 * is thrown, for `readProfiles` to name — a profile that cannot say which
 * versions it covers would be selected on all of them, which is the v2 profile
 * on a v3 project again.
 */
function readPackages(raw: unknown): Pick<Profile, 'packages' | 'ranges'> {
	if (!isRecord(raw)) return { packages: asStrings(raw), ranges: new Map() };
	const ranges = new Map<string, string>();
	for (const [pkg, range] of Object.entries(raw)) {
		if (typeof range !== 'string' || !parseRange(range))
			throw new Error(`packages: ${JSON.stringify(range)} for ${pkg} is not a version range`);
		if (pkg) ranges.set(pkg, range);
	}
	return { packages: [...ranges.keys()], ranges };
}

/**
 * Every `<root>/<id>/profile.json`. A malformed or unreadable profile is
 * skipped rather than thrown: one bad directory must not take the gate down.
 * Skipped is not silent, though, when `unreadable` is passed: each one is named
 * there, for the caller to say.
 */
export function readProfiles(
	root: string | null | undefined,
	origin: ProfileOrigin = 'shipped',
	unreadable?: string[],
): Profile[] {
	if (!root || !existsSync(root)) return [];
	const out: Profile[] = [];
	// Sorted, and one profile per id. Sorting is what makes "the first one wins" a
	// fact rather than a filesystem accident.
	const seen = new Set<string>();
	for (const e of readDir(root)) {
		if (!e.isDirectory()) continue;
		const dir = join(root, e.name);
		const manifest = join(dir, 'profile.json');
		if (!existsSync(manifest)) continue;
		try {
			const raw = readJsonStrict(manifest) as RawProfile;
			// Every field is whatever JSON happened to hold, and `id` is a Set key, a
			// `--profile` match and a sort key — and that sort runs outside every `try`
			// here, so a manifest carrying `"id": 3` would throw past all of it.
			const id = asString(raw.id) ?? e.name;
			// `none` is reserved: it is what pins selection to no profile, so a profile
			// by that name could be listed and selected by package but never named.
			if (id === NO_PROFILE || seen.has(id)) continue;
			const patterns = asString(raw.patterns);
			const components = asString(raw.components);
			const tokenDescriptions = asString(raw.tokenDescriptions);
			// Validated here, once, so a mistake surfaces as the profile loads rather than
			// as suggestions that quietly fell back to the generic table.
			const scopes = raw.tokenScopes === undefined ? null : readScopes(dir, raw.tokenScopes);
			const delivery = asString(raw.delivery);
			out.push({
				id,
				name: asString(raw.name) ?? asString(raw.id) ?? e.name,
				preset: asString(raw.preset) ?? null,
				...readPackages(raw.packages),
				patterns: patterns ? under(dir, patterns) : null,
				components: components ? under(dir, components) : null,
				tokenDescriptions: tokenDescriptions ? under(dir, tokenDescriptions) : null,
				tokenScopes: scopes?.scopes ?? null,
				problems: scopes?.errors ?? [],
				// Read now, not by path later: two consumers want it, and a block that
				// does not validate is no block rather than a profile that cannot load.
				delivery: delivery ? readDelivery(under(dir, delivery)) : null,
				dir,
				origin,
			});
			// Claimed only once the entry is on the list: reserving it above let a
			// directory that threw on the way to `push` lock the id out.
			seen.add(id);
		} catch (err) {
			// It contributes nothing — but a project profile that fails to load leaves
			// the shipped one it was written to replace selected in its place, which
			// reads exactly like the bug the project profile exists to fix.
			unreadable?.push(`${manifest} \u2014 ${messageOf(err)}`);
		}
	}
	// Output order only — which duplicate won was settled by directory name above.
	return out.sort((a, b) => byBytes(a.id, b.id));
}

/** A directory as the filesystem names it, so two spellings of one are one. */
const realDir = (dir: string): string => {
	try {
		return realpathSync(dir);
	} catch {
		return dir;
	}
};

/**
 * Where profiles are read from, most authoritative first: the directories the
 * config lists, then `.loupe/profiles/` under the root, then the shipped set,
 * then each `--profiles` in the order given.
 *
 * The convention is read whether or not the config names other directories —
 * it is where a profile is found with no config at all — and a directory named
 * twice is read once, under the first, most authoritative, origin. Twice is the
 * normal case for the shipped set: the hooks and commands still pass it as
 * `--profiles`, through `${CLAUDE_PLUGIN_ROOT}`, which can be a symlink to the
 * directory the engine found on its own — so the comparison is by real path.
 */
export function profileRoots({
	root,
	configured = [],
	shipped = null,
	flags = [],
}: {
	root: string;
	configured?: readonly string[];
	shipped?: string | null;
	flags?: readonly string[];
}): ProfileRoot[] {
	const roots: ProfileRoot[] = [
		...configured.map((dir) => ({ dir: resolve(dir), origin: 'project' as const })),
		{ dir: resolve(root, PROJECT_PROFILES), origin: 'project' },
		...[...(shipped ? [shipped] : []), ...flags].map((dir) => ({ dir: resolve(dir), origin: 'shipped' as const })),
	];
	const seen = new Set<string>();
	return roots.filter((r) => {
		const key = realDir(r.dir);
		return !seen.has(key) && Boolean(seen.add(key));
	});
}

/**
 * Every profile under `roots`, one per id, the first root to carry an id
 * winning it — which, in {@link profileRoots}' order, is the project's.
 *
 * `unreadable` collects the project's profiles that failed to load. The shipped
 * set's are left out: a broken shipped profile is the plugin's bug, and every
 * project would otherwise repeat it.
 */
export function readProfileRoots(roots: readonly ProfileRoot[], unreadable?: string[]): Profile[] {
	const out = new Map<string, Profile>();
	for (const { dir, origin } of roots)
		for (const p of readProfiles(dir, origin, origin === 'project' ? unreadable : undefined))
			if (!out.has(p.id)) out.set(p.id, p);
	return [...out.values()].sort((a, b) => byBytes(a.id, b.id));
}

/**
 * The profiles that apply to `config`.
 *
 * Selection is by package: the project imports `@wordpress/components`, so the
 * profile that claims it is the one whose composites can legitimately match.
 * Any one of the packages a profile lists selects it. `force` names a profile
 * explicitly and skips the question; `none` names no profile, without the
 * project having to stop declaring its packages — which would switch off every
 * rule that needs them.
 *
 * A profile that claims a package for a range of versions is selected only
 * where the range the project declares for it, as `declared` reads it, admits
 * some version the profile's range does too. Overlap, not containment: `^2.3.0`
 * may resolve to a 2.x, which a `<3` profile describes. A package with no
 * declared range, or one that is not a range at all (`workspace:*`, a git URL),
 * is taken at any version — that says nothing the profile can check. Each
 * profile a declared range kept out is pushed onto `outOfRange`, for the CLI to
 * say: a profile missing for that reason reads exactly like one never written.
 *
 * A shipped profile claiming a package that a selected project profile also
 * claims is left out: two descriptions of one package, and the project wrote
 * its own because the shipped one is wrong for it.
 */
export function selectProfiles(
	profiles: readonly Profile[],
	// Narrower than `Config` on purpose: selection reads the package list and
	// nothing else.
	config: { designSystem?: { packages?: readonly string[] } },
	force: string | null = null,
	{
		declared = () => null,
		outOfRange,
	}: { declared?: (pkg: string) => DeclaredVersion | null; outOfRange?: OutOfRange[] } = {},
): Profile[] {
	if (force === NO_PROFILE) return [];
	if (force) return profiles.filter((p) => p.id === force);
	const pkgs = config.designSystem?.packages ?? [];
	if (!pkgs.length) return [];
	// What each profile claims of the packages the project imports, at a version
	// the project can be on. Only those: a project profile also claiming one it
	// does not import describes nothing here, and must not shadow a shipped
	// profile over it.
	const claims = new Map<Profile, string[]>();
	for (const p of profiles) {
		const out: OutOfRange[] = [];
		const held = p.packages.filter((pkg) => {
			if (!pkgs.includes(pkg)) return false;
			const range = p.ranges.get(pkg);
			const want = range ? parseRange(range) : null;
			const found = want ? declared(pkg) : null;
			const has = found ? parseRange(found.range) : null;
			// Only two ranges that both read can rule a profile out.
			if (!range || !want || !found || !has || overlaps(has, want)) return true;
			out.push({ profile: p.id, pkg, range, declared: found.range, manifest: found.manifest });
			return false;
		});
		if (held.length) claims.set(p, held);
		else outOfRange?.push(...out);
	}
	const claimed = new Set([...claims].filter(([p]) => p.origin === 'project').flatMap(([, held]) => held));
	return [...claims]
		.filter(([p, held]) => p.origin === 'project' || !held.some((pkg) => claimed.has(pkg)))
		.map(([p]) => p);
}

/**
 * Merge registries from `sources` into `config`. The project always wins.
 *
 * Returns what was applied and what was skipped, so the CLI can say why a
 * registry it was handed did nothing — a registry silently ignored looks exactly
 * like a registry with no findings.
 */
export function applyRegistries(
	config: Config,
	sources: readonly RegistrySource[],
): { applied: string[]; skipped: SkippedRegistry[]; notes: RegistryNote[]; errors: string[] } {
	const applied: string[] = [];
	const skipped: SkippedRegistry[] = [];
	const errors: string[] = [];
	// The sources merged by fiat, with what each one actually contributed rather
	// than just its label: a forced registry whose every id collided with the
	// project's own added nothing, and merged totals would report it as fine.
	const forced: { label: string; kind: 'patterns' | 'components'; added: number; offScope: string[] }[] = [];

	let patterns: Pattern[] = config.patterns ?? [];
	const components = new Map<string, ComponentEntry>(config.componentRegistry ?? []);
	// Each merge keeps what is already there and returns how many entries it added.
	const add = {
		patterns: (raw: unknown): number => {
			const own = new Set(patterns.map((p) => p.id));
			const fresh = loadPatterns(raw).filter((p) => !own.has(p.id));
			patterns = [...patterns, ...fresh];
			return fresh.length;
		},
		components: (raw: unknown): number => {
			const before = components.size;
			for (const [key, entry] of loadComponents(raw)) if (!components.has(key)) components.set(key, entry);
			return components.size - before;
		},
	};
	const saw = { patterns: false, components: false };

	for (const src of sources) {
		let used = false;
		for (const kind of ['patterns', 'components'] as const) {
			const path = src[kind];
			if (!path) continue;
			try {
				const raw = readJsonStrict(resolve(path));
				const inScope = registryApplies(raw, config.designSystem.packages);
				if (!src.forced && !inScope) {
					skipped.push({ label: src.label, kind, packages: declaredPackages(raw) });
					continue;
				}
				const added = add[kind](raw);
				saw[kind] = used = true;
				if (src.forced) forced.push({ label: src.label, kind, added, offScope: inScope ? [] : declaredPackages(raw) });
			} catch (err) {
				// The label says which source; only the path says which file to open.
				errors.push(`could not read ${src.label} ${kind} at ${resolve(path)} — ${messageOf(err)}`);
			}
		}
		if (used) applied.push(src.label);
	}

	// Only reattach what actually changed: the setters recompute rule
	// availability, and reattaching an untouched registry reads like a no-op that
	// did something.
	if (saw.patterns) setPatterns(config, patterns);
	if (saw.components) setComponentRegistry(config, components);

	// Merging a registry by fiat is not the same as its rules coming on: a
	// composite signature still needs a component layer to match against, and a
	// registry that contributed no entries enables nothing. Either way it is as
	// invisible as one that was skipped.
	//
	// Each note is stated once, in the order a reader would check it. Every rule
	// the registry feeds — the catalog says which — not just the first.
	const allOff = (kind: 'patternRegistry' | 'componentRegistry'): boolean =>
		rulesNeeding(kind).every((rule) => config.severityOf(rule) === 'off');
	const patternsNote = (added: number): string | null =>
		allOff('patternRegistry')
			? null
			: !added
				? 'merged but enabled nothing — it added no patterns this config did not already have'
				: // A composite is only ever built from names imported out of
					// `designSystem.packages` (see markup.ts), so with none declared
					// there is nothing for a signature to be compared against.
					!config.designSystem.packages.length
					? 'merged but enabled nothing — this config declares no designSystem.packages, so no composite is ever built to compare'
					: // `knownComponents` is `designSystem.components.layout` + `.text`.
						// A merged component *registry* does not feed it, so "components"
						// alone would point at the wrong file.
						!config.designSystem.knownComponents.size
						? 'merged but enabled nothing — this config declares no designSystem.components for its signatures to match'
						: null;
	const componentsNote = (added: number): string | null =>
		added || allOff('componentRegistry')
			? null
			: 'merged but enabled nothing — it added no entries this config did not already have';

	const notes: RegistryNote[] = [];
	for (const f of forced) {
		// Merged past the scope gate onto a config naming a different design system.
		// The registry applies — that is what `--profile` asked for — but composite
		// signatures are bare component names, so this is the one state in which they
		// match a codebase they describe nothing about.
		if (f.offScope.length)
			notes.push({
				label: f.label,
				kind: f.kind,
				// Named against what the *config* declares, not what the project imports:
				// those differ on an inferred config.
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
