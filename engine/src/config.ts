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
import { RULES, RULE_IDS, canonicalRuleId, isRuleId, isSeverity } from './rules.ts';
import { loadPatterns } from './patterns.ts';
import { registryApplies } from './registry.ts';
import { loadComponents } from './components.ts';
import { DEFAULT_BASELINE } from './paths.ts';
import type {
	AuthoredConfig,
	Capability,
	ComponentEntry,
	Config,
	ConfigSource,
	ElementMapping,
	MergedConfig,
	Pattern,
	RuleId,
	RuleSetting,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

const CONFIG_NAMES = [
	'loupe.config.mjs',
	'loupe.config.js',
	'loupe.config.json',
	'.louperc.json',
];

export const DEFAULTS: MergedConfig = {
	designSystem: {
		// What to call this design system in a finding. Rule guidance that names
		// the system reads as advice about *your* stack; a generic phrase reads as
		// advice about linting.
		name: '',
		packages: [],
		tokenPrefixes: [],
		tokenSources: [],
		cssInJsPackages: [],
		normalizeExports: '',
		components: { layout: [], text: [] },
		elementMap: {},
		// Props that hand a component the element it should render — `render` in
		// WPDS and Base UI, `as` and `component` in most other React systems. The
		// element in one of these is an argument naming a tag, not markup being
		// rendered, so the raw-element rule leaves it alone. Set it to `[]` to get
		// the old behaviour back; a system with a differently-named prop names it.
		substitutionProps: ['render', 'as', 'component'],
	},
	namespaces: { project: [], external: [], neverDead: [] },
	sources: {
		styles: ['**/*.css', '**/*.scss'],
		markup: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
		references: ['**/*.php', '**/*.html'],
		ignore: ['**/node_modules/**', '**/build/**', '**/dist/**', '**/vendor/**', '**/.git/**'],
	},
	suppression: { keyword: 'ds-allow', blanket: ['ds-disable'], aliases: [] },
	rules: {},
	patterns: null,
	// The component-currency registry (recommended/legacy/locked/experimental
	// per component+package). Named distinctly from `designSystem.components`
	// (the layout/text categorization) — same word, unrelated concern.
	componentRegistry: null,
	baseline: DEFAULT_BASELINE,
	hook: { maxAttempts: 3, maxFindings: 12, timeoutMs: 120000 },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
	Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep merge; arrays replace rather than concatenate so a preset can be overridden.
 *
 * Declared as returning the base's type. That is the contract every caller
 * relies on — merging *onto* `DEFAULTS` is what makes every field present — and
 * it is what keeps a settled config strict downstream. Extra keys an override
 * carries do survive at runtime; nothing reads them.
 */
function merge<T>(base: T, over: unknown): T {
	if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
	return out as T;
}

/** Walk up from `start` looking for a config file or a `loupe` package.json key. */
export function findConfig(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		for (const name of CONFIG_NAMES) {
			const p = join(dir, name);
			if (existsSync(p)) return p;
		}
		const pkg = join(dir, 'package.json');
		if (existsSync(pkg)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
				if (isObj(parsed) && parsed['loupe']) return pkg;
			} catch {
				/* unreadable package.json is not our problem here */
			}
		}
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

async function readConfigFile(path: string): Promise<AuthoredConfig | undefined> {
	if (path.endsWith('.json')) {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as AuthoredConfig & {
			loupe?: AuthoredConfig;
		};
		return path.endsWith('package.json') ? parsed.loupe : parsed;
	}
	const mod = (await import(pathToFileURL(path).href)) as { default?: AuthoredConfig };
	return mod.default ?? (mod as AuthoredConfig);
}

/**
 * Where a preset spec would live, if it names a shipped preset at all.
 *
 * Shared with {@link presetExists} so the two cannot disagree: a check that
 * strips the `loupe/presets/` prefix and a check that does not will reject a
 * spec the resolver would have accepted, which is how `--profile` came to
 * report a perfectly resolvable preset as "not installed".
 */
const presetPath = (spec: string): string => join(PRESET_DIR, `${spec.replace(/^loupe\/presets\//, '')}.json`);

/** Resolve `extends`, which may name a shipped preset or a path. */
async function resolveExtends(spec: string, fromDir: string): Promise<{ path: string; dir: string }> {
	const asPreset = presetPath(spec);
	if (existsSync(asPreset)) return { path: asPreset, dir: PRESET_DIR };
	const asPath = isAbsolute(spec) ? spec : join(fromDir, spec);
	if (existsSync(asPath)) return { path: asPath, dir: dirname(asPath) };
	throw new Error(`cannot resolve extends: ${spec}`);
}

async function loadChain(path: string, seen = new Set<string>()): Promise<AuthoredConfig> {
	const real = resolve(path);
	if (seen.has(real)) throw new Error(`circular extends at ${real}`);
	seen.add(real);
	const raw = (await readConfigFile(real)) ?? {};
	return expandExtends(raw, dirname(real), seen);
}

/**
 * Resolve `extends` on an already-parsed object.
 *
 * Split out of loadChain so a config that never touched disk — the one
 * auto-detection produces — goes through the same resolution as a file.
 */
async function expandExtends(
	raw: AuthoredConfig | undefined,
	fromDir: string,
	seen = new Set<string>(),
): Promise<AuthoredConfig> {
	if (!raw?.extends) return raw ?? {};
	const specs = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
	let base: AuthoredConfig = {};
	for (const spec of specs) {
		const { path: p } = await resolveExtends(spec, fromDir);
		base = merge(base, await loadChain(p, seen));
	}
	const { extends: _drop, ...rest } = raw;
	return merge(base, rest);
}

export function listPresets(): string[] {
	// Read the directory rather than hardcode: a list maintained by hand drifts
	// the moment someone adds a preset and forgets this line.
	try {
		return readdirSync(PRESET_DIR)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''))
			.sort((a, b) => (a === 'generic' ? 1 : b === 'generic' ? -1 : a.localeCompare(b)));
	} catch {
		// An unreadable preset directory is a broken install, not a design system
		// list to guess at; name only the one the engine falls back to anyway.
		return ['generic'];
	}
}

