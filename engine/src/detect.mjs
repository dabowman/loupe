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

import { existsSync, readFileSync } from 'node:fs';
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

/**
 * Which preset fits this project?
 *
 * Ordered most-specific first. `wpds` wins over `wordpress-components` for
 * anything importing the component library: it extends that preset and adds the
 * token prefix and severities this plugin exists to enforce, so selecting the
 * weaker parent would silently drop them.
 */
export function detectPreset(root) {
	const pkg = readJson(join(root, 'package.json')) || {};
	const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
	const reasons = [];

	const hasThemeJson = existsSync(join(root, 'theme.json'));
	const hasBlockThemeDirs = existsSync(join(root, 'templates')) || existsSync(join(root, 'parts'));
	const wpComponents = Object.keys(deps).filter((d) => d === '@wordpress/components' || d === '@wordpress/ui');

	if (wpComponents.length) {
		reasons.push(`${wpComponents[0]} in package.json`);
		if (hasThemeJson) reasons.push('theme.json also present');
		return { preset: 'wpds', reasons, confidence: 'high' };
	}
	if (hasThemeJson && hasBlockThemeDirs) {
		reasons.push('theme.json + templates/ or parts/');
		return { preset: 'wordpress-block-theme', reasons, confidence: 'high' };
	}
	if (hasThemeJson) {
		reasons.push('theme.json present, no templates/ or parts/');
		return { preset: 'wordpress-block-theme', reasons, confidence: 'medium' };
	}
	reasons.push('no WordPress markers found');
	return { preset: 'generic', reasons, confidence: 'low' };
}

const CLASS_RE = /\.(-?[_a-zA-Z][\w-]*)/g;

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
export function detectNamespaces(root, presetName) {
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

	// Drop prefixes already covered by a shorter accepted one (`wf-card-` under `wf-`).
	const accepted = [];
	for (const [prefix, count] of candidates) {
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
	const { preset: name, reasons, confidence: presetConfidence } = detectPreset(root);
	const ns = detectNamespaces(root, name);
	return {
		inferred: true,
		preset: name,
		presetReasons: reasons,
		presetConfidence,
		namespaces: { project: ns.project },
		namespaceConfidence: ns.confidence,
		coverage: ns.coverage,
		sampled: ns.sampled,
		config: { extends: name, namespaces: { project: ns.project } },
	};
}
