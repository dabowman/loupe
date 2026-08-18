#!/usr/bin/env node
/**
 * ds-hygiene — design-system conformance checking for front-end codebases.
 *
 * Exit codes are a contract; callers (CI, hooks, quality runners) depend on them:
 *   0  clean, or advisory findings only
 *   1  blocking findings
 *   2  could not run (bad usage, not a git worktree, config error)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyze } from '../src/analyze.mjs';
import { applyBaseline, readBaseline, writeBaseline } from '../src/baseline.mjs';
import { listPresets, loadConfig } from '../src/config.mjs';
import { changedFiles, toPosix } from '../src/discover.mjs';
import { RULES, canonicalRuleId, renderTitle } from '../src/rules.mjs';
import { formatAgent, formatJson, formatSarif, formatSummary } from '../src/report.mjs';
import { bumpAttempts, clearAttempts, emitBlocking, emitClean, hookRoot, parsePayload, payloadFile, readStdin } from '../src/hook.mjs';

const EXIT = { OK: 0, BLOCKED: 1, CANNOT_RUN: 2 };

function parseArgs(argv) {
	const args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) {
			args._.push(a);
			continue;
		}
		const [key, inline] = a.slice(2).split(/=(.*)/s);
		const needsValue = ['format', 'config', 'root', 'preset', 'files', 'max-findings', 'severity', 'baseline'].includes(key);
		if (needsValue) args.flags[key] = inline ?? argv[++i];
		else args.flags[key] = inline === undefined ? true : inline !== 'false';
	}
	return args;
}

const USAGE = `ds-hygiene <command> [options]

Commands:
  check                 Analyze the project (default)
  baseline              Record current findings as the accepted backlog
  suppressions          List every active suppression directive
  explain <rule>        Print a rule's guidance
  presets               List bundled presets
  hook                  Claude Code Stop-hook mode (reads payload on stdin)

Options:
  --changed             Only report findings in files changed vs. HEAD (default for hook)
  --all                 Report across the whole repo (default for check)
  --files a,b           Only report findings in these files
  --format <f>          agent | json | sarif        (default: agent)
  --max-findings <n>    Cap findings shown; 0 = no cap (default: 0)
  --severity <s>        error | warn — minimum severity to report
  --no-baseline         Ignore the baseline file for this run
  --preset <name>       Use a bundled preset instead of discovering config
  --config <path>       Explicit config file
  --root <path>         Project root (default: cwd, or CLAUDE_PROJECT_DIR under hook)
`;

function resolveScope(config, args, { defaultChanged = false }) {
	const given = ['all', 'changed', 'files'].filter((f) => args.flags[f]);
	if (given.length > 1) return { error: `conflicting scope flags: ${given.map((f) => `--${f}`).join(' ')}` };
	if (args.flags.all) return null;
	if (args.flags.files) return args.flags.files.split(',').map((f) => toPosix(f.trim())).filter(Boolean);
	if (args.flags.changed || defaultChanged) {
		const changed = changedFiles(config.root);
		if (changed === null) return { error: 'not a git worktree; use --all or --files' };
		return [...changed];
	}
	return null;
}

function filterSeverity(result, min) {
	if (min !== 'error') return result;
	const findings = result.findings.filter((f) => f.severity === 'error');
	return { ...result, findings };
}

async function main() {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const command = args._[0] && !args._[0].startsWith('-') ? args._[0] : 'check';

	if (args.flags.help || command === 'help') {
		process.stdout.write(USAGE);
		return EXIT.OK;
	}
	if (command === 'presets') {
		process.stdout.write(`${listPresets().join('\n')}\n`);
		return EXIT.OK;
	}

	const isHook = command === 'hook';
	const root = resolve(args.flags.root || (isHook ? hookRoot() : process.cwd()));
	if (!existsSync(root)) {
		process.stderr.write(`ds-hygiene: root does not exist: ${root}\n`);
		return EXIT.CANNOT_RUN;
	}

	let config;
	try {
		config = await loadConfig({ root, configPath: args.flags.config, preset: args.flags.preset });
	} catch (err) {
		process.stderr.write(`ds-hygiene: config error \u2014 ${err.message}\n`);
		return EXIT.CANNOT_RUN;
	}

	if (command === 'explain') {
		const id = canonicalRuleId(args._[1] || '');
		if (!RULES[id]) {
			process.stderr.write(`ds-hygiene: unknown rule "${args._[1]}"\n`);
			return EXIT.CANNOT_RUN;
		}
		const state = config.enabled[id] ? config.severityOf(id) : 'disabled (config does not satisfy its requirements)';
		process.stdout.write(`${id}  [${state}]\n  ${renderTitle(id, config.designSystem, config.suppression.keyword)}\n`);
		return EXIT.OK;
	}

	if (command === 'baseline') {
		const result = await analyze(config, { scope: null });
		const { path, count } = writeBaseline(root, args.flags.baseline || config.baselinePath, result);
		process.stdout.write(`ds-hygiene: baselined ${count} finding(s) \u2192 ${path}\n`);
		return EXIT.OK;
	}

	if (command === 'suppressions') {
		const { directives } = await analyze(config, { scope: null });
		if (args.flags.format === 'json') process.stdout.write(`${JSON.stringify(directives, null, 2)}\n`);
		else for (const d of directives) process.stdout.write(`${d.file}:${d.line}  ${d.rules.join(',')}  ${d.reason}\n`);
		return EXIT.OK;
	}

	if (command !== 'check' && !isHook) {
		process.stderr.write(`ds-hygiene: unknown command "${command}"\n\n${USAGE}`);
		return EXIT.CANNOT_RUN;
	}

	// ── check / hook ──────────────────────────────────────────────────────────
	let payload = {};
	if (isHook) payload = parsePayload(await readStdin());

	// A PostToolUse payload names the file just written; scope to it so drift is
	// reported at write time. Stop payloads carry no file and fall through to
	// the changed-file scope.
	const touched = isHook ? payloadFile(payload, root) : null;
	const scope = touched ? [touched] : resolveScope(config, args, { defaultChanged: isHook });
	if (scope && scope.error) {
		if (isHook) return emitClean(`ds-hygiene: skipped \u2014 ${scope.error}`);
		process.stderr.write(`ds-hygiene: ${scope.error}\n`);
		return EXIT.CANNOT_RUN;
	}

	let result;
	try {
		result = await analyze(config, { scope });
	} catch (err) {
		if (isHook) return emitClean(`ds-hygiene: skipped \u2014 ${err.message}`);
		process.stderr.write(`ds-hygiene: ${err.message}\n`);
		return EXIT.CANNOT_RUN;
	}

	if (!args.flags['no-baseline']) {
		const baseline = readBaseline(root, args.flags.baseline || config.baselinePath);
		result = applyBaseline(result, baseline);
	}
	if (args.flags.severity) result = filterSeverity(result, args.flags.severity);

	if (isHook) {
		const sessionId = payload.session_id || payload.sessionId || '';
		if (!result.blocking) {
			clearAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
			return emitClean(formatSummary(result));
		}
		const attempts = bumpAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
		const max = config.hook.maxAttempts;
		if (!sessionId && payload.stop_hook_active) {
			// No session id to budget against: fall back to the conservative
			// single-pass behaviour rather than risk looping the turn.
			return emitClean('ds-hygiene: blocking findings remain (retry budget unavailable).');
		}
		if (attempts > max) {
			clearAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
			return emitClean(`ds-hygiene: still failing after ${max} attempt(s) \u2014 gate stood down. ${formatSummary(result, { prefix: false })}`);
		}
		const report = formatAgent({ ...result, findings: result.findings.filter((f) => f.severity === 'error') }, config, {
			maxFindings: config.hook.maxFindings,
		});
		return emitBlocking(`${report}\n\n(attempt ${attempts} of ${max})`);
	}

	const maxFindings = Number(args.flags['max-findings'] ?? 0) || 0;
	const format = args.flags.format || 'agent';
	if (format === 'json') process.stdout.write(`${formatJson(result, config)}\n`);
	else if (format === 'sarif') process.stdout.write(`${formatSarif(result, config)}\n`);
	else {
		process.stdout.write(`${formatAgent(result, config, { maxFindings })}\n`);
		if (result.baselined) process.stdout.write(`\n${result.baselined} baselined finding(s) hidden.\n`);
	}
	return result.blocking ? EXIT.BLOCKED : EXIT.OK;
}

// Set exitCode rather than calling process.exit(): exit() tears down the
// process before a large stdout write has drained to a pipe, which silently
// truncates JSON and SARIF output when a caller pipes it anywhere.
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		process.stderr.write(`ds-hygiene: ${err?.stack || err}\n`);
		process.exitCode = EXIT.CANNOT_RUN;
	});
