/**
 * Zero-config project detection.
 *
 * The hook runs `loupe hook` with no `--preset`, and a project without a
 * `loupe.config.json` would otherwise fall through to `generic` — which declares
 * no component layer, which disables every correlation rule. So when no config
 * exists, infer one.
 *
 * Inference is a guess and the caller treats it as one: see `confidence`, and
 * note that the CLI refuses to let an inferred config run a destructive rule at
 * error severity.
 *
 * Design notes: docs/design/cli.md#detection-inference-budgeted
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { blockPrefixes, blocksIn } from './blocks.ts';
import type { BlockPrefix } from './blocks.ts';
import { DEFAULTS, compilePatterns, merge } from './config.ts';
import { byBytes, discover, readDir } from './discover.ts';
import { presetKey, presetNames, readPreset } from './embedded.ts';
import { isRecord, listOf, readJson } from './json.ts';
import type { AuthoredConfig, DeclaredVersion } from './types.ts';

/** How much a match is worth. Presets name these; nothing else interprets them. */
export type Confidence = 'high' | 'low' | 'none' | (string & {});

/** A preset's declared evidence: what this design system leaves behind. */
interface DetectBlock {
	priority?: number;
	dependencies?: string[];
	files?: { all?: string[]; any?: string[] };
	/** One value for every kind, or one per kind (`full`, `partial`). */
	confidence?: string | Record<string, string>;
}

/** A preset file: an authored config, plus the evidence that selects it. */
interface PresetFile extends AuthoredConfig {
	detect?: DetectBlock;
}

/** Which preset fits, and the evidence for saying so. */
interface PresetMatch {
	preset: string;
	reasons: string[];
	confidence: Confidence;
	/** Where the manifest that matched lives — its `node_modules` holds the tokens. */
	packageDir: string;
}

interface NamespaceDetection {
	project: string[];
	coverage: number;
	confidence: Confidence;
	sampled: { styles: number; markup: number; references: number };
	/** The walk hit {@link DETECT_ENTRY_BUDGET} and stopped: this is part of the tree. */
	truncated: boolean;
	/** What the stylesheet budgets left unread, as sentences; empty when nothing was. */
	notes: string[];
	external: ExternalCandidate[];
	blocks: BlockPrefix[];
	/** Scoped packages the markup imports, by count: evidence a manifest may not carry. */
	imports: Map<string, number>;
}

/**
 * A class prefix that looks like somebody else's: reported for a person to
 * confirm, never written into a config on inference's say-so.
 */
export interface ExternalCandidate {
	prefix: string;
	/** Distinct class names under it in the project's stylesheets. */
	classes: number;
	reason: string;
}

/** Everything inference concluded, with the config it produced. */
export interface DetectedConfig {
	inferred: true;
	preset: string;
	presetReasons: string[];
	presetConfidence: Confidence;
	packageDir: string;
	namespaces: { project: string[] };
	namespaceConfidence: Confidence;
	coverage: number;
	sampled: NamespaceDetection['sampled'];
	/** Inference stopped at the file ceiling — the caller has to say so. */
	truncated: boolean;
	/**
	 * Stylesheets the read budgets skipped, said in words. Not `truncated`: the
	 * walk saw the whole tree, it just declined to read all of what it found.
	 */
	namespaceNotes: string[];
	/**
	 * Prefixes that look vendored rather than owned. Reported, not written: a
	 * prefix nothing references is also exactly what dead CSS looks like, and
	 * only somebody who can read the enqueue code can tell the two apart.
	 */
	possibleExternal: ExternalCandidate[];
	/**
	 * The wrapper prefixes of the blocks the project's `block.json` files name
	 * (`acme/card` → `wp-block-acme-`). Reported, and recognised by the analysis
	 * on its own walk, but never written into `namespaces.project`: that would
	 * make a wrapper class no source spells eligible to be called dead.
	 */
	blocks: BlockPrefix[];
	/**
	 * When the preset is a weak guess, what the project shows that the markers
	 * could not rank: imports no manifest declares, type packages, build
	 * manifests. Detection surfaces it; whoever runs `init` decides. Empty when
	 * the preset matched outright.
	 */
	presetEvidence: string[];
	config: AuthoredConfig;
}

