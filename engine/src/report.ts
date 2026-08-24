/**
 * Formatters.
 *
 * The agent format exists because context is the scarce resource: fix guidance
 * is printed once per rule group, and per-finding lines carry only what varies.
 * A report that repeats the same remedy 200 times costs more to read than the
 * findings are worth.
 */

import { RULES, renderTitle } from './rules.ts';
import type { AnalyzeResult, BaselinedResult, Config, Finding, RuleId, Severity } from './types.ts';

const SEV_MARK: Partial<Record<Severity, string>> = { error: '\u2717', warn: '\u2022' };

export function formatAgent(
	result: AnalyzeResult | BaselinedResult,
	config: Config,
	{ maxFindings = 0, showSuppressed = false }: { maxFindings?: number; showSuppressed?: boolean } = {},
): string {
	const { findings, diagnostics } = result;
	const kw = config.suppression.keyword;
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
			lines.push(`${SEV_MARK[sev] ?? '\u2022'} ${ruleId} (${group.length}) \u2014 ${renderTitle(ruleId, config.designSystem, kw)}`);
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

export function formatJson(result: AnalyzeResult | BaselinedResult, config: Config): string {
	return JSON.stringify(
		{
			version: 1,
			tool: 'loupe',
			blocking: result.blocking,
			summary: {
				total: result.findings.length,
				error: result.findings.filter((f) => f.severity === 'error').length,
				warn: result.findings.filter((f) => f.severity === 'warn').length,
				suppressions: result.directives.length,
				parseErrors: result.diagnostics.parseErrors.length,
			},
			findings: result.findings.map(({ rank, ...f }) => ({ ...f, fix: RULES[f.rule].title })),
			suppressions: result.directives,
			parseErrors: result.diagnostics.parseErrors,
			config: { rules: config.rules, enabled: config.enabled },
		},
		null,
		2
	);
}

export function formatSarif(result: AnalyzeResult | BaselinedResult, config: Config): string {
	const used = [...new Set(result.findings.map((f) => f.rule))];
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
							rules: used.map((id) => ({
								id,
								shortDescription: { text: RULES[id].title },
								defaultConfiguration: { level: config.severityOf(id) === 'error' ? 'error' : 'warning' },
							})),
						},
					},
					results: result.findings.map((f) => ({
						ruleId: f.rule,
						level: f.severity === 'error' ? 'error' : 'warning',
						message: { text: `${f.message} \u2014 ${RULES[f.rule].title}` },
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
