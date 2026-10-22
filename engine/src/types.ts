/**
 * The shapes every module agrees on.
 *
 * These live in one file rather than beside their producers because most of
 * them are contracts *between* modules — a `Finding` is built in `analyze.ts`,
 * grouped in `report.ts`, keyed in `baseline.ts` and rewritten in `autofix.ts`.
 *
 * Rule ids are the keys of `RULES`, so a typo in one is an error at the place it
 * was typed rather than a silently-absent lookup downstream.
 *
 * Design notes: docs/design/report.md#shared-shapes
 */

import type { Rule as PostcssRule } from 'postcss';
import type { RULES } from './rules.ts';
import type { TokenScopes } from './scopes.ts';

// ── rules ───────────────────────────────────────────────────────────────────

export type RuleId = keyof typeof RULES;

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
	/**
	 * Written only by `--judge`: a run without it reports nothing for the rule,
	 * which `status` and a `--rule` naming it both have to say.
	 */
	judgeOnly?: true;
}

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Where a value is written, in a channel whose source text is not CSS.
 *
 * `style={{ paddingBottom: 13 }}` is reported as `padding-bottom: 13px`, and
 * neither half of that is in the file: the key is camelCase and React is what
 * gives the number its unit. So the JSX channel hands `fix` the bytes instead
 * of a declaration to match. `col` is 0-based within the declaration's own
 * reported line, and `text` is the literal exactly as written there — checked
 * before the splice, so a file that has moved under the report refuses rather
 * than rewriting whatever now sits in that column.
 */
export interface ValueSpan {
	col: number;
	text: string;
}

/** A property/value pair whose literal could be a token. Feeds the token pass. */
export interface Hint {
	prop: string;
	value: string;
	/**
	 * The line this declaration is on, where that is not the finding's own.
	 * A collapsed finding reports at the first declaration's line and carries
	 * the rest, which sit further down the same CSS rule — and a substitution
	 * matched against the wrong line edits the wrong declaration.
	 */
	line?: number | undefined;
	/** Set by the channels whose source is not CSS, where a match cannot find it. */
	span?: ValueSpan | undefined;
}

/**
 * What `check --judge` settled about one declaration, or about a whole
 * one-declaration finding.
 *
 * `answer` is the model's pick — a replacement value, `keep`, a variant, a
 * `not_` option, a force value — and `confidence` its certainty, as data, so a
 * later reader takes them from here rather than parsing the prose. `spans` are
 * the parts of `message` the judgement wrote, which the report paints green.
 */
export interface Judged {
	answer: string;
	confidence: number;
	spans: string[];
}

/** One declaration and the token(s) that carry its exact value on-role. */
export interface Suggestion extends Hint {
	/**
	 * Empty where nothing matched. The entry is still here, one per flagged
	 * declaration, so a consumer can tell "no token for this" from "this
	 * declaration was never flagged" without reading it back out of `message`.
	 */
	tokens: string[];
	/**
	 * What `--judge` settled for this declaration, where `tokens` did not. A
	 * collapsed finding is several declarations with several answers, so this is
	 * where `fix --judge` reads them — the finding's own `judged` is the same
	 * answers rendered for a reader.
	 */
	judged?: Judged | undefined;
	/**
	 * Why the one token in `tokens` is not applied unattended: the profile scopes
	 * it to a kind of element this declaration is not shown to style, or is shown
	 * not to. An off-role candidate is a question, the way two on-role ones are,
	 * so `fix` leaves it and the report says what to check.
	 */
	review?: string | undefined;
}

/**
 * A misspelled token name and the one known token it is a near miss for.
 *
 * A name, not a declaration: `tokens/unknown-token` reports once per file and
 * name however many times the file writes it, so the fix it licenses is every
 * one of `lines` — fixing the line it was reported at would leave the rest, and
 * the next run would report the same name again.
 */
export interface TokenRename {
	from: string;
	to: string;
	/** Every line of this file that references the name, first-seen order. */
	lines: number[];
}

/**
 * The whole extent of a rule that declares nothing but a dead class, in lines.
 *
 * Carried only where the rule can be removed on its own — and read only by the
 * language server, because deleting is not substituting and `loupe fix` does
 * not do it. See docs/design/report.md#deleting-is-the-editors-alone.
 */