const preset = (name: string): PresetFile => (readPreset(name) as PresetFile) ?? {};

/** Directories never worth descending into when looking for a manifest. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'build', 'dist', '.claude']);

/** The subdirectories worth looking in: not the skipped ones, not the dot-directories. */
const childDirs = (dir: string): string[] =>
	readDir(dir)
		.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
		.map((e) => e.name);

/** The dependency fields of a manifest, as `package.json` spells them. */
interface Manifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

/** The manifest at `rel` under the root, or an empty one where there is none to read. */
const readManifest = (root: string, rel: string): Manifest =>
	(readJson(join(root, rel, 'package.json')) as Manifest | null) ?? {};

/** How a reason names a manifest: `pkg/package.json`, or the root's by its bare name. */
const manifestLabel = (rel: string): string => (rel ? `${rel}/package.json` : 'package.json');

/**
 * How many directory entries inference will look at before it gives up and
 * answers from what it has.
 *
 * Inference is a guess, and a guess does not earn an unbounded walk — the caller
 * that matters is the hook, whose root falls back to the process cwd and is
 * sometimes a home directory. Entries, not files: a home directory is mostly
 * directories holding almost nothing.
 *
 * 50,000 is several times the largest project this plugin plausibly meets, and
 * costs about a second of walking. See docs/design/cli.md#detection-inference-budgeted.
 */
export const DETECT_ENTRY_BUDGET = 50_000;

/**
 * Every `package.json` in the project, shallowest first. A WordPress repo is
 * very often a monorepo: the root manifest carries `@wordpress/env` and a build
 * script, and the plugin importing `@wordpress/components` sits a directory down.
 */
function manifests(root: string, maxDepth = 3, budget = 60): { dir: string; rel: string }[] {
	const out: { dir: string; rel: string }[] = [];
	const walk = (dir: string, rel: string, depth: number): void => {
		if (depth > maxDepth || out.length >= budget) return;
		const pkg = join(dir, 'package.json');
		if (existsSync(pkg)) out.push({ dir, rel });
		if (depth === maxDepth) return;
		for (const name of childDirs(dir)) walk(join(dir, name), rel ? `${rel}/${name}` : name, depth + 1);
	};
	walk(root, '', 0);
	return out;
}

/**
 * What the project's manifests declare for a package: the range, and the
 * manifest it came from. The manifests are the ones detection reads, and the
 * shallowest naming the package answers for it, as it does when a preset is
 * matched — so a monorepo's package a directory down is found the same way.
 *
 * Within one manifest the field installed from wins over the one only promised:
 * `dependencies`, then `devDependencies`, then `peerDependencies`. A library
 * declaring `"^2 || ^3"` as a peer and developing against `^3` is on v3.
 *
 * The walk is paid on the first question, not on the call: most runs select no
 * profile that limits a version, and never ask.
 */
export function declaredVersions(root: string): (pkg: string) => DeclaredVersion | null {
	let read: { rel: string; fields: Record<string, unknown>[] }[] | null = null;
	return (pkg) => {
		read ??= manifests(root).map(({ rel }) => {
			const m = readManifest(root, rel);
			const fields = [m.dependencies, m.devDependencies, m.peerDependencies].flatMap((f) => (isRecord(f) ? [f] : []));
			return { rel, fields };
		});
		for (const { rel, fields } of read)
			for (const deps of fields) {
				const range = deps[pkg];
				if (typeof range === 'string') return { range, manifest: manifestLabel(rel) };
			}
		return null;
	};
}

/**
 * Does `dir` contain `marker`? A trailing slash means "must be a directory",
 * which is also how the marker reads back in the reason text.
 */
function markerAt(dir: string, marker: string): boolean {
	const name = marker.replace(/\/$/, '');
	const full = join(dir, name);
	if (!existsSync(full)) return false;
	if (!marker.endsWith('/')) return true;
	try {
		return statSync(full).isDirectory();
	} catch {
		return false;
	}
}

/** The root and each immediate subdirectory, which is as deep as file markers look. */
function probeDirs(root: string): { dir: string; rel: string }[] {
	return [{ dir: root, rel: '' }, ...childDirs(root).map((name) => ({ dir: join(root, name), rel: name }))];
}

