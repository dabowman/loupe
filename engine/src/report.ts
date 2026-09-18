/**
 * Formatters.
 *
 * The agent format exists because context is the scarce resource: fix guidance
 * is printed once per rule group, and per-finding lines carry only what varies.
 * A report that repeats the same remedy 200 times costs more to read than the
 * findings are worth.
 */

import { createHash } from 'node:crypto';
import { findingKey } from './analyze.ts';
import { SEV_PAINT, cyan, dim, green, magenta, red, yellow } from './color.ts';
import { RULES, renderTitle } from './rules.ts';
import { messageLine } from './text.ts';
import type {
	AnalyzeResult, BaselinedResult, Config, Directive, Finding, ReportPayload, RuleDescriptor, RuleId, Severity,
} from './types.ts';

const SEV_MARK: Partial<Record<Severity, string>> = { error: '\u2717', warn: '\u2022' };

/**
 * The same severity in words, on every rule-group heading.
 *
 * The glyph is unambiguous once you know it and invisible until then — a reader
 * who does not decode it reaches for `loupe status` and cross-references the
 * table of what blocks, which is a second run of the tool to learn something
 * this line already knew. `/loupe-audit` has to separate blocking from advisory
 * on every run, so that join was being paid every time.
 */
const SEV_WORD: Partial<Record<Severity, string>> = { error: 'blocking', warn: 'advisory' };

/**
 * Component mentions inside a finding's message.
 *
 * Two shapes, because a message names a component two ways: as a JSX tag
 * (`font-size on <Text>`, `<Card> \u2190 background`) and bare, inside a
 * composite's signature or a currency verdict (`Card(CardBody(Stack))`,
 * `Placeholder (@wordpress/components) \u2192 Notice`). Bare names are matched
 * only where a signature puts them — against a bracket, a comma or an arrow, or
 * at the end — so a stray capitalised word in a CSS value is left alone.
 */
const COMPONENT = /<\/?[A-Z][A-Za-z0-9]*\s*\/?>|<[A-Z][A-Za-z0-9]*(?=\s)|\b[A-Z][A-Za-z0-9]+(?=\s*[(),\u2192]|$)/g;

/**
 * The same message with those names painted \u2014 at print time, never at capture.
 *
 * `findingKey` falls back to `message` for a finding that carries no `code`, so
 * a name coloured any earlier would land in the baseline key and in the SARIF
 * fingerprint hashed from it: every accepted finding of those rules would come
 * back live the first time someone ran the tool in a terminal.
 */
const components = (message: string): string => message.replace(COMPONENT, cyan);

/**
 * A finding's line, with what `--judge` wrote in green and the rest through
 * `components`. Each span is its own fragment rather than a colour over the
 * line: the names beside it carry their own, and a nested pair would end the
 * green at the first one. A span the line bound elided is simply not painted.
 */
const painted = (f: Finding): string => {
	const line = withNote(f);
	let out = '';
	let at = 0;
	for (const span of f.judged?.spans ?? []) {
		const i = line.indexOf(span, at);
		if (i < 0) continue;
		out += `${components(line.slice(at, i))}${green(span)}`;
		at = i + span.length;
	}
	return out + components(line.slice(at));
};

/**
 * A rule title with its {placeholders} resolved.
 *
 * `RULES[id].title` is a template — `replace with a {tokenPrefix} token` — and
 * only the resolved config knows what fills it. The agent format has always
 * interpolated; JSON and SARIF shipped the raw template, so a consumer read
 * `{tokenPrefix}` where a human read `--wpds-*`. Guidance that names a
 * placeholder is worse than no guidance: it is actionable-looking and wrong.
 * Binding this per formatter keeps the obligation in one place, so a fourth
 * format cannot quietly skip it.
 */
const titleFor = (config: Config) => (id: RuleId): string =>
	renderTitle(id, config.designSystem, config.suppression.keyword);

/** How far from a finding a directive can sit and still plausibly be for it. */
const NEAR = 5;
const MAX_NEAR_MISSES = 5;

