/**
 * The analyzer.
 *
 * The one thing here that no single-language linter can do: correlate the
 * markup that binds a class to a component with the CSS that styles that class.
 * Rules that need no correlation (hardcoded values, margins) are a stylelint
 * plugin in disguise; the correlation rules are why this exists.
 *
 * Scoping note: the index is ALWAYS built repo-wide, and `scope` only filters
 * what gets *reported*. Building the index from changed files alone would make
 * every unchanged reference look absent and every class look dead.
 *
 * What lives here is the machinery: build the index, walk the three channels a
 * declaration can arrive by, scope and suppress, then name tokens, dedupe and
 * bound. What each rule decides lives in `checks/`, one file per rule, or per
 * family of rules that share one pass; a new rule is a new file there and a
 * call here. The catalog — severity, rank, title — stays in `rules.ts`, where
 * the ranks can be read against each other.
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
 *     checks/tokens/unknown-token.ts    tokens/unknown-token
 *   run by the scanner, per JSX element (`markup.ts`):
 *     checks/detectors/*.ts             the pattern registry's detectors
 *
 * `stylesheet/unparsed` and `suppression/malformed` are the machinery reporting
 * on itself, and stay here; `patterns/judged-redirect` is `judge.ts`.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import type { Root } from 'postcss';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RULES } from './rules.ts';
import { discover, toPosix } from './discover.ts';
import { makeSuppressionParser, isSuppressed } from './suppressions.ts';
import { scanMarkup, harvestTokens } from './markup.ts';
import { syntaxFor } from './syntax.ts';
import { messageLine, messageOf, oneLine, snippet } from './text.ts';
import {
	cssFilesUnder,
	declarationMessage,
	harvestTokenDefs,
	readTokenSources,
	tokensFor,
	tokenRefsIn,
} from './tokens.ts';
import {
	APPEARANCE_PROPS,
	GAP_PROPS,
	TYPE_PROPS,
	classesIn,
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
import { hardcodedValue } from './checks/tokens/hardcoded-value.ts';
import { unknownTokens as unknownTokenFindings } from './checks/tokens/unknown-token.ts';
import type { TokenRef } from './checks/tokens/unknown-token.ts';
import { typographyInCss } from './checks/typography/in-css.ts';
import { untokenizedType } from './checks/typography/untokenized.ts';
import type {
	AnalyzeResult,
	Binding,
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
 *
 * Ancestors (`.dark .label`), state modifiers (`.tab.is-active`), pseudo-class
 * arguments and attribute values are context, not a part — and harvesting them
 * made a project's own `.acme-tab.is-active` a "library internal" whose verdict
 * replaced the real findings on the rule. An escaped name (`.md\:flex`) is not
 * cut short into a class that was never written.
 *
 * ponytail: a part whose class is not first in its compound (`.is-open.popover`)
 * is missed — a missed override, never a false one.
 */
const partClass = (sel: string): string | undefined =>
	keySelector(sel.replace(/\[[^\]]*\]|\([^)]*\)/g, '')).match(/\.(-?[_a-zA-Z][\w-]*)(?![\w\\-])/)?.[1];

/**
 * The design system's own stylesheets: the parts they style, and where they are.
 *
 * `namespaces.external` recognises a library's internals by prefix, and a
 * system whose classes carry none — `.field-label`, `.toast-viewport` — slipped
 * past it entirely. No JSX binds those classes (the component renders them
 * itself), so a consumer rule restyling one correlated with nothing and
 * reported nothing: the override most likely to break on upgrade was the one
 * the gate could not see. Reading the classes out of the system's stylesheets
 * recognises them without a prefix to match.
 *
 * `dirs` are resolved through symlinks, so a vendored library is recognised
 * however the project walk spelled its path — a workspace link, a different
 * case — and never checked as the project's own code. Its token definitions
 * still count: that is what the project walk used to read them for.
 *
 * A sheet that cannot be read fails nothing — the project has nothing to fix in
 * it — but it is reported, since its classes then go unrecognised.
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
				unread.push({ file: shown, message: messageOf(err) });
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
 * Shared by the stylesheet walk, the JSX inline-style walk and CSS-in-JS.
 * `margin-bottom: 16px` in a stylesheet and `style={{ marginBottom: 16 }}` in
 * JSX are the same mistake with the same remedy, so they must not be able to
 * drift into different verdicts — which is exactly what happens when the chain
 * is written out twice.
 *
 * At most ONE finding per declaration, most specific first. Emitting both the
 * precise remedy and the generic one doubles the report and leaves the agent to
 * guess which to act on.
 *
 * `styling` reports whether the declaration counts as styling the element at
 * all, which feeds the raw-element and library-override logic.
 */
