/**
 * Formatters.
 *
 * The agent format is built as a nesting, and a per-finding line carries only
 * what varies inside it: context is the scarce resource, and a report repeating
 * the same remedy 200 times costs more to read than the findings are worth.
 *
 * Which of rule and path heads a block and which sub-heads it is the reader's
 * choice ({@link GroupBy}); everything else is the same either way.
 *
 * Design notes: docs/design/report.md
 */

import { createHash } from 'node:crypto';
import { findingKey } from './analyze.ts';
import { byBytes } from './discover.ts';
import { SEV_PAINT, bold, cyan, dim, green, magenta, red, yellow } from './color.ts';
import { RULES, renderTitle } from './rules.ts';
import { messageLine } from './text.ts';
import type {
	AnalyzeResult,
	BaselinedResult,
	Config,
	Directive,
	Finding,
	ReportPayload,
	RuleDescriptor,
	RuleId,
	Severity,
} from './types.ts';

const SEV_MARK: Partial<Record<Severity, string>> = { error: '\u2717', warn: '\u2022' };

/**
 * The same severity in words, on every rule-group heading. The glyph is
 * unambiguous once you know it and invisible until then, and a reader who does
 * not decode it reaches for `loupe status` — a second run of the tool to learn
 * something this line already knew.
 */
const SEV_WORD: Partial<Record<Severity, string>> = { error: 'blocking', warn: 'advisory' };

/**
 * Component mentions inside a finding's message.
 *
 * Two shapes, because a message names a component two ways: as a JSX tag
 * (`font-size on <Text>`) and bare, inside a composite's signature or a currency
 * verdict (`Card(CardBody(Stack))`). Bare names are matched only where a
 * signature puts them — against a bracket, a comma or an arrow, or at the end.
 */
const COMPONENT = /<\/?[A-Z][A-Za-z0-9]*\s*\/?>|<[A-Z][A-Za-z0-9]*(?=\s)|\b[A-Z][A-Za-z0-9]+(?=\s*[(),\u2192]|$)/g;

/**
 * The same message with those names painted — at print time, never at capture.
 *
 * `findingKey` falls back to `message` for a finding carrying no `code`, so a
 * name coloured any earlier would land in the baseline key and in the SARIF
 * fingerprint hashed from it.
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
 * `RULES[id].title` is a template and only the resolved config knows what fills
 * it. Guidance that names a placeholder is worse than no guidance: it is
 * actionable-looking and wrong. Bound per formatter, so a fourth format cannot
 * quietly skip it.
 */
const titleFor =
	(config: Config) =>
	(id: RuleId): string =>
		renderTitle(id, config.designSystem, config.suppression.keyword);

/** How far from a finding a directive can sit and still plausibly be for it. */
const NEAR = 5;
const MAX_NEAR_MISSES = 5;

/**
 * Directives written for a finding that is still firing — the placement missed.
 *
 * `isSuppressed` anchors to the finding's line and the one above it, so a
 * directive naming the right rule in the right file, a few lines off, mutes
 * nothing and says nothing. Every failure mode that produces one is silent, so
 * naming the two line numbers turns a blind retry into a move.
 */
