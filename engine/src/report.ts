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
import { RULES, renderTitle } from './rules.ts';
import type {
	AnalyzeResult, BaselinedResult, Config, Finding, ReportPayload, RuleDescriptor, RuleId, Severity,
} from './types.ts';

const SEV_MARK: Partial<Record<Severity, string>> = { error: '\u2717', warn: '\u2022' };

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

export function formatAgent(
	result: AnalyzeResult | BaselinedResult,
	config: Config,
	{ maxFindings = 0, showSuppressed = false }: { maxFindings?: number; showSuppressed?: boolean } = {},
): string {
	const { findings, diagnostics } = result;
	const kw = config.suppression.keyword;
	const title = titleFor(config);
	const lines: string[] = [];

	if (!findings.length) {
		lines.push('loupe: clean.');
	} else {
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
			lines.push(`${SEV_MARK[sev] ?? '\u2022'} ${ruleId} (${group.length}) \u2014 ${title(ruleId)}`);
			const show = group.slice(0, quota.get(ruleId) ?? 0);
			hidden += group.length - show.length;
			for (const f of show) lines.push(`    ${f.file}:${f.line}  ${f.message}`);
			if (group.length > show.length) lines.push(`    \u2026 ${group.length - show.length} more`);
		}
		if (hidden) {
			lines.push('');
			lines.push(`${hidden} finding(s) not shown \u2014 run \`loupe check --all --max-findings 0\` for the full list.`);
		}
		lines.push('');
		lines.push(`To suppress a specific finding, add \`${kw} <ruleId> -- <reason>\` on the offending line or the line above.`);
	}

	if (diagnostics.parseErrors.length) {
		lines.push('');
		lines.push(`! ${diagnostics.parseErrors.length} file(s) could not be parsed and were skipped:`);
		for (const e of diagnostics.parseErrors.slice(0, 5)) lines.push(`    ${e.file}: ${e.message}`);
	}
	if (showSuppressed && result.directives.length) {
		lines.push('');
		lines.push(`${result.directives.length} active suppression(s).`);
	}
	return lines.join('\n').replace(/^\n/, '');
}

/** One-line tally for the hook's success path. */
export function formatSummary(
	result: AnalyzeResult | BaselinedResult,
	{ prefix = true }: { prefix?: boolean } = {},
): string {
	const tag = prefix ? 'loupe: ' : '';
	const { findings } = result;
	if (!findings.length) return `${tag}clean.`;
	const errors = findings.filter((f) => f.severity === 'error').length;
	const warns = findings.length - errors;
	const top = [...new Set(findings.map((f) => f.rule))].slice(0, 3).join(', ');
	const parts = [];
	if (errors) parts.push(`${errors} blocking`);
	if (warns) parts.push(`${warns} advisory`);
	return `${tag}${parts.join(', ')}${top ? ` (${top})` : ''}.`;
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