function classifyDeclaration(
	{ prop, value }: Decl,
	{ boundSystem = [], boundText = [], isGrid = false, enabled }: ClassifyContext,
): { finding: ClassifiedFinding | null; styling: boolean } {
	const styling =
		isMarginProp(prop) ||
		isFlexDecl(prop, value) ||
		GAP_PROPS.has(prop) ||
		TYPE_PROPS.has(prop) ||
		isHardcodedTokenValue(prop, value) ||
		APPEARANCE_PROPS.has(prop);
	const ctx = { boundSystem, boundText, isGrid, enabled };
	// Deliberately unbounded. `message` is what the dedupe tells two findings
	// apart by, and on the rules whose `code` is only the property (`margin-*`,
	// `gap`) it is the ONLY thing that tells them apart — so a cap applied at
	// capture folds two distinct declarations on one line into one finding and
	// drops a real violation. The line is bounded once, at the end of
	// `analyze`, after the dedupe has run.
	for (const check of DECLARATIONS) {
		const verdict = check({ prop, value }, ctx);
		if (verdict !== undefined) return { finding: verdict, styling };
	}
	return { finding: null, styling };
}

/**
 * Rules whose remedy is one action for the whole rule, not one per declaration.
 *
 * `display:flex; flex-direction:column; align-items:center; gap:8px` is four
 * findings for a single decision — replace this with a layout primitive — and a
 * real repo produced 702 of them. Four times the report buys nothing, and a rule
 * that floods the report crowds out every rule with a cheaper remedy.
 *
 * Values are kept in the message because they are what the agent needs to carry
 * across to the primitive; `code` drops them so baseline identity survives a
 * value tweak.
 */
