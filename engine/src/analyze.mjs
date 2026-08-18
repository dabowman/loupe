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

import { readFileSync } from 'node:fs';
import { RULES } from './rules.mjs';
import { discover } from './discover.mjs';
import { makeSuppressionParser, isSuppressed } from './suppressions.mjs';
import { scanMarkup, harvestTokens } from './markup.mjs';
import { syntaxFor } from './syntax.mjs';
import {
	APPEARANCE_PROPS, FLEX_PROPS, GAP_PROPS, TYPE_PROPS,
	classesIn, classifyMargin, isHardcodedTokenValue, keySelector, ownDecls,
	resolvedSelectors, ruleIsGrid, usesToken,
} from './styles.mjs';

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
function classifyDeclaration({ prop, value }, { boundSystem = [], boundText = [], isGrid = false, options = {} }) {
	const isMargin = prop === 'margin' || prop.startsWith('margin-');
	const marginKind = isMargin ? classifyMargin(value) : null;
	const isFlexish = FLEX_PROPS.has(prop) || (prop === 'display' && /\b(inline-)?(flex|grid)\b/.test(value));
	const hardcoded = isHardcodedTokenValue(prop, value, options);
	const styling =
		isMargin || isFlexish || GAP_PROPS.has(prop) || TYPE_PROPS.has(prop) || hardcoded || APPEARANCE_PROPS.has(prop);

	let finding = null;
	if (TYPE_PROPS.has(prop) && boundText.length) {
		finding = { rule: 'typography/in-css', message: `${prop} on <${boundText[0].tag}>` };
	} else if (boundSystem.length && APPEARANCE_PROPS.has(prop)) {
		finding = { rule: 'system/override', message: `<${boundSystem[0].tag}> \u2190 ${prop}` };
	} else if (isMargin) {
		// Zero and `auto` classify as null: a reset and a centering trick,
		// neither of which has a gap remedy to point at.
		if (marginKind === 'negative') finding = { rule: 'layout/negative-margin', message: `${prop}: ${value}`, code: prop };
		else if (marginKind) finding = { rule: 'layout/margin-on-child', message: `${prop}: ${value}`, code: prop };
	} else if (TYPE_PROPS.has(prop)) {
		if (!usesToken(value)) finding = { rule: 'typography/untokenized', message: `${prop}: ${value}` };
	} else if (GAP_PROPS.has(prop)) {
		// Skipped on a component-bound class (component-internal flex, or a class
		// already on a layout primitive) and on a grid, neither of which is
		// convertible to a flex primitive.
		if (!boundSystem.length && !isGrid) finding = { rule: 'layout/in-css', message: `${prop}: ${value}`, code: prop };
	} else if (isFlexish) {
		const gridDisplay = prop === 'display' && /\bgrid\b/.test(value);
		if (!boundSystem.length && !isGrid && !gridDisplay) finding = { rule: 'layout/in-css', message: `${prop}: ${value}` };
	} else if (hardcoded) {
		finding = { rule: 'tokens/hardcoded-value', message: `${prop}: ${value}` };
	}
	return { finding, styling };
}

