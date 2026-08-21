/**
 * Zero-config project detection.
 *
 * The hook runs `ds-hygiene hook` with no `--preset`, so a project without a
 * `ds-hygiene.config.json` fell through to `generic` — which declares no
 * component layer, which disables every correlation rule. The gate stayed
 * green and quiet on exactly the wp-admin code it exists to check. A preset
 * that has to be selected by hand is a preset that mostly isn't.
 *
 * So when no config exists, infer one. Inference is a guess and the caller
 * treats it as one: see `confidence`, and note that the CLI refuses to let an
 * inferred config run a destructive rule at error severity.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, 'utf8'));
	} catch {
		return null;
	}
};

const preset = (name) => readJson(join(PRESET_DIR, `${name}.json`)) || {};

/** Directories never worth descending into when looking for a manifest. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor', 'build', 'dist', '.claude']);

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
function manifests(root, maxDepth = 3, budget = 60) {
	const out = [];
	const walk = (dir, rel, depth) => {
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

/** Is there a `theme.json` at the root or one level down? */
function blockThemeMarkers(root) {
	const probe = (dir, rel) => ({
		themeJson: existsSync(join(dir, 'theme.json')),
		dirs: existsSync(join(dir, 'templates')) || existsSync(join(dir, 'parts')),
		rel,
	});
	const hits = [probe(root, '')];
	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		/* unreadable root just yields the root probe */
	}
	for (const e of entries) {
		if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
		hits.push(probe(join(root, e.name), e.name));
	}
	return hits.find((h) => h.themeJson && h.dirs) || hits.find((h) => h.themeJson) || null;
}

/**
 * Which preset fits this project?
 *
 * Ordered most-specific first. `wpds` wins over `wordpress-components` for
 * anything importing the component library: it extends that preset and adds the
 * token prefix and severities this plugin exists to enforce, so selecting the
 * weaker parent would silently drop them.
 */
export function detectPreset(root) {
	const reasons = [];
	const found = manifests(root);

	// Shallowest manifest declaring the component library wins, so a root that
	// happens to list it beats a nested one, and `packageDir` names where its
	// `node_modules` — and therefore the token stylesheet — will be.
	for (const { rel } of found) {
		const pkg = readJson(join(root, rel, 'package.json')) || {};
		const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
		const hit = Object.keys(deps).filter((d) => d === '@wordpress/components' || d === '@wordpress/ui');
		if (!hit.length) continue;
		reasons.push(`${hit[0]} in ${rel ? `${rel}/package.json` : 'package.json'}`);
		if (found.length > 1) reasons.push(`${found.length} package.json files scanned`);
		return { preset: 'wpds', reasons, confidence: 'high', packageDir: rel };
	}

	const theme = blockThemeMarkers(root);
	if (theme?.dirs) {
		reasons.push(`theme.json + templates/ or parts/${theme.rel ? ` in ${theme.rel}/` : ''}`);
		return { preset: 'wordpress-block-theme', reasons, confidence: 'high', packageDir: theme.rel };
	}
	if (theme) {
		reasons.push('theme.json present, no templates/ or parts/');
		return { preset: 'wordpress-block-theme', reasons, confidence: 'medium', packageDir: theme.rel };
	}
	reasons.push(`no WordPress markers found in ${found.length} package.json file(s)`);
	return { preset: 'generic', reasons, confidence: 'low', packageDir: '' };
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
function libraryPrefixes(dirs, candidates) {
	const want = new Set(candidates);
	const found = new Set();
	if (!want.size) return found;
	let budget = 600;

	const walk = (dir, depth) => {
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
					const i = m[1].indexOf('-');
					if (i < 1) continue;
					const prefix = m[1].slice(0, i + 1);
					if (want.delete(prefix)) found.add(prefix);
				}
			}
		}
	};

	for (const dir of dirs) if (existsSync(dir)) walk(dir, 0);
	return found;
}

/** Resolve a preset's `extends` chain far enough to read namespaces and sources. */
function resolvePreset(name, seen = new Set()) {
	if (seen.has(name)) return {};
	seen.add(name);
	const raw = preset(name);
	if (!raw.extends) return raw;
	const specs = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
	let base = {};
	for (const spec of specs) {
		const parent = resolvePreset(String(spec).replace(/^ds-hygiene\/presets\//, ''), seen);
		base = {
			...base,
			...parent,
			namespaces: { ...(base.namespaces || {}), ...(parent.namespaces || {}) },
			sources: { ...(base.sources || {}), ...(parent.sources || {}) },
		};
	}
	return {
		...base,
		...raw,
		namespaces: { ...(base.namespaces || {}), ...(raw.namespaces || {}) },
		sources: { ...(base.sources || {}), ...(raw.sources || {}) },
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
export function detectNamespaces(root, presetName, packageDir = '') {
	const base = resolvePreset(presetName);
	const generic = resolvePreset('generic');
	const sources = { ...generic.sources, ...(base.sources || {}) };
	const files = discover({ root, sources });

	// Library prefixes from every WordPress preset, so a project styling only
	// third-party classes yields no namespace rather than adopting theirs.
	const external = [
		...(base.namespaces?.external || []),
		...(resolvePreset('wordpress-components').namespaces?.external || []),
		...(resolvePreset('wordpress-block-theme').namespaces?.external || []),
	];
	const neverDead = [
		...(base.namespaces?.neverDead || []),
		...(resolvePreset('wordpress-components').namespaces?.neverDead || []),
	].map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
	const isExcluded = (cls) => external.some((p) => cls.startsWith(p)) || neverDead.some((re) => re.test(cls));

	const cssCounts = new Map();
	for (const { abs } of files.styles) {
		let text;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		for (const m of text.matchAll(CLASS_RE)) {
			const cls = m[1];
			if (isExcluded(cls)) continue;
			const idx = cls.indexOf('-');
			if (idx < 1) continue;
			const prefix = cls.slice(0, idx + 1);
			cssCounts.set(prefix, (cssCounts.get(prefix) || 0) + 1);
		}
	}

	const markupText = [];
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
		candidates.map(([p]) => p)
	);

	// Drop prefixes already covered by a shorter accepted one (`wf-card-` under `wf-`).
	const accepted = [];
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
		confidence: accepted.length === 0 ? 'none' : coverage >= 0.5 ? 'high' : 'low',
		sampled: { styles: files.styles.length, markup: files.markup.length, references: files.references.length },
	};
}

/**
 * Full inferred config for a project with no config file.
 *
 * `inferred: true` travels with the result so the CLI can hold guessed settings
 * to a lower bar than ones somebody wrote down.
 */
export function detectConfig(root) {
	const { preset: name, reasons, confidence: presetConfidence, packageDir } = detectPreset(root);
	const ns = detectNamespaces(root, name, packageDir);
	const config = { extends: name, namespaces: { project: ns.project } };

	// A preset's token sources are written relative to the project root. In a
	// monorepo the design system is installed beside the manifest that asked for
	// it, so without this the token set comes back empty and every finding goes
	// back to naming a namespace instead of a token.
	if (packageDir) {
		const sources = resolvePreset(name).designSystem?.tokenSources || [];
		if (sources.length)
			config.designSystem = { tokenSources: sources.map((p) => `${packageDir}/${p}`) };
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
		config,
	};
}
