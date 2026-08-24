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

import { readFileSync, statSync } from 'node:fs';
import { RULES } from './rules.ts';
import { discover } from './discover.ts';
import { makeSuppressionParser, isSuppressed } from './suppressions.ts';
import { scanMarkup, harvestTokens, isLayoutDecl } from './markup.ts';
import { syntaxFor } from './syntax.ts';
import { SUBSTANTIAL, matches } from './patterns.ts';
import { harvestTokenDefs, readTokenSources, suggestionFor, tokensFor, tokenRefsIn } from './tokens.ts';
import {
	APPEARANCE_PROPS, FLEX_PROPS, GAP_PROPS, TYPE_PROPS,
	classesIn, classifyMargin, isHardcodedTokenValue, isInertValue, keySelector, ownDecls,
	resolvedSelectors, ruleIsGrid, usesToken,
} from './styles.ts';
import type {
	AnalyzeResult,
	Binding,
	ClassifiedFinding,
	ClassifyContext,
	ComponentImport,
	Composite,
	Config,
	CssInJsTemplate,
	Decl,
	Diagnostics,
	Directive,
	Finding,
	Hint,
	InlineStyleElement,
	Pattern,
	PendingFinding,
	RawElement,
	RuleId,
	Suppressions,
	TokenSet,
} from './types.ts';

/** First line of an unknown throw — a parser may reject with anything. */
const messageOf = (err: unknown): string =>
	(err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'parse failed';

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
	{ boundSystem = [], boundText = [], isGrid = false, options = {} }: ClassifyContext,
): { finding: ClassifiedFinding | null; styling: boolean } {
	const isMargin = prop === 'margin' || prop.startsWith('margin-');
	const marginKind = isMargin ? classifyMargin(value) : null;
	const isFlexish = FLEX_PROPS.has(prop) || (prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value));
	const hardcoded = isHardcodedTokenValue(prop, value, options);
	const styling =
		isMargin || isFlexish || GAP_PROPS.has(prop) || TYPE_PROPS.has(prop) || hardcoded || APPEARANCE_PROPS.has(prop);

	let finding: ClassifiedFinding | null = null;
	if (TYPE_PROPS.has(prop) && boundText[0]) {
		finding = { rule: 'typography/in-css', message: `${prop} on <${boundText[0].tag}>` };
	} else if (boundSystem[0] && APPEARANCE_PROPS.has(prop)) {
		finding = { rule: 'system/override', message: `<${boundSystem[0].tag}> \u2190 ${prop}` };
	} else if (isMargin) {
		// Zero and `auto` classify as null: a reset and a centering trick,
		// neither of which has a gap remedy to point at.
		if (marginKind === 'negative') finding = { rule: 'layout/negative-margin', message: `${prop}: ${value}`, code: prop };
		else if (marginKind) finding = { rule: 'layout/margin-on-child', message: `${prop}: ${value}`, code: prop };
	} else if (TYPE_PROPS.has(prop)) {
		if (!usesToken(value) && !isInertValue(value))
			finding = { rule: 'typography/untokenized', message: `${prop}: ${value}`, hint: { prop, value } };
	} else if (GAP_PROPS.has(prop)) {
		// Skipped on a component-bound class (component-internal flex, or a class
		// already on a layout primitive) and on a grid, neither of which is
		// convertible to a flex primitive.
		if (!boundSystem.length && !isGrid) finding = { rule: 'layout/in-css', message: `${prop}: ${value}`, code: prop };
	} else if (isFlexish) {
		const gridDisplay = prop === 'display' && /\bgrid\b/.test(value);
		if (!boundSystem.length && !isGrid && !gridDisplay) finding = { rule: 'layout/in-css', message: `${prop}: ${value}` };
	} else if (hardcoded) {
		finding = { rule: 'tokens/hardcoded-value', message: `${prop}: ${value}`, hint: { prop, value } };
	}
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
			message: group.map((f) => f.message).join('; '),
			hints: group.flatMap((f) => f.hints ?? (f.hint ? [f.hint] : [])),
			suffix: first.suffix,
			code: `${rule}:${props.sort().join(',')}`,
		});
	}
	return out;
}

