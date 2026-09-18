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
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { RULES } from './rules.ts';
import { discover, toPosix } from './discover.ts';
import { makeSuppressionParser, isSuppressed } from './suppressions.ts';
import { scanMarkup, harvestTokens, isLayoutDecl } from './markup.ts';
import { syntaxFor } from './syntax.ts';
import { messageLine, messageParts, oneLine, snippet } from './text.ts';
import { SUBSTANTIAL, matches, nodeCount, partsOf } from './patterns.ts';
import { cssFilesUnder, harvestTokenDefs, readTokenSources, suggestionFor, tokensFor, tokenRefsIn } from './tokens.ts';
import {
	APPEARANCE_PROPS,
	FLEX_PROPS,
	GAP_PROPS,
	TYPE_PROPS,
	classesIn,
	classifyMargin,
	isHardcodedTokenValue,
	isInertValue,
	keySelector,
	ownDecls,
	resolvedSelectors,
	ruleIsGrid,
	usesToken,
} from './styles.ts';
import type {
	AnalyzeResult,
	Binding,
	ClassifiedFinding,
	ClassifyContext,
	ComponentEntry,
	ComponentImport,
	Composite,
	Config,
	Control,
	CssInJsTemplate,
	Decl,
	Diagnostics,
	Directive,
	Finding,
	Hint,
	InlineStyleElement,
	ParseError,
	Pattern,
	PatternRule,
	PendingFinding,
	RawElement,
	RuleHit,
	RuleId,
	Suppressions,
	TokenSet,
} from './types.ts';

