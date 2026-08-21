/**
 * Config discovery, `extends` resolution, and normalization into the shape the
 * analyzer consumes.
 *
 * Everything project-specific lives here. The rules and the file walker know
 * nothing about WordPress, or about any particular design system.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RULES, SEVERITIES, canonicalRuleId } from './rules.mjs';
import { loadPatterns } from './patterns.mjs';
import { loadComponents } from './components.mjs';

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
		tokenSources: [],
		cssInJsPackages: [],
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
	patterns: null,
	// The component-currency registry (recommended/legacy/locked/experimental
	// per component+package). Named distinctly from `designSystem.components`
	// (the layout/text categorization) — same word, unrelated concern.
	componentRegistry: null,
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
	return expandExtends(raw, dirname(real), seen);
}

/**
 * Resolve `extends` on an already-parsed object.
 *
 * Split out of loadChain so a config that never touched disk — the one
 * auto-detection produces — goes through the same resolution as a file.
 */
async function expandExtends(raw, fromDir, seen = new Set()) {
	if (!raw?.extends) return raw || {};
	const specs = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
	let base = {};
	for (const spec of specs) {
		const { path: p } = await resolveExtends(spec, fromDir);
		base = merge(base, await loadChain(p, seen));
	}
	const { extends: _drop, ...rest } = raw;
	return merge(base, rest);
}

export function listPresets() {
	// Read the directory rather than hardcode: a list maintained by hand drifts
	// the moment someone adds a preset and forgets this line.
	try {
		return readdirSync(PRESET_DIR)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''))
			.sort((a, b) => (a === 'generic' ? 1 : b === 'generic' ? -1 : a.localeCompare(b)));
	} catch {
		return ['wpds', 'wordpress-components', 'wordpress-block-theme', 'generic'];
	}
}

export const presetExists = (name) => existsSync(join(PRESET_DIR, `${name}.json`));

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

	// A registry may be inline or a path. A path that does not resolve leaves the
	// registry empty, which disables the rules that need one rather than throwing
	// — the engine has to keep working in a project that ships no patterns.
	let patterns = [];
	if (Array.isArray(cfg.patterns)) patterns = loadPatterns(cfg.patterns);
	else if (typeof cfg.patterns === 'string') {
		const p = isAbsolute(cfg.patterns) ? cfg.patterns : join(root, cfg.patterns);
		try {
			patterns = loadPatterns(JSON.parse(readFileSync(p, 'utf8')));
		} catch {
			patterns = [];
		}
	}

	// Same inline-or-path shape as patterns, for the same reason: a bad path
	// disables the rules that need it rather than throwing.
	let componentRegistry = new Map();
	if (Array.isArray(cfg.componentRegistry)) componentRegistry = loadComponents(cfg.componentRegistry);
	else if (typeof cfg.componentRegistry === 'string') {
		const p = isAbsolute(cfg.componentRegistry) ? cfg.componentRegistry : join(root, cfg.componentRegistry);
		try {
			componentRegistry = loadComponents(JSON.parse(readFileSync(p, 'utf8')));
		} catch {
			componentRegistry = new Map();
		}
	}

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
		tokenPrefixes: (ds.tokenPrefixes || []).length > 0,
		patternRegistry: hasComponents && patterns.length > 0,
		componentRegistry: componentRegistry.size > 0,
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
			tokenSources: ds.tokenSources || [],
			cssInJsPackages: ds.cssInJsPackages || [],
			normalizeExports: ds.normalizeExports ? new RegExp(ds.normalizeExports) : null,
			layoutComponents,
			textComponents,
			knownComponents: new Set([...layoutComponents, ...textComponents]),
			elementMap,
		},
		patterns,
		componentRegistry,
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

/**
 * Attach a pattern registry after the fact, keeping `enabled` in step.
 *
 * `patternRegistry` is a capability computed during normalization, so assigning
 * `config.patterns` on its own leaves the rule disabled and the registry
 * silently unused — which looks exactly like "no composite drift found".
 */
export function setPatterns(config, patterns) {
	config.patterns = patterns || [];
	config.enabled['patterns/duplicate-composite'] =
		config.patterns.length > 0 &&
		config.designSystem.knownComponents.size > 0 &&
		config.severityOf('patterns/duplicate-composite') !== 'off';
	return config;
}

/** Same after-the-fact attachment as {@link setPatterns}, for the component registry. */
export function setComponentRegistry(config, componentRegistry) {
	config.componentRegistry = componentRegistry || new Map();
	config.enabled['system/locked-component'] =
		config.componentRegistry.size > 0 && config.severityOf('system/locked-component') !== 'off';
	config.enabled['system/superseded-component'] =
		config.componentRegistry.size > 0 && config.severityOf('system/superseded-component') !== 'off';
	return config;
}

/**
 * Load config for `root`.
 *
 * Resolution order, most explicit first:
 *   1. an explicit --config path
 *   2. an explicit --preset
 *   3. a discovered project config file
 *   4. an inline object (what auto-detection produces)
 *   5. the generic preset
 *
 * `source` records which of those won, and `inferred` marks a config nobody
 * wrote down — the CLI uses it to hold guessed settings to a lower bar.
 */
export async function loadConfig({ root, configPath, preset, inline, inferred = false }) {
	let raw;
	let source;
	if (configPath) {
		raw = await loadChain(resolve(configPath));
		source = { kind: 'file', path: resolve(configPath) };
	} else if (preset) {
		if (!presetExists(preset)) throw new Error(`unknown preset: ${preset}`);
		raw = await loadChain(join(PRESET_DIR, `${preset}.json`));
		source = { kind: 'preset', name: preset };
	} else {
		const found = findConfig(root);
		if (found) {
			raw = await loadChain(found);
			source = { kind: 'file', path: found };
		} else if (inline) {
			raw = await expandExtends(inline, root);
			source = { kind: inferred ? 'inferred' : 'inline' };
		} else {
			raw = await loadChain(join(PRESET_DIR, 'generic.json'));
			source = { kind: 'preset', name: 'generic' };
		}
	}
	const normalized = normalize(raw, { root });
	normalized.source = source;
	normalized.inferred = source.kind === 'inferred';
	return normalized;
}
