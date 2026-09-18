/**
 * Zero-config project detection.
 *
 * The hook runs `loupe hook` with no `--preset`, so a project without a
 * `loupe.config.json` fell through to `generic` — which declares no
 * component layer, which disables every correlation rule. The gate stayed
 * green and quiet on exactly the wp-admin code it exists to check. A preset
 * that has to be selected by hand is a preset that mostly isn't.
 *
 * So when no config exists, infer one. Inference is a guess and the caller
 * treats it as one: see `confidence`, and note that the CLI refuses to let an
 * inferred config run a destructive rule at error severity.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.ts';
import type { AuthoredConfig, SourceGlobs } from './types.ts';

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
export interface PresetMatch {
	preset: string;
	reasons: string[];
	confidence: Confidence;
	/** Where the manifest that matched lives — its `node_modules` holds the tokens. */
	packageDir: string;
}

export interface NamespaceDetection {
	project: string[];
	coverage: number;
	confidence: Confidence;
	sampled: { styles: number; markup: number; references: number };
	/** The walk hit {@link DETECT_ENTRY_BUDGET} and stopped: this is part of the tree. */
	truncated: boolean;
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
	config: AuthoredConfig;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

const readJson = (p: string): unknown => {
	try {
		return JSON.parse(readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
};

const preset = (name: string): PresetFile => (readJson(join(PRESET_DIR, `${name}.json`)) as PresetFile) ?? {};

/** Directories never worth descending into when looking for a manifest. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'build', 'dist', '.claude']);

/**
 * How many directory entries inference will look at before it gives up and
 * answers from what it has.
 *
 * Inference is a guess, and a guess does not earn an unbounded walk. The caller
 * that matters is the hook, which has 60s for a PostToolUse and 120s for a
 * Stop, and whose root falls back to the process cwd whenever
 * CLAUDE_PROJECT_DIR is unset — so the tree handed to this is not always a
 * project, and was sometimes a home directory. The ceiling is what stops that
 * from being paid for on every edit.
 *
 * Entries, not files: a home directory is mostly directories that hold almost
 * nothing — a package cache, a pnpm store, maildirs — and a file-counting
 * budget walks all of them for free.
 *
 * 50,000 is several times the largest project this plugin plausibly meets —
 * WordPress core is around 7,000 files and Gutenberg around 15,000 once
 * node_modules is pruned, which the walk does — so a real repo reaches its own
 * end long before the ceiling, and a tree that trips it is one where the answer
 * was never going to be about a project anyway. It costs about a second of
 * walking, which leaves the hook's budget for the analysis that follows.
 */
export const DETECT_ENTRY_BUDGET = 50_000;

/**
 * Every `package.json` in the project, shallowest first.
 *
 * A WordPress repo is very often a monorepo: the root manifest carries
 * `@wordpress/env` and a build script, and the plugin that actually imports
 * `@wordpress/components` sits a directory down. Reading only the root meant
 * those repos detected as `generic`, which declares no component layer and
 * therefore switched off every rule this plugin exists to run — silently, and
 * on exactly the code it was pointed at.
 */
function manifests(root: string, maxDepth = 3, budget = 60): { dir: string; rel: string }[] {
	const out: { dir: string; rel: string }[] = [];
	const walk = (dir: string, rel: string, depth: number): void => {
		if (depth > maxDepth || out.length >= budget) return;
		const pkg = join(dir, 'package.json');
		if (existsSync(pkg)) out.push({ dir, rel });
		if (depth === maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
			walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
		}
	};
	walk(root, '', 0);
	return out;
}

/** Preset names on disk, so a new design system is a file rather than an edit here. */
function presetNames(): string[] {
	try {
		return readdirSync(PRESET_DIR)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''));
	} catch {
		return [];
	}
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
	const out = [{ dir: root, rel: '' }];
	let entries: import('node:fs').Dirent[] = [];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
		out.push({ dir: join(root, e.name), rel: e.name });
	}
	return out;
}

const confidenceOf = (detect: DetectBlock, kind: string): string | null =>
	typeof detect.confidence === 'string' ? detect.confidence : (detect.confidence?.[kind] ?? null);

