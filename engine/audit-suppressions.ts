#!/usr/bin/env node
/**
 * Find suppressions that have stopped matching.
 *
 * Precedence changed when the engine moved to one-finding-per-declaration,
 * most-specific-wins. A declaration that used to report as `R2`
 * (tokens/hardcoded-value) now reports as `system/override` if its class is
 * bound to a design-system component — because styling it in CSS at all is the
 * finding, and the token advice is moot.
 *
 * A `wpds-allow R2` on that line no longer matches anything. It doesn't error;
 * it just silently stops suppressing, and the finding reappears.
 *
 * This can't be detected by asking "is the suppression still used?" — a
 * *working* suppression also produces no finding. What it detects instead is
 * the tell: a live finding at a line that already carries a directive naming a
 * different rule.
 *
 * Usage, from the engine directory:
 *   npx tsx audit-suppressions.ts /path/to/repo [--preset wpds]
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Directive, Finding } from './src/types.ts';

/** The `--format json` report, in the two shapes this reads. */
interface JsonReport {
	findings: Finding[];
	suppressions: Directive[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'bin', 'loupe.mjs');

const root = resolve(process.argv[2] ?? process.cwd());
const extra = process.argv.slice(3);

const run = <T>(args: string[]): T => {
	try {
		return JSON.parse(
			execFileSync('node', [CLI, ...args, '--root', root, '--format', 'json'], {
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
		) as T;
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string } | null;
		// A blocking exit code still produced valid stdout.
		if (e?.stdout) {
			try {
				return JSON.parse(e.stdout) as T;
			} catch {
				/* fall through */
			}
		}
		const why = e?.stderr || (err instanceof Error ? err.message : String(err));
		console.error(`failed: loupe ${args.join(' ')}\n${why}`);
		process.exit(2);
	}
};

const directives = run<Directive[]>(['suppressions', ...extra]);
const { findings } = run<JsonReport>(['check', '--all', '--no-baseline', ...extra]);

// Findings indexed by the lines a directive could plausibly cover: the line
// itself and the two below it (a directive sits above the code it mutes, and a
// selector-line directive covers the rule's declarations).
const byFile = new Map();
for (const f of findings) {
	if (!byFile.has(f.file)) byFile.set(f.file, []);
	byFile.get(f.file).push(f);
}

const stale = [];
const orphaned = [];

for (const d of directives) {
	const nearby = (byFile.get(d.file) || []).filter((f: Finding) => f.line >= d.line && f.line <= d.line + 8);
	if (!nearby.length) {
		// Either it's working, or the code it covered is gone. Not distinguishable
		// from here, and a working suppression is the common case — so this is
		// reported separately and quietly.
		orphaned.push(d);
		continue;
	}
	const covered = new Set(d.rules);
	const uncovered = nearby.filter((f: Finding) => !covered.has(f.rule));
	if (uncovered.length) stale.push({ directive: d, findings: uncovered });
}

if (!stale.length) {
	console.log(`No re-pointing needed. ${directives.length} directive(s) checked.`);
} else {
	console.log(`${stale.length} suppression(s) no longer cover the finding at their location:\n`);
	for (const { directive: d, findings: fs } of stale) {
		console.log(`  ${d.file}:${d.line}`);
		console.log(`    suppresses: ${d.rules.join(', ')}`);
		console.log(`    now fires:  ${[...new Set(fs.map((f: Finding) => f.rule))].join(', ')}`);
		console.log(`    reason:     ${d.reason}`);
		console.log('');
	}
	console.log('Re-point each directive at the rule now firing, or fix the finding.');
}

console.log(
	`\n${directives.length} directive(s) total; ${orphaned.length} with no nearby finding ` +
		`(working as intended, or covering code that no longer exists).`
);