/** First line of an unknown throw — a parser may reject with anything. */
const messageOf = (err: unknown): string =>
	(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'parse failed';

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
			let sheet;
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
 * Every `Name (@package)` a `supersededBy` string names.
 *
 * The field is prose — `Stack (@wordpress/ui, direction="row")`, or a sentence
 * naming two candidates and when each applies — so the components in it are
 * read off rather than parsed. A string that names none ("CSS grid or absolute
 * positioning") yields nothing, which is the honest answer: the remedy there is
 * hand-written, not an import swap.
 */
const namedReplacements = (supersededBy: string | undefined): { name: string; package: string }[] =>
	[...(supersededBy ?? '').matchAll(/([A-Z][\w.]*)\s*\(\s*(@[\w@/.-]+)/g)].map((m) => ({
		name: String(m[1]),
		package: String(m[2]),
	}));

/**
 * Whether a superseded entry's replacement is one the registry would recommend.
 *
 * True when the string names no component at all (the remedy is prose, and the
 * finding is still worth making) or when at least one named candidate is not
 * itself `locked` or `experimental`. False only when every candidate is one the
 * design system's own metadata says not to reach for yet — `DropdownMenu` is
 * the shipped case: `Menu (@wordpress/components)` is core-only and
 * `Menu (@wordpress/ui)` is in flux, so the finding asks for a migration onto
 * an API nobody should adopt, and the only answer available to whoever gets it
 * is a suppression restating what the registry already records.
 *
 * This is the same judgement `experimental` status already earns on the *import*
 * side, applied to the replacement rather than the thing being replaced.
 */
export function usableReplacement(
	registry: ReadonlyMap<string, ComponentEntry>,
	supersededBy: string | undefined,
): boolean {
	const candidates = namedReplacements(supersededBy);
	if (!candidates.length) return true;
	// Unknown to the registry is not a reason to stay silent: the registry
	// records currency, not existence, and a name it has never heard of is far
	// likelier to be a real component than a retracted one.
	return candidates.some((c) => {
		// `Menu.Group` is not its own entry — a compound component's currency is
		// its root's, and the registry keys the root. Without this the dotted
		// subcomponents of a locked component read as unknown, so `MenuGroup` and
		// `MenuItem` went on demanding a migration their parent was spared.
		const entry = registry.get(`${c.package}::${c.name}`) ?? registry.get(`${c.package}::${c.name.split('.')[0]}`);
		return !entry || (entry.status !== 'locked' && entry.status !== 'experimental');
	});
}

/**
 * The element map's analog, forwarded if the registry has since superseded it.
 *
 * The map is keyed by tag and names a bare component; the registry is keyed by
 * package and knows currency. Nothing reconciled them, so on a two-package
 * system the two rules contradicted each other: `system/raw-element` said
 * `<h3> → <Heading>`, and doing that earned a `system/superseded-component`
 * saying `Heading` is legacy. An agent that follows the first finding
 * manufactures the second, which is a loop a weaker model can run forever.
 *
 * Only forwards when *every* package carrying the name is stale, so a component
 * that is legacy in one package and recommended in another (WPDS has several)
 * keeps the bare name and lets the import rule speak to the package.
 */
function currentAnalog(registry: ReadonlyMap<string, ComponentEntry>, suggest: string): string {
	const entries = [...registry.values()].filter((e) => e.name === suggest);
	if (!entries.length || entries.some((e) => e.status === 'recommended')) return `<${suggest}>`;
	const forwarded = entries.find((e) => e.supersededBy)?.supersededBy;
	return forwarded ? forwarded : `<${suggest}>`;
}

/**
 * Which rule, if any, a single declaration violates.
 *
 * Shared by the stylesheet walk and the JSX inline-style walk. `margin-bottom:
 * 16px` in a stylesheet and `style={{ marginBottom: 16 }}` in JSX are the same
 * mistake with the same remedy, so they must not be able to drift into
 * different verdicts — which is exactly what happens when the chain is written
 * out twice.
 *
 * At most ONE finding per declaration, most specific first. Emitting both the
 * precise remedy and the generic one doubles the report and leaves the agent to
 * guess which to act on.
 *
 * `styling` reports whether the declaration counts as styling the element at
 * all, which feeds the raw-element and dead-class logic.
 */
function classifyDeclaration(
	{ prop, value }: Decl,
	{ boundSystem = [], boundText = [], isGrid = false, options = {}, enabled = () => true }: ClassifyContext,
): { finding: ClassifiedFinding | null; styling: boolean } {
	const isMargin = prop === 'margin' || prop.startsWith('margin-');
	const marginKind = isMargin ? classifyMargin(value) : null;
	const isFlexish = FLEX_PROPS.has(prop) || (prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value));
	const hardcoded = isHardcodedTokenValue(prop, value, options);
	const styling =
		isMargin || isFlexish || GAP_PROPS.has(prop) || TYPE_PROPS.has(prop) || hardcoded || APPEARANCE_PROPS.has(prop);

	// The declaration as written. Where the rule has no coarser identity to key
	// on, `code` carries the whole of it — only the printed message is bounded.
	const decl = `${prop}: ${value}`;

	// The two superseding branches are conditional on their own rule being live.
	// Both replace the ordinary verdict rather than adding to it, so when one is
	// off — a headless library, where a class on a component is how you are meant
	// to style it — the declaration has to fall through to the verdict it would
	// have had. Emitting a finding nobody will print deleted the `background:
	// #fff` beside it as well.
	let finding: ClassifiedFinding | null = null;
	if (TYPE_PROPS.has(prop) && boundText[0] && enabled('typography/in-css')) {
		finding = { rule: 'typography/in-css', message: `${prop} on <${boundText[0].tag}>` };
	} else if (boundSystem[0] && APPEARANCE_PROPS.has(prop) && enabled('system/override')) {
		finding = { rule: 'system/override', message: `<${boundSystem[0].tag}> \u2190 ${prop}` };
	} else if (isMargin) {
		// Zero and `auto` classify as null: a reset and a centering trick,
		// neither of which has a gap remedy to point at.
		if (marginKind === 'negative') finding = { rule: 'layout/negative-margin', message: decl, code: prop };
		else if (marginKind) finding = { rule: 'layout/margin-on-child', message: decl, code: prop };
	} else if (TYPE_PROPS.has(prop)) {
		if (!usesToken(value) && !isInertValue(value))
			finding = { rule: 'typography/untokenized', message: decl, code: oneLine(decl), hint: { prop, value } };
	} else if (GAP_PROPS.has(prop)) {
		// Skipped on a component-bound class (component-internal flex, or a class
		// already on a layout primitive) and on a grid, neither of which is
		// convertible to a flex primitive.
		if (!boundSystem.length && !isGrid) finding = { rule: 'layout/in-css', message: decl, code: prop };
	} else if (isFlexish) {
		const gridDisplay = prop === 'display' && /\bgrid\b/.test(value);
		if (!boundSystem.length && !isGrid && !gridDisplay)
			finding = { rule: 'layout/in-css', message: decl, code: oneLine(decl) };
	} else if (hardcoded) {
		finding = { rule: 'tokens/hardcoded-value', message: decl, code: oneLine(decl), hint: { prop, value } };
	}
	// Deliberately unbounded here. `message` is what the dedupe below tells two
	// findings apart by, and on the rules whose `code` is only the property
	// (`margin-*`, `gap`) it is the ONLY thing that tells them apart — so a cap
	// applied at capture folds two distinct declarations on one line into one
	// finding and drops a real violation. The line is bounded once, at the end
	// of `analyze`, after the dedupe has run.
	return { finding, styling };
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
			rule,
			// Bounded per contributor, so one long value cannot spend the whole
			// line and crowd the others out of a message that is several of them.
			// Safe to bound here where it is not at capture: a collapsed finding
			// always carries its own `code` below, so identity does not fall back
			// to this string.
			message: group.map((f) => snippet(f.message)).join('; '),
			hints: group.flatMap((f) => f.hints ?? (f.hint ? [f.hint] : [])),
			suffix: first.suffix,
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
	const unknownTokens: {
		file: string;
		line: number;
		name: string;
		scopeLines: number[];
		supp: Suppressions;
	}[] = [];

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
		let text;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		diagnostics.filesScanned++;
		const scanned = scanMarkup(text, rel, ds, patternRules);
		if (scanned.parseError) diagnostics.parseErrors.push({ file: rel, message: scanned.parseError });
		scanned.referenced.forEach((t) => referenced.add(t));
		scanned.stems.forEach((s) => stems.add(s));
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

	const stemList = [...stems];
	const isReferenced = (cls: string): boolean =>
		referenced.has(cls) || config.isNeverDead(cls) || stemList.some((s) => cls.startsWith(s));

	// ── walk CSS ──────────────────────────────────────────────────────────────
	const styledClasses = new Set<string>(); // classes CSS actually styles — feeds system/raw-element
	const layoutClasses = new Set<string>(); // classes whose CSS lays something out — feeds the same rule for div/span
	const seenDead = new Set<string>(); // `${file}\u0000${class}` — report each once per file

	for (const { abs, rel } of files.styles) {
		if (isLibrarySheet(rel)) continue; // the design system's own sheet, not the project's
		let text;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		diagnostics.filesScanned++;
		const supp = suppressionsFor(rel, text);
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

		let root;
		try {
			root = syntax.parse(text, { from: abs });
		} catch (err) {
			unparsed(messageOf(err));
			continue;
		}

		const emit = ({ rule, line, message, code, scopeLines = [], hint, hints, suffix }: PendingFinding): void => {
			if (!config.enabled[rule] || !reports(rel)) return;
			if (isSuppressed(supp.byLine, line, rule, scopeLines)) return;
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: rel,
				line,
				message,
				code: code ?? message,
				rank: RULES[rule].rank,
				hints: hints || (hint ? [hint] : undefined),
				// Forwarded rather than blanked. Nothing in this channel sets one
				// today, but `collapsePerRule` carries `suffix` through on purpose
				// and it is now what keeps a message tail out of the line bound —
				// so dropping it here would silently disarm that for whichever rule
				// reaches for it first.
				suffix,
			});
		};

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
					{ boundSystem, boundText, isGrid, options: config.optionsOf('tokens/hardcoded-value'), enabled: ruleIsLive },
				);
				if (styling) touchesStyle = true;
				if (isLayoutDecl({ prop, value: decl.value })) touchesLayout = true;
				for (const name of tokenRefsIn(decl.value, tokenPrefixes))
					unknownTokens.push({ file: rel, line, name, scopeLines, supp });
				if (finding) pending.push({ ...finding, line, scopeLines });
			}

			if (touchesStyle) for (const c of allClasses) styledClasses.add(c);
			if (touchesLayout) for (const c of allClasses) layoutClasses.add(c);

			// Reaching into a third-party component's internals. One per rule, and
			// it replaces the per-declaration findings rather than adding to them.
			// A project prefix wins over a library one. `wp-parsely-*` matches the
			// `wp-` external prefix, and reporting a project's own class as a
			// library internal sends the agent to fix something it does not own.
			const external = keyClasses.find((c) => (config.isExternal(c) || library.classes.has(c)) && !config.isProject(c));
			if (external && touchesStyle && ruleIsLive('system/override'))
				emit({ rule: 'system/override', line: ruleLine, message: `.${external} (library internal)`, scopeLines });
			else for (const f of collapsePerRule(pending)) emit(f);

			// Dead class: only namespaces we own, and only the classes this rule
			// actually declares (ancestors belong to their own rule).
			for (const cls of keyClasses) {
				const key = `${rel}\u0000${cls}`;
				if (seenDead.has(key) || !config.isProject(cls) || isReferenced(cls)) continue;
				seenDead.add(key);
				emit({ rule: 'css/dead-class', line: ruleLine, message: `.${cls}`, scopeLines });
			}
		});
	}

	// ── inline styles ─────────────────────────────────────────────────────────
	// Same rules, other channel. A stylesheet-only checker leaves `style={{ … }}`
	// entirely unexamined, which is the shape an agent reaches for when it wants
	// something to look right immediately — so tightening the CSS gate quietly
	// makes the unchecked path the attractive one.
	for (const el of inlineStyles) {
		if (!reports(el.file)) continue;
		const supp = suppByFile.get(el.file);
		const muted = (rule: RuleId, line: number): boolean =>
			supp !== undefined && isSuppressed(supp.byLine, line, rule, [el.line, el.line - 1]);

		const push = (
			rule: RuleId,
			line: number,
			message: string,
			code?: string,
			hints?: Hint[],
			suffix?: string,
		): void => {
			if (!config.enabled[rule] || muted(rule, line)) return;
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: el.file,
				line,
				message,
				code: code ?? message,
				rank: RULES[rule].rank,
				hints,
				suffix,
			});
		};

		// On a design-system component the remedy is "use the props", not
		// "tokenize that value" — so one finding for the attribute supersedes
		// the per-declaration ones, the same way a library-internal override
		// supersedes advice about how to style it.
		if (el.isSystem && ruleIsLive('system/inline-style')) {
			const shown = el.decls
				.map((d) => d.prop)
				.slice(0, 3)
				.join(', ');
			const extra = el.decls.length + el.dynamic - Math.min(el.decls.length, 3);
			push(
				'system/inline-style',
				el.line,
				`<${el.tag}> style={{ ${shown || '\u2026'}${extra > 0 ? `, +${extra}` : ''} }}`,
				`<${el.tag}> inline-style`,
			);
			continue;
		}

		const isGrid = el.decls.some(
			(d) =>
				(d.prop === 'display' && /\bgrid\b/.test(d.value)) ||
				d.prop.startsWith('grid-template') ||
				d.prop.startsWith('grid-auto'),
		);
		const pending: PendingFinding[] = [];
		for (const d of el.decls) {
			const { finding } = classifyDeclaration(d, {
				isGrid,
				options: config.optionsOf('tokens/hardcoded-value'),
				enabled: ruleIsLive,
			});
			if (finding)
				pending.push({
					...finding,
					line: d.line ?? el.line,
					code: finding.code ?? finding.message,
					suffix: ' (inline)',
				});
		}
		for (const f of collapsePerRule(pending))
			push(
				f.rule,
				f.line,
				`${f.message}${f.suffix ?? ''}`,
				f.code,
				f.hints ?? (f.hint ? [f.hint] : undefined),
				f.suffix,
			);
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
						unknownTokens.push({ file: tpl.file, line: d.line ?? tpl.line, name, scopeLines: [tpl.line], supp });
				const { finding } = classifyDeclaration(d, {
					boundSystem: onTarget ? boundSystem : [],
					boundText: onTarget ? boundText : [],
					isGrid: group.isGrid,
					options: config.optionsOf('tokens/hardcoded-value'),
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
			for (const f of collapsePerRule(pending)) {
				if (!config.enabled[f.rule]) continue;
				if (supp && isSuppressed(supp.byLine, f.line, f.rule, [tpl.line, tpl.line - 1])) continue;
				findings.push({
					rule: f.rule,
					severity: config.severityOf(f.rule),
					file: tpl.file,
					line: f.line,
					message: `${f.message}${where} (css-in-js)`,
					suffix: `${where} (css-in-js)`,
					code: `css-in-js:${f.code ?? f.message}`,
					rank: RULES[f.rule].rank,
					hints: f.hints ?? (f.hint ? [f.hint] : undefined),
				});
			}
		}
	}

	// ── raw elements with a design-system analog ──────────────────────────────
	for (const el of rawEls) {
		if (!config.enabled['system/raw-element'] || !reports(el.file)) continue;
		const supp = suppByFile.get(el.file);
		if (supp && isSuppressed(supp.byLine, el.line, 'system/raw-element')) continue;
		// A `styledOnly` mapping only earns its suggestion when the element is doing
		// what the suggested component is for. `<span>` → `<Text>` needs styling of
		// any kind; `<div>` → a layout primitive needs the div to actually lay
		// something out. Accepting any styling for both told agents to turn every
		// bordered `<div>` into an `<HStack>` — the largest single source of
		// findings in a real repo, and wrong nearly every time.
		if (el.styledOnly) {
			const suggestsLayout = String(el.suggest)
				.split('/')
				.some((n) => ds.layoutComponents.includes(n.trim()));
			const laidOut = el.inlineLayout || el.classes.some((c) => layoutClasses.has(c));
			const styled = el.inlineStyled || el.classes.some((c) => styledClasses.has(c));
			if (suggestsLayout ? !laidOut : !styled) continue;
		}
		findings.push({
			rule: 'system/raw-element',
			severity: config.severityOf('system/raw-element'),
			file: el.file,
			line: el.line,
			message: `<${el.tag}> \u2192 ${currentAnalog(config.componentRegistry, el.suggest)}`,
			code: `<${el.tag}>`,
			rank: RULES['system/raw-element'].rank,
		});
	}

	// ── composite drift ───────────────────────────────────────────────────────
	// The only findings here that cannot exist in one file. A sixth bespoke page
	// header is not a defect anywhere in particular — it is a defect in the set,
	// so the index has to be whole-repo even when the report is scoped to one file.
	const dupEnabled = config.enabled['patterns/duplicate-composite'];
	const newEnabled = config.enabled['patterns/unregistered-composite'];
	const supEnabled = config.enabled['patterns/superseded-composite'];
	if ((dupEnabled || newEnabled || supEnabled) && (composites.length || ruleHits.length)) {
		const registry = config.patterns || [];
		// Components whose anatomy the registry declares: an entry whose
		// `canonical` is the root of its own signature.
		const anatomyRoots = registry.flatMap((p) =>
			p.node && p.canonical && p.canonical === p.node.name.split('.')[0] ? [p.canonical] : [],
		);

		// Largest match wins: a page header contains an action bar, and reporting
		// both says the same thing twice at two levels of the same tree.
		const bestMatch = (c: Composite): Pattern | null =>
			registry
				.filter((p) => p.node !== null && p.size >= SUBSTANTIAL.minNodes && matches(p.node, c.tree))
				.sort((a, b) => b.size - a.size)[0] ?? null;

		// The shape a pattern exists to replace. Unlike the two rules below this
		// one, it is a per-file defect and not a set-level one: the file in hand
		// built the clunky version, and that is already worth saying once.
		//
		// Ties go to the most specific anti-shape that matched, not to the largest
		// replacement: a pattern's own `size` says nothing about how well its
		// anti-shape fit, and ranking by it means the smallest entry in the
		// registry can never win a tie it deserves.
		const avoidMatch = (c: Composite): Pattern | null => {
			let best: { pattern: Pattern; fit: number } | null = null;
			for (const p of registry) {
				let fit = 0;
				for (const a of p.avoid) if (matches(a, c.tree)) fit = Math.max(fit, nodeCount(a));
				if (fit && (!best || fit > best.fit)) best = { pattern: p, fit };
			}
			return best?.pattern ?? null;
		};

		const byPattern = new Map<string, Map<string, Composite>>(); // pattern id -> file -> best instance
		const bySuperseded = new Map<string, Map<string, Composite>>(); // pattern id -> file -> first instance
		const bySignature = new Map<string, Map<string, Composite>>(); // signature -> file -> best instance
		for (const c of composites) {
			const hit = dupEnabled ? bestMatch(c) : null;
			if (hit) {
				// A file that already imports the shared implementation is using the
				// pattern, not rebuilding it.
				if (hit.canonical && importsByFile.get(c.file)?.has(hit.canonical)) continue;
				const perFile = byPattern.get(hit.id) ?? new Map<string, Composite>();
				byPattern.set(hit.id, perFile);
				const prev = perFile.get(c.file);
				if (!prev || c.size > prev.size) perFile.set(c.file, { ...c, pattern: hit });
				continue;
			}
			const avoided = supEnabled ? avoidMatch(c) : null;
			if (avoided) {
				// Already importing the answer means the anti-shape sitting beside it
				// is deliberate, not a rebuild waiting to happen.
				if (avoided.canonical && importsByFile.get(c.file)?.has(avoided.canonical)) continue;
				const perFile = bySuperseded.get(avoided.id) ?? new Map<string, Composite>();
				bySuperseded.set(avoided.id, perFile);
				// Smallest wins, the opposite of `duplicate-composite`. Containment
				// means an outer wrapper matches whatever its children match, and
				// the whole form's tree is a worse answer to "where" than the one
				// field that should have been a Field.
				const prev = perFile.get(c.file);
				if (!prev || c.size < prev.size) perFile.set(c.file, { ...c, pattern: avoided });
				continue;
			}
			if (!newEnabled || c.size < SUBSTANTIAL.minNodes || c.depth < SUBSTANTIAL.minDepth) continue;
			// An anatomy entry matches from the component's root down, but a file
			// that renders only a row or a popup cuts the same anatomy lower —
			// `TableRow(TableCell,TableCell,TableCell)` is a Table's parts, not a
			// composition anyone chose. Only a tree of nothing *but* parts: a
			// `DialogPopup` holding a form is still the form.
			if (anatomyRoots.some((root) => partsOf(root, c.tree))) continue;
			const perFile = bySignature.get(c.signature) ?? new Map<string, Composite>();
			bySignature.set(c.signature, perFile);
			const prev = perFile.get(c.file);
			if (!prev || c.line < prev.line) perFile.set(c.file, c);
		}

		// These two rules lead with a signature and close with the remedy, and a
		// signature is as big as the tree it describes — a five-column card runs
		// past the line bound on its own. The remedy goes in `tail`, which that
		// bound is built to spare: eliding the shape still names the file count
		// and what to do about it, where eliding the end left neither.
		const emitComposite = (
			rule: RuleId,
			c: Pick<Composite, 'file' | 'line' | 'signature'>,
			signature: string,
			tail: string,
			group: string,
		): void => {
			if (!reports(c.file)) return;
			const supp = suppByFile.get(c.file);
			if (supp && isSuppressed(supp.byLine, c.line, rule)) return;
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: c.file,
				line: c.line,
				message: `${signature}${tail}`,
				suffix: tail,
				code: c.signature,
				group,
				rank: RULES[rule].rank,
			});
		};

		// Two files is already a pattern being rebuilt; one is just the first use.
		for (const [id, files] of byPattern) {
			if (files.size < 2) continue;
			for (const c of files.values()) {
				// With no canonical implementation recorded there is nothing to import
				// yet, and telling an agent to import it would send it looking for a
				// module that does not exist.
				const remedy = c.pattern?.canonical ? `import \`${c.pattern.canonical}\`` : 'extract one shared implementation';
				emitComposite(
					'patterns/duplicate-composite',
					c,
					c.signature,
					` \u2014 rebuilds \`${id}\`, also in ${files.size - 1} other file(s); ${remedy}`,
					id,
				);
			}
		}
		// One file is enough: this is a wrong choice made here, not a duplication
		// that only exists across the set.
		// A rule hit is the same finding from below the floor: the file in hand
		// made the choice the entry exists to replace. The canonical import means
		// the choice was deliberate, exactly as it does for a matched anti-shape.
		if (supEnabled)
			for (const h of ruleHits) {
				const entry = registry.find((p) => p.id === h.patternId);
				if (!entry) continue;
				if (entry.canonical && importsByFile.get(h.file)?.has(entry.canonical)) continue;
				const remedy = entry.canonical ? `use \`${entry.canonical}\`` : `follow the \`${entry.id}\` pattern`;
				emitComposite(
					'patterns/superseded-composite',
					{ file: h.file, line: h.line, signature: `rule:${h.rule}:${h.detail}` },
					h.detail,
					` \u2014 \`${entry.id}\` covers this; ${remedy}`,
					entry.id,
				);
			}
		for (const [id, files] of bySuperseded) {
			for (const c of files.values()) {
				const remedy = c.pattern?.canonical ? `use \`${c.pattern.canonical}\`` : `follow the \`${id}\` pattern`;
				emitComposite('patterns/superseded-composite', c, c.signature, ` \u2014 \`${id}\` covers this; ${remedy}`, id);
			}
		}
		// Three for an unregistered shape: nothing says the second one was wrong,
		// but a third means it is the house style and belongs in the registry.
		for (const [sig, files] of bySignature) {
			if (files.size < 3) continue;
			for (const c of files.values())
				emitComposite(
					'patterns/unregistered-composite',
					c,
					sig,
					` \u2014 assembled in ${files.size} files, registered in none`,
					sig,
				);
		}
	}

	// ── component currency ────────────────────────────────────────────────────
	// Whether the import itself — independent of any CSS — is still the
	// current best-practice choice. `experimental`-status entries never fire
	// here: WPDS itself flags those not-yet-safe to recommend, so the call is
	// contextual, not mechanical, and belongs in the authoring skill, not a
	// blocking check.
	if (config.enabled['system/locked-component'] || config.enabled['system/superseded-component']) {
		const seen = new Set<string>(); // one finding per file+component+package, not per usage
		for (const ci of componentImports) {
			if (ci.file === undefined) continue;
			const entry = config.componentRegistry.get(`${ci.package}::${ci.canonical}`);
			if (!entry || (entry.status !== 'legacy' && entry.status !== 'locked')) continue;
			const rule = entry.status === 'locked' ? 'system/locked-component' : 'system/superseded-component';
			if (!config.enabled[rule] || !reports(ci.file)) continue;
			// A replacement the registry itself will not recommend is not a
			// replacement. Firing anyway asks for a migration onto a private or
			// in-flux API, and the only honest answer an agent can give is a
			// suppression restating what the registry already knows.
			if (!usableReplacement(config.componentRegistry, entry.supersededBy)) continue;
			const key = `${ci.file} ${rule} ${ci.canonical} ${ci.package}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const supp = suppByFile.get(ci.file);
			// The declaration line and the one above it: both were live anchors
			// when every specifier reported on the declaration, and a directive
			// someone signed off must not go silent because the reporting moved.
			if (supp && isSuppressed(supp.byLine, ci.line, rule, [ci.declLine, ci.declLine - 1])) continue;
			const remedy = entry.supersededBy ? ` → ${entry.supersededBy}` : '';
			// The finding anchors at the import and there is one per file, so the
			// count is what says whether this is a one-line edit or a dozen call
			// sites — the question an agent otherwise answers by grepping the file.
			const uses = ci.uses > 1 ? ` ×${ci.uses}` : '';
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: ci.file,
				line: ci.line,
				message: `${ci.canonical} (${ci.package})${uses}${remedy}`,
				// Carried, not concatenated: the finalize pass caps `message`, and a
				// registry note spliced into it lost its own last clause to that cap
				// in every format at once.
				note: entry.note,
				code: `${rule}:${ci.package}:${ci.canonical}`,
				rank: RULES[rule].rank,
			});
		}
	}

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
		// Rebuilt from the hints, so each declaration goes back through `snippet` —
		// the message the classifier bounded is being replaced, not appended to.
		// Composed with `messageParts` rather than joined, because this is the one
		// message that is a list: a collapsed rule carries one remedy per property,
		// and a line bound that cuts the list mid-token loses the last remedy and
		// every remedy after it without saying so.
		f.message = messageParts(
			f.hints.map(({ prop, value }) => `${snippet(`${prop}: ${value}`)}${suggestionFor(tokenSet, prop, value)}`),
			f.suffix ?? '',
		);
		// Keep the match structured as well as rendered. The prose is for a reader;
		// an unambiguous substitution should not need a model to parse it back out
		// of a sentence in order to apply it.
		const suggest = f.hints
			.map(({ prop, value }) => ({ prop, value, tokens: tokensFor(tokenSet, prop, value) }))
			.filter((s) => s.tokens.length);
		if (suggest.length) f.suggest = suggest;
		if (f.rule === 'tokens/hardcoded-value' && f.hints.length === 1) f.decl = f.hints[0];
		delete f.hints;
		// `suffix` stays until the message is bounded below, which needs to know
		// which part of it is the channel marker. Nothing downstream of that sees it.
	}

	// An empty token set means nothing was found to check against — not that every
	// token is unknown. Staying silent is the only honest answer there.
	if (tokenSet.known.size && config.enabled['tokens/unknown-token']) {
		const seenUnknown = new Set();
		for (const { file, line, name, scopeLines, supp } of unknownTokens) {
			if (tokenSet.known.has(name) || !reports(file)) continue;
			const key = `${file}\u0000${name}`;
			if (seenUnknown.has(key)) continue;
			seenUnknown.add(key);
			if (isSuppressed(supp.byLine, line, 'tokens/unknown-token', scopeLines)) continue;
			findings.push({
				rule: 'tokens/unknown-token',
				severity: config.severityOf('tokens/unknown-token'),
				file,
				line,
				message: `var(${name})`,
				code: name,
				rank: RULES['tokens/unknown-token'].rank,
			});
		}
	}

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
		delete f.suffix;
	}

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