export interface DeadRule {
	/** First line to remove: a comment attached above the rule, where there is one. */
	startLine: number;
	/** The line the rule's closing brace is on. */
	endLine: number;
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
	 * A composite rebuilt in six files is one defect reported six times, and only a
	 * shared key puts those six back together. Not `code`, which holds the same
	 * value today but is the *baselining* identity: tying the cluster to it would
	 * let a change in what survives a value tweak silently regroup the report.
	 */
	group?: string | undefined;
	/**
	 * Registry prose about this component or shape — why it is flagged, in the
	 * registry's own words rather than the source's.
	 *
	 * Its own field because `message` carries a display cap: a note concatenated
	 * into it spends that cap on prose and loses its own actionable end. The agent
	 * format composes the two and bounds the result; JSON and SARIF ship this whole.
	 */
	note?: string | undefined;
	/**
	 * What `check --judge` wrote into this finding, as a whole. Where the
	 * finding is several declarations, `answer` is their answers joined and
	 * `confidence` the least certain of them; the per-declaration answers a fix
	 * acts on are on `suggest`.
	 */
	judged?: Judged | undefined;
	/**
	 * The selector of the CSS rule this finding sits in, as authored.
	 *
	 * Every other consumer anchors on `file`/`line`. A browser has no lines — but a
	 * stylesheet finding's selector *is* a DOM query, which is what lets a reader
	 * outside the source say which rendered elements the declaration lands on.
	 *
	 * The whole resolved selector list, not the key selector: `.card .title` and
	 * `.title` match different elements. Absent on JSX, inline-style and CSS-in-JS
	 * findings, which have no selector to carry.
	 */
	selector?: string | undefined;
	/**
	 * The `@media` condition the finding's rule sits under, if any.
	 *
	 * `selector` says which elements a rule reaches; this says when, so a reader in
	 * a browser can ask `matchMedia` and tell "these three elements are wrong" from
	 * "would be wrong at a width you are not at". Absent on an unconditional rule.
	 */
	media?: string | undefined;
	rank: number;
	hints?: Hint[] | undefined;
	suffix?: string | undefined;
	/**
	 * Working state, like `hints`: what the markup and the selector say this
	 * finding's declarations land on — `button`, `Modal` — for the token pass to
	 * hold a suggestion against its declared scope. Dropped there.
	 */
	elements?: string[] | undefined;
	suggest?: Suggestion[] | undefined;
	/**
	 * The declaration `tokens/hardcoded-value` flagged, as written — what a
	 * judgement acts on, without reading it back out of `message`. Set only
	 * where the finding is one declaration, which is the only shape
	 * `judgeValues` writes an answer for.
	 */
	decl?: Hint | undefined;
	/**
	 * The rewrite `tokens/unknown-token` licenses, where exactly one known token
	 * is a near miss for the name, or where `--judge` picked one. Absent
	 * otherwise — then the finding stands for a reader.
	 */
	rename?: TokenRename | undefined;
	/**
	 * Where a `tokens/unknown-token` name with no settled rename is written: the
	 * property of its first reference, and every line of the file naming it.
	 * What `--judge` needs to ask which token was meant, and to rename it.
	 */
	unknown?: { prop: string; lines: number[] } | undefined;
	/**
	 * The rule a `css/dead-class` finding names, where deleting it is safe.
	 * Absent where it is not — then no deletion is offered at all.
	 */
	dead?: DeadRule | undefined;
}

/**
 * What the shared classifier decides about one declaration, before anything
 * knows which file or channel it came from.
 */
export interface ClassifiedFinding {
	rule: RuleId;
	message: string;
	code?: string | undefined;
	hints?: Hint[] | undefined;
}

/**
 * A finding mid-construction, once it has a line but before it has a severity
 * or a rank. The three channel walks complete these into `Finding`s.
 */
export interface PendingFinding extends ClassifiedFinding {
	line: number;
	suffix?: string | undefined;
	scopeLines?: number[] | undefined;
	selector?: string | undefined;
	media?: string | undefined;
	elements?: string[] | undefined;
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
	 * `tokens/unknown-token` fires only when the set is non-empty, so a
	 * `tokenSources` path that stops resolving turns the rule off and reports
	 * `clean`. Carrying the count is what lets the report say so.
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
	/**
	 * The rule ids it names that muted nothing on this run: dead weight, or a
	 * typo. Set only by a run that applied suppressions to the directive's file,
	 * and absent when every id it names is live.
	 */
	stale?: string[];
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
	/** The directives covering each line of `byLine`, for crediting a mute to the one that did it. */
	owners: Map<number, Directive[]>;
	directives: Directive[];
	malformed: MalformedDirective[];
}

