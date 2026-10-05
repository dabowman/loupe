/**
 * The analyzer.
 *
 * Correlates the markup that binds a class to a component with the CSS that
 * styles that class — the rules no single-language linter can run. The index is
 * ALWAYS built repo-wide; `scope` only filters what gets *reported*.
 *
 * The machinery lives here: build the index, walk the three channels a
 * declaration can arrive by, scope and suppress, then name tokens, dedupe and
 * bound. What each rule decides lives in `checks/`, one file per rule or per
 * family of rules sharing one pass; a new rule is a new file there and a call
 * here. The catalog — severity, rank, title — is `rules.ts`.
 *
 * Design notes: docs/design/analysis.md
 *
 *   per declaration, first to claim it decides (`DECLARATIONS`):
 *     checks/typography/in-css.ts       typography/in-css
 *     checks/system/override.ts         system/override, and its whole-rule form
 *     checks/layout/margin.ts           layout/margin-on-child, layout/negative-margin
 *     checks/typography/untokenized.ts  typography/untokenized
 *     checks/layout/in-css.ts           layout/in-css
 *     checks/tokens/hardcoded-value.ts  tokens/hardcoded-value
 *   per element or rule:
 *     checks/system/inline-style.ts     system/inline-style
 *     checks/system/raw-element.ts      system/raw-element
 *     checks/css/dead-class.ts          css/dead-class
 *   over the whole index:
 *     checks/patterns/composites.ts     patterns/duplicate-, superseded-, unregistered-composite
 *     checks/system/currency.ts         system/locked-component, system/superseded-component
 *     delivery.ts                       a reachability note on those and system/raw-element
 *     checks/tokens/unknown-token.ts    tokens/unknown-token
 *     checks/tokens/misapplied-token.ts tokens/misapplied-token
 *     checks/tokens/undelivered.ts      tokens/undelivered, from the profile's delivery block
 *   run by the scanner, per JSX element (`markup.ts`):
 *     checks/detectors/*.ts             the pattern registry's detectors
 *
 * `stylesheet/unparsed` and `suppression/malformed` are the machinery reporting
 * on itself, and stay here; `patterns/judged-redirect` is `judge.ts`.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { list } from 'postcss';
import type { Root } from 'postcss';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RULES } from './rules.ts';
import { annotateReach, mergeDeliveries, projectDependencies } from './delivery.ts';
import { TreeTooLarge, analyzeEntryBudget, byBytes, discover, toPosix } from './discover.ts';
import { MuteLedger, makeSuppressionParser } from './suppressions.ts';
import { scanMarkup, harvestTokens } from './markup.ts';
import { syntaxFor } from './syntax.ts';
import { surfaceFor, surfacesRecorded } from './components.ts';
import { boundMessage, oneLine, parseMessageOf, parseReasonOf, snippet } from './text.ts';
import {
	cssFilesUnder,
	declarationMessage,
	emptyTokenSet,
	harvestTokenDefs,
	planValue,
	readTokenSources,
	tokensFor,
	tokenRefsIn,
} from './tokens.ts';
import {
	APPEARANCE_PROPS,
	GAP_PROPS,
	TYPE_PROPS,
	classesIn,
	deletableRule,
	isFlexDecl,
	isGridDecl,
	isHardcodedTokenValue,
	isLayoutDecl,
	isMarginProp,
	keySelector,
	mediaQuery,
	ownDecls,
	resolvedSelectors,
	ruleIsGrid,
} from './styles.ts';
import { deadClasses } from './checks/css/dead-class.ts';
import type { DeclaredClass } from './checks/css/dead-class.ts';
import { layoutInCss } from './checks/layout/in-css.ts';
import { margin } from './checks/layout/margin.ts';
import { composites as compositeFindings } from './checks/patterns/composites.ts';
import { currency } from './checks/system/currency.ts';
import { inlineStyle } from './checks/system/inline-style.ts';
import { libraryOverride, systemOverride } from './checks/system/override.ts';
import { rawElements } from './checks/system/raw-element.ts';
import type { ClassDecl } from './checks/system/raw-element.ts';
import { hardcodedValue } from './checks/tokens/hardcoded-value.ts';
import { undelivered } from './checks/tokens/undelivered.ts';
import { unknownTokens as unknownTokenFindings } from './checks/tokens/unknown-token.ts';
import type { TokenRef } from './checks/tokens/unknown-token.ts';
import { misappliedTokens } from './checks/tokens/misapplied-token.ts';
import type { ScopedRef } from './checks/tokens/misapplied-token.ts';
import { fitOf, mergeScopes } from './scopes.ts';
import { typographyInCss } from './checks/typography/in-css.ts';
import { untokenizedType } from './checks/typography/untokenized.ts';
import type {
	AnalyzeResult,
	Binding,
	ClassCarrier,
	ClassifiedFinding,
	ClassifyContext,
	ComponentImport,
	Composite,
	Config,
	Control,
	CssInJsTemplate,
	Decl,
	Diagnostics,
	Directive,
	Finding,
	InlineStyleElement,
	ParseError,
	PatternRule,
	PendingFinding,
	RawElement,
	RuleHit,
	RuleId,
	StylingSurface,
	Suppressions,
	TokenSet,
} from './types.ts';

/** A path resolved through symlinks and case, or null when nothing is there. */
const realPath = (path: string): string | null => {
	try {
		return realpathSync.native(path);
	} catch {
		return null;
	}
};

/**
 * The part a library selector styles: the first class of its key compound.
 * Ancestors (`.dark .label`), state modifiers (`.tab.is-active`), pseudo-class
 * arguments and attribute values are context, not a part. An escaped name
 * (`.md\:flex`) is not cut short into a class that was never written.
 *
 * ponytail: a part whose class is not first in its compound (`.is-open.popover`)
 * is missed — a missed override, never a false one.
 */
