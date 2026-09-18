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
	| 'patterns/superseded-composite'
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
	| 'packages'
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
 * `message` and drops `hints`, and `suffix` — the channel marker — survives
 * just long enough for the message to be bounded around it. They are optional
 * so that deletion is legal, and absent from anything a formatter sees.
 */
export interface Finding {
	rule: RuleId;
	severity: Severity;
	file: string;
	line: number;
	message: string;
	/** Stable identity for baselining — survives a value tweak. Defaults to `message`. */
	code?: string | undefined;
	/**
	 * Cluster key, for rules whose finding is one member of an N-way relation.
	 *
	 * The two pattern rules are the only findings that cannot exist in one file:
	 * a composite rebuilt in six files is one defect reported six times, and
	 * only a shared key puts those six back together. `code` happens to hold the
	 * same value today, but `code` is the *baselining* identity — tying the
	 * cluster to it means a future change to what survives a value tweak
	 * silently regroups the report. Say which one the grouping means.
	 */
	group?: string | undefined;
	/**
	 * Registry prose about this component or shape — why it is flagged, in the
	 * registry's own words rather than the source's.
	 *
	 * Its own field because `message` carries a display cap that is applied
	 * before any format is built. A note concatenated into it spent that cap on
	 * prose and then lost the end of it — the actionable half — mid-word, in
	 * `--format json` as much as in the report, where nothing could recover it.
	 * The agent format composes the two and bounds the result to its one line;
	 * JSON and SARIF ship this whole.
	 */
	note?: string | undefined;
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
	/**
	 * How many tokens the declared `tokenSources` actually yielded.
	 *
	 * `tokens/unknown-token` fires only when the set is non-empty, because a
	 * project that declares no sources must not have every token it writes
	 * called unknown. That fail-open is silent, so a `tokenSources` path that
	 * stops resolving — a dependency moving its stylesheet, which
	 * `@wordpress/theme` did — turns the rule off and reports `clean`. Carrying
	 * the count is what lets the report say so.
	 */
	tokensKnown: number;
}