export interface AnalyzeResult {
	findings: Finding[];
	directives: Directive[];
	diagnostics: Diagnostics;
	blocking: boolean;
	/**
	 * Controls a `judge` detector named, in files the report covers and not
	 * suppressed for `patterns/judged-redirect`. Nothing here is a finding until
	 * `check --judge` asks about it.
	 */
	controls?: Control[];
	/**
	 * The token set the run read, which `--judge` chooses from. Absent when the
	 * design system's own sources yielded nothing (`diagnostics.tokensKnown` is
	 * 0), whatever the project defines under the same prefix.
	 */
	tokens?: TokenSet;
}

// ── CSS ─────────────────────────────────────────────────────────────────────

/** A CSS declaration, from whichever of the three channels produced it. */
export interface Decl {
	prop: string;
	value: string;
	line?: number | null;
	/** The JSX channel's pointer back at the bytes this declaration was translated from. */
	span?: ValueSpan | undefined;
}

export type MarginKind = 'spacing' | 'negative' | null;

export interface ClassifyContext {
	boundSystem?: readonly Binding[];
	boundText?: readonly Binding[];
	isGrid?: boolean;
	/**
	 * The styling surface the registry records for a bound component, if any.
	 * `undefined` is "nobody recorded one", which is not "it owns nothing".
	 */
	surfaceOf?: (binding: Binding) => StylingSurface | undefined;
	/**
	 * Whether the registry a bound component comes from records styling
	 * surfaces at all. Where it does not, a missing surface says nothing about
	 * this component in particular, and `system/override` reads it the way it
	 * did before surfaces existed — see `surfacesRecorded`.
	 */
	surfaced?: (binding: Binding) => boolean;
	/**
	 * Whether a rule is live in this run. Two branches of the classifier
	 * *supersede* the ordinary verdict rather than adding to it, so a
	 * superseding rule that is off has to step aside and let the ordinary one
	 * through — otherwise turning it off deletes the other finding too.
	 */
	enabled: (rule: RuleId) => boolean;
}

export type { PostcssRule };

// ── tokens ──────────────────────────────────────────────────────────────────

export interface TokenSet {
	known: Set<string>;
	/** normalized value -> token names carrying it */
	byValue: Map<string, string[]>;
	sources: number;
	/**
	 * What each configured `tokenSources` path yielded, in the order configured.
	 * Present on a set `readTokenSources` returned, and only there.
	 */
	read?: TokenSourceRead[] | undefined;
	/**
	 * What the active profiles declare each token is for. Absent: the generic
	 * property→token table decides everything, as it did before profiles could
	 * say.
	 */
	scopes?: TokenScopes | undefined;
}

/** One `designSystem.tokenSources` path, and what reading it yielded. */
export interface TokenSourceRead {
	/** As configured, relative to the root. */
	path: string;
	/** The stylesheets found under it. 0: not installed, or no stylesheet there. */
	files: number;
	/** The token names first defined here. The set keeps a token's first definition. */
	definitions: number;
}

// ── markup ──────────────────────────────────────────────────────────────────

/** A class name tied to the component that carries it. The correlation key. */
export interface Binding {
	cls?: string;
	tag: string | null;
	isSystem: boolean;
	isText?: boolean;
	/**
	 * The canonical name and the package it was imported from, which together
	 * key the component registry. Absent where the channel cannot say.
	 */
	component?: string;
	package?: string;
	file?: string;
	line?: number;
}

export interface RawElement {
	tag: string;
	classes: string[];
	file: string;
	line: number;
	suggest: string;
	/** The element `suggest` should render as, from the mapping's `render`. */
	render?: string | undefined;
	styledOnly: boolean;
	inlineStyled: boolean;
	inlineLayout: boolean;
}