/**
 * Directives written for a finding that is still firing — the placement missed.
 *
 * `isSuppressed` anchors to the finding's line and the one above it, so a
 * directive naming the right rule in the right file, a few lines off, mutes
 * nothing and says nothing. Every failure mode that produces one is silent: a
 * comment below the element rather than above it, one inside a JSX attribute
 * list, one on an import specifier whose finding anchors elsewhere. Naming the
 * two line numbers turns a blind retry into a move.
 */
function nearMisses(result: AnalyzeResult | BaselinedResult): string[] {
	const out: string[] = [];
	for (const f of result.findings) {
		if (out.length >= MAX_NEAR_MISSES) break;
		const near = result.directives.find(
			(d) => d.file === f.file && d.rules.includes(f.rule) && Math.abs(d.line - f.line) <= NEAR,
		);
		if (!near) continue;
		// The line a correct directive would occupy may already be taken by a
		// directive for a different rule on the same node. Stacking a second
		// comment above it does not work — only the nearest line is consulted —
		// so the remedy there is the comma list, not a move that would displace
		// a suppression someone else signed off.
		const occupant = result.directives.find((d) => d.file === f.file && d.line === f.line - 1 && !d.rules.includes(f.rule));
		out.push(
			occupant
				? `a \`${f.rule}\` directive is on ${f.file}:${near.line}, but line ${f.line - 1} already carries one for ` +
					`\`${occupant.rules.join(', ')}\` — only the nearest line is read, so name both on it: ` +
					`\`${occupant.rules.join(', ')}, ${f.rule} -- <reason>\`.`
				: `a \`${f.rule}\` directive is on ${f.file}:${near.line}, but this finding anchors to line ${f.line} — ` +
					`move it to line ${f.line}, or the line directly above it.`,
		);
	}
	return out;
}