/**
 * Match one preset's declared markers against the project.
 *
 * Two kinds, because there are two kinds of evidence a design system leaves: a
 * dependency in a manifest, and files on disk. A preset declaring neither is
 * never inferred — `wordpress-components` is a parent others extend, not a
 * conclusion, and `generic` is the fallback rather than a match.
 */
function matchPreset(
	name: string,
	detect: DetectBlock,
	root: string,
	found: readonly { dir: string; rel: string }[],
): PresetMatch | null {
	if (detect.dependencies?.length) {
		// Shallowest manifest declaring the library wins, so a root that happens to
		// list it beats a nested one, and `packageDir` names where its
		// `node_modules` — and therefore the token stylesheet — will be.
		for (const { rel } of found) {
			const pkg =
				(readJson(join(root, rel, 'package.json')) as {
					dependencies?: Record<string, string>;
					devDependencies?: Record<string, string>;
					peerDependencies?: Record<string, string>;
				} | null) ?? {};
			const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
			const hit = detect.dependencies.filter((d) => deps[d] !== undefined);
			const first = hit[0];
			if (first === undefined) continue;
			const reasons = [`${first} in ${rel ? `${rel}/package.json` : 'package.json'}`];
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
 * and this walks them by descending priority. That is the whole difference
 * between "add a design system" meaning a JSON file and meaning a patch to the
 * engine — and the reason the WordPress markers that used to be hardcoded in
 * this function now sit in `wpds.json` and `wordpress-block-theme.json`.
 *
 * Priority matters where two presets both match: `wpds` outranks any weaker
 * WordPress preset because it extends one and adds the token prefix and
 * severities the plugin exists to enforce, so selecting the parent would
 * silently drop them.
 */
export function detectPreset(root: string): PresetMatch {
	const found = manifests(root);
	const candidates = presetNames()
		.map((name) => ({ name, detect: preset(name).detect }))
		.filter((c): c is { name: string; detect: DetectBlock } => c.detect !== undefined)
		.sort((a, b) => (b.detect.priority ?? 0) - (a.detect.priority ?? 0) || a.name.localeCompare(b.name));

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

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

/**
 * Which of these prefixes are defined by an installed dependency?
 *
 * A prefix appearing in both the project's CSS and its markup looks exactly
 * like a namespace the project owns — and that is also exactly what styling a
 * third-party library looks like. `rbc-` (react-big-calendar) passed every test
 * and accounted for every dead-class finding in a real repo, all of them false:
 * the rule then tells an agent to delete CSS that is holding a vendored
 * component together.
 *
 * The distinguishing evidence is where the class is *defined*. A library ships
 * its own stylesheet; a project's own namespace appears nowhere in
 * `node_modules`. Stops as soon as every candidate is decided, so the usual
 * case costs a fraction of the budget.
 */
function libraryPrefixes(dirs: readonly string[], candidates: readonly string[]): Set<string> {
	const want = new Set(candidates);
	const found = new Set<string>();
	if (!want.size) return found;
	let budget = 600;

	const walk = (dir: string, depth: number): void => {
		if (depth > 4 || budget <= 0 || !want.size) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (budget <= 0 || !want.size) return;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (e.name === '.bin' || e.name === 'node_modules') continue;
				walk(full, depth + 1);
			} else if (e.name.endsWith('.css') && !e.name.endsWith('.min.css')) {
				budget--;
				let text;
				try {
					text = readFileSync(full, 'utf8');
				} catch {
					continue;
				}
				if (text.length > 2_000_000) continue;
				for (const m of text.matchAll(CLASS_RE)) {
					const cls = m[1];
					if (cls === undefined) continue;
					const i = cls.indexOf('-');
					if (i < 1) continue;
					const prefix = cls.slice(0, i + 1);
					if (want.delete(prefix)) found.add(prefix);
				}
			}
		}
	};

	for (const dir of dirs) if (existsSync(dir)) walk(dir, 0);
	return found;
}

/** Resolve a preset's `extends` chain far enough to read namespaces and sources. */
function resolvePreset(name: string, seen = new Set<string>()): PresetFile {
	if (seen.has(name)) return {};
	seen.add(name);
	const raw = preset(name);
	if (!raw.extends) return raw;
	const specs = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
	let base: PresetFile = {};
	for (const spec of specs) {
		const parent = resolvePreset(String(spec).replace(/^loupe\/presets\//, ''), seen);
		base = {
			...base,
			...parent,
			namespaces: { ...(base.namespaces ?? {}), ...(parent.namespaces ?? {}) },
			sources: { ...(base.sources ?? {}), ...(parent.sources ?? {}) },
		};
	}
	return {
		...base,
		...raw,
		namespaces: { ...(base.namespaces ?? {}), ...(raw.namespaces ?? {}) },
		sources: { ...(base.sources ?? {}), ...(raw.sources ?? {}) },
	};
}

/**
 * Infer which class prefixes the project owns.
 *
 * Only prefixes that appear in BOTH the CSS and the markup count. A prefix
 * present only in CSS is exactly what a dead class looks like, so accepting it
 * on CSS evidence alone would let the dead-class rule bootstrap its own false
 * positives.
 */
export function detectNamespaces(
	root: string,
	presetName: string,
	packageDir = '',
	/** Required: {@link detectConfig} is the only caller and always has one, so a default here would be a second, dead declaration of the ceiling. */
	limit: number,
): NamespaceDetection {
	const base = resolvePreset(presetName);
	const generic = resolvePreset('generic');
	const sources = { ...generic.sources, ...(base.sources ?? {}) } as SourceGlobs;
	const files = discover({ root, sources, limit });

	// Library prefixes from *every* shipped preset, not just the detected one, so
	// a project styling only third-party classes yields no namespace rather than
	// adopting theirs. Every preset rather than a named few: each one lists the
	// prefixes its design system owns, and a prefix owned by any of them is
	// somebody's library whichever preset this project turned out to be.
	const others = presetNames()
		.filter((n) => n !== presetName)
		.map((n) => resolvePreset(n));
	const external = [...(base.namespaces?.external ?? []), ...others.flatMap((p) => p.namespaces?.external ?? [])];
	const neverDead = [
		...(base.namespaces?.neverDead ?? []),
		...others.flatMap((p) => p.namespaces?.neverDead ?? []),
	].map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
	const isExcluded = (cls: string): boolean =>
		external.some((p) => cls.startsWith(p)) || neverDead.some((re) => re.test(cls));

	const cssCounts = new Map<string, number>();
	for (const { abs } of files.styles) {
		let text;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		for (const m of text.matchAll(CLASS_RE)) {
			const cls = m[1];
			if (cls === undefined || isExcluded(cls)) continue;
			const idx = cls.indexOf('-');
			if (idx < 1) continue;
			const prefix = cls.slice(0, idx + 1);
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

	const total = [...cssCounts.values()].reduce((a, b) => a + b, 0);
	const covered = accepted.reduce((a, [, c]) => a + c, 0);
	const coverage = total ? covered / total : 0;

	return {
		project: accepted.map(([p]) => p),
		coverage,
		// A truncated walk read part of a tree, so `high` is a claim it cannot
		// make: the prefixes it did not reach are exactly the ones that would
		// have changed the answer. Coverage is measured against what was read,
		// which is why it can look convincing and still be wrong. It demotes
		// `high` only: `none` is the different and still-true claim that nothing
		// was found, and swallowing it printed "(none found) [low confidence]".
		confidence: accepted.length === 0 ? 'none' : files.truncated ? 'low' : coverage >= 0.5 ? 'high' : 'low',
		sampled: { styles: files.styles.length, markup: files.markup.length, references: files.references.length },
		truncated: files.truncated,
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
	// `--profile <id>` names the design system outright, which is the one
	// statement that beats a guess about it. Inference's own verdict is still
	// returned as `preset` — `status` and `init` report it — but the config
	// extends what the flag named. Everything derived from the preset below has
	// to follow it: overriding `extends` after the fact left a config extending
	// one preset while carrying another's token sources.
	const extend = override || name;
	const config: AuthoredConfig = { extends: extend, namespaces: { project: ns.project } };

	// A preset's token sources are written relative to the project root. In a
	// monorepo the design system is installed beside the manifest that asked for
	// it, so without this the token set comes back empty and every finding goes
	// back to naming a namespace instead of a token.
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
		config,
	};
}
