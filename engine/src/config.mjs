/**
 * Config discovery, `extends` resolution, and normalization into the shape the
 * analyzer consumes.
 *
 * Everything project-specific lives here. The rules and the file walker know
 * nothing about WordPress, or about any particular design system.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES, SEVERITIES, canonicalRuleId } from './rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

const CONFIG_NAMES = [
	'ds-hygiene.config.mjs',
	'ds-hygiene.config.js',
	'ds-hygiene.config.json',
	'.ds-hygienerc.json',
];

export const DEFAULTS = {
	designSystem: {
		packages: [],
		tokenPrefixes: [],
		normalizeExports: '',
		components: { layout: [], text: [] },
		elementMap: {},
	},
	namespaces: { project: [], external: [], neverDead: [] },
	sources: {
		styles: ['**/*.css', '**/*.scss'],
		markup: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
		references: ['**/*.php', '**/*.html'],
		ignore: ['**/node_modules/**', '**/build/**', '**/dist/**', '**/vendor/**', '**/.git/**'],
	},
	suppression: { keyword: 'ds-allow', blanket: ['ds-disable'] },
	rules: {},
	baseline: '.ds-hygiene-baseline.json',
	hook: { maxAttempts: 3, maxFindings: 12, timeoutMs: 120000 },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge; arrays replace rather than concatenate so a preset can be overridden. */
function merge(base, over) {
	if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
	return out;
}

/** Walk up from `start` looking for a config file or a `dsHygiene` package.json key. */
export function findConfig(start) {
	let dir = resolve(start);
	for (;;) {
		for (const name of CONFIG_NAMES) {
			const p = join(dir, name);
			if (existsSync(p)) return p;
		}
		const pkg = join(dir, 'package.json');
		if (existsSync(pkg)) {
			try {
				if (JSON.parse(readFileSync(pkg, 'utf8')).dsHygiene) return pkg;
			} catch {
				/* unreadable package.json is not our problem here */
			}
		}
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

async function readConfigFile(path) {
	if (path.endsWith('.json')) {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		return path.endsWith('package.json') ? parsed.dsHygiene : parsed;
	}
	const mod = await import(pathToFileURL(path).href);
	return mod.default ?? mod;
}

/** Resolve `extends`, which may name a shipped preset or a path. */
async function resolveExtends(spec, fromDir) {
	const asPreset = join(PRESET_DIR, `${spec.replace(/^ds-hygiene\/presets\//, '')}.json`);
	if (existsSync(asPreset)) return { path: asPreset, dir: PRESET_DIR };
	const asPath = isAbsolute(spec) ? spec : join(fromDir, spec);
	if (existsSync(asPath)) return { path: asPath, dir: dirname(asPath) };
	throw new Error(`cannot resolve extends: ${spec}`);
}

async function loadChain(path, seen = new Set()) {
	const real = resolve(path);
	if (seen.has(real)) throw new Error(`circular extends at ${real}`);
	seen.add(real);
	const raw = (await readConfigFile(real)) || {};
	if (!raw.extends) return raw;
	const specs = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
	let base = {};
	for (const spec of specs) {
		const { path: p } = await resolveExtends(spec, dirname(real));
		base = merge(base, await loadChain(p, seen));
	}
	const { extends: _drop, ...rest } = raw;
	return merge(base, rest);
}

export function listPresets() {
	return ['wpds', 'wordpress-components', 'wordpress-block-theme', 'generic'];
}

/** Compile `has-*` style patterns into anchored regexes. */
function compilePatterns(patterns) {
	return (patterns || []).map(
		(p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
	);
}

/**
 * Normalize a merged config: canonicalize rule ids, coerce severities, expand
 * the element map, and precompute the predicates the analyzer uses.
 */
export function normalize(raw, { root }) {
	const cfg = merge(DEFAULTS, raw || {});
	const ds = cfg.designSystem;

	// Rule severities + options. Accepts "warn" | ["warn", {opts}] | "off".
	const rules = {};
	for (const [id, def] of Object.entries(RULES)) rules[id] = { severity: def.severity, options: {} };
	for (const [rawId, value] of Object.entries(cfg.rules || {})) {
		const id = canonicalRuleId(rawId);
		if (!RULES[id]) throw new Error(`unknown rule in config: ${rawId}`);
		const [sev, opts] = Array.isArray(value) ? value : [value, {}];
		if (!SEVERITIES.has(sev)) throw new Error(`bad severity for ${rawId}: ${sev}`);
		rules[id] = { severity: sev, options: { ...opts } };
	}

	// Element map: "p": "Text" or "div": { component, styledOnly }.
	const elementMap = new Map();
	for (const [tag, v] of Object.entries(ds.elementMap || {})) {
		const entry = typeof v === 'string' ? { component: v, styledOnly: false } : v;
		elementMap.set(tag.toLowerCase(), { styledOnly: false, ...entry });
	}

	const layoutComponents = ds.components?.layout || [];
	const textComponents = ds.components?.text || [];
	const hasComponents = (ds.packages || []).length > 0 && layoutComponents.length + textComponents.length > 0;

	// A rule is available only if the active config satisfies its `needs`.
	const capability = {
		components: hasComponents,
		layoutComponents: hasComponents && layoutComponents.length > 0,
		textComponents: hasComponents && textComponents.length > 0,
		elementMap: elementMap.size > 0,
		projectNamespace: (cfg.namespaces.project || []).length > 0,
	};

	const enabled = {};
	for (const [id, def] of Object.entries(RULES)) {
		const met = def.needs.every((n) => capability[n]);
		enabled[id] = met && rules[id].severity !== 'off';
	}

	const neverDead = compilePatterns(cfg.namespaces.neverDead);
	const projectPrefixes = cfg.namespaces.project || [];
	const externalPrefixes = cfg.namespaces.external || [];

	return {
		root,
		raw: cfg,
		designSystem: {
			packages: ds.packages || [],
			tokenPrefixes: ds.tokenPrefixes || [],
			normalizeExports: ds.normalizeExports ? new RegExp(ds.normalizeExports) : null,
			layoutComponents,
			textComponents,
			knownComponents: new Set([...layoutComponents, ...textComponents]),
			elementMap,
		},
		sources: cfg.sources,
		suppression: cfg.suppression,
		baselinePath: cfg.baseline,
		hook: cfg.hook,
		rules,
		enabled,
		severityOf: (id) => rules[id]?.severity ?? 'warn',
		optionsOf: (id) => rules[id]?.options ?? {},
		isProject: (cls) => projectPrefixes.some((p) => cls.startsWith(p)),
		isExternal: (cls) => externalPrefixes.some((p) => cls.startsWith(p)),
		isNeverDead: (cls) => neverDead.some((re) => re.test(cls)),
	};
}

/** Load config for `root`, falling back to the generic preset when none exists. */
export async function loadConfig({ root, configPath, preset }) {
	let raw;
	if (configPath) raw = await loadChain(resolve(configPath));
	else if (preset) raw = await loadChain(join(PRESET_DIR, `${preset}.json`));
	else {
		const found = findConfig(root);
		raw = found ? await loadChain(found) : await loadChain(join(PRESET_DIR, 'generic.json'));
	}
	return normalize(raw, { root });
}
