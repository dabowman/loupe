/**
 * The shapes every module agrees on.
 *
 * These live in one file rather than beside their producers because most of
 * them are contracts *between* modules — a `Finding` is built in `analyze.ts`,
 * grouped in `report.ts`, keyed in `baseline.ts` and rewritten in `autofix.ts`.
 * A shape that four modules read is not owned by any of them.
 *
 * The rule ids and capability names are written out as unions rather than
 * derived from `RULES`, so a typo in a rule id is an error at the place it was
 * typed rather than a silently-absent lookup somewhere downstream.
 */

import type { Rule as PostcssRule } from 'postcss';

// ── rules ───────────────────────────────────────────────────────────────────

export type RuleId =
	| 'suppression/malformed'
	| 'stylesheet/unparsed'
	| 'css/dead-class'
	| 'system/locked-component'
	| 'system/superseded-component'
	| 'patterns/duplicate-composite'
	| 'patterns/unregistered-composite'
	| 'tokens/unknown-token'
	| 'tokens/hardcoded-value'
	| 'layout/margin-on-child'
	| 'layout/negative-margin'
	| 'layout/in-css'
	| 'typography/untokenized'
	| 'system/override'
	| 'system/inline-style'
	| 'system/raw-element'
	| 'typography/in-css';

export type Severity = 'error' | 'warn' | 'off';

/**
 * What a rule needs from the design-system model before it can say anything
 * true. A rule whose needs the active config cannot meet disables itself.
 */
export type Capability =
	| 'components'
	| 'layoutComponents'
	| 'textComponents'
	| 'elementMap'
	| 'tokenPrefixes'
	| 'patternRegistry'
	| 'componentRegistry'
	| 'projectNamespace';

export interface RuleDef {
	severity: Severity;
	rank: number;
	needs: readonly Capability[];
	title: string;
}

// ── findings ────────────────────────────────────────────────────────────────

/** A property/value pair whose literal could be a token. Feeds the token pass. */
export interface Hint {
	prop: string;
	value: string;
}

/** A resolved substitution: the token(s) that carry this exact value on-role. */
export interface Suggestion extends Hint {
	tokens: string[];
}

/**
 * One reported violation.
 *
 * `hints` and `suffix` are working state: the token pass reads them to rewrite
 * `message`, then deletes both. They are optional so that deletion is legal,
 * and absent from anything a formatter sees.
 */
export interface Finding {
	rule: RuleId;
	severity: Severity;
	file: string;
	line: number;
	message: string;
	/** Stable identity for baselining — survives a value tweak. Defaults to `message`. */
	code?: string | undefined;
	rank: number;
	hints?: Hint[] | undefined;
	suffix?: string | undefined;
	suggest?: Suggestion[] | undefined;
}

/**
 * What the shared classifier decides about one declaration, before anything
 * knows which file or channel it came from.
 */
export interface ClassifiedFinding {
	rule: RuleId;
	message: string;
	code?: string | undefined;
	hint?: Hint | undefined;
}

/**
 * A finding mid-construction, once it has a line but before it has a severity
 * or a rank. The three channel walks complete these into `Finding`s.
 */
export interface PendingFinding extends ClassifiedFinding {
	line: number;
	hints?: Hint[] | undefined;
	suffix?: string | undefined;
	scopeLines?: number[] | undefined;
}

export interface ParseError {
	file: string;
	message: string;
}

export interface Diagnostics {
	parseErrors: ParseError[];
	filesScanned: number;
}

export interface Directive {
	file: string;
	line: number;
	rules: string[];
	reason: string;
}

/** A suppression comment that names no rule, or gives no reason. */
export interface MalformedDirective {
	rule: 'suppression/malformed';
	file: string;
	line: number;
	message: string;
}

export interface Suppressions {
	byLine: Map<number, Set<string>>;
	directives: Directive[];
	malformed: MalformedDirective[];
}

export interface AnalyzeResult {
	findings: Finding[];
	directives: Directive[];
	diagnostics: Diagnostics;
	blocking: boolean;
}

// ── CSS ─────────────────────────────────────────────────────────────────────

/** A CSS declaration, from whichever of the three channels produced it. */
export interface Decl {
	prop: string;
	value: string;
	line?: number | null;
}

export type MarginKind = 'spacing' | 'negative' | null;

export interface ClassifyContext {
	boundSystem?: readonly Binding[];
	boundText?: readonly Binding[];
	isGrid?: boolean;
	options?: HardcodedOptions;
}

export interface HardcodedOptions {
	allowZero?: boolean;
}

export type { PostcssRule };

// ── tokens ──────────────────────────────────────────────────────────────────

export interface TokenSet {
	known: Set<string>;
	/** normalized value -> token names carrying it */
	byValue: Map<string, string[]>;
	sources: number;
}

// ── markup ──────────────────────────────────────────────────────────────────