/** Tallies, densest first — the shape every "where does this concentrate" line wants. */
const tally = (keys: readonly string[]): [string, number][] => {
	const counts = new Map<string, number>();
	for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** How many entries a one-line tally may name before it starts counting the rest. */
const TOP = 3;

/**
 * Where the findings sit.
 *
 * `/loupe-audit`'s first instruction is to say whether findings cluster or
 * spread, and the report not answering it meant the answer was hand-rolled
 * from the report with `grep` and `awk` — three separate runs in the session
 * this line comes from, one of which silently returned nothing because its
 * character class excluded `/`.
 */
function densestLine(findings: readonly Finding[]): string {
	const files = tally(findings.map((f) => f.file));
	// One file is not a distribution, and naming it twice says nothing the
	// finding list above has not already said on every line.
	if (files.length < 2) return '';
	const rest = files.length - TOP;
	return `Densest: ${files
		.slice(0, TOP)
		.map(([file, n]) => `${file} (${n})`)
		.join(', ')}${rest > 0 ? `, then ${rest} more file(s)` : ''}.`;
}

/**
 * What is already silenced.
 *
 * This used to be behind an option no caller ever passed, so the count was
 * never printed anywhere: a repo could report clean with its entire blocking
 * backlog muted by directives, and the report said nothing to tell those two
 * states apart. An agent reading one concluded the codebase was token-clean and
 * told its user so. The count alone would not have stopped that — it is the
 * rules that say what the silence is covering — so name them, and say where
 * the rest is.
 */
function suppressionLine(directives: readonly Directive[]): string {
	const rules = tally(directives.flatMap((d) => d.rules));
	const rest = rules.length - TOP;
	const files = new Set(directives.map((d) => d.file)).size;
	return (
		`${directives.length} active suppression(s) in ${files} file(s), silencing ${rules
			.slice(0, TOP)
			.map(([rule, n]) => `${rule} (${n})`)
			.join(', ')}${rest > 0 ? `, +${rest} more rule(s)` : ''}` + ' — run `loupe suppressions` to read them.'
	);
}

/**
 * A finding's message with its registry note, bounded to the report's one line.
 *
 * The note rides as the `tail` the bound is built to spare, and is shortened
 * from the front like any other tail, because a note is read for its last
 * clause: "...it wanted Stack, not Grid" is the instruction and "planned for
 * deprecation" is the background. Bounding here rather than in `analyze` is the
 * point of carrying the note separately — this is the only format with a line
 * budget, and JSON and SARIF ship the whole of it.
 */
const withNote = (f: Finding): string => (f.note ? messageLine(f.message, ` (${f.note})`) : f.message);

/**
 * The report a reader gets.
 *
 * `terse` is the hook's version: blocking findings handed back mid-turn, to a
 * reader that is about to spend its retry budget on exactly those findings.
 * Two of the lines below answer questions only somebody auditing a whole repo
 * asks — where do findings cluster, what is already silenced — and the
 * suppression inventory is repo-wide where a hook run has looked at two files,
 * so under the hook it would be both noise and a non sequitur. The tally, the
 * severity words and the next-step line stay: the first two cost nothing, and
 * the last is most needed exactly where the reader is blocked and the only
 * other suggestion on offer is how to silence the thing blocking it.
 */
export function formatAgent(
	result: AnalyzeResult | BaselinedResult,
	config: Config,
	{ maxFindings = 0, terse = false }: { maxFindings?: number; terse?: boolean } = {},
): string {
	const { findings, diagnostics } = result;
	const kw = config.suppression.keyword;
	const title = titleFor(config);
	const lines: string[] = [];

	// First, always, findings or none — the count, the split, and what was read
	// to reach it. A report that opens on a rule group gives a reader no way to
	// tell a complete one from a truncated pipe, and the way that question gets
	// answered without this line is by running the tool again and counting. The
	// scanned count is here for the same reason in the other direction: without
	// it, "no `stylesheet/unparsed` findings" and "no stylesheets were found"
	// print identically, and only one of them means the CSS was checked.
	lines.push(`${formatSummary(result)} ${dim(`${diagnostics.filesScanned} file(s) scanned.`)}`);
	// Outside the findings branch on purpose: a clean run with a hundred
	// directives is the exact report this line exists to qualify.
	if (!terse && result.directives.length) lines.push(dim(suppressionLine(result.directives)));

	if (findings.length) {
		const byRule = new Map<RuleId, Finding[]>();
		for (const f of findings) {
			const group = byRule.get(f.rule) ?? [];
			group.push(f);
			byRule.set(f.rule, group);
		}
		const groups = [...byRule.entries()].sort((a, b) => RULES[b[0]].rank - RULES[a[0]].rank);

		// Spend the budget round-robin across rule groups. Filling it first-come
		// buries every other rule behind whichever one happens to rank highest,
		// and an agent that only ever sees one rule only ever fixes one rule.
		const quota = new Map<RuleId, number>(groups.map(([id]) => [id, 0]));
		let budget = maxFindings > 0 ? maxFindings : Infinity;
		if (budget !== Infinity) {
			let progress = true;
			while (budget > 0 && progress) {
				progress = false;
				for (const [id, group] of groups) {
					if (budget <= 0) break;
					const taken = quota.get(id) ?? 0;
					if (taken >= group.length) continue;
					quota.set(id, taken + 1);
					budget--;
					progress = true;
				}
			}
		} else {
			for (const [id, group] of groups) quota.set(id, group.length);
		}

		let hidden = 0;
		for (const [ruleId, group] of groups) {
			const sev = group[0]?.severity ?? 'warn';
			lines.push('');
			// Spans, not one paint: severity carries the mark and the word beside it,
			// the id carries the colour rules wear everywhere else, and the count is
			// arithmetic. Painting the whole heading by severity made the id the one
			// thing on the line that did not look like itself.
			lines.push(
				`${SEV_PAINT[sev](SEV_MARK[sev] ?? '\u2022')} ${magenta(ruleId)} ${dim(`(${group.length})`)} ` +
					`${SEV_PAINT[sev](SEV_WORD[sev] ?? 'advisory')} \u2014 ${title(ruleId)}`
			);
			const show = group.slice(0, quota.get(ruleId) ?? 0);
			hidden += group.length - show.length;
			// Location dimmed, message plain: the location is what an editor
			// consumes and the message is what a reader does, and the pair sits on
			// one line with nothing else to tell them apart.
			for (const f of show) lines.push(`    ${dim(`${f.file}:${f.line}`)}  ${painted(f)}`);
			if (group.length > show.length) lines.push(dim(`    \u2026 ${group.length - show.length} more`));
		}
		if (hidden) {
			lines.push('');
			lines.push(dim(`${hidden} finding(s) not shown \u2014 run \`loupe check --all --max-findings 0\` for the full list.`));
		}
		if (!terse) {
			const dense = densestLine(findings);
			if (dense) {
				lines.push('');
				lines.push(dim(dense));
			}
		}
		lines.push('');
		// The escape hatch used to be the only action the report named anywhere,
		// which reads as the recommended one — and to a reader under a blocked
		// turn, as the fastest one. Name the three that fix or explain first.
		lines.push(
			dim(
				'Next: `loupe fix` applies the unambiguous token substitutions, `loupe explain <ruleId>` says what a rule wants, ' +
					'`--format json` carries every finding whole.'
			)
		);
		lines.push(dim(`To suppress a specific finding, add \`${kw} <ruleId> -- <reason>\` on the offending line or the line above.`));
		// A directive for the right rule, sitting just too far from the finding
		// it was written for, is the single most expensive thing to debug from
		// the report alone: the hint above is already followed, the finding is
		// still there, and nothing says the placement is what failed. Retrying
		// blind is what an agent does next, and the retry message is identical.
		for (const m of nearMisses(result)) lines.push(yellow(`  ! ${m}`));
	}

	if (diagnostics.parseErrors.length) {
		lines.push('');
		lines.push(yellow(`! ${diagnostics.parseErrors.length} file(s) could not be parsed and were skipped:`));
		for (const e of diagnostics.parseErrors.slice(0, 5)) lines.push(`    ${dim(e.file)}: ${e.message}`);
	}
	// A prefix declared and not one token behind it: `tokens/unknown-token` is
	// off, and every invented name passes. Silent, this reads as a clean repo —
	// it is how a `tokenSources` path that stopped resolving went unnoticed.
	if (config.designSystem.tokenPrefixes.length && !diagnostics.tokensKnown) {
		lines.push('');
		lines.push(
			yellow(
				`! no ${config.designSystem.tokenPrefixes.join('/')} tokens were found, so unknown ones cannot be reported \u2014 check designSystem.tokenSources against what the package actually ships.`
			)
		);
	}
	return lines.join('\n');
}

/** One-line tally for the hook's success path. */
export function formatSummary(
	result: AnalyzeResult | BaselinedResult,
	{ prefix = true }: { prefix?: boolean } = {},
): string {
	const tag = prefix ? 'loupe: ' : '';
	const { findings } = result;
	if (!findings.length) return green(`${tag}clean.`);
	const errors = findings.filter((f) => f.severity === 'error').length;
	const warns = findings.length - errors;
	const top = [...new Set(findings.map((f) => f.rule))].slice(0, 3).join(', ');
	const parts = [];
	if (errors) parts.push(red(`${errors} blocking`));
	if (warns) parts.push(yellow(`${warns} advisory`));
	return `${tag}${parts.join(', ')}${top ? dim(` (${top})`) : ''}.`;
}

/** The rules a report actually used, richest first — the order every format prints in. */
function usedRules(result: AnalyzeResult | BaselinedResult, config: Config): RuleDescriptor[] {
	const ids = [...new Set(result.findings.map((f) => f.rule))];
	const title = titleFor(config);
	return ids
		.sort((a, b) => RULES[b].rank - RULES[a].rank)
		.map((id) => ({ id, title: title(id), rank: RULES[id].rank, severity: config.severityOf(id) }));
}

/**
 * An opaque, line-independent identity for each finding, in report order.
 *
 * SARIF consumers track an alert across pushes by its fingerprint, so a
 * fingerprint that moves when a line moves re-opens every alert in a reformatted
 * file. `findingKey` is already the identity the baseline ratchets on — which is
 * the same question asked by a different consumer — so this hashes that rather
 * than inventing a second answer to it. Hashed because the raw key embeds
 * arbitrary CSS text, and a fingerprint is meant to be compared, not read.
 *
 * Two findings can share that key: one file declaring `margin-bottom: 16px`
 * three times is three findings differing only by line, which the key
 * deliberately drops. A fingerprint has to be unique within a run — a repeated
 * one makes code scanning fold those three into a single alert, so two of the
 * three vanish from the Files tab — so occurrences past the first are separated
 * by their position among the findings sharing the key. Only duplicates pay for
 * it: a finding that is the only one of its key keeps a fingerprint nothing but
 * an edit to the finding itself can move.
 */
function fingerprints(findings: readonly Finding[]): string[] {
	const seen = new Map<string, number>();
	return findings.map((f) => {
		const key = findingKey(f);
		const nth = seen.get(key) ?? 0;
		seen.set(key, nth + 1);
		return createHash('sha256')
			.update(nth === 0 ? key : `${key}|#${nth}`)
			.digest('hex')
			.slice(0, 16);
	});
}

/**
 * The one machine-readable shape of a report.
 *
 * `formatJson` prints this and `formatHtml` embeds it, so the page and the JSON
 * cannot disagree about what was found — a divergence that would otherwise be
 * invisible, because each looks correct on its own.
 */
export function reportPayload(result: AnalyzeResult | BaselinedResult, config: Config): ReportPayload {
	const title = titleFor(config);
	return {
		version: 1,
		tool: 'loupe',
		blocking: result.blocking,
		summary: {
			total: result.findings.length,
			error: result.findings.filter((f) => f.severity === 'error').length,
			warn: result.findings.filter((f) => f.severity === 'warn').length,
			suppressions: result.directives.length,
			parseErrors: result.diagnostics.parseErrors.length,
			tokensKnown: result.diagnostics.tokensKnown,
			filesScanned: result.diagnostics.filesScanned,
			byFile: Object.fromEntries(tally(result.findings.map((f) => f.file))),
			// Only when a baseline was applied. Without it, the number the agent
			// format prints has no counterpart here, and a consumer cannot tell a
			// clean repo from one whose whole backlog is accepted.
			...('baselined' in result ? { baselined: result.baselined } : {}),
		},
		rules: usedRules(result, config),
		findings: result.findings.map(({ rank, ...f }) => ({ ...f, fix: title(f.rule) })),
		suppressions: result.directives,
		parseErrors: result.diagnostics.parseErrors,
		config: { rules: config.rules, enabled: config.enabled },
	};
}

export function formatJson(result: AnalyzeResult | BaselinedResult, config: Config): string {
	return JSON.stringify(reportPayload(result, config), null, 2);
}

export function formatSarif(result: AnalyzeResult | BaselinedResult, config: Config): string {
	const title = titleFor(config);
	const fps = fingerprints(result.findings);
	return JSON.stringify(
		{
			$schema: 'https://json.schemastore.org/sarif-2.1.0.json',
			version: '2.1.0',
			runs: [
				{
					tool: {
						driver: {
							name: 'Loupe',
							informationUri: 'https://github.com/dvdbwmn/loupe',
							rules: usedRules(result, config).map((r) => ({
								id: r.id,
								shortDescription: { text: r.title },
								// No `fullDescription`: the rule catalog holds exactly one line of
								// guidance per rule, and shipping it twice under two names tells a
								// reader there is more to read when there is not. `help` points at
								// where the rest of the reasoning actually lives.
								help: { text: `Run \`loupe explain ${r.id}\` for this rule's guidance.` },
								// The namespace, so a security tab with fifteen rules can be
								// filtered down to the layout ones.
								properties: { tags: [r.id.split('/')[0] ?? 'loupe'] },
								defaultConfiguration: { level: r.severity === 'error' ? 'error' : 'warning' },
							})),
						},
					},
					results: result.findings.map((f, i) => ({
						ruleId: f.rule,
						level: f.severity === 'error' ? 'error' : 'warning',
						message: { text: `${f.message} \u2014 ${title(f.rule)}` },
						partialFingerprints: { loupeCode: fps[i] ?? '' },
						locations: [
							{
								physicalLocation: {
									artifactLocation: { uri: f.file },
									region: { startLine: f.line },
								},
							},
						],
					})),
				},
			],
		},
		null,
		2
	);
}