export async function analyze(
	config: Config,
	{ scope = null }: { scope?: readonly string[] | null } = {},
): Promise<AnalyzeResult> {
	const ds = config.designSystem;
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
	const diagnostics: Diagnostics = { parseErrors: [], filesScanned: 0 };
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
		const scanned = scanMarkup(text, rel, ds);
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

		const emit = ({ rule, line, message, code, scopeLines = [], hint, hints }: PendingFinding): void => {
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
				suffix: undefined,
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
					{ boundSystem, boundText, isGrid, options: config.optionsOf('tokens/hardcoded-value') }
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
			const external = keyClasses.find((c) => config.isExternal(c) && !config.isProject(c));
			if (external && touchesStyle)
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
		if (el.isSystem) {
			const shown = el.decls.map((d) => d.prop).slice(0, 3).join(', ');
			const extra = el.decls.length + el.dynamic - Math.min(el.decls.length, 3);
			push(
				'system/inline-style',
				el.line,
				`<${el.tag}> style={{ ${shown || '\u2026'}${extra > 0 ? `, +${extra}` : ''} }}`,
				`<${el.tag}> inline-style`
			);
			continue;
		}

		const isGrid = el.decls.some(
			(d) => (d.prop === 'display' && /\bgrid\b/.test(d.value)) || d.prop.startsWith('grid-template') || d.prop.startsWith('grid-auto')
		);
		const pending: PendingFinding[] = [];
		for (const d of el.decls) {
			const { finding } = classifyDeclaration(d, { isGrid, options: config.optionsOf('tokens/hardcoded-value') });
			if (finding)
				pending.push({ ...finding, line: d.line ?? el.line, code: finding.code ?? finding.message, suffix: ' (inline)' });
		}
		for (const f of collapsePerRule(pending))
			push(f.rule, f.line, `${f.message}${f.suffix ?? ''}`, f.code, f.hints ?? (f.hint ? [f.hint] : undefined), f.suffix);
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
				});
				if (finding) pending.push({ ...finding, line: d.line ?? tpl.line });
			}
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
			message: `<${el.tag}> \u2192 <${el.suggest}>`,
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
	if ((dupEnabled || newEnabled) && composites.length) {
		const registry = config.patterns || [];

		// Largest match wins: a page header contains an action bar, and reporting
		// both says the same thing twice at two levels of the same tree.
		const bestMatch = (c: Composite): Pattern | null =>
			registry
				.filter((p) => p.size >= SUBSTANTIAL.minNodes && matches(p.node, c.tree))
				.sort((a, b) => b.size - a.size)[0] ?? null;

		const byPattern = new Map<string, Map<string, Composite>>(); // pattern id -> file -> best instance
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
			if (!newEnabled || c.size < SUBSTANTIAL.minNodes || c.depth < SUBSTANTIAL.minDepth) continue;
			const perFile = bySignature.get(c.signature) ?? new Map<string, Composite>();
			bySignature.set(c.signature, perFile);
			const prev = perFile.get(c.file);
			if (!prev || c.line < prev.line) perFile.set(c.file, c);
		}

		const emitComposite = (rule: RuleId, c: Composite, message: string): void => {
			if (!reports(c.file)) return;
			const supp = suppByFile.get(c.file);
			if (supp && isSuppressed(supp.byLine, c.line, rule)) return;
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: c.file,
				line: c.line,
				message,
				code: c.signature,
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
					`${c.signature} \u2014 rebuilds \`${id}\`, also in ${files.size - 1} other file(s); ${remedy}`
				);
			}
		}
		// Three for an unregistered shape: nothing says the second one was wrong,
		// but a third means it is the house style and belongs in the registry.
		for (const [sig, files] of bySignature) {
			if (files.size < 3) continue;
			for (const c of files.values())
				emitComposite('patterns/unregistered-composite', c, `${sig} \u2014 assembled in ${files.size} files, registered in none`);
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
			const key = `${ci.file} ${rule} ${ci.canonical} ${ci.package}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const supp = suppByFile.get(ci.file);
			if (supp && isSuppressed(supp.byLine, ci.line, rule)) continue;
			const remedy = entry.supersededBy ? ` → ${entry.supersededBy}` : '';
			const note = entry.note ? ` (${entry.note})` : '';
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: ci.file,
				line: ci.line,
				message: `${ci.canonical} (${ci.package})${remedy}${note}`,
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
	if (!f.hints?.length) continue;
	f.message =
		f.hints.map(({ prop, value }) => `${prop}: ${value}${suggestionFor(tokenSet, prop, value)}`).join('; ') +
		(f.suffix ?? '');
	// Keep the match structured as well as rendered. The prose is for a reader;
	// an unambiguous substitution should not need a model to parse it back out
	// of a sentence in order to apply it.
	const suggest = f.hints
		.map(({ prop, value }) => ({ prop, value, tokens: tokensFor(tokenSet, prop, value) }))
		.filter((s) => s.tokens.length);
	if (suggest.length) f.suggest = suggest;
	delete f.hints;
	delete f.suffix;
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

	for (const f of findings) delete f.suffix;

	// Dedupe: nesting and multi-selector rules can legitimately reach the same
	// declaration twice.
	const seen = new Set<string>();
	const unique = findings.filter((f) => {
		const k = `${f.rule}|${f.file}|${f.line}|${f.message}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});

	unique.sort((a, b) => b.rank - a.rank || a.file.localeCompare(b.file) || a.line - b.line);
	directives.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

	return {
		findings: unique,
		directives,
		diagnostics,
		blocking: unique.some((f) => f.severity === 'error'),
	};
}

/** Stable identity for baselining: survives reformatting and unrelated edits. */
export const findingKey = (f: Pick<Finding, 'rule' | 'file' | 'code' | 'message'>): string =>
	`${f.rule}|${f.file}|${String(f.code ?? f.message).replace(/\s+/g, ' ').trim()}`;