/** A class name tied to the component that carries it. The correlation key. */
export interface Binding {
	cls?: string;
	tag: string | null;
	isSystem: boolean;
	isText?: boolean;
	isLayout?: boolean;
	file?: string;
	line?: number;
}

export interface RawElement {
	tag: string;
	classes: string[];
	file: string;
	line: number;
	suggest: string;
	styledOnly: boolean;
	inlineStyled: boolean;
	inlineLayout: boolean;
}

export interface InlineStyleElement {
	tag: string;
	isSystem: boolean;
	isText: boolean;
	isLayout: boolean;
	decls: Decl[];
	dynamic: number;
	file: string;
	line: number;
}

export interface ComponentImport {
	canonical: string;
	package: string;
	line: number;
	/** Attached by the analyzer once it knows which file the scan came from. */
	file?: string;
}

/** A `package::name` registry entry: is this import still the right choice? */
export interface ComponentEntry {
	name: string;
	package: string;
	status: 'recommended' | 'legacy' | 'locked' | 'experimental';
	supersededBy?: string;
	note?: string;
}

// ── css-in-js ───────────────────────────────────────────────────────────────

export interface TemplateGroup {
	selector: string | null;
	decls: Decl[];
	isGrid: boolean;
	/** Do these declarations style the tagged component itself, or a descendant? */
	onTarget: boolean;
	line: number;
}

export interface CssInJsTemplate {
	file: string;
	line: number;
	target: string | null;
	isSystem: boolean;
	isText: boolean;
	isLayout: boolean;
	groups: TemplateGroup[];
	error: string | null;
}

export interface CssInJsLocals {
	styled: Set<string>;
	bare: Set<string>;
	any: boolean;
}

// ── patterns ────────────────────────────────────────────────────────────────

/** A design-system component tree with everything else dropped. */
export interface PatternNode {
	name: string;
	pkg: string | null;
	children: PatternNode[];
	line?: number;
}

export interface Pattern {
	id: string;
	summary: string;
	canonical: string | null;
	node: PatternNode;
	size: number;
}

export interface Composite {
	file: string;
	line: number;
	signature: string;
	tree: PatternNode;
	size: number;
	depth: number;
	/** Set when the composite matched a registered pattern. */
	pattern?: Pattern;
}

export interface ScanResult {
	bindings: Binding[];
	rawEls: RawElement[];
	inlineStyles: InlineStyleElement[];
	cssInJs: CssInJsTemplate[];
	composites: Composite[];
	imports: Set<string>;
	referenced: Set<string>;
	stems: Set<string>;
	componentImports: ComponentImport[];
	parseError: string | null;
}

// ── config ──────────────────────────────────────────────────────────────────

export interface SourceGlobs {
	styles: string[];
	markup: string[];
	references: string[];
	ignore: string[];
}

export type SourceKind = 'styles' | 'markup' | 'references';

export interface SuppressionConfig {
	keyword: string;
	blanket: string[];
}

export interface HookConfig {
	maxAttempts: number;
	maxFindings: number;
	timeoutMs: number;
}

/** An element→component mapping, resolved: `styledOnly` has been defaulted. */
export interface ElementMapping {
	component: string;
	/** Only suggest the analog when the element is actually being styled. */
	styledOnly: boolean;
}

/** The same mapping as authored, where `styledOnly` may simply be absent. */
export interface AuthoredElementMapping {
	component: string;
	styledOnly?: boolean;
}

/**
 * A config once `DEFAULTS` has been merged under it.
 *
 * This is the boundary between "what someone wrote" and "what the engine
 * reads": a config file is a `Partial<MergedConfig>`, and everything downstream
 * of `normalize` gets fields that are all present. Keeping the two apart is
 * what stops a defaulted-but-absent field reading as a deliberate empty one.
 */
export interface MergedConfig {
	designSystem: {
		name: string;
		packages: string[];
		tokenPrefixes: string[];
		tokenSources: string[];
		cssInJsPackages: string[];
		normalizeExports: string;
		components: { layout: string[]; text: string[] };
		elementMap: Record<string, string | AuthoredElementMapping>;
	};
	namespaces: { project: string[]; external: string[]; neverDead: string[] };
	sources: SourceGlobs;
	suppression: SuppressionConfig;
	rules: Record<string, Severity | [Severity, HardcodedOptions]>;
	patterns: string | unknown[] | null;
	componentRegistry: string | unknown[] | null;
	baseline: string;
	hook: HookConfig;
	extends?: string | string[];
}

/**
 * A config as written — a project's file, a shipped preset, or what detection
 * infers. Partial all the way down, because a preset that sets only
 * `designSystem.tokenSources` is a normal preset, not a broken one.
 */