export interface InlineStyleElement {
	tag: string;
	/** The canonical name of a design-system component, however the file imported it. */
	component: string | null;
	/**
	 * What a profile's token-scope kinds call this element: the tag, or the
	 * design-system component it is — `Button` under any alias, a namespace
	 * import's member, a compound part as itself (`Card.Header`). Null for a
	 * project component, whose own markup decides what it renders.
	 */
	element: string | null;
	isSystem: boolean;
	isText: boolean;
	decls: Decl[];
	dynamic: number;
	/**
	 * The CSS property of each dynamic entry whose key is static
	 * (`color: isError ? a : b`). An entry with no knowable key — a spread,
	 * `style={obj}` — has none, which is how the two are told apart.
	 */
	dynamicProps: string[];
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
	 * Currency findings anchor at the import, one per file and component, so the
	 * count is what says how much work the migration is. Tallied by the JSX walk,
	 * which already visits every opening element.
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
	/**
	 * Set only where moving the import to the package `supersededBy` names
	 * changes the specifier and nothing else: same exported name, every prop the
	 * old component takes accepted with the same meaning, no prop the old one did
	 * not require, same default element and same rendering — established by
	 * reading both implementations, never inferred from the names matching.
	 *
	 * There is no `false`. Absent means "nobody established it", which is also
	 * what a verified no leaves behind, because a fix must not fire on a guess
	 * that happens to be recorded. No WPDS entry carries it.
	 *
	 * Design notes: docs/design/checks.md#a-same-name-move-is-not-a-drop-in-move
	 */
	dropIn?: true;
	note?: string;
	/** Variant name → what it is for. Read only by `check --judge`. */
	variants?: Record<string, string>;
	/**
	 * What the component styles itself, on the element its `className` lands
	 * on, and what controls each. Read by `system/override` and
	 * `typography/in-css`. Absent means nobody has recorded it, and those rules
	 * fail safe — see `StylingSurface`.
	 */
	surface?: StylingSurface;
	/**
	 * Set by the loader, never authored: the registry this entry was read from
	 * records a surface on at least one entry. It is what tells "this entry was
	 * not read for a surface" (a gap, advisory) from "this registry records no
	 * surfaces" (the pre-surface reading, blocking).
	 */
	surfaced?: true;
}

/**
 * A component's styling surface: the CSS properties it owns on the element its
 * `className` reaches, each mapped to the prop (or props) that controls it, or
 * to `null` where the component sets it and exposes no prop for it.
 *
 * A property not listed is one the component has no opinion about, so a class
 * setting it is the sanctioned styling channel rather than an override.
 * `properties: {}` is a verified answer — it owns nothing there — which is not
 * the same as the field being absent. A shorthand and its longhands overlap:
 * owning `border` owns `border-color`, and `font` reaches `font-size`.
 *
 * Design notes: docs/design/checks.md#systemoverride
 */
export interface StylingSurface {
	properties: Record<string, string | string[] | null>;
	/** Package, version and date the surface was read from — never inferred. */
	verifiedAgainst?: string;
	note?: string;
}

// ── css-in-js ───────────────────────────────────────────────────────────────

export interface TemplateGroup {
	selector: string | null;
	decls: Decl[];
	isGrid: boolean;
	/** Do these declarations style the tagged component itself, or a descendant? */
	onTarget: boolean;
}