export const presetExists = (name: string): boolean => existsSync(presetPath(name));

/**
 * The suppression vocabulary of every shipped preset: the keywords each one
 * asks people to write, and the blanket forms each one refuses.
 *
 * Read from the directory for the same reason {@link listPresets} is: a list
 * kept by hand drifts the moment a preset is added, and here the drift is
 * invisible — a directive written in the missing vocabulary simply stops
 * suppressing. Read every time rather than cached, so a preset dropped into
 * `presets/` takes effect in the same run that adds it; it is a handful of
 * small files, once per `normalize`.
 *
 * Both halves matter. A term one preset treats as a blanket disable must never
 * become a muting keyword somewhere else just because a third preset names it,
 * so the blanket side is collected to be *excluded* from the alias set.
 */
function shippedVocabulary(): { keywords: string[]; blanket: Set<string> } {
	const keywords = new Set<string>([DEFAULTS.suppression.keyword]);
	const blanket = new Set<string>(DEFAULTS.suppression.blanket);
	try {
		for (const f of readdirSync(PRESET_DIR)) {
			if (!f.endsWith('.json')) continue;
			try {
				const raw: unknown = JSON.parse(readFileSync(join(PRESET_DIR, f), 'utf8'));
				const supp = isObj(raw) ? raw['suppression'] : undefined;
				if (!isObj(supp)) continue;
				const kw = supp['keyword'];
				if (typeof kw === 'string' && kw) keywords.add(kw);
				const bl = supp['blanket'];
				if (Array.isArray(bl)) for (const b of bl) if (typeof b === 'string' && b) blanket.add(b);
			} catch {
				// A preset that will not parse fails loudly when something extends it;
				// it must not take the alias list down with it here.
			}
		}
	} catch {
		// An unreadable preset directory is a broken install. The default
		// vocabulary is still worth honoring.
	}
	return { keywords: [...keywords], blanket };
}

/** Compile `has-*` style patterns into anchored regexes. */
function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
	return (patterns ?? []).map(
		(p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
	);
}

/**
 * Normalize a merged config: canonicalize rule ids, coerce severities, expand
 * the element map, and precompute the predicates the analyzer uses.
 */