const partClass = (sel: string): string | undefined =>
	keySelector(sel.replace(/\[[^\]]*\]|\([^)]*\)/g, '')).match(/\.(-?[_a-zA-Z][\w-]*)(?![\w\\-])/)?.[1];

/** The element a compound selector names, lowercased: `button.primary:hover` → `button`. */
const tagOf = (compound: string): string | null => /^[a-z][a-z0-9-]*/i.exec(compound)?.[0]?.toLowerCase() ?? null;

/**
 * The last compound of a selector — the element it styles. Cut only at a
 * combinator outside brackets, parentheses and quotes: `.x[aria-label="Close
 * dialog"]` is one compound, and so is `.x:has(> .y)`.
 */
function keyCompound(sel: string): string {
	let depth = 0;
	let quote = '';
	let start = 0;
	const s = sel.trim();
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === '\\') i++;
		else if (quote) {
			if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (!depth && (ch === ' ' || ch === '\n' || ch === '\t' || ch === '>' || ch === '+' || ch === '~'))
			start = i + 1;
	}
	return s.slice(start);
}

/**
 * A compound with its attribute selectors and pseudo-class arguments taken out:
 * what it says about the element itself. A class inside `:not()` is one the
 * element does not carry, and one inside `:is()` or `:has()` one it may not.
 */
function ownLevel(compound: string): string {
	let depth = 0;
	let quote = '';
	let out = '';
	for (let i = 0; i < compound.length; i++) {
		const ch = compound[i] ?? '';
		if (quote) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = '';
		} else if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '(' || ch === '[') depth++;
		else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
		else if (!depth) out += ch;
	}
	return out;
}

/**
 * The elements a key compound lands on, or null where that is not known: the
 * tag it names, or every element the markup puts all of its own classes on.
 *
 * Unknown rather than a guess: a compound naming neither, an interpolated one
 * (`${Icon}`, `.size-${s}`), an escaped class, a class no element carries, and
 * a class carried by an element the index records nothing for — a project
 * component, a tag the element map does not name — since the rule styles that
 * one too, and what it is is not shown.
 */
function compoundElements(
	compound: string,
	carriersByClass: ReadonlyMap<string, readonly ClassCarrier[]>,
): string[] | null {
	if (compound.includes('dsh-e') || compound.includes('\\')) return null;
	const own = ownLevel(compound);
	const tag = tagOf(own);
	if (tag) return [tag];
	const [head, ...rest] = new Set(classesIn(own));
	if (head === undefined) return null;
	const on = (carriersByClass.get(head) ?? []).filter((c) => rest.every((k) => c.classes.includes(k)));
	const out: string[] = [];
	for (const c of on) {
		if (c.element === null) return null;
		out.push(c.element);
	}
	return out.length ? out : null;
}

/**
 * The design system's own stylesheets: the parts they style, and where they are.
 *
 * Recognises a system's internals by the classes its own sheets declare, not
 * only by `namespaces.external` prefix. `dirs` are resolved through symlinks, so
 * a vendored library is never checked as the project's own code. A sheet that
 * cannot be read fails nothing, but is reported: its classes go unrecognised.
 */