const confidenceOf = (detect: DetectBlock, kind: string): string | null =>
	typeof detect.confidence === 'string' ? detect.confidence : (detect.confidence?.[kind] ?? null);

/**
 * Match one preset's declared markers against the project: a dependency in a
 * manifest, and files on disk. A preset declaring neither is never inferred —
 * `wordpress-components` is a parent others extend, `generic` is the fallback.
 */
function matchPreset(
	name: string,
	detect: DetectBlock,
	root: string,
	found: readonly { dir: string; rel: string }[],
): PresetMatch | null {
	if (detect.dependencies?.length) {
		// Shallowest manifest declaring the library wins, and `packageDir` names where
		// its `node_modules` — and therefore the token stylesheet — will be.
		for (const { rel } of found) {
			const pkg = readManifest(root, rel);
			const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
			const hit = detect.dependencies.filter((d) => deps[d] !== undefined);
			const first = hit[0];
			if (first === undefined) continue;
			const reasons = [`${first} in ${manifestLabel(rel)}`];
			if (found.length > 1) reasons.push(`${found.length} package.json files scanned`);
			return { preset: name, reasons, confidence: confidenceOf(detect, 'full') ?? 'high', packageDir: rel };
		}
	}

	if (detect.files) {
		const all = detect.files.all ?? [];
		const any = detect.files.any ?? [];
		const describe = (list: readonly string[]): string => list.join(' or ');
		let partial: PresetMatch | null = null;
		for (const { dir, rel } of probeDirs(root)) {
			if (all.length && !all.every((m) => markerAt(dir, m))) continue;
			const where = rel ? ` in ${rel}/` : '';
			if (!any.length || any.some((m) => markerAt(dir, m))) {
				const what = [...all, ...(any.length ? [describe(any)] : [])].join(' + ');
				return {
					preset: name,
					reasons: [`${what}${where}`],
					confidence: confidenceOf(detect, 'full') ?? 'high',
					packageDir: rel,
				};
			}
			// `all` without `any` is weaker evidence, not none — but only when the
			// preset says what a partial match is worth.
			const weak = confidenceOf(detect, 'partial');
			if (weak && !partial)
				partial = {
					preset: name,
					reasons: [`${describe(all)} present, no ${describe(any)}${where}`],
					confidence: weak,
					packageDir: rel,
				};
		}
		if (partial) return partial;
	}

	return null;
}

/**
 * Which preset fits this project?
 *
 * The markers live in the presets, not here: a preset declares a `detect` block
 * and this walks them by descending priority. Priority matters where two presets
 * both match — `wpds` outranks any weaker WordPress preset because it extends
 * one and adds the token prefix and severities the plugin exists to enforce.
 */
export function detectPreset(root: string): PresetMatch {
	const found = manifests(root);
	const candidates = presetNames()
		.map((name) => ({ name, detect: preset(name).detect }))
		.filter((c): c is { name: string; detect: DetectBlock } => c.detect !== undefined)
		.sort((a, b) => (b.detect.priority ?? 0) - (a.detect.priority ?? 0) || byBytes(a.name, b.name));

	for (const { name, detect } of candidates) {
		const hit = matchPreset(name, detect, root, found);
		if (hit) return hit;
	}

	const tried = candidates.map((c) => c.name).join(', ') || 'none';
	return {
		preset: 'generic',
		reasons: [`no design-system markers found in ${found.length} package.json file(s) (looked for: ${tried})`],
		confidence: 'low',
		packageDir: '',
	};
}

/**
 * How many stylesheets namespace inference reads, and how large one may be.
 *
 * The walk ceiling bounds how many entries inference *visits*, not how much it
 * reads, and a tree can be nothing but large generated stylesheets — a token
 * dump, a checked-in `build-style/` a preset's ignore globs miss. The count
 * matches {@link libraryPrefixes}'s budget; the size matches `analyze`, which
 * skips anything bigger as generated, so a file the check never reads does not
 * get to name the project's namespace either.
 */