export function normalize(raw: AuthoredConfig | undefined, { root }: { root: string }): Config {
	const cfg = merge(DEFAULTS, raw ?? {});
	const ds = cfg.designSystem;

	// A registry may be inline or a path. A path that does not resolve leaves the
	// registry empty, which disables the rules that need one rather than throwing
	// — the engine has to keep working in a project that ships no patterns.
	let patterns: Pattern[] = [];
	if (Array.isArray(cfg.patterns)) patterns = loadPatterns(cfg.patterns);
	else if (typeof cfg.patterns === 'string') {
		const p = isAbsolute(cfg.patterns) ? cfg.patterns : join(root, cfg.patterns);
		try {
			const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
			// A registry scoped to packages this project does not import applies to
			// some other design system that happens to name its components the same.
			patterns = registryApplies(raw, ds.packages) ? loadPatterns(raw) : [];
		} catch {
			patterns = [];
		}
	}

	// Same inline-or-path shape as patterns, for the same reason: a bad path
	// disables the rules that need it rather than throwing.
	let componentRegistry = new Map<string, ComponentEntry>();
	if (Array.isArray(cfg.componentRegistry)) componentRegistry = loadComponents(cfg.componentRegistry);
	else if (typeof cfg.componentRegistry === 'string') {
		const p = isAbsolute(cfg.componentRegistry) ? cfg.componentRegistry : join(root, cfg.componentRegistry);
		try {
			const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
			componentRegistry = registryApplies(raw, ds.packages) ? loadComponents(raw) : new Map();
		} catch {
			componentRegistry = new Map();
		}
	}

	// Rule severities + options. Accepts "warn" | ["warn", {opts}] | "off".
	// Seeded for every rule first, so the record is complete by construction and
	// the cast below is describing what the loop guarantees rather than hoping.
	const rules = Object.fromEntries(
		RULE_IDS.map((id) => [id, { severity: RULES[id].severity, options: {} }]),
	) as Record<RuleId, RuleSetting>;
	for (const [rawId, value] of Object.entries(cfg.rules ?? {})) {
		const id = canonicalRuleId(rawId);
		if (!isRuleId(id)) throw new Error(`unknown rule in config: ${rawId}`);
		const [sev, opts] = Array.isArray(value) ? value : [value, {}];
		if (!isSeverity(sev)) throw new Error(`bad severity for ${rawId}: ${String(sev)}`);
		rules[id] = { severity: sev, options: { ...opts } };
	}

	// Element map: "p": "Text" or "div": { component, styledOnly }.
	const elementMap = new Map<string, ElementMapping>();
	for (const [tag, v] of Object.entries(ds.elementMap ?? {})) {
		const entry = typeof v === 'string' ? { component: v, styledOnly: false } : v;
		elementMap.set(tag.toLowerCase(), { styledOnly: false, ...entry });
	}

	// `new Set('render')` is a set of four characters, and a config that means
	// nothing it says would report exactly like one that meant `[]` — the whole
	// exemption off, with nothing to see. Every coercion here that cannot mean
	// what it says throws; this one does too.
	//
	// The fallback is the default rather than `[]` because this key is the one
	// whose default is not empty: `merge` writes an explicit `undefined` straight
	// over the default, so `designSystem: { ...opts, substitutionProps: opts.subs }`
	// in a `.mjs` config would otherwise turn the exemption off silently. `[]`
	// stays the way to ask for that on purpose.
	const substitutionProps: unknown = ds.substitutionProps ?? DEFAULTS.designSystem.substitutionProps;
	if (!Array.isArray(substitutionProps) || substitutionProps.some((p) => typeof p !== 'string'))
		throw new Error(
			`designSystem.substitutionProps must be an array of prop names, got: ${JSON.stringify(substitutionProps)}`,
		);

	const layoutComponents = ds.components?.layout ?? [];
	const textComponents = ds.components?.text ?? [];
	const hasComponents = (ds.packages ?? []).length > 0 && layoutComponents.length + textComponents.length > 0;

	// A rule is available only if the active config satisfies its `needs`.
	const capability: Record<Capability, boolean> = {
		components: hasComponents,
		layoutComponents: hasComponents && layoutComponents.length > 0,
		textComponents: hasComponents && textComponents.length > 0,
		elementMap: elementMap.size > 0,
		tokenPrefixes: (ds.tokenPrefixes || []).length > 0,
		patternRegistry: hasComponents && patterns.length > 0,
		componentRegistry: componentRegistry.size > 0,
		projectNamespace: (cfg.namespaces.project ?? []).length > 0,
	};

	const enabled = Object.fromEntries(
		RULE_IDS.map((id) => [
			id,
			RULES[id].needs.every((n: Capability) => capability[n]) && rules[id].severity !== 'off',
		]),
	) as Record<RuleId, boolean>;

	// Read aliases: every keyword the shipped presets know, plus any this config
	// names itself. The keyword is preset-scoped, so adopting a preset renames it
	// — and a directive in the old vocabulary is not read as a directive at all,
	// which loses the suppression and reports nothing. Reading them all keeps a
	// recorded reason counting; `keyword` alone is still what the tool tells
	// people to write, and the only vocabulary a malformed directive is judged
	// against.
	//
	// A blanket term anywhere in the shipped presets is never an alias: `wpds`
	// refuses `ds-disable`, and another preset adopting that spelling as its
	// keyword must not turn it into a mute here. Declared aliases are filtered
	// too — the guard is about the term, not about who named it — and anything
	// that is not a non-empty string is dropped rather than interpolated into a
	// regex.
	//
	// The same guard has to cover `keyword` and `blanket`. `merge` copies a
	// non-object value from authored JSON verbatim, so the declared types are a
	// contract with the author, not a check: `"keyword": ""` makes the parser's
	// `startsWith`/`includes` universally true and reports every line of every
	// file as malformed, `"keyword": 12` throws out of `esc`, and `"blanket":
	// "ds-disable"` spreads into eleven single-character prefixes. An unusable
	// value falls back to the default vocabulary for the same reason an
	// unreadable preset directory does — a broken install still has to run.
	const shipped = shippedVocabulary();
	const declared = Array.isArray(cfg.suppression.aliases) ? cfg.suppression.aliases : [];
	const isTerm = (v: unknown): v is string => typeof v === 'string' && v !== '';
	const keyword = isTerm(cfg.suppression.keyword) ? cfg.suppression.keyword : DEFAULTS.suppression.keyword;
	const blanket = Array.isArray(cfg.suppression.blanket)
		? cfg.suppression.blanket.filter(isTerm)
		: [...DEFAULTS.suppression.blanket];
	const suppression = {
		...cfg.suppression,
		keyword,
		blanket,
		aliases: [...new Set([...shipped.keywords, ...declared])].filter(
			(a) => isTerm(a) && a !== keyword && !shipped.blanket.has(a),
		),
	};

	const neverDead = compilePatterns(cfg.namespaces.neverDead);
	const projectPrefixes = cfg.namespaces.project ?? [];
	const externalPrefixes = cfg.namespaces.external ?? [];

	return {
		root,
		raw: cfg,
		// Overwritten by `loadConfig`, which knows which of the five resolution
		// paths won. Normalizing a bare object is the inline case by definition.
		source: { kind: 'inline' },
		inferred: false,
		designSystem: {
			name: ds.name || '',
			packages: ds.packages ?? [],
			tokenPrefixes: ds.tokenPrefixes ?? [],
			tokenSources: ds.tokenSources ?? [],
			cssInJsPackages: ds.cssInJsPackages ?? [],
			normalizeExports: ds.normalizeExports ? new RegExp(ds.normalizeExports) : null,
			layoutComponents,
			textComponents,
			knownComponents: new Set([...layoutComponents, ...textComponents]),
			elementMap,
			substitutionProps: new Set(substitutionProps as string[]),
		},
		patterns,
		componentRegistry,
		sources: cfg.sources,
		suppression,
		baselinePath: cfg.baseline,
		hook: cfg.hook,
		rules,
		enabled,
		severityOf: (id: RuleId) => rules[id]?.severity ?? 'warn',
		optionsOf: (id: RuleId) => rules[id]?.options ?? {},
		isProject: (cls: string) => projectPrefixes.some((p) => cls.startsWith(p)),
		isExternal: (cls: string) => externalPrefixes.some((p) => cls.startsWith(p)),
		isNeverDead: (cls: string) => neverDead.some((re) => re.test(cls)),
	};
}