export interface CssInJsTemplate {
	file: string;
	line: number;
	target: string | null;
	isSystem: boolean;
	isText: boolean;
	/** Registry key parts for a design-system target, as on a `Binding`. */
	component?: string;
	package?: string;
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
	/**
	 * A registry node written `>Name`: it must be a direct child of the node
	 * above it, not anywhere beneath. Only pattern nodes carry it.
	 */
	direct?: boolean;
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

/** An element a `judge` detector named: one control to ask about. */
export interface Control {
	file: string;
	line: number;
	/** The name the registry uses, alias resolved: `Button`, `Menu.Item`. */
	component: string;
	/** The component function the control sits in, when the parse found a name. */
	enclosing: string | null;
	/** The JSX element, opening tag to close. */
	source: string;
	/** The registry entry whose detector named it. */
	patternId: string;
}

/**
 * An element carrying classes, for a token scope to know what a rule lands on:
 * every class it carries, and what it is — the design-system component or the
 * mapped raw tag the rest of the index records. Null where the index records
 * nothing for it (a project component, a tag the element map does not name),
 * so a class it shares with a recorded element cannot be taken to style only
 * that one.
 */
export interface ClassCarrier {
	element: string | null;
	classes: string[];
}

export interface ScanResult {
	controls: Control[];
	bindings: Binding[];
	rawEls: RawElement[];
	carriers: ClassCarrier[];
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
	/** The deadline for the hook's whole judge phase, every stage and request in it. */
	timeoutMs: number;
}

/** An element→component mapping, resolved: `styledOnly` has been defaulted. */
export interface ElementMapping {
	component: string;
	/** Only suggest the analog when the element is actually being styled. */
	styledOnly: boolean;
	/** An attribute whose static value picks the analog: `input` by `type`. */
	attribute?: string;
	/** That attribute's value → its analog; `null` means the element has none. */
	values?: Record<string, string | null>;
	/**
	 * The element the analog renders as, through its `render` prop: a heading
	 * keeps its semantics as `<Text render={ <h4 /> }>`. Applies to `component`
	 * only, never to an analog `values` picked.
	 */
	render?: string;
}

/** The same mapping as authored, where `styledOnly` may simply be absent. */
export interface AuthoredElementMapping {
	component: string;
	styledOnly?: boolean;
	attribute?: string;
	values?: Record<string, string | null>;
	render?: string;
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
		/**
		 * Recognition lists: every spelling of a layout or text component the
		 * rules must match, superseded ones included, so a check reads code that
		 * still writes the old name. **Canonical first** — guidance names the
		 * first entry, so a legacy name there is a recommendation to write it.
		 */
		components: { layout: string[]; text: string[] };
		elementMap: Record<string, string | AuthoredElementMapping>;
		substitutionProps: string[];
		/**
		 * The inline-style declarations a component's own API sanctions, by
		 * component and CSS property: WPDS `Text` has no color prop, so its docs
		 * set color through `style`. Only a `style` made entirely of these is not
		 * `system/inline-style`; its declarations still go through the ordinary
		 * checks, so a raw colour there is still a hardcoded value.
		 */
		allowedInlineStyles: Record<string, string[]>;
	};
	namespaces: { project: string[]; external: string[]; neverDead: string[] };
	sources: SourceGlobs;
	suppression: SuppressionConfig;
	rules: Record<string, AuthoredRuleSetting>;
	patterns: string | unknown[] | null;
	componentRegistry: string | unknown[] | null;
	baseline: string;
	hook: HookConfig;
	/** How many entries analysis walks before it refuses. Absent for the default. */
	maxEntries?: number;
	/**
	 * The project's own profile directories. Anchored to the file that wrote them
	 * as `extends` is resolved, so by the time it is merged every entry is absolute.
	 */
	profiles?: string | string[];
	/** Pin profile selection to one id, or to `none`. */
	profile?: string;
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
	rules?: Record<string, AuthoredRuleSetting>;
	patterns?: string | unknown[] | null;
	componentRegistry?: string | unknown[] | null;
	baseline?: string;
	hook?: Partial<HookConfig>;
	maxEntries?: number;
	profiles?: string | string[];
	profile?: string;
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
	/** Canonical component → the CSS properties its `style` may carry. */
	allowedInlineStyles: Map<string, Set<string>>;
}

export interface RuleSetting {
	severity: Severity;
	/**
	 * Why the config set it, when it says. Turning a rule off in config is a
	 * suppression of the whole rule, everywhere, so it can carry a reason the way
	 * a directive does, and `loupe suppressions` lists it beside them.
	 */
	reason?: string;
}

/**
 * A rule setting as written: a bare severity, or the object form that can also
 * say why. The `[severity, options]` array form is gone, and fails with a
 * message naming the fix.
 */
export type AuthoredRuleSetting = Severity | { severity: Severity; reason?: string };

/**
 * A rule turned off in config, listed by `loupe suppressions` beside the inline
 * directives. Shaped like a {@link Directive} where the two overlap, so a
 * consumer reading `file`, `rules` and `reason` reads either; there is no line.
 */
export interface ConfigSuppression {
	scope: 'config';
	/** The config file that turned it off, relative to the root, or `preset <name>`. */
	file: string;
	rules: [RuleId];
	/** Null when the setting gives none. */
	reason: string | null;
}