function nearMisses(result: AnalyzeResult | BaselinedResult): string[] {
	const out: string[] = [];
	for (const f of result.findings) {
		if (out.length >= MAX_NEAR_MISSES) break;
		const near = result.directives.find(
			(d) => d.file === f.file && d.rules.includes(f.rule) && Math.abs(d.line - f.line) <= NEAR,
		);
		if (!near) continue;
		// The line a correct directive would occupy may already be taken by a directive
		// for a different rule on the same node. Only the nearest line is consulted, so
		// the remedy there is the comma list, not a move that displaces it.
		const occupant = result.directives.find(
			(d) => d.file === f.file && d.line === f.line - 1 && !d.rules.includes(f.rule),
		);
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
	return [...counts].sort((a, b) => b[1] - a[1] || byBytes(a[0], b[0]));
};

/** How many entries a one-line tally may name before it starts counting the rest. */
const TOP = 3;

/**
 * Where the findings sit — whether they cluster or spread, which is
 * `/loupe-audit`'s first question and the one a flat list buries.
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
 * A repo can report clean with its entire blocking backlog muted by directives,
 * and a count alone does not tell those apart — it is the rules that say what
 * the silence is covering. So name them, and say where the rest is.
 */
function suppressionLine(directives: readonly Directive[]): string {
	const rules = tally(directives.flatMap((d) => d.rules));
	const rest = rules.length - TOP;
	const files = new Set(directives.map((d) => d.file)).size;
	return `${directives.length} active suppression(s) in ${files} file(s), silencing ${rules
		.slice(0, TOP)
		.map(([rule, n]) => `${rule} (${n})`)
		.join(', ')}${rest > 0 ? `, +${rest} more rule(s)` : ''} — run \`loupe suppressions\` to read them.`;
}

/**
 * A finding's message with its registry note, bounded to the report's one line.
 *
 * The note rides as the `tail` the bound is built to spare, and is shortened
 * from the front like any other tail: a note is read for its last clause. This
 * is the only format with a line budget; JSON and SARIF ship the whole of it.
 */
const withNote = (f: Finding): string => (f.note ? messageLine(f.message, ` (${f.note})`) : f.message);

/**
 * Which axis the report groups on. The other one becomes the sub-heading, so
 * neither the rule nor the path is ever repeated line by line.
 *
 * Rule first is "what is wrong with this codebase, and in what order do I fix
 * it"; file first is "what do I have to change in the file I have open". Both
 * answer a real question and neither answers the other's.
 */
export const GROUP_BYS = ['rule', 'file'] as const;
export type GroupBy = (typeof GROUP_BYS)[number];
export const isGroupBy = (g: string): g is GroupBy => (GROUP_BYS as readonly string[]).includes(g);

/** A heading and everything filed under it. */
type Group = [key: string, findings: Finding[]];

/** Findings bucketed by key, first-seen order — what both axes are built from. */
function bucket(findings: readonly Finding[], key: (f: Finding) => string): Group[] {
	const out = new Map<string, Finding[]>();
	for (const f of findings) {
		const g = out.get(key(f));
		if (g) g.push(f);
		else out.set(key(f), [f]);
	}
	return [...out.entries()];
}

/** Rules richest first — the order the guidance under them wants to be read in. */
const byRank = (a: Group, b: Group): number => RULES[b[0] as RuleId].rank - RULES[a[0] as RuleId].rank;

/**
 * Files worst first: whatever blocks, then by weight, then by name. A path has
 * no rank to sort on, and first-seen order is whatever order the file walker
 * reached them in — neither meaningful nor stable across platforms.
 */
const byWeight = (a: Group, b: Group): number => {
	const blocking = (g: Finding[]): number => g.filter((f) => f.severity === 'error').length;
	return blocking(b[1]) - blocking(a[1]) || b[1].length - a[1].length || byBytes(a[0], b[0]);
};

/** The findings grouped on one axis, that axis's own order. */
const groupsOf = (findings: readonly Finding[], by: GroupBy): Group[] =>
	by === 'rule' ? bucket(findings, (f) => f.rule).sort(byRank) : bucket(findings, (f) => f.file).sort(byWeight);

/**
 * What makes two findings one line of the report: the same rule, in the same
 * file, printing the same text.
 *
 * The printed text rather than `code`: `code` is the baselining identity, and
 * for a margin it is the property alone — `margin-top: 2px` and `margin-top:
 * 12px` share it, and a line that printed one of them under the other's count
 * would be stating something false about the file.
 */
const sameLine = (f: Finding): string => `${f.rule}\u0000${f.file}\u0000${painted(f)}`;

/**
 * Identical findings, one entry each, largest first and then first-seen. Each
 * entry is sorted by line.
 *
 * Duplicates are the ordinary case in a real stylesheet — the same declaration
 * seven times in one file — and listed one by one they spend the budget seven
 * times on one decision. The count is also the signal: `×7` in one file says
 * "write a script", eleven singletons say "read each one".
 */
const collapse = (findings: readonly Finding[]): Finding[][] =>
	bucket(findings, sameLine)
		.map(([, run]) => run.sort((a, b) => a.line - b.line))
		.sort((a, b) => b.length - a.length);

/**
 * How concentrated a rule's findings are: `25 in 9 files, 11 distinct`.
 *
 * The total alone cannot say whether 25 is 25 decisions or the same three
 * repeated, and those want different remedies. Distinct counts the text, repo
 * wide, so one declaration copied into nine files is one. Under a file heading
 * the file count is that heading, and is left off.
 */
function concentration(group: readonly Finding[], nested: boolean): string {
	if (group.length < 2) return String(group.length);
	const files = new Set(group.map((f) => f.file)).size;
	const distinct = new Set(group.map(painted)).size;
	return `${group.length}${nested ? '' : ` in ${files} ${files === 1 ? 'file' : 'files'}`}, ${distinct} distinct`;
}

/** `✗ layout/margin-on-child (25 in 9 files, 11 distinct) blocking — margin — move spacing to the parent…` */
function ruleHeading(id: string, group: readonly Finding[], title: (id: RuleId) => string, nested: boolean): string {
	const sev = group[0]?.severity ?? 'warn';
	// Spans, not one paint: severity carries the mark and the word beside it, the
	// id carries the colour rules wear everywhere else, and the count is
	// arithmetic.
	return (
		`${SEV_PAINT[sev](SEV_MARK[sev] ?? '•')} ${magenta(id)} ${dim(`(${concentration(group, nested)})`)} ` +
		`${SEV_PAINT[sev](SEV_WORD[sev] ?? 'advisory')} — ${title(id as RuleId)}`
	);
}

/** `styles/card.css (3)` */
const fileHeading = (file: string, group: readonly Finding[]): string => `${bold(file)} ${dim(`(${group.length})`)}`;

/** A heading on either axis; `nested` when it is the sub-heading, under the other one. */
const heading = (
	by: GroupBy,
	key: string,
	group: readonly Finding[],
	title: (id: RuleId) => string,
	nested = false,
): string => (by === 'rule' ? ruleHeading(key, group, title, nested) : fileHeading(key, group));

/** How many line numbers a collapsed line lists before it stops; the count is already said. */
const MAX_LINES = 10;

/**
 * The findings of one group, by line, identical ones collapsed onto the first.
 *
 * The number alone: the path is the heading in either mode. Right-aligned so a
 * three-digit line does not push a two-digit one out of column — the message is
 * what the eye is scanning down. A collapsed line carries its count and every
 * line it stands for, so the batch can be found without a second run.
 */
function findingLines(group: readonly Finding[]): string[] {
	const runs = collapse(group).sort((a, b) => (a[0]?.line ?? 0) - (b[0]?.line ?? 0));
	const width = Math.max(...runs.map((run) => String(run[0]?.line).length));
	return runs.map((run) => {
		const [f] = run as [Finding, ...Finding[]];
		const at = run.map((g) => g.line);
		const more = at.length > MAX_LINES ? ', \u2026' : '';
		const times =
			run.length > 1 ? `  \u00d7${run.length} ${dim(`(lines ${at.slice(0, MAX_LINES).join(', ')}${more})`)}` : '';
		return `      ${dim(String(f.line).padStart(width))}  ${painted(f)}${times}`;
	});
}

/**
 * The report a reader gets.
 *
 * `terse` is the hook's version: blocking findings handed back mid-turn. The
 * lines it drops answer questions only somebody auditing a whole repo asks, and
 * the suppression inventory is repo-wide where a hook run has looked at two
 * files. The tally, the severity words and the next-step line stay.
 *
 * `concise` withholds the findings: the tally, then one heading per group on
 * whichever axis {@link GroupBy} heads on. The next-step lines go with them —
 * they instruct on lines nobody printed — while the diagnostics below stay at
 * either verbosity.
 */
export function formatAgent(
	result: AnalyzeResult | BaselinedResult,
	config: Config,
	{
		maxFindings = 0,
		terse = false,
		group = 'rule',
		concise = false,
	}: { maxFindings?: number; terse?: boolean; group?: GroupBy; concise?: boolean } = {},
): string {
	const { findings, diagnostics } = result;
	const kw = config.suppression.keyword;
	const title = titleFor(config);
	const lines: string[] = [];

	// First, always, findings or none — the count, the split, and what was read to
	// reach it, so a complete report can be told from a truncated pipe. The scanned
	// count for the same reason in the other direction: without it, "no
	// stylesheet/unparsed findings" and "no stylesheets were found" print alike.
	lines.push(`${formatSummary(result)} ${dim(`${diagnostics.filesScanned} file(s) scanned.`)}`);
	// Outside the findings branch on purpose: a clean run with a hundred
	// directives is the exact report this line exists to qualify.
	if (!terse && result.directives.length) lines.push(dim(suppressionLine(result.directives)));

	if (findings.length && concise) {
		lines.push('');
		for (const [key, all] of groupsOf(findings, group)) lines.push(heading(group, key, all, title));
	} else if (findings.length) {
		const sub: GroupBy = group === 'rule' ? 'file' : 'rule';
		const groups = groupsOf(findings, group);

		// Spend the budget round-robin across the groups being shown: filling it
		// first-come buries every other group behind whichever one sorts highest.
		// What it counts is printed lines, so identical findings collapsed onto one
		// cost one: duplicates make the budget go further rather than eat it.
		const runs = new Map<string, Finding[][]>(groups.map(([key, all]) => [key, collapse(all)]));
		const quota = new Map<string, number>(groups.map(([key]) => [key, 0]));
		let budget = maxFindings > 0 ? maxFindings : Infinity;
		let progress = true;
		while (budget > 0 && progress) {
			progress = false;
			for (const [key] of groups) {
				if (budget <= 0) break;
				const taken = quota.get(key) ?? 0;
				if (taken >= (runs.get(key)?.length ?? 0)) continue;
				quota.set(key, taken + 1);
				budget--;
				progress = true;
			}
		}

		let hidden = 0;
		for (const [key, all] of groups) {
			lines.push('');
			lines.push(heading(group, key, all, title));
			const show = (runs.get(key) ?? []).slice(0, quota.get(key) ?? 0).flat();
			hidden += all.length - show.length;
			for (const [subKey, subGroup] of groupsOf(show, sub)) {
				lines.push(`  ${heading(sub, subKey, subGroup, title, true)}`);
				lines.push(...findingLines(subGroup));
			}
			if (all.length > show.length) lines.push(dim(`  \u2026 ${all.length - show.length} more`));
		}
		if (hidden) {
			lines.push('');
			lines.push(
				dim(`${hidden} finding(s) not shown \u2014 run \`loupe check --all --max-findings 0\` for the full list.`),
			);
		}
		if (!terse) {
			const dense = densestLine(findings);
			if (dense) {
				lines.push('');
				lines.push(dim(dense));
			}
		}
		lines.push('');
		// The escape hatch is not the recommended action, and to a reader under a
		// blocked turn it reads as the fastest one. Name what fixes or explains first.
		lines.push(
			dim(
				'Next: `loupe fix` applies the unambiguous token substitutions, `loupe explain <ruleId>` says what a rule wants, ' +
					'`--format json` carries every finding whole.',
			),
		);
		lines.push(
			dim(
				`To suppress a specific finding, add \`${kw} <ruleId> -- <reason>\` on the offending line or the line above.`,
			),
		);
		// A directive for the right rule sitting just too far from its finding is the
		// most expensive thing to debug from the report alone: the hint is followed,
		// the finding is still there, and nothing says the placement failed.
		for (const m of nearMisses(result)) lines.push(yellow(`  ! ${m}`));
	}

	if (diagnostics.parseErrors.length) {
		lines.push('');
		lines.push(yellow(`! ${diagnostics.parseErrors.length} file(s) could not be parsed and were skipped:`));
		for (const e of diagnostics.parseErrors.slice(0, 5)) lines.push(`    ${dim(e.file)}: ${e.message}`);
	}
	// A prefix declared and not one token behind it: `tokens/unknown-token` is off,
	// and every invented name passes. Silent, this reads as a clean repo.
	if (config.designSystem.tokenPrefixes.length && !diagnostics.tokensKnown) {
		lines.push('');
		lines.push(
			yellow(
				`! no ${config.designSystem.tokenPrefixes.join('/')} tokens were found, so unknown ones cannot be reported \u2014 check designSystem.tokenSources against what the package actually ships.`,
			),
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
 * SARIF consumers track an alert across pushes by its fingerprint, so this
 * hashes `findingKey` — already the identity the baseline ratchets on — rather
 * than inventing a second answer to the same question. Hashed because the raw
 * key embeds arbitrary CSS text.
 *
 * Two findings can share that key, and a fingerprint has to be unique within a
 * run, so occurrences past the first are separated by their position among the
 * findings sharing it. Only duplicates pay for that.
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
 * `--format json` prints this and `formatHtml` embeds it, so the page and the JSON
 * cannot disagree about what was found — a divergence that would otherwise be
 * invisible, because each looks correct on its own.
 */
export function reportPayload(result: AnalyzeResult | BaselinedResult, config: Config): ReportPayload {
	const title = titleFor(config);
	return {
		version: 2,
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
			...('fixed' in result && result.fixed !== null ? { fixed: result.fixed } : {}),
		},
		rules: usedRules(result, config),
		// `rank` orders the report and `suffix` carries the channel marker; both are
		// working state, and this is the last place they can be dropped.
		findings: result.findings.map(({ rank, suffix, ...f }) => ({ ...f, fix: title(f.rule) })),
		suppressions: result.directives,
		parseErrors: result.diagnostics.parseErrors,
		config: { rules: config.rules, enabled: config.enabled },
	};
}

/**
 * How a baselined finding is marked in SARIF. `external`: the decision lives in
 * the baseline file, not in a directive beside the code. No `status`, which the
 * spec reads as `accepted` when absent.
 */
const BASELINE_SUPPRESSION = { kind: 'external', justification: 'accepted in the loupe baseline' } as const;

export function formatSarif(result: AnalyzeResult | BaselinedResult, config: Config): string {
	const title = titleFor(config);
	// Listed, not just counted: code scanning shows a suppressed result as
	// suppressed, where a backlog that is simply absent reads as a clean repo.
	// After the live findings, so their order is untouched; fingerprinted
	// together, which changes nothing — a baselined finding never shares a key
	// with a live one.
	const accepted = 'baselinedFindings' in result ? result.baselinedFindings : [];
	const all = [...result.findings, ...accepted];
	const fps = fingerprints(all);
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
							rules: usedRules({ ...result, findings: all }, config).map((r) => ({
								id: r.id,
								shortDescription: { text: r.title },
								// No `fullDescription`: the catalog holds one line of guidance per
								// rule, and shipping it twice under two names tells a reader there
								// is more to read when there is not. `help` points at the rest.
								help: { text: `Run \`loupe explain ${r.id}\` for this rule's guidance.` },
								// The namespace, so a security tab with fifteen rules can be
								// filtered down to the layout ones.
								properties: { tags: [r.id.split('/')[0] ?? 'loupe'] },
								defaultConfiguration: { level: r.severity === 'error' ? 'error' : 'warning' },
							})),
						},
					},
					results: all.map((f, i) => ({
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
						...(i >= result.findings.length ? { suppressions: [BASELINE_SUPPRESSION] } : {}),
					})),
					// The same counts `--format json` carries in its summary.
					...('baselined' in result
						? {
								properties: {
									baselined: result.baselined,
									...(result.fixed !== null ? { fixed: result.fixed } : {}),
								},
							}
						: {}),
				},
			],
		},
		null,
		2,
	);
}