export interface AuthoredConfig {
	extends?: string | string[];
	designSystem?: Partial<MergedConfig['designSystem']>;
	namespaces?: Partial<MergedConfig['namespaces']>;
	sources?: Partial<SourceGlobs>;
	suppression?: Partial<SuppressionConfig>;
	rules?: Record<string, Severity | [Severity, HardcodedOptions]>;
	patterns?: string | unknown[] | null;
	componentRegistry?: string | unknown[] | null;
	baseline?: string;
	hook?: Partial<HookConfig>;
}

/** The design system, resolved: names expanded, predicates precompiled. */
export interface DesignSystem {
	name: string;
	packages: string[];
	tokenPrefixes: string[];
	tokenSources: string[];
	cssInJsPackages: string[];
	normalizeExports: RegExp | null;
	layoutComponents: string[];
	textComponents: string[];
	knownComponents: Set<string>;
	elementMap: Map<string, ElementMapping>;
}

export interface RuleSetting {
	severity: Severity;
	options: HardcodedOptions;
}

/** One design system, as a directory: what it is, and what describes it. */
export interface Profile {
	id: string;
	name: string;
	preset: string | null;
	packages: string[];
	skills: string[];
	patterns: string | null;
	components: string | null;
	dir: string;
}

/** A registry that was read but did not apply to this project. */
export interface SkippedRegistry {
	label: string;
	kind: 'patterns' | 'components';
	packages: string[];
}

/**
 * Something worth saying about a registry `--profile` forced past the scope gate.
 *
 * Two states earn a note and neither shows up anywhere else. A registry that
 * merged and changed nothing is exactly as invisible as one that was skipped —
 * the thing skip reporting exists to prevent, reached by the other road. And a
 * registry merged onto a config naming a different design system still matches:
 * composite signatures are bare component names, so `Stack(Text,Button)` fits
 * every design system that ships those names, and the finding names an import
 * the project has never heard of. Forcing that is allowed — it is what the flag
 * asks for — but it may not be silent.
 */
export interface RegistryNote {
	label: string;
	kind: 'patterns' | 'components';
	/** The whole verdict, as the predicate after `<label> <kind> registry`. */
	note: string;
}

/** Which profiles were on offer, which applied, and what they contributed. */
export interface ProfileState {
	available: Profile[];
	active: Profile[];
	applied: string[];
	skipped: SkippedRegistry[];
	notes: RegistryNote[];
	errors: string[];
}

export type ConfigSource =
	| { kind: 'file'; path: string }
	| { kind: 'preset'; name: string }
	| { kind: 'inline' }
	| { kind: 'inferred' };

/** A normalized config: what every consumer downstream of `normalize` sees. */
export interface Config {
	root: string;
	raw: MergedConfig;
	designSystem: DesignSystem;
	patterns: Pattern[];
	componentRegistry: Map<string, ComponentEntry>;
	sources: SourceGlobs;
	suppression: SuppressionConfig;
	baselinePath: string;
	hook: HookConfig;
	rules: Record<RuleId, RuleSetting>;
	enabled: Record<RuleId, boolean>;
	severityOf: (id: RuleId) => Severity;
	optionsOf: (id: RuleId) => HardcodedOptions;
	isProject: (cls: string) => boolean;
	isExternal: (cls: string) => boolean;
	isNeverDead: (cls: string) => boolean;
	/** Where this config came from. `normalize` defaults it; `loadConfig` sets it. */
	source: ConfigSource;
	/** True when nobody wrote this config down — the CLI holds it to a lower bar. */
	inferred: boolean;
	/** Attached by the CLI once profile registries have been merged in. */
	profiles?: ProfileState;
}

// ── discovery ───────────────────────────────────────────────────────────────

export interface DiscoveredFile {
	abs: string;
	rel: string;
}

export type Discovered = Record<SourceKind, DiscoveredFile[]>;

// ── state ───────────────────────────────────────────────────────────────────

export type StateScope = 'plugin-data' | 'project' | 'none';

/** A baseline as written to disk. */
export interface BaselineFile {
	version: number;
	createdAt: string;
	count: number;
	entries: string[];
}

/** A baseline once read, with its entries indexed for lookup. */
export interface Baseline extends BaselineFile {
	set: Set<string>;
}

/** An analysis with the accepted backlog subtracted. */
export interface BaselinedResult extends AnalyzeResult {
	baselined: number;
	/** Only meaningful on a whole-repo run — scoped runs suppress it. */
	fixed: number;
}

// ── autofix ─────────────────────────────────────────────────────────────────

/**
 * What a fix is decided from.
 *
 * Deliberately narrower than `Finding`: the substitution reads four fields and
 * nothing else, and asking for a whole finding would mean a caller with a
 * candidate in hand had to invent a severity and a rank to be allowed to ask.
 */
export type FixCandidate = Pick<Finding, 'rule' | 'file' | 'line' | 'suggest'>;

/** One unambiguous substitution: this property, this value, this token. */
export interface TokenFix {
	file: string;
	line: number;
	prop: string;
	value: string;
	token: string;
}

export interface SkippedFix extends TokenFix {
	why: string;
}