const COLLAPSE_PER_RULE = new Set(['layout/in-css', 'typography/untokenized']);

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
		const props = [...new Set(group.map((f) => (f.message.split(':')[0] ?? f.message).trim()))];
		out.push({
			...first,
			// Bounded per contributor, so one long value cannot spend the whole
			// line and crowd the others out of a message that is several of them.
			// Safe to bound here where it is not at capture: a collapsed finding
			// always carries its own `code` below, so identity does not fall back
			// to this string.
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
	{ scope = null, judge = false }: { scope?: readonly string[] | null; judge?: boolean } = {},
): Promise<AnalyzeResult> {
	const ds = config.designSystem;
	const ruleIsLive = (rule: RuleId): boolean => config.enabled[rule];
	const parseSuppressions = makeSuppressionParser(config.suppression);
	const files = discover({ root: config.root, sources: config.sources });

	// Nothing a person wrote is this big. A generated blob costs more to parse
	// than every finding it could produce, and one 10MB checked-in emscripten
	// file was on its own enough to push a repo scan past every hook timeout.
	const MAX_BYTES = 1_500_000;
	const tooBig = (abs: string): boolean => {
		try {
			return statSync(abs).size > MAX_BYTES;
		} catch {
			return false;
		}
	};

	// Seeded from the design system's shipped token stylesheet, then topped up
	// with anything the project defines itself. Without it a finding can only
	// name a namespace, and an agent told `13px` is hardcoded invents
	// `--wpds-font-size-13` rather than looking one up.
	const tokenPrefixes = ds.tokenPrefixes ?? [];
	const tokenSet: TokenSet = readTokenSources(config.root, ds.tokenSources, tokenPrefixes);
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

	const findings: Finding[] = [];
	const directives: Directive[] = [];
	const diagnostics: Diagnostics = {
		parseErrors: [...library.unread],
		filesScanned: 0,
		tokensKnown: tokenSet.known.size,
	};
	const suppByFile = new Map<string, Suppressions>();
	const inScope = scope ? new Set(scope) : null;
	const reports = (rel: string): boolean => !inScope || inScope.has(rel);

	const suppressionsFor = (rel: string, text: string): Suppressions => {
		const cached = suppByFile.get(rel);
		if (cached) return cached;
		const parsed = parseSuppressions(text, rel);
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
		if (supp && isSuppressed(supp.byLine, line, rule, scopeLines)) return;
		// Keys in one order whichever channel built the candidate, so `--format json` reads alike.
		findings.push({ rule, severity: config.severityOf(rule), file, line, message, ...f, rank: RULES[rule].rank });
	};

	// ── index markup, repo-wide ───────────────────────────────────────────────
	const referenced = new Set<string>();
	const stems = new Set<string>();
	/** class -> every component binding that carries it */
	const bindings = new Map<string, Binding[]>();
	const rawEls: RawElement[] = [];
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
		if (tooBig(abs)) continue;
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
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
		inlineStyles.push(...scanned.inlineStyles);
		cssInJs.push(...scanned.cssInJs);
		composites.push(...scanned.composites);
		for (const h of scanned.ruleHits) ruleHits.push({ ...h, file: rel });
		controls.push(...scanned.controls);
		if (scanned.imports) importsByFile.set(rel, scanned.imports);
		for (const ci of scanned.componentImports) componentImports.push({ ...ci, file: rel });
		suppressionsFor(rel, text);
	}

	for (const { abs } of files.references) {
		if (tooBig(abs)) continue;
		try {
			harvestTokens(readFileSync(abs, 'utf8'), referenced);
			diagnostics.filesScanned++;
		} catch {
			/* unreadable reference file just contributes nothing */
		}
	}

	// ── walk CSS ──────────────────────────────────────────────────────────────
	const styledClasses = new Set<string>(); // classes CSS actually styles — feeds system/raw-element
	const layoutClasses = new Set<string>(); // classes whose CSS lays something out — feeds the same rule for div/span
	const declared: DeclaredClass[] = []; // every key class a stylesheet rule declares — feeds css/dead-class

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
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		diagnostics.filesScanned++;
		suppressionsFor(rel, text); // cached for `report`
		// A stylesheet we cannot read is a hole in coverage, not a diagnostic:
		// it reports as a finding so a clean run always means "checked and clean".
		const unparsed = (message: string): void => {
			diagnostics.parseErrors.push({ file: rel, message });
			if (config.enabled['stylesheet/unparsed'] && reports(rel))
				findings.push({
					rule: 'stylesheet/unparsed',
					severity: config.severityOf('stylesheet/unparsed'),
					file: rel,
					line: 1,
					message,
					code: message,
					rank: RULES['stylesheet/unparsed'].rank,
				});
		};

		if (tooBig(abs)) {
			unparsed(`stylesheet over ${Math.round(MAX_BYTES / 1000)}kB — skipped as generated`);
			continue;
		}

		const syntax = await syntaxFor(rel);
		if (syntax.missing !== undefined) {
			unparsed(`needs \`npm i -D ${syntax.missing}\` to be checked`);
			continue;
		}

		let root: Root;
		try {
			root = syntax.parse(text, { from: abs });
		} catch (err) {
			unparsed(messageOf(err));
			continue;
		}

		const emit = (f: PendingFinding): void => report({ ...f, file: rel, code: f.code ?? f.message });

		harvestTokenDefs(root, tokenPrefixes, tokenSet);

		root.walkRules((cssRule) => {
			const ruleLine = cssRule.source?.start?.line ?? 1;
			const selectors = resolvedSelectors(cssRule);
			const allClasses = [...new Set(selectors.flatMap(classesIn))];
			const keyClasses = [...new Set(selectors.map(keySelector).flatMap(classesIn))];
			if (!allClasses.length) return;

			// Bindings correlate against the KEY selector only: `.card .title`
			// styles `.title`, so `.card`'s component must not answer for it.
			const bound = keyClasses.flatMap((c) => bindings.get(c) ?? []);
			const boundSystem = bound.filter((b) => b.isSystem);
			const boundText = bound.filter((b) => b.isText);
			const isGrid = ruleIsGrid(cssRule);
			const scopeLines = [ruleLine, ruleLine - 1];
			// Carried so a browser-side reader can resolve this rule to the
			// elements it actually styles, and say whether it is styling them
			// right now. The whole selector list, comma-joined, is both what the
			// author wrote and a valid `querySelectorAll` argument; the media
			// condition is what `matchMedia` takes. `undefined` rather than `''`
			// for an unconditional rule, so the field is absent from the payload
			// instead of present and empty.
			const selector = selectors.join(', ');
			const media = mediaQuery(cssRule) || undefined;
			let touchesStyle = false;
			let touchesLayout = false;

			// Held rather than emitted directly: if this rule turns out to target a
			// third-party component's internals, "stop styling this" supersedes
			// every per-declaration remedy inside it.
			const pending: PendingFinding[] = [];

			for (const decl of ownDecls(cssRule)) {
				const prop = decl.prop.toLowerCase();
				const line = decl.source?.start?.line ?? ruleLine;
				const { finding, styling } = classifyDeclaration(
					{ prop, value: decl.value },
					{ boundSystem, boundText, isGrid, enabled: ruleIsLive },
				);
				if (styling) touchesStyle = true;
				if (isLayoutDecl({ prop, value: decl.value })) touchesLayout = true;
				for (const name of tokenRefsIn(decl.value, tokenPrefixes))
					tokenRefs.push({ file: rel, line, name, scopeLines });
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
			else for (const f of collapsePerRule(pending)) emit({ ...f, selector, media });

			for (const cls of keyClasses) declared.push({ file: rel, line: ruleLine, cls, scopeLines });
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
	// Same rules, other channel. A stylesheet-only checker leaves `style={{ … }}`
	// entirely unexamined, which is the shape an agent reaches for when it wants
	// something to look right immediately — so tightening the CSS gate quietly
	// makes the unchecked path the attractive one.
	for (const el of inlineStyles) {
		// `report` would drop it anyway; skipping first keeps a scoped hook run
		// from classifying every inline style in the repo on every edit.
		if (!reports(el.file)) continue;
		const scopeLines = [el.line, el.line - 1];
		const whole = ruleIsLive('system/inline-style') ? inlineStyle(el) : null;
		if (whole) {
			report({ ...whole, file: el.file, line: el.line, code: whole.code ?? whole.message, scopeLines });
			continue;
		}

		const isGrid = el.decls.some((d) => isGridDecl(d.prop, d.value));
		const pending: PendingFinding[] = [];
		for (const d of el.decls) {
			const { finding } = classifyDeclaration(d, { isGrid, enabled: ruleIsLive });
			if (finding)
				pending.push({
					...finding,
					line: d.line ?? el.line,
					code: finding.code ?? finding.message,
					suffix: ' (inline)',
				});
		}
		for (const f of collapsePerRule(pending))
			report({ ...f, file: el.file, message: `${f.message}${f.suffix ?? ''}`, code: f.code ?? f.message, scopeLines });
	}

	// ── CSS-in-JS template literals ───────────────────────────────────────────
	// The third channel, through the same classifier as the other two. A
	// `styled(Button)` template is the stylesheet pass's "class bound to a
	// design-system component", written somewhere no stylesheet can see.
	for (const tpl of cssInJs) {
		if (!reports(tpl.file)) continue;
		const supp = suppByFile.get(tpl.file);
		if (tpl.error) {
			// Not a finding: an interpolation-driven template is opaque by design,
			// and a rule that fired on every one of them would just be turned off.
			// It is still recorded, so a clean report can be checked against it.
			diagnostics.parseErrors.push({ file: tpl.file, message: `css-in-js at line ${tpl.line}: ${tpl.error}` });
			continue;
		}

		const boundSystem: Binding[] = tpl.isSystem ? [{ tag: tpl.target, isSystem: true }] : [];
		const boundText: Binding[] = tpl.isText ? [{ tag: tpl.target, isSystem: true, isText: true }] : [];

		for (const group of tpl.groups) {
			const onTarget = group.onTarget;
			const pending: PendingFinding[] = [];
			for (const d of group.decls) {
				if (supp)
					for (const name of tokenRefsIn(d.value, tokenPrefixes))
						tokenRefs.push({ file: tpl.file, line: d.line ?? tpl.line, name, scopeLines: [tpl.line] });
				const { finding } = classifyDeclaration(d, {
					boundSystem: onTarget ? boundSystem : [],
					boundText: onTarget ? boundText : [],
					isGrid: group.isGrid,
					enabled: ruleIsLive,
				});
				if (finding) pending.push({ ...finding, line: d.line ?? tpl.line });
			}
			// Held whole, not bounded here. The selector is the only thing telling
			// two otherwise identical findings in one template apart, and it never
			// reaches `code` — so bounding it at capture made two of them
			// byte-identical and the dedupe folded them into one, dropping a real
			// violation. It stays in `suffix`, which is also what carries it across
			// the token pass's rebuild of `message`; the line bound at the end of
			// `analyze` is where it gets shortened, from the front, so the part
			// that distinguishes two sibling selectors is the part that survives.
			const where = group.selector ? ` in \`${group.selector}\`` : '';
			for (const f of collapsePerRule(pending))
				report({
					...f,
					file: tpl.file,
					message: `${f.message}${where} (css-in-js)`,
					code: `css-in-js:${f.code ?? f.message}`,
					suffix: `${where} (css-in-js)`,
					scopeLines: [tpl.line, tpl.line - 1],
				});
		}
	}

	// ── the checks that read the whole index ─────────────────────────────────
	for (const f of rawElements(ruleIsLive('system/raw-element') ? rawEls.filter((el) => reports(el.file)) : [], {
		layoutComponents: ds.layoutComponents,
		styledClasses,
		layoutClasses,
		registry: config.componentRegistry,
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
	// Deferred to here because the token set is only complete once every stylesheet
	// has been read, and a rule that fires against a half-built set reports the
	// design system's own tokens as unknown.

	// Name the replacement instead of the namespace. A finding that says
	// "13px is hardcoded — use a --wpds-* token" leaves the agent to invent one.
	for (const f of findings) {
		// An empty array is still working state, and `collapsePerRule` produces one
		// whenever it merges a group where nothing carried a hint. Dropped here too,
		// or `"hints": []` rides out into `--format json`.
		if (!f.hints?.length) {
			delete f.hints;
			continue;
		}
		// Match first, render from the match. The prose is for a reader; an
		// unambiguous substitution should not need a model to parse it back out of
		// a sentence in order to apply it — and the message that reader sees is
		// then a rendering of the same thing the consumer acts on, not a second
		// account of it. One entry per flagged declaration, matched or not: `fix`
		// clears a finding only when every declaration in it was substituted, and
		// an entry with no tokens is how it knows one was not.
		f.suggest = f.hints.map((h) => ({ ...h, tokens: tokensFor(tokenSet, h.prop, h.value) }));
		// Replaces what the classifier bounded rather than appending to it.
		// `--judge` composes the same message from the same entries when it settles
		// one; `declarationMessage` is the single place that decides how it reads.
		f.message = declarationMessage(f.suggest, f.suffix ?? '');
		if (f.rule === 'tokens/hardcoded-value' && f.hints.length === 1) f.decl = f.hints[0];
		delete f.hints;
		// `suffix` stays until the message is bounded below, which needs to know
		// which part of it is the channel marker. Nothing downstream of that sees it.
	}

	for (const f of unknownTokenFindings(tokenRefs, tokenSet.known)) report(f);

	// Dedupe: nesting and multi-selector rules can legitimately reach the same
	// declaration twice.
	//
	// Keyed on identity AND display, and run BEFORE the line bound below. A cap
	// decides how a finding reads; it must not get to decide whether a finding
	// survives, and folding on a capped message is exactly that — two distinct
	// declarations, or two distinct selectors, alike only up to the cut would
	// collapse into one. `code` alone would fold the other way, since on the
	// margin and gap rules it is deliberately just the property.
	const seen = new Set<string>();
	const unique = findings.filter((f) => {
		const k = `${f.rule}|${f.file}|${f.line}|${f.code ?? ''}|${f.message}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});

	// One report line per finding, bounded — once, here, because the token pass
	// above is the last of several writers of `message`, and a cap applied
	// before it would simply be overwritten. Each captured snippet is bounded
	// where it was captured; this bounds what a message assembled out of
	// several of them adds up to, keeping the channel marker on the end.
	for (const f of unique) {
		const tail = f.suffix ?? '';
		const body = tail && f.message.endsWith(tail) ? f.message.slice(0, -tail.length) : f.message;
		f.message = messageLine(body, tail);
	}
	// `suffix` is not dropped here. `--judge` runs after this and recomposes the
	// message of anything it settles, and it needs the marker as the datum it is
	// rather than read back off the end of a sentence. It is dropped where the
	// output is built, which is the last place it can be spent.

	unique.sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file) || a.line - b.line);
	directives.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

	return {
		findings: unique,
		directives,
		diagnostics,
		blocking: unique.some((f) => f.severity === 'error'),
		tokens: tokenSet,
		// Scoped and suppressed here, where the scope and the comments are: the
		// finding a control becomes is written later, by the judge.
		...(judge && config.enabled['patterns/judged-redirect']
			? {
					controls: controls.filter((c) => {
						const supp = suppByFile.get(c.file);
						return reports(c.file) && !(supp && isSuppressed(supp.byLine, c.line, 'patterns/judged-redirect'));
					}),
				}
			: {}),
	};
}

/** Stable identity for baselining: survives reformatting and unrelated edits. */
export const findingKey = (f: Pick<Finding, 'rule' | 'file' | 'code' | 'message'>): string =>
	`${f.rule}|${f.file}|${oneLine(String(f.code ?? f.message))}`;