export async function analyze(config, { scope = null } = {}) {
	const ds = config.designSystem;
	const parseSuppressions = makeSuppressionParser(config.suppression);
	const files = discover({ root: config.root, sources: config.sources });

	const findings = [];
	const directives = [];
	const diagnostics = { parseErrors: [], filesScanned: 0 };
	const suppByFile = new Map();
	const inScope = scope ? new Set(scope) : null;
	const reports = (rel) => !inScope || inScope.has(rel);

	const suppressionsFor = (rel, text) => {
		if (!suppByFile.has(rel)) suppByFile.set(rel, parseSuppressions(text, rel));
		return suppByFile.get(rel);
	};

	// ── index markup, repo-wide ───────────────────────────────────────────────
	const referenced = new Set();
	const stems = new Set();
	const bindings = new Map(); // class -> binding[]
	const rawEls = [];
	const inlineStyles = [];

	for (const { abs, rel } of files.markup) {
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
			if (!bindings.has(b.cls)) bindings.set(b.cls, []);
			bindings.get(b.cls).push(b);
		}
		rawEls.push(...scanned.rawEls);
		inlineStyles.push(...(scanned.inlineStyles || []));
		suppressionsFor(rel, text);
	}

	for (const { abs } of files.references) {
		try {
			harvestTokens(readFileSync(abs, 'utf8'), referenced);
			diagnostics.filesScanned++;
		} catch {
			/* unreadable reference file just contributes nothing */
		}
	}

	const stemList = [...stems];
	const isReferenced = (cls) =>
		referenced.has(cls) || config.isNeverDead(cls) || stemList.some((s) => cls.startsWith(s));

	// ── walk CSS ──────────────────────────────────────────────────────────────
	const styledClasses = new Set(); // classes CSS actually styles — feeds system/raw-element
	const seenDead = new Set(); // `${file}\u0000${class}` — report each once per file

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
		const unparsed = (message) => {
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

		const syntax = await syntaxFor(rel);
		if (syntax.missing) {
			unparsed(`needs \`npm i -D ${syntax.missing}\` to be checked`);
			continue;
		}

		let root;
		try {
			root = syntax.parse(text, { from: abs });
		} catch (err) {
			unparsed(err.message.split('\n')[0]);
			continue;
		}

		const emit = ({ rule, line, message, code, scopeLines = [] }) => {
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
			});
		};

		root.walkRules((cssRule) => {
			const ruleLine = cssRule.source?.start?.line ?? 1;
			const selectors = resolvedSelectors(cssRule);
			const allClasses = [...new Set(selectors.flatMap(classesIn))];
			const keyClasses = [...new Set(selectors.map(keySelector).flatMap(classesIn))];
			if (!allClasses.length) return;

			// Bindings correlate against the KEY selector only: `.card .title`
			// styles `.title`, so `.card`'s component must not answer for it.
			const bound = keyClasses.flatMap((c) => bindings.get(c) || []);
			const boundSystem = bound.filter((b) => b.isSystem);
			const boundText = bound.filter((b) => b.isText);
			const isGrid = ruleIsGrid(cssRule);
			const scopeLines = [ruleLine, ruleLine - 1];
			let touchesStyle = false;

			// Held rather than emitted directly: if this rule turns out to target a
			// third-party component's internals, "stop styling this" supersedes
			// every per-declaration remedy inside it.
			const pending = [];

			for (const decl of ownDecls(cssRule)) {
				const prop = decl.prop.toLowerCase();
				const line = decl.source?.start?.line ?? ruleLine;
				const { finding, styling } = classifyDeclaration(
					{ prop, value: decl.value },
					{ boundSystem, boundText, isGrid, options: config.optionsOf('tokens/hardcoded-value') }
				);
				if (styling) touchesStyle = true;
				if (finding) pending.push({ ...finding, line, scopeLines });
			}

			if (touchesStyle) for (const c of allClasses) styledClasses.add(c);

			// Reaching into a third-party component's internals. One per rule, and
			// it replaces the per-declaration findings rather than adding to them.
			const external = keyClasses.find(config.isExternal);
			if (external && touchesStyle)
				emit({ rule: 'system/override', line: ruleLine, message: `.${external} (library internal)`, scopeLines });
			else for (const f of pending) emit(f);

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
		const muted = (rule, line) => supp && isSuppressed(supp.byLine, line, rule, [el.line, el.line - 1]);

		const push = (rule, line, message, code) => {
			if (!config.enabled[rule] || muted(rule, line)) return;
			findings.push({
				rule,
				severity: config.severityOf(rule),
				file: el.file,
				line,
				message,
				code: code ?? message,
				rank: RULES[rule].rank,
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
		for (const d of el.decls) {
			const { finding } = classifyDeclaration(d, { isGrid, options: config.optionsOf('tokens/hardcoded-value') });
			if (finding) push(finding.rule, d.line ?? el.line, `${finding.message} (inline)`, finding.code ?? finding.message);
		}
	}

	// ── raw elements with a design-system analog ──────────────────────────────
	for (const el of rawEls) {
		if (!config.enabled['system/raw-element'] || !reports(el.file)) continue;
		const supp = suppByFile.get(el.file);
		if (supp && isSuppressed(supp.byLine, el.line, 'system/raw-element')) continue;
		if (el.styledOnly && !el.inlineStyled && !el.classes.some((c) => styledClasses.has(c))) continue;
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

	// Dedupe: nesting and multi-selector rules can legitimately reach the same
	// declaration twice.
	const seen = new Set();
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
export const findingKey = (f) => `${f.rule}|${f.file}|${String(f.code ?? f.message).replace(/\s+/g, ' ').trim()}`;
