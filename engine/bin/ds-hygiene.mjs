#!/usr/bin/env node
/**
 * ds-hygiene — design-system conformance checking for front-end codebases.
 *
 * Exit codes are a contract; callers (CI, hooks, quality runners) depend on them:
 *   0  clean, or advisory findings only
 *   1  blocking findings
 *   2  could not run (bad usage, not a git worktree, config error)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { analyze } from '../src/analyze.mjs';
import { applyTokenFixes } from '../src/autofix.mjs';
import { applyBaseline, readBaseline, writeBaseline } from '../src/baseline.mjs';
import { findConfig, listPresets, loadConfig, setComponentRegistry, setPatterns } from '../src/config.mjs';
import { changedFiles, isSource, toPosix } from '../src/discover.mjs';
import { RULES, canonicalRuleId, renderTitle } from '../src/rules.mjs';
import { formatAgent, formatJson, formatSarif, formatSummary } from '../src/report.mjs';
import { detectConfig } from '../src/detect.mjs';
import { loadPatterns } from '../src/patterns.mjs';
import { loadComponents } from '../src/components.mjs';
import { findExistingBaseline, isPluginContext, stateDir } from '../src/paths.mjs';
import {
	bumpAttempts, clearAttempts, emitBlocking, emitClean, hookRoot,
	parsePayload, payloadFile, readStdin, resolvedOptions,
} from '../src/hook.mjs';

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
		const needsValue = ['format', 'config', 'root', 'preset', 'files', 'max-findings', 'severity', 'baseline', 'patterns', 'components'].includes(key);
		if (needsValue) args.flags[key] = inline ?? argv[++i];
		else args.flags[key] = inline === undefined ? true : inline !== 'false';
	}
	return args;
}

const USAGE = `ds-hygiene <command> [options]

Commands:
  check                 Analyze the project (default)
  fix                   Apply the fixes the engine can make without judgement
  baseline              Record current findings as the accepted backlog
  suppressions          List every active suppression directive
  explain <rule>        Print a rule's guidance
  presets               List bundled presets
  detect                Show the config that would be inferred for this project
  init                  Write the inferred config to ds-hygiene.config.json
  status                Show the effective config: rules, severities, what blocks
  hook                  Claude Code hook mode (reads payload on stdin)

Options:
  --changed             Only report findings in files changed vs. HEAD (default for hook)
  --all                 Report across the whole repo (default for check)
  --files a,b           Only report findings in these files
  --format <f>          agent | json | sarif        (default: agent)
  --max-findings <n>    Cap findings shown; 0 = no cap (default: 0)
  --severity <s>        error | warn — minimum severity to report
  --no-baseline         Ignore the baseline file for this run
  --dry-run             Report what 'fix' would change without writing
  --force               Overwrite an existing config (init)
  --preset <name>       Use a bundled preset instead of discovering config
  --patterns <path>     Composite pattern registry (JSON)
  --components <path>   Component currency registry (JSON)
  --config <path>       Explicit config file
  --root <path>         Project root (default: cwd, or CLAUDE_PROJECT_DIR under hook)

With no config file present, the project is inspected and a config inferred.
Run 'ds-hygiene detect' to see what that produces, 'init' to write it down.
`;

function resolveScope(config, args, { defaultChanged = false }) {
	const given = ['all', 'changed', 'files'].filter((f) => args.flags[f]);
	if (given.length > 1) return { error: `conflicting scope flags: ${given.map((f) => `--${f}`).join(' ')}` };
	if (args.flags.all) return null;
	if (args.flags.files)
		return args.flags.files
			.split(',')
			.map((f) => f.trim())
			.filter(Boolean)
			// Findings are keyed repo-relative, so an absolute path matched nothing
			// and the run reported clean — the worst answer a gate can give.
			.map((f) => toPosix(isAbsolute(f) ? relative(config.root, resolve(f)) : f))
			.filter((f) => f && !f.startsWith('..'));
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
		if (isHook) return emitClean(`ds-hygiene: skipped \u2014 root does not exist: ${root}`);
		process.stderr.write(`ds-hygiene: root does not exist: ${root}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Resolved for every command, not just the hook. `status` exists to say what
	// the gate will do, and it cannot do that without the settings the gate reads.
	const { options, source: optionsSource } = resolvedOptions();

	let config;
	let detected = null;
	try {
		// An explicit path or preset wins; then a discovered project config; then
		// whatever the project itself implies. Without the last step a project
		// with no config file fell through to `generic`, which declares no
		// component layer and therefore silently disables every correlation rule.
		const explicitPreset =
			args.flags.preset || (options.preset && options.preset !== 'auto' ? options.preset : null);
		if (!args.flags.config && !explicitPreset && !findConfig(root)) {
			detected = detectConfig(root);
			if (options.projectPrefixes?.length) detected.config.namespaces.project = options.projectPrefixes;
		}
		config = await loadConfig({
			root,
			configPath: args.flags.config,
			preset: explicitPreset,
			inline: detected?.config,
			inferred: Boolean(detected),
		});
	} catch (err) {
		// Under the hook, EXIT.CANNOT_RUN is exit 2 — which blocks the turn. A
		// mistyped preset in the plugin settings would then block every turn in
		// every project with nothing the agent could do about it. A gate that
		// cannot configure itself stands aside and says so.
		if (isHook) return emitClean(`ds-hygiene: skipped \u2014 config error: ${err.message}`);
		process.stderr.write(`ds-hygiene: config error \u2014 ${err.message}\n`);
		return EXIT.CANNOT_RUN;
	}

	// The registry travels with the plugin; the project may also ship one. Merge
	// them with the project winning on id, because a project that has written
	// down its own version of `page-header` means that one, not the generic.
	if (args.flags.patterns) {
		try {
			const shipped = loadPatterns(JSON.parse(readFileSync(resolve(args.flags.patterns), 'utf8')));
			const own = new Set((config.patterns || []).map((p) => p.id));
			setPatterns(config, [...(config.patterns || []), ...shipped.filter((p) => !own.has(p.id))]);
		} catch (err) {
			if (!isHook) process.stderr.write(`ds-hygiene: could not read --patterns \u2014 ${err.message}\n`);
		}
	}

	// Same merge as --patterns: the project's own entries win on `package::name`.
	if (args.flags.components) {
		try {
			const shipped = loadComponents(JSON.parse(readFileSync(resolve(args.flags.components), 'utf8')));
			const merged = new Map(config.componentRegistry || []);
			for (const [key, entry] of shipped) if (!merged.has(key)) merged.set(key, entry);
			setComponentRegistry(config, merged);
		} catch (err) {
			if (!isHook) process.stderr.write(`ds-hygiene: could not read --components \u2014 ${err.message}\n`);
		}
	}

	// An inferred namespace list is a guess, and css/dead-class tells an agent to
	// delete code. Never let a guess drive a destructive rule at error severity.
	if (config.inferred && config.rules['css/dead-class']?.severity === 'error')
		config.rules['css/dead-class'].severity = 'warn';

	// Whether the gate may stop a turn.
	//
	// A config file is a deliberate statement about THIS project, so its
	// severities stand. An inferred config is a guess about a project the plugin
	// has just met, and blocking someone's turn on a guess is hostile — so a
	// guessed config is advisory-only unless blocking is explicitly turned on.
	// The plugin option can force advisory either way.
	const blockingAllowed = options.blocking === true || (!config.inferred && options.blocking !== false);
	if (isHook && !blockingAllowed) {
		for (const def of Object.values(config.rules)) if (def.severity === 'error') def.severity = 'warn';
	}
	if (options.maxAttempts) config.hook.maxAttempts = options.maxAttempts;
	if (options.maxFindings) config.hook.maxFindings = options.maxFindings;

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

	if (command === 'status') {
		const src =
			config.source.kind === 'file'
				? config.source.path
				: config.source.kind === 'preset'
					? `preset ${config.source.name}`
					: config.source.kind === 'inferred'
						? 'inferred (no config file found)'
						: config.source.kind;
		const state = stateDir(root);
		const lines = [
			`config:     ${src}`,
			`namespaces: ${(config.raw.namespaces?.project || []).join(', ') || '(none \u2014 css/dead-class inactive)'}`,
			`suppress:   ${config.suppression.keyword} <ruleId> -- <reason>`,
			`state:      ${state.dir}${state.scope === 'plugin-data' ? '  (outside your repo)' : ''}`,
			`options:    ${
				optionsSource === 'environment'
					? 'from the plugin environment (hook context)'
					: optionsSource === 'settings'
						? 'from ~/.claude settings'
						: 'none found — plugin defaults apply'
			}${options.blocking === undefined ? '' : `; blocking ${options.blocking ? 'on' : 'off'}`}`,
			`plugin:     ${isPluginContext() ? 'running as a plugin' : 'not running as a plugin'}`,
			'',
			'rules:',
		];
		for (const [id, def] of Object.entries(RULES)) {
			const sev = config.severityOf(id);
			// Report what will actually happen, not the configured severity: an
			// error-severity rule under a gate that isn't allowed to block is
			// advisory in practice, and saying otherwise here is how you end up
			// debugging a gate that "should" be blocking and isn't.
			const note = config.enabled[id]
				? sev === 'error' && blockingAllowed
					? 'BLOCKS'
					: sev === 'error'
						? 'advisory (would block if enabled)'
						: 'advisory'
				: `off (${sev === 'off' ? 'disabled in config' : `needs ${def.needs.join('+')}`})`;
			lines.push(`  ${id.padEnd(32)} ${note}`);
		}
		const blockers = Object.keys(RULES).filter((id) => config.enabled[id] && config.severityOf(id) === 'error');
		lines.push(
			'',
			blockingAllowed && blockers.length
				? `Turns are blocked by: ${blockers.join(', ')}`
				: 'Nothing blocks turns; every finding is advisory.'
		);
		if (config.inferred) {
			lines.push('css/dead-class is held to advisory because the namespaces were inferred, not configured.');
			if (!blockingAllowed)
				lines.push(
					'The gate reports only: this config was inferred and "Block turns on findings" is not on. Write a config with `ds-hygiene init`, or turn the setting on.'
				);
		} else if (!blockingAllowed) {
			lines.push('The gate reports only: "Block turns on findings" is off in the plugin settings.');
		}
		process.stdout.write(`${lines.join('\n')}\n`);
		return EXIT.OK;
	}

	if (command === 'detect' || command === 'init') {
		const info = detected || detectConfig(root);
		if (args.flags.format === 'json') {
			process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
			return EXIT.OK;
		}
		const lines = [
			`preset:     ${info.preset}  [${info.presetConfidence} confidence]`,
			`            ${info.presetReasons.join('; ')}`,
			`namespaces: ${info.namespaces.project.join(', ') || '(none found)'}  [${info.namespaceConfidence} confidence]`,
			`            ${Math.round(info.coverage * 100)}% of project CSS classes covered`,
			`scanned:    ${info.sampled.styles} style, ${info.sampled.markup} markup, ${info.sampled.references} reference file(s)`,
		];
		if (command === 'detect') {
			lines.push('', 'Inferred config:', JSON.stringify(info.config, null, 2));
			if (config.source.kind === 'file') lines.push('', `Note: ${config.source.path} exists and takes precedence.`);
			process.stdout.write(`${lines.join('\n')}\n`);
			return EXIT.OK;
		}
		const target = join(root, 'ds-hygiene.config.json');
		if (existsSync(target) && !args.flags.force) {
			process.stderr.write(`ds-hygiene: ${target} already exists (use --force)\n`);
			return EXIT.CANNOT_RUN;
		}
		writeFileSync(target, `${JSON.stringify(info.config, null, 2)}\n`);
		process.stdout.write(`${lines.join('\n')}\n\nWrote ${target}\n`);
		return EXIT.OK;
	}

	if (command === 'baseline') {
		const result = await analyze(config, { scope: null });
		const { path: target, scope } = findExistingBaseline(root, args.flags.baseline, config.baselinePath, { create: true });
		const { path, count } = writeBaseline(root, target, result);
		const where = scope === 'plugin-data' ? ' (plugin data \u2014 nothing written to your repo)' : '';
		process.stdout.write(`ds-hygiene: baselined ${count} finding(s) \u2192 ${path}${where}\n`);
		return EXIT.OK;
	}

	if (command === 'suppressions') {
		const { directives } = await analyze(config, { scope: null });
		if (args.flags.format === 'json') process.stdout.write(`${JSON.stringify(directives, null, 2)}\n`);
		else for (const d of directives) process.stdout.write(`${d.file}:${d.line}  ${d.rules.join(',')}  ${d.reason}\n`);
		return EXIT.OK;
	}

	// ── fix ───────────────────────────────────────────────────────────────────
	// Only substitutions the engine resolved to exactly one on-role token. The
	// baseline is deliberately ignored: it exists to stop the gate blocking on an
	// accepted backlog, and burning that backlog down is the point of this
	// command.
	if (command === 'fix') {
		const fixScope = resolveScope(config, args, { defaultChanged: false });
		if (fixScope && fixScope.error) {
			process.stderr.write(`ds-hygiene: ${fixScope.error}\n`);
			return EXIT.CANNOT_RUN;
		}
		let toFix;
		try {
			toFix = await analyze(config, { scope: fixScope });
		} catch (err) {
			process.stderr.write(`ds-hygiene: ${err.message}\n`);
			return EXIT.CANNOT_RUN;
		}
		const dry = Boolean(args.flags['dry-run']);
		const { applied, skipped } = applyTokenFixes(root, toFix.findings, { dry });
		const verb = dry ? 'would fix' : 'fixed';
		for (const f of applied) process.stdout.write(`${f.file}:${f.line}  ${f.prop}: ${f.value} \u2192 var(${f.token})\n`);
		for (const f of skipped) process.stdout.write(`skip ${f.file}:${f.line}  ${f.prop}: ${f.value} \u2014 ${f.why}\n`);
		const left = toFix.findings.length - applied.length;
		process.stdout.write(
			`\nds-hygiene: ${verb} ${applied.length} finding(s)${skipped.length ? `, skipped ${skipped.length}` : ''}. ` +
				`${left} left for review.\n`
		);
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
	if (touched && !isSource(config.sources, touched))
		return emitClean('ds-hygiene: skipped \u2014 not a checked file type.');
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
		const { path: bPath } = findExistingBaseline(root, args.flags.baseline, config.baselinePath);
		result = applyBaseline(result, readBaseline(root, bPath));
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
