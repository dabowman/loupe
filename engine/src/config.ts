/**
 * Config discovery, `extends` resolution, and normalization into the shape the
 * analyzer consumes.
 *
 * Everything project-specific lives here. The rules and the file walker know
 * nothing about WordPress, or about any particular design system.
 *
 * Design notes: docs/design/cli.md#config
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES, RULE_IDS, canonicalRuleId, isRuleId, isSeverity } from './rules.ts';
import { loadPatterns } from './patterns.ts';
import { registryApplies } from './registry.ts';
import { loadComponents } from './components.ts';
import { isRecord as isObj, listOf, readJson } from './json.ts';
import { DEFAULT_BASELINE, under } from './paths.ts';
import { escapeRe } from './text.ts';
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
import { EMBEDDED_PRESETS, PRESET_DIR, hasPreset, presetNames, presetOf, presetPath, readPreset } from './embedded.ts';

const CONFIG_NAMES = ['loupe.config.mjs', 'loupe.config.js', 'loupe.config.json', '.louperc.json'];

export const DEFAULTS: MergedConfig = {
	designSystem: {
		// What to call this design system in a finding. Rule guidance that names
		// the system reads as advice about *your* stack; a generic phrase reads as
		// advice about linting.
		name: '',
		packages: [],
		tokenPrefixes: [],
		tokenSources: [],
		// The system's own stylesheets, read for the classes they define. A
		// prefixed system is covered by `namespaces.external`; an unprefixed one
		// (`.field-label`) is only recognisable by what its stylesheets declare.
		styleSources: [],
		cssInJsPackages: [],
		normalizeExports: '',
		components: { layout: [], text: [] },
		elementMap: {},
		// Props that hand a component the element it should render — `render` in WPDS
		// and Base UI, `as` and `component` elsewhere. The element in one of these is
		// an argument naming a tag, not markup being rendered. `[]` turns it off.
		substitutionProps: ['render', 'as', 'component'],
		allowedInlineStyles: {},
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
	// timeoutMs is the hook's whole judge phase, well inside the 60s Claude Code
	// gives PostToolUse: the analysis on either side of it needs the rest.
	hook: { maxAttempts: 3, maxFindings: 12, timeoutMs: 30000 },
};

/**
 * Deep merge; arrays replace rather than concatenate so a preset can be
 * overridden.
 *
 * Declared as returning the base's type, which is the contract every caller
 * relies on: merging *onto* `DEFAULTS` is what makes every field present. Extra
 * keys an override carries survive at runtime; nothing reads them.
 */
export function merge<T>(base: T, over: unknown): T {
	if (!isObj(base) || !isObj(over)) return over === undefined ? base : (over as T);
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
	return out as T;
}

/**
 * {@link merge}, except that a rule's setting is replaced whole.
 *
 * Merging one field-by-field would carry a preset's `reason` for turning a rule
 * off onto a project that turned it back on — an explanation of a setting that
 * is no longer there.
 */
function mergeConfig(base: AuthoredConfig, over: AuthoredConfig): AuthoredConfig {
	const out = merge(base, over);
	if (isObj(base.rules) && isObj(over.rules)) out.rules = { ...base.rules, ...over.rules };
	return out;
}