export interface Directive {
	file: string;
	line: number;
	rules: string[];
	reason: string;
	/** The read alias it was written with, when that is not the active keyword. */
	alias?: string;
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
	/**
	 * Whether a rule is live in this run. Two branches of the classifier
	 * *supersede* the ordinary verdict rather than adding to it, so a
	 * superseding rule that is off has to step aside and let the ordinary one
	 * through — otherwise turning it off deletes the other finding too.
	 */
	enabled?: (rule: RuleId) => boolean;
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
	/** The specifier's own line — where a reader would write the suppression. */
	line: number;
	/**
	 * The `import {` line. Kept as a second anchor so directives written against
	 * the old, declaration-wide reporting keep muting what they were signed off
	 * for. It mutes every specifier in the declaration, which is why it is not
	 * where a new one should go.
	 */
	declLine: number;
	/**
	 * How many times the file renders it.
	 *
	 * Currency findings anchor at the import, one per file and component, so
	 * eight of them on one `import {` line read as eight duplicates and say
	 * nothing about how much work the migration is. The JSX walk already visits
	 * every opening element and already knows which are design-system ones, so
	 * the count is a tally kept alongside it rather than a second pass.
	 */
	uses: number;
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

/**
 * An AST rule a registry entry is checked by, with the parameters the registry
 * gives it. The engine ships the rule; the registry names the components it
 * runs against, so the engine itself names none.
 */
export interface RuleSpec {
	rule: string;
	[param: string]: unknown;
}

export interface Pattern {
	id: string;
	summary: string;
	canonical: string | null;
	/** Null for an entry checked by its canonical import or a rule alone, or documented only. */
	node: PatternNode | null;
	size: number;
	/**
	 * Shapes this pattern replaces, as trees rather than the prose of
	 * `instead_of`. Matching one is the finding: the file built the clunky
	 * version of a composite the system already has an answer for. Only
	 * substantial nodes survive the load, for the same reason signatures do.
	 */
	avoid: PatternNode[];
	rules: RuleSpec[];
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

/** A registry entry's AST rule, ready to run: which entry it reports as. */
export interface PatternRule {
	patternId: string;
	spec: RuleSpec;
}

/**
 * One place an AST rule matched. The composite matcher cannot see below its
 * four-node floor, and the wrong choice is usually one control: a select for
 * four options, a modal holding a consent pair. A hit is that finding.
 */
export interface RuleHit {
	patternId: string;
	rule: string;
	line: number;
	/** What was seen, in the words of the finding: `SelectControl with 4 static options`. */
	detail: string;
}

export interface ScanResult {
	bindings: Binding[];
	rawEls: RawElement[];
	inlineStyles: InlineStyleElement[];
	cssInJs: CssInJsTemplate[];
	composites: Composite[];
	ruleHits: RuleHit[];
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
	/**
	 * Keywords honored for *reading* alongside `keyword`, so switching preset
	 * renames the vocabulary without orphaning the directives already written in
	 * it. Seeded from every shipped preset's keyword; a config naming its own
	 * keyword can list the one it replaced here.
	 */
	aliases: string[];
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
		/**
		 * The design system's own stylesheets. Every class they define is a
		 * library internal, for a system whose classes carry no prefix that
		 * `namespaces.external` could match.
		 */
		styleSources: string[];
		cssInJsPackages: string[];
		normalizeExports: string;
		components: { layout: string[]; text: string[] };
		elementMap: Record<string, string | AuthoredElementMapping>;
		substitutionProps: string[];
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
	styleSources: string[];
	cssInJsPackages: string[];
	normalizeExports: RegExp | null;
	layoutComponents: string[];
	textComponents: string[];
	knownComponents: Set<string>;
	elementMap: Map<string, ElementMapping>;
	/** Props whose value names the element a component should render. */
	substitutionProps: Set<string>;
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

/**
 * What one walk turned up.
 *
 * `truncated` is the walk saying it stopped rather than finished. A caller that
 * handed `discover` a file ceiling gets back a prefix of the tree, not the
 * tree, and a conclusion drawn from a prefix must not be reported as though the
 * whole project had been read.
 */
export type Discovered = Record<SourceKind, DiscoveredFile[]> & { truncated: boolean };

// ── state ───────────────────────────────────────────────────────────────────

export type StateScope = 'plugin-data' | 'project' | 'none';

/** A baseline as written to disk. */
export interface BaselineFile {
	version: number;
	createdAt: string;
	/** Entries, not findings — kept under this name because 0.1.x files use it. */
	count: number;
	/**
	 * Findings recorded, which is >= `count` whenever several shared a key.
	 * Optional: files written before the two numbers were told apart lack it.
	 */
	findings?: number;
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

// ── report payload ──────────────────────────────────────────────────────────

/** One rule as a report presents it: placeholders resolved, report order baked in. */
export interface RuleDescriptor {
	id: RuleId;
	title: string;
	rank: number;
	severity: Severity;
}

/**
 * The machine-readable report — what `--format json` prints and `--format html`
 * embeds.
 *
 * Written down as a type rather than left implicit in the formatter, because it
 * is now a contract with two consumers instead of one, and the second reads it
 * back at runtime. `version` is additive-only: fields may be added, so a
 * consumer must ignore what it does not know, and nothing already emitted
 * changes meaning without a bump.
 */
export interface ReportPayload {
	version: 1;
	tool: 'loupe';
	blocking: boolean;
	summary: {
		total: number;
		error: number;
		warn: number;
		suppressions: number;
		parseErrors: number;
		/** Tokens the declared sources yielded; 0 means `tokens/unknown-token` is off. */
		tokensKnown: number;
		/**
		 * Files read. Without it, "no `stylesheet/unparsed` findings" and "no
		 * stylesheets were found" are the same report, and a consumer cannot tell
		 * a clean scan from one that scanned nothing.
		 */
		filesScanned: number;
		/**
		 * Findings per file, densest first. The report prints the top few as
		 * prose; a consumer that wants to know whether findings cluster or spread
		 * should not have to parse that back out of it.
		 */
		byFile: Record<string, number>;
		/**
		 * Findings hidden by the baseline. Absent under `--no-baseline`, where the
		 * question was never asked; 0 where it was asked and nothing was hidden —
		 * which is equally what a project with no baseline file reports, so 0 is
		 * not evidence that a baseline exists.
		 */
		baselined?: number;
	};
	rules: RuleDescriptor[];
	findings: (Omit<Finding, 'rank'> & { fix: string })[];
	suppressions: Directive[];
	parseErrors: ParseError[];
	config: { rules: Record<RuleId, RuleSetting>; enabled: Record<RuleId, boolean> };
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