/** One design system, as a directory: what it is, and what describes it. */
export interface Profile {
	id: string;
	name: string;
	preset: string | null;
	packages: string[];
	patterns: string | null;
	components: string | null;
	/** `{ token: description }`, the design system's own words for what each token is for. */
	tokenDescriptions: string | null;
	/**
	 * What each token is for, as the system's naming grammar says it — read and
	 * validated from `profile.json`. Null where the profile declares none, or
	 * declares it wrong: the engine then falls back to its generic table.
	 */
	tokenScopes: TokenScopes | null;
	/** What was wrong with the profile's own declarations, for the CLI to say. Empty when nothing was. */
	problems: string[];
	/** How the system's packages and tokens reach a page — read, validated, or null. */
	delivery: Delivery | null;
	dir: string;
	/**
	 * Where it was read from. A project's own profile outranks a shipped one on
	 * the same id or the same package, so selection has to know which is which.
	 */
	origin: ProfileOrigin;
}

/** `shipped` is anything handed over with `--profiles`; `project` is the project's own. */
export type ProfileOrigin = 'project' | 'shipped';

// ── delivery ────────────────────────────────────────────────────────────────

/**
 * How one package reaches the page.
 *
 * `external`: the host provides it at runtime (WordPress's `wp-components`
 * script), so importing it costs the build nothing. `bundled`: the build tool
 * compiles it into the project's own bundle, so the first import is a new
 * runtime dependency and a bigger bundle.
 */
export interface PackageDelivery {
	provided: 'external' | 'bundled';
	/** The host's handle for an external package, where it has one. */
	handle?: string | undefined;
	note?: string | undefined;
}

/**
 * One way a project can show the token stylesheet reaches its pages. The
 * profile states them; `tokens/undelivered` runs them. None parses a language:
 * each is a bounded, literal read of the files its `files` globs name.
 *
 *   enqueue-dependency   a call (`wp_enqueue_style(…)`) whose dependency
 *                        argument is a literal list naming one of `handles`,
 *                        or an `enqueues` call whose own handle is one of them.
 *                        The only kind that can say "not delivered": calls
 *                        found, every one read, none naming a handle.
 *   import               an `@import`, `import` or `require` of one of
 *                        `specifiers` — the sheet bundled into the project's own.
 *   pattern              any match of `pattern` — a build plugin that writes
 *                        fallbacks into every `var()`, say.
 */
export type DeliveryCheck =
	| {
			kind: 'enqueue-dependency';
			files: string[];
			calls: string[];
			handles: string[];
			/** Calls whose first argument naming a handle is itself the delivery. */
			enqueues: string[];
			/** 0-based position of the dependency list in the call. */
			argument: number;
			note?: string | undefined;
	  }
	| { kind: 'import'; files: string[]; specifiers: string[]; note?: string | undefined }
	| { kind: 'pattern'; files: string[]; pattern: RegExp; note?: string | undefined };

/** Where a design system's tokens come from, and what shows they arrived. */
export interface TokenDelivery {
	/** The stylesheet that defines them, as a reader would name it. */
	stylesheet: string;
	/** The host's handle for it, where there is one. */
	handle?: string | undefined;
	/** The token namespace this delivery covers. Empty: the design system's own. */
	prefixes: string[];
	note?: string | undefined;
	/** Any one of these, holding, is delivery. */
	evidence: DeliveryCheck[];
	/**
	 * Any one of these, holding, means the build writes fallback values into
	 * each `var()`: the declarations render, but at the default theme's values,
	 * not the site's. Not delivery — said on the finding instead.
	 */
	fallbacks: DeliveryCheck[];
}