/**
 * Attach a pattern registry after the fact, keeping `enabled` in step.
 *
 * `patternRegistry` is a capability computed during normalization, so assigning
 * `config.patterns` on its own leaves the rule disabled and the registry
 * silently unused — which looks exactly like "no composite drift found".
 */
export function setPatterns(config: Config, patterns: Pattern[] | null | undefined): Config {
	config.patterns = patterns ?? [];
	const hasRegistry =
		config.patterns.length > 0 &&
		// The same `hasComponents` normalization computes above, restated rather
		// than recomputed. Dropping the packages half made this looser than the
		// capability it stands in for: a composite is only ever built from names
		// imported out of `designSystem.packages`, so a config declaring none can
		// never produce one — and `status` reported the rule active anyway.
		config.designSystem.packages.length > 0 &&
		config.designSystem.knownComponents.size > 0;
	// Every rule reading the registry has to be wired here, not just the first
	// one: a rule left out looks exactly like "nothing found".
	for (const rule of ['patterns/duplicate-composite', 'patterns/superseded-composite'] as const)
		config.enabled[rule] = hasRegistry && config.severityOf(rule) !== 'off';
	return config;
}

/** Same after-the-fact attachment as {@link setPatterns}, for the component registry. */
export function setComponentRegistry(
	config: Config,
	componentRegistry: Map<string, ComponentEntry> | null | undefined,
): Config {
	config.componentRegistry = componentRegistry ?? new Map();
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
export async function loadConfig({
	root,
	configPath,
	preset,
	inline,
	inferred = false,
}: {
	root: string;
	configPath?: string | null;
	preset?: string | null;
	inline?: AuthoredConfig | null;
	inferred?: boolean;
}): Promise<Config> {
	let raw: AuthoredConfig;
	let source: ConfigSource;
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