export const STYLE_FILE_BUDGET = 600;
export const STYLE_MAX_BYTES = 1_500_000;

/**
 * The prefix a build tool's generated class name carries, or null.
 *
 * A project's own source never spells these: its `Foo.module.css` says
 * `.container`, and the bundler writes `Foo-module_container`. So a stylesheet
 * that does spell one is styling compiled output, nearly always a bundle that
 * belongs to someone else — a widget served from another origin, say.
 */
function generatedPrefix(cls: string): { prefix: string; reason: string } | null {
	// CSS Modules' `[name]-module_[local]`, or `_module_`.
	const mod = /^([A-Za-z]\w*?[-_]module_)/.exec(cls);
	if (mod?.[1]) return { prefix: mod[1], reason: 'CSS-module output' };
	// `[name]_[local]__[hash]` (Next.js), and emotion's or styled-jsx's bare hash.
	// The hash has to carry a digit, which is what keeps BEM's `block__element` out.
	const hashed =
		/^([A-Za-z][A-Za-z0-9]*_)[A-Za-z][\w-]*__(?=[\w-]*\d)[\w-]{5,}$/.exec(cls) ??
		/^((?:css|jsx)-)(?=[a-z0-9]*\d)[a-z0-9]{5,}$/.exec(cls);
	if (hashed?.[1]) return { prefix: hashed[1], reason: 'hashed class names' };
	return null;
}

/** How many candidates `detect` lists: a shortlist to confirm, not an inventory. */
const EXTERNAL_LIMIT = 8;

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

/** A class's namespace — everything up to and including its first `-` — or null when it has none. */
const prefixOf = (cls: string | undefined): string | null => {
	const i = cls?.indexOf('-') ?? -1;
	return cls && i >= 1 ? cls.slice(0, i + 1) : null;
};

/**
 * Which of these prefixes are defined by an installed dependency?
 *
 * A prefix in both the project's CSS and its markup looks exactly like a
 * namespace the project owns — and exactly like styling a third-party library.
 * The distinguishing evidence is where the class is *defined*: a library ships
 * its own stylesheet, a project's own namespace appears nowhere in
 * `node_modules`. Stops as soon as every candidate is decided.
 */
function libraryPrefixes(dirs: readonly string[], candidates: readonly string[]): Set<string> {
	const want = new Set(candidates);
	const found = new Set<string>();
	if (!want.size) return found;
	let budget = 600;

	const walk = (dir: string, depth: number): void => {
		if (depth > 4 || budget <= 0 || !want.size) return;
		for (const e of readDir(dir)) {
			if (budget <= 0 || !want.size) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === '.bin' || e.name === 'node_modules') continue;
				walk(full, depth + 1);
			} else if (e.name.endsWith('.css') && !e.name.endsWith('.min.css')) {
				budget--;
				let text: string;
				try {
					text = readFileSync(full, 'utf8');
				} catch {
					continue;
				}
				if (text.length > 2_000_000) continue;
				for (const m of text.matchAll(CLASS_RE)) {
					const prefix = prefixOf(m[1]);
					if (prefix && want.delete(prefix)) found.add(prefix);
				}
			}
		}
	};

	for (const dir of dirs) if (existsSync(dir)) walk(dir, 0);
	return found;
}

/** A scoped package named by `import`, `import()`, `require()` or `export … from`. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@[\w.-]+\/[\w.-]+)/g;

/**
 * What a project shows about its design system that the preset markers could
 * not rank.
 *
 * The case this exists for is `@wordpress/scripts`' externals: `@wordpress/*`
 * imports are rewritten to `wp.*` globals at build time, so nothing lands in
 * `dependencies` and no preset matches — while the source, the type packages
 * and the build's asset manifests all say plainly what the project is built on.
 * Deciding from these is a judgement this does not make; it only gathers them,
 * cheaply, for whoever runs `init`.
 *
 * Which packages count is read off the presets — every package a preset
 * detects or declares, and anything else in those scopes — so a new preset's
 * evidence is surfaced with no change here.
 */