/** A profile's delivery block, validated. */
export interface Delivery {
	/** What provides the externals: "WordPress". */
	host: string;
	packages: Map<string, PackageDelivery>;
	tokens: TokenDelivery | null;
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
 * Two states earn a note and neither shows up anywhere else: a registry that
 * merged and changed nothing is as invisible as one that was skipped, and one
 * merged onto a config naming a different design system still matches, because
 * composite signatures are bare component names. Forcing either is allowed —
 * it is what the flag asks for — but it may not be silent.
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
	/**
	 * The analysis walk's ceiling as the config sets it, validated. Absent when
	 * the config leaves it to the default; `LOUPE_MAX_ENTRIES` outranks it.
	 */
	maxEntries?: number;
	rules: Record<RuleId, RuleSetting>;
	/**
	 * Where each rule setting the config wrote came from: a path relative to the
	 * root, or `preset <name>`. A rule left at its default is absent.
	 */
	ruleFrom: Partial<Record<RuleId, string>>;
	enabled: Record<RuleId, boolean>;
	severityOf: (id: RuleId) => Severity;
	isProject: (cls: string) => boolean;
	isExternal: (cls: string) => boolean;
	isNeverDead: (cls: string) => boolean;
	/** Where this config came from. `normalize` defaults it; `loadConfig` sets it. */
	source: ConfigSource;
	/** True when nobody wrote this config down — the CLI holds it to a lower bar. */
	inferred: boolean;
	/** The project's own profile directories (`profiles`), absolute. Read ahead of `--profiles`. */
	profileDirs: string[];
	/** `profile`: the id selection is pinned to, `none`, or null for selection by package. */
	profilePin: string | null;
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

/** A baseline as written to disk. */
export interface BaselineFile {
	version: number;
	createdAt: string;
	/**
	 * Entries, not findings — kept under this name because 0.1.x files use it.
	 * Nothing here reads it; it is written for engines that predate `findings`.
	 * Remove it in 0.9.0, the minor after 0.8.0: the 0.1.x locations that were
	 * its only other reason to stay were dropped in 0.8.0 (#42).
	 */
	count: number;
	/**
	 * Findings recorded, which is >= `count` whenever several shared a key.
	 * Optional: files written before the two numbers were told apart lack it.
	 */
	findings?: number;
	entries: string[];
}

/** A baseline once read, with its entries indexed for lookup. */
export interface Baseline extends Pick<BaselineFile, 'createdAt' | 'entries'> {
	set: Set<string>;
}

/** An analysis with the accepted backlog subtracted. */
export interface BaselinedResult extends AnalyzeResult {
	/** Findings the baseline hid — `baselinedFindings.length`. */
	baselined: number;
	/** The findings the baseline hid, for the formats that list them as suppressed. */
	baselinedFindings: Finding[];
	/**
	 * Baseline *entries* nothing matched — work done since it was recorded. In
	 * entries, not findings, because entries are all a baseline stores. Null on a
	 * scoped run, where an absent entry is mostly just out of scope, and when no
	 * baseline was read.
	 */
	fixed: number | null;
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
 * changes meaning or disappears without a bump.
 *
 * 2 — `config.rules[id]` is `{ severity }`: `options` went with the
 * `[severity, {opts}]` rule form. A setting that says why it is set also
 * carries `reason`, which is additive.
 */
export interface ReportPayload {
	version: 2;
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
		/**
		 * Baseline *entries* nothing matched any more — the backlog burned down
		 * since it was recorded. Entries, not findings: several findings can
		 * collapse into one entry, and an entry with no finding left has nothing
		 * to count but itself. The same `-N fixed` `baseline --dry-run` prints.
		 * Absent on a scoped run, where a missing entry is mostly out of scope,
		 * and when no baseline file was read.
		 */
		fixed?: number;
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
export type FixCandidate = Pick<Finding, 'rule' | 'file' | 'line' | 'suggest' | 'decl' | 'judged' | 'rename'>;

/**
 * One substitution: this property, this value, rewritten `to` this.
 *
 * A rename carries no `prop`, because it is not a `prop: value` substitution —
 * `value` is the misspelled token name and `to` the name it becomes, replaced
 * inside every `var()` on the line that names it.
 */
export interface TokenFix {
	file: string;
	line: number;
	/** Absent on a token rename, which has no declaration around it. */
	prop?: string | undefined;
	value: string;
	/** `var(--token)`, one per part for a shorthand the judge settled, or a token name for a rename. */
	to: string;
	/** Where to splice, for a declaration whose source text is not the CSS reported. */
	span?: ValueSpan | undefined;
}

export interface SkippedFix extends TokenFix {
	why: string;
}

/** A value `fix --judge` suppressed rather than rewrote, and the reason it wrote down. */
export interface KeptValue {
	file: string;
	line: number;
	prop: string;
	value: string;
	reason: string;
}

export interface SkippedKeep extends KeptValue {
	why: string;
}