/** Walk up from `start` looking for a config file or a `loupe` package.json key. */
export function findConfig(start: string): string | null {
	let dir = resolve(start);
	for (;;) {
		for (const name of CONFIG_NAMES) {
			const p = join(dir, name);
			if (existsSync(p)) return p;
		}
		// An unreadable package.json is not this walk's problem: it reads as one with no `loupe` key.
		const pkg = join(dir, 'package.json');
		const parsed = readJson(pkg);
		if (isObj(parsed) && parsed.loupe) return pkg;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

async function readConfigFile(path: string): Promise<AuthoredConfig | undefined> {
	// A preset the binary carries rather than reads. Checked before the disk
	// read so the error below stays about *your* config file, not this one.
	const preset = presetOf(path);
	if (preset !== null && !existsSync(path)) {
		const embedded = EMBEDDED_PRESETS[preset];
		if (embedded) return embedded as AuthoredConfig;
	}
	if (path.endsWith('.json')) {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as AuthoredConfig & {
			loupe?: AuthoredConfig;
		};
		return path.endsWith('package.json') ? parsed.loupe : parsed;
	}
	const mod = (await import(pathToFileURL(path).href)) as { default?: AuthoredConfig };
	return mod.default ?? (mod as AuthoredConfig);
}

/** Resolve `extends`, which may name a shipped preset or a path. */
async function resolveExtends(spec: string, fromDir: string): Promise<{ path: string; dir: string }> {
	if (hasPreset(spec)) return { path: presetPath(spec), dir: PRESET_DIR };
	const asPath = under(fromDir, spec);
	if (existsSync(asPath)) return { path: asPath, dir: dirname(asPath) };
	throw new Error(`cannot resolve extends: ${spec}`);
}

/**
 * A config with its `extends` resolved, and which file in the chain wrote each
 * rule setting — what lets `loupe suppressions` say a preset turned a rule off
 * rather than pin it on the project's own config.
 */
interface Chain {
	raw: AuthoredConfig;
	/** Rule id as written → the absolute path or `preset <name>` that set it. */
	ruleFrom: Record<string, string>;
}

/**
 * Where a walk of `extends` has got to.
 *
 * `ancestors` is the path from the config being loaded down to this one, and a
 * config met again on it is a cycle. It is not every config visited: a diamond
 * — `extends: ["wpds", "base-ui"]`, both of which reach `generic` — meets the
 * shared ancestor twice on separate branches, and that is no cycle.
 *
 * `applied` is every config merged in so far, across branches. A shared
 * ancestor is merged once, where it is first met, and skipped after: merged
 * again, the second branch's copy would land on top of the first branch and put
 * back every setting the first branch's own configs had replaced — `generic`'s
 * `sources.references` over `wordpress-components`'. Merged once, every config
 * still lands after its ancestors and before its descendants, as in one chain.
 */
interface Walk {
	ancestors: ReadonlySet<string>;
	applied: Set<string>;
}

const freshWalk = (): Walk => ({ ancestors: new Set(), applied: new Set() });

async function loadChain(path: string, walk = freshWalk()): Promise<Chain> {
	const real = resolve(path);
	if (walk.ancestors.has(real)) throw new Error(`circular extends at ${real}`);
	if (walk.applied.has(real)) return { raw: {}, ruleFrom: {} };
	walk.applied.add(real);
	const raw = (await readConfigFile(real)) ?? {};
	const preset = presetOf(real);
	const label = preset === null ? real : `preset ${preset}`;
	return expandExtends(raw, dirname(real), label, {
		ancestors: new Set([...walk.ancestors, real]),
		applied: walk.applied,
	});
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
	label: string,
	walk = freshWalk(),
): Promise<Chain> {
	raw = anchorProfiles(raw, fromDir);
	const own = Object.fromEntries(Object.keys(isObj(raw?.rules) ? raw.rules : {}).map((id) => [id, label]));
	if (!raw?.extends) return { raw: raw ?? {}, ruleFrom: own };
	let base: AuthoredConfig = {};
	let ruleFrom: Record<string, string> = {};
	for (const spec of listOf(raw.extends)) {
		const { path: p } = await resolveExtends(spec, fromDir);
		const parent = await loadChain(p, walk);
		base = mergeConfig(base, parent.raw);
		ruleFrom = { ...ruleFrom, ...parent.ruleFrom };
	}
	const { extends: _drop, ...rest } = raw;
	return { raw: mergeConfig(base, rest), ruleFrom: { ...ruleFrom, ...own } };
}

/**
 * `profiles` resolved against the directory of the file that wrote it.
 *
 * Here rather than in `normalize`, which knows only the root: once `extends` is
 * merged nothing says which file a path came from, and a shared config's
 * `./profiles` means the directory beside *it*, not beside whatever extends it.
 * Anything that is not a string is left alone for `normalize` to refuse.
 */
function anchorProfiles(raw: AuthoredConfig | undefined, fromDir: string): AuthoredConfig | undefined {
	if (!raw || raw.profiles === undefined) return raw;
	const at = (p: unknown): unknown => (typeof p === 'string' && p !== '' ? resolve(fromDir, p) : p);
	const spec: unknown = raw.profiles;
	return { ...raw, profiles: (Array.isArray(spec) ? spec.map(at) : at(spec)) as string | string[] };
}

/** Shipped presets, `generic` last — it is the fallback, not a choice. */
export function listPresets(): string[] {
	return presetNames().sort((a, b) => Number(a === 'generic') - Number(b === 'generic'));
}

/**
 * The suppression vocabulary of every shipped preset: the keywords each one asks
 * people to write, and the blanket forms each one refuses.
 *
 * Read from the directory rather than kept by hand, for the same reason
 * {@link listPresets} is — and here the drift is invisible, since a directive in
 * the missing vocabulary simply stops suppressing. Read every time, so a preset
 * dropped into `presets/` takes effect in the run that adds it.
 *
 * Both halves matter: a term one preset treats as a blanket disable must never
 * become a muting keyword somewhere else.
 */
function shippedVocabulary(): { keywords: string[]; blanket: Set<string> } {
	const keywords = new Set<string>([DEFAULTS.suppression.keyword]);
	const blanket = new Set<string>(DEFAULTS.suppression.blanket);
	try {
		for (const name of presetNames()) {
			try {
				const raw: unknown = readPreset(name);
				const supp = isObj(raw) ? raw.suppression : undefined;
				if (!isObj(supp)) continue;
				const kw = supp.keyword;
				if (typeof kw === 'string' && kw) keywords.add(kw);
				const bl = supp.blanket;
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
export function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
	return (patterns ?? []).map((p) => new RegExp(`^${escapeRe(p).replace(/\\\*/g, '.*')}$`));
}

/**
 * Normalize a merged config: canonicalize rule ids, coerce severities, expand
 * the element map, and precompute the predicates the analyzer uses.
 */
export function normalize(
	raw: AuthoredConfig | undefined,
	{ root, ruleFrom = {} }: { root: string; ruleFrom?: Record<string, string> },
): Config {
	const cfg = merge(DEFAULTS, raw ?? {});
	const ds = cfg.designSystem;
	const patterns = readRegistry(cfg.patterns, root, ds.packages, loadPatterns, []);
	const componentRegistry = readRegistry(cfg.componentRegistry, root, ds.packages, loadComponents, new Map());

	// Rule severities. Seeded for every rule first, so the record is complete by
	// construction and the cast is describing what the loop guarantees.
	const rules = Object.fromEntries(RULE_IDS.map((id) => [id, { severity: RULES[id].severity }])) as Record<
		RuleId,
		RuleSetting
	>;
	const ruleOrigins: Partial<Record<RuleId, string>> = {};
	for (const [rawId, value] of Object.entries(cfg.rules ?? {})) {
		const id = canonicalRuleId(rawId);
		if (!isRuleId(id)) throw new Error(`unknown rule in config: ${rawId}`);
		rules[id] = ruleSetting(rawId, value);
		// A path is shown relative to the root; a preset by name. A config normalized
		// straight from an object has no file to name.
		const from = ruleFrom[rawId];
		ruleOrigins[id] = from === undefined ? 'config' : isAbsolute(from) ? relative(root, from) || from : from;
	}

	// Element map: "p": "Text", "div": { component, styledOnly },
	// "input": { component, attribute: "type", values: { checkbox: "CheckboxControl" } },
	// or "h4": { component: "Text", render: "h4" }.
	const elementMap = new Map<string, ElementMapping>();
	for (const [tag, v] of Object.entries(ds.elementMap ?? {})) {
		const entry = typeof v === 'string' ? { component: v, styledOnly: false } : v;
		if ((entry.values === undefined) !== (entry.attribute === undefined))
			throw new Error(`elementMap.${tag}: attribute and values go together`);
		// It is printed as `render={ <h4 /> }`, so anything but a bare tag name
		// would put a suggestion in the finding that does not parse.
		if (entry.render !== undefined && !(typeof entry.render === 'string' && /^[a-z][a-z0-9-]*$/i.test(entry.render)))
			throw new Error(
				`elementMap.${tag}.render must be an element name like "h4", got: ${JSON.stringify(entry.render)}`,
			);
		elementMap.set(tag.toLowerCase(), { styledOnly: false, ...entry });
	}

	// `new Set('render')` is a set of four characters, and a config meaning nothing
	// it says reports exactly like one that meant `[]`. The fallback is the default
	// rather than `[]` because this is the one key whose default is not empty:
	// `merge` writes an explicit `undefined` straight over a default. `[]` stays
	// the way to ask for the exemption off.
	const substitutionProps: unknown = ds.substitutionProps ?? DEFAULTS.designSystem.substitutionProps;
	if (!Array.isArray(substitutionProps) || substitutionProps.some((p) => typeof p !== 'string'))
		throw new Error(
			`designSystem.substitutionProps must be an array of prop names, got: ${JSON.stringify(substitutionProps)}`,
		);

	// The same mistake costs more here: a bare string is walked one character at a
	// time, `/` is the repo root, and every project stylesheet is then skipped as
	// the library's own.
	const styleSources: unknown = ds.styleSources ?? [];
	if (!Array.isArray(styleSources) || styleSources.some((p) => typeof p !== 'string' || p === ''))
		throw new Error(`designSystem.styleSources must be an array of paths, got: ${JSON.stringify(styleSources)}`);

	const allowedInlineStyles: unknown = ds.allowedInlineStyles ?? {};
	if (
		!isObj(allowedInlineStyles) ||
		Object.values(allowedInlineStyles).some((v) => !Array.isArray(v) || v.some((p) => typeof p !== 'string'))
	)
		throw new Error(
			`designSystem.allowedInlineStyles must map component names to arrays of CSS properties, got: ${JSON.stringify(allowedInlineStyles)}`,
		);

	// A ceiling the walk refuses at. A string or a fraction read as "no ceiling
	// set" would leave a project that meant to raise it refusing at the default,
	// and one that meant to lower it walking a home directory.
	const maxEntries: unknown = cfg.maxEntries;
	if (maxEntries !== undefined && maxEntries !== null && !(Number.isInteger(maxEntries) && (maxEntries as number) > 0))
		throw new Error(`maxEntries must be a positive whole number of entries, got: ${JSON.stringify(maxEntries)}`);

	// A project's own profile directories. A bare string is one directory, not a
	// list of characters; anything else is a mistake, and read as "none" it would
	// quietly hand the project the shipped profile it wrote its own to replace.
	const profileSpec: unknown = cfg.profiles ?? [];
	const profileList: unknown[] =
		typeof profileSpec === 'string' ? [profileSpec] : Array.isArray(profileSpec) ? profileSpec : [profileSpec];
	if (profileList.some((p) => typeof p !== 'string' || p === ''))
		throw new Error(`profiles must be a directory or an array of directories, got: ${JSON.stringify(profileSpec)}`);
	// Normally absolute already (see `anchorProfiles`); an object normalized
	// straight from code has no file, so its paths are the root's.
	const profileDirs = (profileList as string[]).map((p) => resolve(root, p));

	const pin: unknown = cfg.profile;
	if (pin !== undefined && pin !== null && !(typeof pin === 'string' && pin !== ''))
		throw new Error(`profile must be a profile id or "none", got: ${JSON.stringify(pin)}`);

	const layoutComponents = ds.components?.layout ?? [];
	const textComponents = ds.components?.text ?? [];

	// Read aliases: every keyword the shipped presets know, plus any this config
	// names itself, so a directive written in a preset's old vocabulary still
	// mutes. `keyword` stays the one the tool tells people to write, and the only
	// vocabulary a malformed directive is judged against.
	//
	// A blanket term anywhere in the shipped presets is never an alias, declared
	// aliases included. Anything that is not a non-empty string is dropped rather
	// than interpolated into a regex — as are unusable `keyword` and `blanket`
	// values, which fall back to the default vocabulary.
	// See docs/design/cli.md#coercion-throws-because-the-silent-reading-is-worse.
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

	const config: Omit<Config, 'enabled'> = {
		root,
		raw: cfg,
		// Overwritten by `loadConfig`, which knows which of the five resolution
		// paths won. Normalizing a bare object is the inline case by definition.
		source: { kind: 'inline' },
		inferred: false,
		profileDirs,
		profilePin: typeof pin === 'string' ? pin : null,
		designSystem: {
			name: ds.name || '',
			packages: ds.packages ?? [],
			tokenPrefixes: ds.tokenPrefixes ?? [],
			tokenSources: ds.tokenSources ?? [],
			styleSources: styleSources as string[],
			cssInJsPackages: ds.cssInJsPackages ?? [],
			normalizeExports: ds.normalizeExports ? new RegExp(ds.normalizeExports) : null,
			layoutComponents,
			textComponents,
			knownComponents: new Set([...layoutComponents, ...textComponents]),
			elementMap,
			substitutionProps: new Set(substitutionProps as string[]),
			allowedInlineStyles: new Map(
				Object.entries(allowedInlineStyles as Record<string, string[]>).map(([c, props]) => [
					c,
					new Set(props.map((p) => p.toLowerCase())),
				]),
			),
		},
		patterns,
		componentRegistry,
		sources: cfg.sources,
		suppression,
		// An empty `baseline` names nothing, as an empty `--baseline=` does.
		baselinePath: cfg.baseline || DEFAULT_BASELINE,
		hook: cfg.hook,
		...(typeof maxEntries === 'number' ? { maxEntries } : {}),
		rules,
		ruleFrom: ruleOrigins,
		severityOf: (id: RuleId) => rules[id].severity,
		isProject: (cls: string) => projectPrefixes.some((p) => cls.startsWith(p)),
		isExternal: (cls: string) => externalPrefixes.some((p) => cls.startsWith(p)),
		isNeverDead: (cls: string) => neverDead.some((re) => re.test(cls)),
	};
	return { ...config, enabled: enabledRules(config) };
}

/**
 * One rule's setting: `"<severity>"`, or `{ severity, reason }` to say why.
 *
 * Anything else throws rather than guessing — a misspelled `reasn` read as no
 * reason at all is exactly the silent loss the object form exists to prevent.
 */
function ruleSetting(rawId: string, value: unknown): RuleSetting {
	if (isSeverity(value)) return { severity: value };
	if (Array.isArray(value))
		throw new Error(`rule options are no longer supported — write "${rawId}": ${JSON.stringify(value[0])}`);
	if (!isObj(value)) throw new Error(`bad severity for ${rawId}: ${String(value)}`);
	const extra = Object.keys(value).filter((k) => k !== 'severity' && k !== 'reason');
	if (extra.length)
		throw new Error(
			`unknown key${extra.length > 1 ? 's' : ''} in the setting for ${rawId}: ${extra.join(', ')} — a rule setting takes only severity and reason`,
		);
	const { severity, reason } = value;
	if (!isSeverity(severity)) throw new Error(`bad severity for ${rawId}: ${String(severity)}`);
	if (reason === undefined) return { severity };
	if (typeof reason !== 'string' || !reason.trim())
		throw new Error(`the reason for ${rawId} must be a non-empty string, got: ${JSON.stringify(reason)}`);
	return { severity, reason: reason.trim() };
}

/**
 * A registry given inline or as a path. A path that does not resolve leaves it
 * empty, which disables the rules that need one rather than throwing. So does a
 * registry scoped to packages this project does not import: it describes some
 * other design system that happens to name its components the same.
 */
function readRegistry<T>(
	spec: string | unknown[] | null,
	root: string,
	packages: readonly string[],
	load: (raw: unknown) => T,
	empty: T,
): T {
	// Inline, it is the config itself, and a malformed one is a config error.
	if (Array.isArray(spec)) return load(spec);
	if (typeof spec !== 'string') return empty;
	try {
		const raw: unknown = JSON.parse(readFileSync(under(root, spec), 'utf8'));
		return registryApplies(raw, packages) ? load(raw) : empty;
	} catch {
		return empty;
	}
}

/**
 * Which rules run: on in config, and every capability they `need` is met.
 *
 * One computation for normalization and for a registry attached afterwards, so
 * the two cannot disagree about what a registry enables.
 */
function enabledRules(config: Omit<Config, 'enabled'>): Record<RuleId, boolean> {
	const ds = config.designSystem;
	// A composite is built from every name imported out of `designSystem.packages`,
	// whether or not it is a layout or text primitive, so the compositional rules
	// need the packages and nothing else — a headless library has no layout or text
	// layer at all.
	const hasPackages = ds.packages.length > 0;
	const hasComponents = hasPackages && ds.layoutComponents.length + ds.textComponents.length > 0;
	const capability: Record<Capability, boolean> = {
		packages: hasPackages,
		components: hasComponents,
		layoutComponents: hasComponents && ds.layoutComponents.length > 0,
		textComponents: hasComponents && ds.textComponents.length > 0,
		elementMap: ds.elementMap.size > 0,
		tokenPrefixes: ds.tokenPrefixes.length > 0,
		patternRegistry: hasPackages && config.patterns.length > 0,
		componentRegistry: config.componentRegistry.size > 0,
		projectNamespace: (config.raw.namespaces.project ?? []).length > 0,
	};
	return Object.fromEntries(
		RULE_IDS.map((id) => [
			id,
			RULES[id].needs.every((n: Capability) => capability[n]) && config.rules[id].severity !== 'off',
		]),
	) as Record<RuleId, boolean>;
}

/**
 * Attach a pattern registry after the fact, keeping `enabled` in step —
 * assigning `config.patterns` alone leaves the rules that read it off, which
 * looks exactly like "no composite drift found".
 */
export function setPatterns(config: Config, patterns: Pattern[] | null | undefined): Config {
	config.patterns = patterns ?? [];
	config.enabled = enabledRules(config);
	return config;
}

/** Same after-the-fact attachment as {@link setPatterns}, for the component registry. */
export function setComponentRegistry(
	config: Config,
	componentRegistry: Map<string, ComponentEntry> | null | undefined,
): Config {
	config.componentRegistry = componentRegistry ?? new Map();
	config.enabled = enabledRules(config);
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
	let chain: Chain;
	let source: ConfigSource;
	if (configPath) {
		chain = await loadChain(resolve(configPath));
		source = { kind: 'file', path: resolve(configPath) };
	} else if (preset) {
		if (!hasPreset(preset)) throw new Error(`unknown preset: ${preset}`);
		chain = await loadChain(presetPath(preset));
		source = { kind: 'preset', name: preset };
	} else {
		const found = findConfig(root);
		if (found) {
			chain = await loadChain(found);
			source = { kind: 'file', path: found };
		} else if (inline) {
			chain = await expandExtends(inline, root, inferred ? 'inferred config' : 'inline config');
			source = { kind: inferred ? 'inferred' : 'inline' };
		} else {
			chain = await loadChain(presetPath('generic'));
			source = { kind: 'preset', name: 'generic' };
		}
	}
	const normalized = normalize(chain.raw, { root, ruleFrom: chain.ruleFrom });
	normalized.source = source;
	normalized.inferred = source.kind === 'inferred';
	return normalized;
}