async function readLibrary(
	root: string,
	sources: readonly string[],
	tokenPrefixes: readonly string[],
	tokenSet: TokenSet,
): Promise<{ classes: Set<string>; dirs: string[]; unread: ParseError[] }> {
	const classes = new Set<string>();
	const dirs: string[] = [];
	const unread: ParseError[] = [];
	for (const src of sources) {
		const dir = realPath(isAbsolute(src) ? src : join(root, src));
		if (!dir) continue; // not installed: nothing to recognise, and not an error
		dirs.push(dir);
		const budget = { left: 400 };
		for (const file of cssFilesUnder(dir, budget, ['.css', '.scss', '.less'])) {
			const shown = toPosix(relative(root, file));
			const syntax = await syntaxFor(file);
			if (!syntax.parse) {
				unread.push({ file: shown, message: `needs \`npm i -D ${syntax.missing}\` to be read` });
				continue;
			}
			let sheet: Root;
			try {
				sheet = syntax.parse(readFileSync(file, 'utf8'), { from: file });
			} catch (err) {
				unread.push({ file: shown, message: parseMessageOf(err, file) });
				continue;
			}
			harvestTokenDefs(sheet, tokenPrefixes, tokenSet);
			// Local names, hashed at build: nothing a consumer can reach to override.
			if (/\.module\.[^./\\]+$/i.test(file)) continue;
			sheet.walkRules((rule) => {
				const decls = [...ownDecls(rule)];
				// A theme block (`.dark { --color-bg: #111 }`) declares tokens, not a part.
				if (decls.length && decls.every((d) => d.prop.startsWith('--'))) return;
				for (const sel of resolvedSelectors(rule)) {
					if (/^[.#][\w-]+\s*\(/.test(sel)) continue; // a Less mixin definition is never emitted
					const part = partClass(sel);
					if (part) classes.add(part);
				}
			});
		}
		if (!budget.left)
			unread.push({ file: toPosix(relative(root, dir)), message: 'read the first 400 stylesheets only' });
	}
	return { classes, dirs, unread };
}

/**
 * A finding as a check hands it back: everything but the severity and rank,
 * which config and the catalog supply, plus any lines besides its own that a
 * suppression for it may sit on.
 */
export type Candidate = Omit<Finding, 'severity' | 'rank'> & { scopeLines?: readonly number[] | undefined };

/**
 * One rule's verdict on one CSS declaration, whichever channel it came from.
 *
 * `undefined` leaves the declaration to the next check. `null` claims it and
 * passes it: `margin: 0` is the margin check's, and nothing after it may call
 * it a hardcoded value. A finding claims it and fails it.
 */
export type DeclarationCheck = (decl: Decl, ctx: Required<ClassifyContext>) => ClassifiedFinding | null | undefined;

/**
 * In order, most specific first. The first two supersede the verdict the
 * declaration would otherwise get, and only when their rule is live — see
 * `ClassifyContext.enabled`.
 */
const DECLARATIONS: readonly DeclarationCheck[] = [
	typographyInCss,
	systemOverride,
	margin,
	untokenizedType,
	layoutInCss,
	hardcodedValue,
];

/**
 * Which rule, if any, a single declaration violates.
 *
 * Shared by the stylesheet walk, the JSX inline-style walk and CSS-in-JS, so one
 * declaration cannot mean different things in different channels. At most ONE
 * finding per declaration, most specific first.
 *
 * `styling` reports whether the declaration counts as styling the element at
 * all, which feeds the raw-element and library-override logic.
 */
function classifyDeclaration(
	{ prop, value }: Decl,
	{
		boundSystem = [],
		boundText = [],
		isGrid = false,
		surfaceOf = () => undefined,
		surfaced = () => true,
		enabled,
	}: ClassifyContext,
): { finding: ClassifiedFinding | null; styling: boolean } {
	const styling =
		isMarginProp(prop) ||
		isFlexDecl(prop, value) ||
		GAP_PROPS.has(prop) ||
		TYPE_PROPS.has(prop) ||
		isHardcodedTokenValue(prop, value) ||
		APPEARANCE_PROPS.has(prop);
	const ctx = { boundSystem, boundText, isGrid, surfaceOf, surfaced, enabled };
	// Deliberately unbounded: `message` is part of what the dedupe tells two
	// findings apart by. The line is bounded once, at the end of `analyze`.
	for (const check of DECLARATIONS) {
		const verdict = check({ prop, value }, ctx);
		if (verdict !== undefined) return { finding: verdict, styling };
	}
	return { finding: null, styling };
}

/**
 * Rules whose remedy is one action for the whole rule, not one per declaration.
 *
 * Values are kept in the message because they are what the agent carries across
 * to the primitive; `code` drops them so baseline identity survives a value
 * tweak.
 */
const COLLAPSE_PER_RULE = new Set(['layout/in-css', 'typography/untokenized']);

/** The property a collapsible finding's message opens with: `gap: 8px` → `gap`. */
const propOf = (message: string): string => (message.split(':')[0] ?? message).trim();

/**
 * A finding's identity one declaration at a time, for the hook's pre-edit
 * comparison: `findingKey`, except that a collapsed finding is each of its
 * declarations.
 *
 * A collapsed finding's `code` is the sorted property list, and a lone one's is
 * its own declaration, so `.c { display: flex; gap: 8px }` losing its `gap`
 * changes the code although the edit introduced nothing. Compared per
 * declaration, that edit removed one; adding `gap` back to a lone `display:
 * flex` adds one, which the whole-rule key would not have noticed either.
 */
export const declarationKeys = (f: Pick<Finding, 'rule' | 'file' | 'code' | 'message'>): string[] => {
	if (!COLLAPSE_PER_RULE.has(f.rule)) return [findingKey(f)];
	const collapsed = `${f.rule}:`;
	const props = f.code?.startsWith(collapsed) ? f.code.slice(collapsed.length).split(',') : [propOf(f.message)];
	return props.map((p) => findingKey({ ...f, code: `${collapsed}${p}` }));
};

function collapsePerRule(pending: readonly PendingFinding[]): PendingFinding[] {
	const out: PendingFinding[] = [];
	const groups = new Map<RuleId, PendingFinding[]>();
	for (const f of pending) {
		if (!COLLAPSE_PER_RULE.has(f.rule)) {
			out.push(f);
			continue;
		}
		const group = groups.get(f.rule) ?? [];
		group.push(f);
		groups.set(f.rule, group);
	}
	for (const [rule, group] of groups) {
		const first = group[0];
		if (!first) continue;
		if (group.length === 1) {
			out.push(first);
			continue;
		}
		const props = [...new Set(group.map((f) => propOf(f.message)))];
		out.push({
			...first,
			// Bounded per contributor, so one long value cannot spend the whole
			// line. Safe here where it is not at capture: a collapsed finding
			// carries its own `code`, so identity does not fall back to this.
			message: group.map((f) => snippet(f.message)).join('; '),
			// Each hint keeps the line it was flagged on. The collapsed finding
			// reports at the first one, and `fix` matches every other against the
			// line it is actually written on rather than that one.
			hints: group.flatMap((f) => (f.hints ?? []).map((h) => ({ ...h, line: f.line }))),
			code: `${rule}:${props.sort().join(',')}`,
		});
	}
	return out;
}

export async function analyze(
	config: Config,
	// `judge` collects the controls a `judge` detector names, for `check --judge`
	// to ask about. Off, the scanner never sees those detectors.
	// `suppress: false` reads directives (still listed, still checked for form)
	// but mutes nothing: the full audit.
	// `contents` stands in for what is on disk, by repo-relative path: the hook
	// asks what a file's findings were before the edit it is looking at the
	// result of, and the file now holds the edit.
	{
		scope = null,
		judge = false,
		suppress = true,
		contents,
	}: {
		scope?: readonly string[] | null;
		judge?: boolean;
		suppress?: boolean;
		contents?: ReadonlyMap<string, string>;
	} = {},
): Promise<AnalyzeResult> {
	const ds = config.designSystem;
	const ruleIsLive = (rule: RuleId): boolean => config.enabled[rule];
	const surfaceOf = (b: Binding): StylingSurface | undefined =>
		surfaceFor(config.componentRegistry, b.package, b.component);
	const recorded = surfacesRecorded(config.componentRegistry);
	const surfaced = (b: Binding): boolean => recorded(b.package, b.component);
	// How the active profiles say their packages and tokens reach a page.
	const delivery = mergeDeliveries((config.profiles?.active ?? []).map((p) => p.delivery));
	const parseSuppressions = makeSuppressionParser(config.suppression);
	// Bounded, and loud when the bound trips: the index is repo-wide whatever the
	// scope, so a hook on one file under a home directory with a `package.json`
	// in it walked the whole home directory. Stopping short and carrying on would
	// report "clean" for everything past the ceiling.
	const limit = analyzeEntryBudget(config.maxEntries);
	const files = discover({ root: config.root, sources: config.sources, limit });
	if (files.truncated) throw new TreeTooLarge(limit);

	// Nothing a person wrote is this big, and a generated blob costs more to
	// parse than every finding it could produce.
	const MAX_BYTES = 1_500_000;
	const tooBig = (abs: string, rel: string): boolean => {
		const given = contents?.get(rel);
		if (given !== undefined) return Buffer.byteLength(given) > MAX_BYTES;
		try {
			return statSync(abs).size > MAX_BYTES;
		} catch {
			return false;
		}
	};
	const read = (abs: string, rel: string): string => contents?.get(rel) ?? readFileSync(abs, 'utf8');

	// Seeded from the design system's shipped token stylesheet, then topped up
	// with anything the project defines itself.
	const tokenPrefixes = ds.tokenPrefixes ?? [];
	const tokenSet: TokenSet = readTokenSources(config.root, ds.tokenSources, tokenPrefixes);
	// What the active profiles say each token is for. Absent, every suggestion
	// below is made from the generic table exactly as before.
	tokenSet.scopes = mergeScopes((config.profiles?.active ?? []).map((p) => p.tokenScopes));
	const scopes = tokenSet.scopes;
	// Real paths on both sides: the walk never follows a symlink below the root,
	// so the root is the only link a discovered path can have come through.
	const realRoot = realPath(config.root) ?? config.root;
	const library = await readLibrary(realRoot, ds.styleSources, tokenPrefixes, tokenSet);
	const isLibrarySheet = (rel: string): boolean => {
		const abs = join(realRoot, rel);
		return library.dirs.some((d) => abs === d || abs.startsWith(`${d}${sep}`));
	};
	/** Resolved after the walk: an empty token set proves nothing. */
	const tokenRefs: TokenRef[] = [];
	/** The same references, with what each lands on — and the inline channel's too — for `tokens/misapplied-token`. */
	const scopedRefs: ScopedRef[] = [];
	/** The tokens the project's own stylesheets define. Read only by `tokens/undelivered`. */
	const projectTokens: TokenSet = emptyTokenSet();

	const findings: Finding[] = [];
	const directives: Directive[] = [];
	const diagnostics: Diagnostics = {
		parseErrors: [...library.unread],
		filesScanned: 0,
		tokensKnown: tokenSet.known.size,
	};
	const suppByFile = new Map<string, Suppressions>();
	const ledger = new MuteLedger();
	const inScope = scope ? new Set(scope) : null;
	const reports = (rel: string): boolean => !inScope || inScope.has(rel);

	const suppressionsFor = (rel: string, text: string): Suppressions => {
		const cached = suppByFile.get(rel);
		if (cached) return cached;
		const parsed = parseSuppressions(text, rel);
		if (!suppress) parsed.byLine.clear();
		suppByFile.set(rel, parsed);
		return parsed;
	};

	/**
	 * Complete a check's finding and keep it — unless its rule is off, its file
	 * is out of scope, or a directive on its line, the line above, or one of
	 * its `scopeLines` suppresses it.
	 */
	const report = ({ scopeLines, rule, file, line, message, ...f }: Candidate): void => {
		if (!config.enabled[rule] || !reports(file)) return;
		const supp = suppByFile.get(file);
		if (supp && ledger.mute(supp, line, rule, scopeLines)) return;
		// Keys in one order whichever channel built the candidate, so `--format json` reads alike.
		findings.push({ rule, severity: config.severityOf(rule), file, line, message, ...f, rank: RULES[rule].rank });
	};

	// ── index markup, repo-wide ───────────────────────────────────────────────
	const referenced = new Set<string>();
	const stems = new Set<string>();
	/** class -> every component binding that carries it */
	const bindings = new Map<string, Binding[]>();
	const rawEls: RawElement[] = [];
	/** class -> every element carrying it, for the token pass to know what a rule lands on */
	const carriersByClass = new Map<string, ClassCarrier[]>();
	const inlineStyles: InlineStyleElement[] = [];
	const cssInJs: CssInJsTemplate[] = [];
	const composites: Composite[] = [];
	// The registry's AST rules, run per file by the scanner. They exist for the
	// wrong choice the composite matcher cannot see: one control, under the
	// four-node floor.
	const patternRules: PatternRule[] = (config.patterns ?? []).flatMap((p) =>
		p.rules.filter((spec) => judge || spec.rule !== 'judge').map((spec) => ({ patternId: p.id, spec })),
	);
	const controls: Control[] = [];
	const ruleHits: (RuleHit & { file: string })[] = [];
	const importsByFile = new Map<string, Set<string>>();
	const componentImports: ComponentImport[] = [];

	for (const { abs, rel } of files.markup) {
		if (tooBig(abs, rel)) continue;
		let text: string;
		try {
			text = read(abs, rel);
		} catch {
			continue;
		}
		diagnostics.filesScanned++;
		const scanned = scanMarkup(text, rel, ds, patternRules);
		if (scanned.parseError) diagnostics.parseErrors.push({ file: rel, message: scanned.parseError });
		for (const t of scanned.referenced) referenced.add(t);
		for (const t of scanned.stems) stems.add(t);
		for (const b of scanned.bindings) {
			if (b.cls === undefined) continue;
			const group = bindings.get(b.cls) ?? [];
			group.push(b);
			bindings.set(b.cls, group);
		}
		rawEls.push(...scanned.rawEls);
		// Only collected where a profile declares scopes to check.
		if (scopes)
			for (const c of scanned.carriers)
				for (const cls of new Set(c.classes)) {
					const list = carriersByClass.get(cls);
					if (list) list.push(c);
					else carriersByClass.set(cls, [c]);
				}
		inlineStyles.push(...scanned.inlineStyles);
		cssInJs.push(...scanned.cssInJs);
		composites.push(...scanned.composites);
		for (const h of scanned.ruleHits) ruleHits.push({ ...h, file: rel });
		controls.push(...scanned.controls);
		if (scanned.imports) importsByFile.set(rel, scanned.imports);
		for (const ci of scanned.componentImports) componentImports.push({ ...ci, file: rel });
		suppressionsFor(rel, text);
	}

	/**
	 * What a stylesheet rule lands on: the element its key compound names, or
	 * every element the markup puts all of its key compound's classes on. Empty
	 * when any one of its selectors says nothing — a scope is only held against
	 * what is shown.
	 */
	const elementsOf = (selectors: readonly string[]): string[] => {
		if (!scopes) return [];
		const out = new Set<string>();
		for (const sel of selectors) {
			const found = compoundElements(keyCompound(sel), carriersByClass);
			if (!found) return [];
			for (const e of found) out.add(e);
		}
		return [...out];
	};
	/**
	 * The same for a selector nested in a CSS-in-JS template, written as the
	 * comma-joined list it is: every selector in it counts. A `&` there stands for
	 * whatever encloses it, which a nested group does not carry, so it is not known.
	 */
	const nestedElements = (selector: string): string[] => {
		const selectors = list.comma(selector);
		return selectors.some((sel) => keyCompound(sel).includes('&')) ? [] : elementsOf(selectors);
	};

	for (const { abs, rel } of files.references) {
		if (tooBig(abs, rel)) continue;
		try {
			harvestTokens(read(abs, rel), referenced);
			diagnostics.filesScanned++;
		} catch {
			/* unreadable reference file just contributes nothing */
		}
	}

	// ── walk CSS ──────────────────────────────────────────────────────────────
	const styledClasses = new Set<string>(); // classes CSS actually styles — feeds system/raw-element
	const layoutClasses = new Set<string>(); // classes whose CSS lays something out — feeds the same rule for div/span
	const declared: DeclaredClass[] = []; // every key class a stylesheet rule declares — feeds css/dead-class
	// What each class some raw element carries is set to, and the verdict it got
	// — for `system/raw-element` to say what converting the element would change.
	const onRaw = new Set(ruleIsLive('system/raw-element') ? rawEls.flatMap((el) => el.classes) : []);
	const rawClassDecls = new Map<string, ClassDecl[]>();

	// `stylesheet/unparsed`, per stylesheet the discovery pass found:
	//   the design system's own sheet                     → skipped, not the project's
	//   unreadable from disk                              → skipped silently
	//   larger than MAX_BYTES                             → stylesheet/unparsed, generated
	//   its syntax needs a plugin the project has not
	//   installed (`postcss-scss`, `postcss-less`)        → stylesheet/unparsed
	//   postcss throws parsing it                         → stylesheet/unparsed
	//   otherwise                                         → walked, and its rules checked
	for (const { abs, rel } of files.styles) {
		if (isLibrarySheet(rel)) continue; // the design system's own sheet, not the project's
		let text: string;
		try {
			text = read(abs, rel);
		} catch {
			continue;
		}
		diagnostics.filesScanned++;
		suppressionsFor(rel, text); // cached for `report`
		// Unreadable is a hole in coverage, not a diagnostic: it reports as a
		// finding, so a clean run always means "checked and clean".
		const unparsed = (message: string, code?: string): void => {
			diagnostics.parseErrors.push({ file: rel, message });
			if (config.enabled['stylesheet/unparsed'] && reports(rel))
				findings.push({
					rule: 'stylesheet/unparsed',
					severity: config.severityOf('stylesheet/unparsed'),
					file: rel,
					line: 1,
					message,
					code: code ?? message,
					rank: RULES['stylesheet/unparsed'].rank,
				});
		};

		if (tooBig(abs, rel)) {
			unparsed(`stylesheet over ${Math.round(MAX_BYTES / 1000)}kB — skipped as generated`);
			continue;
		}

		const syntax = await syntaxFor(rel);
		if (syntax.missing !== undefined) {
			unparsed(`needs \`npm i -D ${syntax.missing}\` to be checked`);
			continue;
		}

		// `map: false`: a sheet naming its source map otherwise reports a syntax
		// error at the original file's absolute path, which no other clone has.
		let root: Root;
		try {
			root = syntax.parse(text, { from: abs, map: false });
		} catch (err) {
			// Keyed on the reason alone. The position moves with every line added
			// above the error, and the hook would call the same error a new one.
			unparsed(parseMessageOf(err, abs), parseReasonOf(err));
			continue;
		}

		const emit = (f: PendingFinding): void => report({ ...f, file: rel, code: f.code ?? f.message });

		harvestTokenDefs(root, tokenPrefixes, tokenSet);
		// Kept apart as well: a token the project defines itself arrives with its
		// own stylesheet, and is no evidence about the design system's.
		if (delivery?.tokens) harvestTokenDefs(root, tokenPrefixes, projectTokens);

		// What a rule's own lines say, for the deletion `css/dead-class` offers in
		// the editor: an extent in lines is only safe if it is the whole of them.
		const srcLines = text.split('\n');

		root.walkRules((cssRule) => {
			const ruleLine = cssRule.source?.start?.line ?? 1;
			const selectors = resolvedSelectors(cssRule);
			const allClasses = [...new Set(selectors.flatMap(classesIn))];
			// Kept per selector as well as pooled: deleting the rule for one dead
			// class is only safe if every selector in the list names that class.
			const keyClassesPer = selectors.map((s) => classesIn(keySelector(s)));
			const keyClasses = [...new Set(keyClassesPer.flat())];
			if (!allClasses.length) return;

			// Bindings correlate against the KEY selector only: `.card .title`
			// styles `.title`, so `.card`'s component must not answer for it.
			const bound = keyClasses.flatMap((c) => bindings.get(c) ?? []);
			const boundSystem = bound.filter((b) => b.isSystem);
			const boundText = bound.filter((b) => b.isText);
			const isGrid = ruleIsGrid(cssRule);
			const scopeLines = [ruleLine, ruleLine - 1];
			// Carried so a browser-side reader can resolve this rule to the elements
			// it styles: the comma-joined selector list is a valid `querySelectorAll`
			// argument, the media condition what `matchMedia` takes. `undefined`
			// rather than `''`, so the field is absent when a rule is unconditional.
			const selector = selectors.join(', ');
			const media = mediaQuery(cssRule) || undefined;
			const elements = elementsOf(selectors);
			let touchesStyle = false;
			let touchesLayout = false;

			// Held rather than emitted directly: if this rule turns out to target a
			// third-party component's internals, "stop styling this" supersedes
			// every per-declaration remedy inside it.
			const pending: PendingFinding[] = [];
			const onRawKeys = keyClasses.filter((c) => onRaw.has(c));
			const classDecls: ClassDecl[] = [];

			for (const decl of ownDecls(cssRule)) {
				const prop = decl.prop.toLowerCase();
				const line = decl.source?.start?.line ?? ruleLine;
				const { finding, styling } = classifyDeclaration(
					{ prop, value: decl.value },
					{ boundSystem, boundText, isGrid, surfaceOf, surfaced, enabled: ruleIsLive },
				);
				if (onRawKeys.length)
					classDecls.push({ prop, value: decl.value, isGrid, boundSystem, boundText, now: finding?.rule ?? null });
				if (styling) touchesStyle = true;
				if (isLayoutDecl({ prop, value: decl.value })) touchesLayout = true;
				for (const name of tokenRefsIn(decl.value, tokenPrefixes)) {
					const ref = { file: rel, line, name, prop, scopeLines };
					tokenRefs.push(ref);
					if (scopes) scopedRefs.push({ ...ref, value: decl.value, elements });
				}
				if (finding) pending.push({ ...finding, line, scopeLines });
			}

			if (touchesStyle) for (const c of allClasses) styledClasses.add(c);
			if (touchesLayout) for (const c of allClasses) layoutClasses.add(c);

			// Reaching into a third-party component's internals replaces the
			// per-declaration findings rather than adding to them.
			const override =
				touchesStyle && ruleIsLive('system/override')
					? libraryOverride(keyClasses, (c) => config.isExternal(c) || library.classes.has(c), config.isProject)
					: null;
			if (override) emit({ ...override, line: ruleLine, scopeLines, selector, media });
			else for (const f of collapsePerRule(pending)) emit({ ...f, selector, media, elements });
			// A library internal is reported whole whatever binds it, so converting
			// the element changes nothing about it.
			if (!override)
				for (const c of onRawKeys) {
					const list = rawClassDecls.get(c) ?? [];
					list.push(...classDecls);
					rawClassDecls.set(c, list);
				}

			const cut = deletableRule(cssRule, srcLines);
			for (const cls of keyClasses)
				declared.push({
					file: rel,
					line: ruleLine,
					cls,
					scopeLines,
					cut: cut && keyClassesPer.every((k) => k.includes(cls)) ? cut : undefined,
				});
		});
	}

	for (const f of deadClasses(declared, {
		referenced,
		stems: [...stems],
		isProject: config.isProject,
		isNeverDead: config.isNeverDead,
	}))
		report(f);

	// ── inline styles ─────────────────────────────────────────────────────────
	// Same rules, other channel.
	for (const el of inlineStyles) {
		// `report` would drop it anyway; skipping first keeps a scoped hook run
		// from classifying every inline style in the repo on every edit.
		if (!reports(el.file)) continue;
		const scopeLines = [el.line, el.line - 1];
		const whole = ruleIsLive('system/inline-style') ? inlineStyle(el, ds.allowedInlineStyles) : null;
		if (whole) {
			report({ ...whole, file: el.file, line: el.line, code: whole.code ?? whole.message, scopeLines });
			continue;
		}

		const isGrid = el.decls.some((d) => isGridDecl(d.prop, d.value));
		const pending: PendingFinding[] = [];
		// An inline style is on exactly the element it is written on — where what
		// that element is is known.
		const elements = el.element ? [el.element] : [];
		for (const d of el.decls) {
			if (scopes)
				for (const name of tokenRefsIn(d.value, tokenPrefixes))
					scopedRefs.push({
						file: el.file,
						line: d.line ?? el.line,
						name,
						prop: d.prop,
						scopeLines,
						value: d.value,
						elements,
					});
			const { finding } = classifyDeclaration(d, { isGrid, enabled: ruleIsLive });
			if (finding)
				pending.push({
					...finding,
					// The classifier sees the translated declaration, which is not what
					// the file says. Only the span points back at the bytes it came from.
					hints: finding.hints?.map((h) => ({ ...h, span: d.span })),
					line: d.line ?? el.line,
					code: finding.code ?? finding.message,
					suffix: ' (inline)',
				});
		}
		for (const f of collapsePerRule(pending))
			report({
				...f,
				file: el.file,
				message: `${f.message}${f.suffix ?? ''}`,
				code: f.code ?? f.message,
				scopeLines,
				elements,
			});
	}

	// ── CSS-in-JS template literals ───────────────────────────────────────────
	// The third channel, through the same classifier. A `styled(Button)` template
	// is the stylesheet pass's "class bound to a design-system component".
	for (const tpl of cssInJs) {
		if (!reports(tpl.file)) continue;
		const supp = suppByFile.get(tpl.file);
		if (tpl.error) {
			// Not a finding: an interpolation-driven template is opaque by design.
			// It is still recorded, so a clean report can be checked against it.
			diagnostics.parseErrors.push({ file: tpl.file, message: `css-in-js at line ${tpl.line}: ${tpl.error}` });
			continue;
		}

		const key = {
			...(tpl.component ? { component: tpl.component } : {}),
			...(tpl.package ? { package: tpl.package } : {}),
		};
		const boundSystem: Binding[] = tpl.isSystem ? [{ tag: tpl.target, isSystem: true, ...key }] : [];
		const boundText: Binding[] = tpl.isText ? [{ tag: tpl.target, isSystem: true, isText: true, ...key }] : [];
		// What the template styles, for a token scope: a design-system component as
		// the component it is, a tag as itself. A project component renders
		// whatever its own markup says, so it is not known.
		const self = tpl.isSystem
			? (tpl.component ?? tpl.target)
			: tpl.target && /^[a-z]/.test(tpl.target)
				? tpl.target
				: null;

		for (const group of tpl.groups) {
			const onTarget = group.onTarget;
			const pending: PendingFinding[] = [];
			// The styled element itself — the component it is, whatever the file
			// called it — or what every selector of a nested group's list lands on.
			let elements: string[] = [];
			if (onTarget) elements = scopes && self ? [self] : [];
			else if (group.selector) elements = nestedElements(group.selector);
			for (const d of group.decls) {
				if (supp)
					for (const name of tokenRefsIn(d.value, tokenPrefixes)) {
						const ref = { file: tpl.file, line: d.line ?? tpl.line, name, prop: d.prop, scopeLines: [tpl.line] };
						tokenRefs.push(ref);
						if (scopes) scopedRefs.push({ ...ref, value: d.value, elements });
					}
				const { finding } = classifyDeclaration(d, {
					boundSystem: onTarget ? boundSystem : [],
					boundText: onTarget ? boundText : [],
					isGrid: group.isGrid,
					surfaceOf,
					surfaced,
					enabled: ruleIsLive,
				});
				if (finding) pending.push({ ...finding, line: d.line ?? tpl.line });
			}
			// Held whole, not bounded here: the selector is the only thing telling two
			// otherwise identical findings in one template apart, and it never reaches
			// `code`. It rides in `suffix`, and the line bound at the end of `analyze`
			// shortens it from the front.
			const where = group.selector ? ` in \`${group.selector}\`` : '';
			for (const f of collapsePerRule(pending))
				report({
					...f,
					file: tpl.file,
					message: `${f.message}${where} (css-in-js)`,
					code: `css-in-js:${f.code ?? f.message}`,
					suffix: `${where} (css-in-js)`,
					scopeLines: [tpl.line, tpl.line - 1],
					elements,
				});
		}
	}

	// ── the checks that read the whole index ─────────────────────────────────
	for (const f of rawElements(ruleIsLive('system/raw-element') ? rawEls.filter((el) => reports(el.file)) : [], {
		layoutComponents: ds.layoutComponents,
		styledClasses,
		layoutClasses,
		registry: config.componentRegistry,
		promotion: {
			decls: rawClassDecls,
			// The same classifier, with the analog bound alongside whatever the
			// rule's classes are already bound to.
			verdictAs: (d, as) =>
				classifyDeclaration(
					{ prop: d.prop, value: d.value },
					{
						boundSystem: [...d.boundSystem, as],
						boundText: as.isText ? [...d.boundText, as] : d.boundText,
						isGrid: d.isGrid,
						surfaceOf,
						surfaced,
						enabled: ruleIsLive,
					},
				).finding?.rule ?? null,
			severityOf: config.severityOf,
			textComponents: ds.textComponents,
		},
	}))
		report(f);
	for (const f of compositeFindings({
		found: composites,
		hits: ruleHits,
		registry: config.patterns ?? [],
		importsByFile,
		enabled: ruleIsLive,
	}))
		report(f);
	for (const f of currency(componentImports, config.componentRegistry, ruleIsLive)) report(f);
	// What a remedy naming a package would cost here: nothing for a package the
	// project already imports or the host provides, a bundling note otherwise.
	// A note, never the message or code, so a baseline keyed on either survives.
	annotateReach(findings, {
		delivery,
		imports: componentImports,
		dependencies: projectDependencies(config.root),
		dsPackages: ds.packages,
	});

	// ── malformed suppressions ────────────────────────────────────────────────
	for (const [file, s] of suppByFile) {
		directives.push(...s.directives);
		if (!config.enabled['suppression/malformed'] || !reports(file)) continue;
		for (const m of s.malformed)
			findings.push({
				...m,
				severity: config.severityOf('suppression/malformed'),
				code: m.message,
				rank: RULES['suppression/malformed'].rank,
			});
	}

	// ── the token pass ────────────────────────────────────────────────────────
	// Deferred to here: the token set is only complete once every stylesheet has
	// been read.

	// Name the replacement instead of the namespace.
	for (const f of findings) {
		const elements = f.elements ?? [];
		delete f.elements;
		// An empty array is still working state — `collapsePerRule` produces one
		// whenever it merges a group where nothing carried a hint. Dropped here too,
		// or `"hints": []` rides out into `--format json`.
		if (!f.hints?.length) {
			delete f.hints;
			continue;
		}
		// Match first, render from the match, so the message a reader sees is a
		// rendering of what `fix` acts on rather than a second account of it. One
		// entry per flagged declaration, matched or not: an entry with no tokens is
		// how `fix` knows a declaration was never substituted.
		//
		// One token is applied unattended only where it is in its declared scope on
		// what this styles. Off it — or scoped to a kind of element nothing here
		// shows this to be — it is a question, the way two on-role tokens are.
		//
		// A value matched part by part — `4px 4px 0 0`, `border: 1px solid #ddd` —
		// or by a token equal to it in another unit (`0.25rem` for `4px`) is
		// settled by `fix --judge` without a question, so it is held the same way,
		// and the review names the token.
		const hold = scopes
			? (token: string): string | null => {
					const fit = fitOf(scopes, token, elements);
					return fit.fit === 'off' || fit.fit === 'unknown' ? fit.why : null;
				}
			: null;
		f.suggest = f.hints.map((h) => {
			const tokens = tokensFor(tokenSet, h.prop, h.value);
			const [only] = tokens;
			let review: string | null = null;
			if (hold && only !== undefined && tokens.length === 1) review = hold(only);
			else if (hold && !tokens.length) {
				const plan = planValue(tokenSet, h.prop, h.value, hold);
				if (plan && plan !== 'none') review = plan.review ?? null;
			}
			return review ? { ...h, tokens, review } : { ...h, tokens };
		});
		// Replaces what the classifier bounded rather than appending to it.
		// `declarationMessage` is the single place that decides how it reads.
		f.message = declarationMessage(f.suggest, f.suffix ?? '');
		if (f.rule === 'tokens/hardcoded-value' && f.hints.length === 1) f.decl = f.hints[0];
		delete f.hints;
		// `suffix` stays until the message is bounded below, which needs to know
		// which part of it is the channel marker. Nothing downstream of that sees it.
	}

	for (const f of unknownTokenFindings(tokenRefs, tokenSet.known)) report(f);
	for (const f of misappliedTokens(scopedRefs, scopes, tokenSet.known)) report(f);
	if (ruleIsLive('tokens/undelivered'))
		for (const f of undelivered({
			root: config.root,
			ignore: config.sources.ignore ?? [],
			tokens: delivery?.tokens ?? null,
			refs: tokenRefs,
			prefixes: tokenPrefixes,
			projectDefined: projectTokens.known,
			reports,
		}))
			report(f);

	// Run BEFORE the line bound below, so a cap cannot decide whether a finding
	// survives.
	const unique = dedupe(findings);

	// One report line per finding, bounded once — here, because the token pass
	// above is the last of several writers of `message`. Each captured snippet is
	// bounded where it was captured; this bounds what they add up to, keeping the
	// channel marker on the end.
	for (const f of unique) f.message = boundMessage(f.message, f.suffix);
	// `suffix` is not dropped here: `--judge` runs after this and recomposes the
	// message of anything it settles. It is dropped where the output is built.

	unique.sort((a, b) => b.rank - a.rank || byBytes(a.file, b.file) || a.line - b.line);
	directives.sort((a, b) => byBytes(a.file, b.file) || a.line - b.line);

	// Controls are muted here, before the ledger settles, so a directive for
	// `patterns/judged-redirect` is credited on a `--judge` run.
	const liveControls =
		judge && config.enabled['patterns/judged-redirect']
			? controls.filter((c) => {
					const supp = suppByFile.get(c.file);
					return reports(c.file) && !(supp && ledger.mute(supp, c.line, 'patterns/judged-redirect'));
				})
			: null;

	// What each directive muted, once every finding has been offered to it. Only
	// where this run applied suppressions: with them off, or outside the scope,
	// nothing was offered and everything would read as stale. A judged rule is
	// only exercised under `--judge`.
	if (suppress)
		ledger.settle(
			directives.filter((d) => reports(d.file)),
			new Set(judge ? [] : ['patterns/judged-redirect']),
		);

	return {
		findings: unique,
		directives,
		diagnostics,
		blocking: unique.some((f) => f.severity === 'error'),
		// Only when the design system's own sources yielded tokens. The walk adds
		// whatever the project defines under the same prefix to this same set, and
		// one `--wpds-brand-color` of the project's own would otherwise pass for a
		// design system read, with every value judged tokenless against it.
		...(diagnostics.tokensKnown ? { tokens: tokenSet } : {}),
		// Scoped and suppressed here, where the scope and the comments are: the
		// finding a control becomes is written later, by the judge.
		...(liveControls ? { controls: liveControls } : {}),
	};
}

/**
 * The findings with each repeat dropped, first one kept. Nesting and
 * multi-selector rules can legitimately reach the same declaration twice, and
 * two controls on one line can be judged the same redirect. Keyed on identity
 * AND display.
 *
 * Exported for `check --judge`, whose redirects are written after `analyze`
 * has returned and so never passed through it here.
 */
export function dedupe(findings: readonly Finding[]): Finding[] {
	const seen = new Set<string>();
	return findings.filter((f) => {
		const k = `${f.rule}|${f.file}|${f.line}|${f.code ?? ''}|${f.message}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** Stable identity for baselining: survives reformatting and unrelated edits. */
export const findingKey = (f: Pick<Finding, 'rule' | 'file' | 'code' | 'message'>): string =>
	`${f.rule}|${f.file}|${oneLine(String(f.code ?? f.message))}`;