function presetEvidence(root: string, imports: ReadonlyMap<string, number>): string[] {
	const marker = new Map<string, string>();
	const scopes = new Set<string>();
	for (const name of presetNames()) {
		const p = preset(name);
		for (const dep of [...(p.detect?.dependencies ?? []), ...(p.designSystem?.packages ?? [])]) {
			if (p.detect?.dependencies?.includes(dep) && !marker.has(dep)) marker.set(dep, name);
			if (dep.startsWith('@')) scopes.add(dep.slice(0, dep.indexOf('/') + 1));
		}
	}
	const known = (pkg: string): boolean => marker.has(pkg) || [...scopes].some((s) => pkg.startsWith(s));
	const named = (pkg: string): string => (marker.has(pkg) ? `${pkg} [a ${marker.get(pkg)} marker]` : pkg);
	const out: string[] = [];

	const imported = [...imports].filter(([pkg]) => known(pkg)).sort((a, b) => b[1] - a[1]);
	if (imported.length)
		out.push(
			`source imports: ${imported
				.slice(0, 5)
				.map(([pkg, n]) => `${named(pkg)} \u00d7${n}`)
				.join(', ')}${imported.length > 5 ? `, +${imported.length - 5} more` : ''}`,
		);

	// `@types/wordpress__components` types `@wordpress/components`: the project
	// writes against the library even where the build supplies it at runtime.
	for (const { rel } of manifests(root)) {
		const pkg = readManifest(root, rel);
		const typed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
			.map((dep) => /^@types\/([\w.-]+)__([\w.-]+)$/.exec(dep))
			.filter((m): m is RegExpExecArray => m !== null && known(`@${m[1]}/${m[2]}`))
			.map((m) => `${m[0]} \u2192 ${named(`@${m[1]}/${m[2]}`)}`);
		if (typed.length) out.push(`${manifestLabel(rel)}: ${typed.join(', ')}`);
	}

	// `@wordpress/scripts` writes the script handles a bundle needs beside it.
	for (const { dir, rel } of probeDirs(root)) {
		const build = join(dir, 'build');
		const assets = readDir(build)
			.filter((e) => e.isFile() && e.name.endsWith('.asset.php'))
			.slice(0, 3);
		for (const e of assets) {
			let text: string;
			try {
				text = readFileSync(join(build, e.name), 'utf8');
			} catch {
				continue;
			}
			const list = /['"]dependencies['"]\s*=>\s*(?:array\s*\(|\[)([^)\]]*)/.exec(text)?.[1] ?? '';
			const deps = [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
			if (deps.length) out.push(`${rel ? `${rel}/` : ''}build/${e.name} dependencies: ${deps.join(', ')}`);
		}
	}

	if (existsSync(join(root, '.wp-env.json'))) out.push('.wp-env.json (a WordPress development environment)');
	const composer = readJson(join(root, 'composer.json')) as { type?: string; require?: Record<string, string> } | null;
	if (composer) {
		const requires = Object.keys(composer.require ?? {}).filter((r) => r !== 'php');
		const what = [
			...(composer.type ? [`type ${composer.type}`] : []),
			...(requires.length ? [`requires ${requires.slice(0, 4).join(', ')}`] : []),
		];
		out.push(`composer.json${what.length ? ` (${what.join('; ')})` : ''}`);
	}
	return out;
}

/** Resolve a shipped preset's `extends` chain, merged the way `loadConfig` merges it. */
function resolvePreset(name: string, seen = new Set<string>()): PresetFile {
	if (seen.has(name)) return {};
	seen.add(name);
	const { extends: parents, ...raw } = preset(name);
	const base = listOf(parents).reduce<PresetFile>((acc, spec) => merge(acc, resolvePreset(presetKey(spec), seen)), {});
	return merge(base, raw);
}

/**
 * Infer which class prefixes the project owns.
 *
 * Only prefixes appearing in BOTH the CSS and the markup: one present only in
 * CSS is exactly what a dead class looks like.
 */
function detectNamespaces(
	root: string,
	presetName: string,
	packageDir = '',
	/** Required: {@link detectConfig} is the only caller and always has one, so a default here would be a second, dead declaration of the ceiling. */
	limit: number,
): NamespaceDetection {
	const base = resolvePreset(presetName);
	const sources = merge(DEFAULTS.sources, base.sources);
	const files = discover({ root, sources, limit });

	// Library prefixes from *every* shipped preset, not just the detected one, so a
	// project styling only third-party classes yields no namespace rather than
	// adopting theirs.
	const others = presetNames()
		.filter((n) => n !== presetName)
		.map((n) => resolvePreset(n));
	const external = [...(base.namespaces?.external ?? []), ...others.flatMap((p) => p.namespaces?.external ?? [])];
	const neverDead = compilePatterns([
		...(base.namespaces?.neverDead ?? []),
		...others.flatMap((p) => p.namespaces?.neverDead ?? []),
	]);
	const isExcluded = (cls: string): boolean =>
		external.some((p) => cls.startsWith(p)) || neverDead.some((re) => re.test(cls));

	const cssCounts = new Map<string, number>();
	const cssClasses = new Map<string, Set<string>>();
	const generated = new Map<string, { classes: Set<string>; reason: string }>();
	// Shallowest first: the project's own stylesheets sit nearer the root than
	// whatever generated the rest. `discover` sorts every list by path bytes, so
	// without re-sorting a deep `assets/gen/` would spend the budget before
	// `styles/` is reached. Bytes break ties so the pick is the tree's, not the
	// machine's. A copy, because the byte order is what reports read.
	const depth = (rel: string): number => rel.split('/').length;
	const read = [...files.styles]
		.sort((a, b) => depth(a.rel) - depth(b.rel) || byBytes(a.rel, b.rel))
		.slice(0, STYLE_FILE_BUDGET);
	let oversized = 0;
	for (const { abs } of read) {
		let text: string;
		try {
			if (statSync(abs).size > STYLE_MAX_BYTES) {
				oversized++;
				continue;
			}
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		for (const m of text.matchAll(CLASS_RE)) {
			const cls = m[1];
			const prefix = prefixOf(cls);
			if (cls === undefined || isExcluded(cls)) continue;
			// Generated names are nobody's namespace, the project's least of all, so
			// they are set aside before they can count towards one.
			const gen = generatedPrefix(cls);
			if (gen) {
				const entry = generated.get(gen.prefix) ?? { classes: new Set<string>(), reason: gen.reason };
				entry.classes.add(cls);
				generated.set(gen.prefix, entry);
				continue;
			}
			if (!prefix) continue;
			cssClasses.set(prefix, (cssClasses.get(prefix) ?? new Set<string>()).add(cls));
			cssCounts.set(prefix, (cssCounts.get(prefix) ?? 0) + 1);
		}
	}

	const markupText: string[] = [];
	for (const { abs } of [...files.markup, ...files.references].slice(0, 2000)) {
		try {
			markupText.push(readFileSync(abs, 'utf8'));
		} catch {
			/* skip */
		}
	}
	const haystack = markupText.join('\n');
	const imports = new Map<string, number>();
	for (const m of haystack.matchAll(IMPORT_RE)) if (m[1]) imports.set(m[1], (imports.get(m[1]) ?? 0) + 1);

	const candidates = [...cssCounts.entries()]
		.filter(([prefix, count]) => count >= 3 && haystack.includes(prefix))
		.sort((a, b) => b[1] - a[1]);

	// A prefix an installed dependency defines is that dependency's, however much
	// of the project's own CSS and markup mentions it.
	const vendored = libraryPrefixes(
		[join(root, 'node_modules'), ...(packageDir ? [join(root, packageDir, 'node_modules')] : [])],
		candidates.map(([p]) => p),
	);

	// Drop prefixes already covered by a shorter accepted one (`wf-card-` under `wf-`).
	const accepted: [string, number][] = [];
	for (const [prefix, count] of candidates) {
		if (vendored.has(prefix)) continue;
		if (accepted.some(([p]) => prefix.startsWith(p))) continue;
		accepted.push([prefix, count]);
		if (accepted.length >= 5) break;
	}

	// What might be somebody else's, most certain first: a generated shape, then a
	// prefix an installed dependency defines, then one only stylesheets mention.
	const owned = (prefix: string): boolean => accepted.some(([p]) => prefix.startsWith(p));
	const distinct = (prefix: string): number => cssClasses.get(prefix)?.size ?? 0;
	const foreign: ExternalCandidate[] = [
		...[...generated]
			.map(([prefix, g]) => ({ prefix, classes: g.classes.size, reason: g.reason }))
			.sort((a, b) => b.classes - a.classes),
		...[...vendored].map((prefix) => ({ prefix, classes: distinct(prefix), reason: 'defined in node_modules' })),
		...[...cssCounts]
			.filter(([prefix, count]) => count >= 3 && !haystack.includes(prefix) && !owned(prefix))
			.map(([prefix]) => ({
				prefix,
				classes: distinct(prefix),
				reason: 'no markup or reference names it \u2014 vendored, or dead',
			}))
			.sort((a, b) => b.classes - a.classes),
	].slice(0, EXTERNAL_LIMIT);

	const total = [...cssCounts.values()].reduce((a, b) => a + b, 0);
	const covered = accepted.reduce((a, [, c]) => a + c, 0);
	const coverage = total ? covered / total : 0;

	// Either budget answering from less than was found is the same claim as a
	// truncated walk, and said the same way: in the confidence, and in words.
	const notes = [
		...(files.styles.length > read.length
			? [`read the first ${read.length} of ${files.styles.length} stylesheets`]
			: []),
		...(oversized
			? [`skipped ${oversized} stylesheet(s) over ${Math.round(STYLE_MAX_BYTES / 1000)}kB as generated`]
			: []),
	];

	return {
		project: accepted.map(([p]) => p),
		coverage,
		// A truncated walk read part of a tree, so `high` is a claim it cannot make.
		// It demotes `high` only: `none` is the different and still-true claim that
		// nothing was found.
		confidence:
			accepted.length === 0 ? 'none' : files.truncated || notes.length ? 'low' : coverage >= 0.5 ? 'high' : 'low',
		sampled: { styles: files.styles.length, markup: files.markup.length, references: files.references.length },
		truncated: files.truncated,
		notes,
		external: foreign,
		blocks: blockPrefixes(blocksIn(files.references)),
		imports,
	};
}

/**
 * Full inferred config for a project with no config file.
 *
 * `inferred: true` travels with the result so the CLI can hold guessed settings
 * to a lower bar than ones somebody wrote down, and `truncated` says whether
 * the guess even got to see the whole tree — the namespaces, specifically:
 * {@link detectPreset} reads manifests and top-level markers rather than
 * walking, so the preset it returns is complete either way. `limit` is the
 * ceiling the walk stops at; it is a parameter only so a test can trip it
 * without building {@link DETECT_ENTRY_BUDGET} entries.
 */
export function detectConfig(
	root: string,
	{ preset: override, limit = DETECT_ENTRY_BUDGET }: { preset?: string | null; limit?: number } = {},
): DetectedConfig {
	const { preset: name, reasons, confidence: presetConfidence, packageDir } = detectPreset(root);
	const ns = detectNamespaces(root, name, packageDir, limit);
	// `--profile <id>` names the design system outright, which beats a guess about
	// it. Inference's own verdict is still returned as `preset`, but the config
	// extends what the flag named, and everything derived from the preset below has
	// to follow it.
	const extend = override || name;
	const config: AuthoredConfig = { extends: extend, namespaces: { project: ns.project } };

	// A preset's token sources are written relative to the project root; in a
	// monorepo the design system is installed beside the manifest that asked for it.
	if (packageDir) {
		const sources = resolvePreset(extend).designSystem?.tokenSources ?? [];
		if (sources.length) config.designSystem = { tokenSources: sources.map((p) => `${packageDir}/${p}`) };
	}

	return {
		inferred: true,
		preset: name,
		presetReasons: reasons,
		presetConfidence,
		packageDir,
		namespaces: { project: ns.project },
		namespaceConfidence: ns.confidence,
		coverage: ns.coverage,
		sampled: ns.sampled,
		truncated: ns.truncated,
		namespaceNotes: ns.notes,
		possibleExternal: ns.external,
		blocks: ns.blocks,
		presetEvidence: presetConfidence === 'low' || presetConfidence === 'none' ? presetEvidence(root, ns.imports) : [],
		config,
	};
}
