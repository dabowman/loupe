/**
 * loupe — design-system conformance checking for front-end codebases.
 *
 * Exit codes are a contract; callers (CI, hooks, quality runners) depend on them:
 *   0  clean, or advisory findings only
 *   1  blocking findings
 *   2  could not run (bad usage, not a git worktree, config error)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { analyze } from './analyze.ts';
import { applyTokenFixes } from './autofix.ts';
import { applyBaseline, readBaseline, writeBaseline } from './baseline.ts';
import { findConfig, listPresets, loadConfig, setComponentRegistry, setPatterns } from './config.ts';
import { changedFiles, isSource, toPosix } from './discover.ts';
import { RULES, canonicalRuleId, isRuleId, renderTitle } from './rules.ts';
import { formatAgent, formatJson, formatSarif, formatSummary } from './report.ts';
import { detectConfig } from './detect.ts';
import { applyRegistries, readProfiles, selectProfiles } from './profiles.ts';
import type { RegistrySource } from './profiles.ts';
import { baselinePath, findExistingBaseline, isPluginContext, stateDir } from './paths.ts';
import { RULE_IDS } from './rules.ts';
import {
	bumpAttempts, clearAttempts, emitBlocking, emitClean, hookRoot, hookSilenced,
	parsePayload, payloadFile, readStdin, resolvedOptions,
} from './hook.ts';
import type { HookPayload } from './hook.ts';
import type { AnalyzeResult, BaselinedResult, Config } from './types.ts';
import type { DetectedConfig } from './detect.ts';

const EXIT = { OK: 0, BLOCKED: 1, CANNOT_RUN: 2 };

/** First line of an unknown throw. Anything can be thrown; only Errors carry a message. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The flags that take a value. Everything else is a boolean switch.
 *
 * Declared `as const` so the two halves cannot drift: this list decides what
 * consumes the next argv entry, and {@link Flags} decides what type comes back.
 */
const VALUE_FLAGS = [
	'format', 'config', 'root', 'preset', 'files', 'max-findings',
	'severity', 'baseline', 'patterns', 'components', 'profiles', 'profile',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

/**
 * Parsed command-line flags.
 *
 * Written out rather than left as a string-keyed record: `--files` carries a
 * path list and `--all` carries nothing, and a record that types both as
 * `string | boolean` pushes that distinction to every read site — which is
 * where it used to get lost.
 */
type Flags = { [K in ValueFlag]?: string } & {
	help?: boolean;
	all?: boolean;
	changed?: boolean;
	'no-baseline'?: boolean;
	'dry-run'?: boolean;
	force?: boolean;
};

interface Args {
	_: string[];
	flags: Flags;
}

const isValueFlag = (key: string): key is ValueFlag => (VALUE_FLAGS as readonly string[]).includes(key);

function parseArgs(argv: readonly string[]): Args {
	const positional: string[] = [];
	const flags: Record<string, string | boolean | undefined> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (!a.startsWith('--')) {
			positional.push(a);
			continue;
		}
		const [key, inline] = a.slice(2).split(/=(.*)/s);
		if (key === undefined) continue;
		if (isValueFlag(key)) flags[key] = inline ?? argv[++i];
		else flags[key] = inline === undefined ? true : inline !== 'false';
	}
	return { _: positional, flags: flags as Flags };
}

const USAGE = `loupe <command> [options]

Commands:
  check                 Analyze the project (default)
  fix                   Apply the fixes the engine can make without judgement
  baseline              Record current findings as the accepted backlog
  suppressions          List every active suppression directive
  explain <rule>        Print a rule's guidance
  presets               List bundled presets
  detect                Show the config that would be inferred for this project
  init                  Write the inferred config to loupe.config.json
  status                Show the effective config: rules, severities, what blocks
  hook                  Claude Code hook mode (reads payload on stdin)

Options:
  --changed             Only report findings in files changed vs. HEAD (default for hook)
  --all                 Report across the whole repo (default for check)
  --files a,b           Only report findings in these files
  --format <f>          agent | json | sarif        (default: agent)
  --max-findings <n>    Cap findings shown; 0 = no cap (default: 0)
  --severity <s>        error | warn — minimum severity to report
  --baseline <path>     Read/write the baseline here instead of the configured
                        path (default: .loupe-baseline.json in the project)
  --no-baseline         Ignore the baseline file for this run
  --dry-run             Report what 'fix' would change without writing
  --force               Overwrite an existing config (init)
  --preset <name>       Use a bundled preset instead of discovering config
  --patterns <path>     Composite pattern registry (JSON)
  --components <path>   Component currency registry (JSON)
  --profiles <dir>      Directory of design-system profiles; the ones matching
                        this project's imports supply their registries
  --profile <id>        Use this profile regardless of what the project imports
  --config <path>       Explicit config file
  --root <path>         Project root (default: the directory holding the config
                        that governs the cwd, or CLAUDE_PROJECT_DIR under hook)

Environment:
  LOUPE_OFF=1           Silence the hook for this session; 'loupe' typed by hand
                        still reports. Start Claude Code as 'LOUPE_OFF=1 claude'.
                        1/true/yes/on turn it on; anything else — 0 and false
                        included — leaves the hook running.

With no config file present, the project is inspected and a config inferred.
Run 'loupe detect' to see what that produces, 'init' to write it down.
`;

/**
 * Which files to report on: every file (`null`), a named set, or a refusal.
 * `null` is a real answer here, so the failure case has to be its own shape.
 */
type ScopeResult = string[] | null | { error: string };

function resolveScope(
	config: Config,
	args: Args,
	{ defaultChanged = false }: { defaultChanged?: boolean },
): ScopeResult {
	const given = (['all', 'changed', 'files'] as const).filter((f) => args.flags[f]);
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

function filterSeverity<T extends AnalyzeResult>(result: T, min: string): T {
	if (min !== 'error') return result;
	const findings = result.findings.filter((f) => f.severity === 'error');
	return { ...result, findings };
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const first = args._[0];
	const command = first && !first.startsWith('-') ? first : 'check';

	if (args.flags.help || command === 'help') {
		process.stdout.write(USAGE);
		return EXIT.OK;
	}
	if (command === 'presets') {
		process.stdout.write(`${listPresets().join('\n')}\n`);
		return EXIT.OK;
	}

	const isHook = command === 'hook';

	// Read the payload before anything can return.
	//
	// Claude Code writes it to this process's stdin, and a hook that exits
	// without draining leaves the writer holding a pipe nobody is reading: once
	// the payload outgrows the pipe buffer — which a Write of a large file does,
	// since `tool_input.content` carries the whole file — the write fails with
	// EPIPE instead of completing. Every early return below is downstream of
	// this line for that reason, the off switch most of all: silencing the gate
	// must not turn every large write into a broken pipe.
	const payload: HookPayload = isHook ? parsePayload(await readStdin()) : {};

	// Per-session off switch: `LOUPE_OFF=1 claude`.
	//
	// Silence, not advisory mode. An advisory finding still lands in the agent's
	// context, and an agent that sees a finding starts fixing it — which is the
	// whole complaint. The only way to work on something else is for the gate to
	// say nothing at all. Deliberately hook-only: `loupe check` typed by hand is
	// someone asking, and answering "nothing" would be a lie.
	if (isHook && hookSilenced()) return EXIT.OK;

	// The project, not the directory you happen to be standing in.
	//
	// The hook roots at CLAUDE_PROJECT_DIR; a typed command used to root at the
	// cwd, so the same repo had two roots and everything keyed off one of them
	// disagreed. `loupe baseline` in `packages/app` of a monorepo wrote
	// `packages/app/.loupe-baseline.json` with subdirectory-relative keys, and
	// the hook — rooted at the repo — never read it and blocked on the findings
	// that had just been accepted. Anchoring to the config the run is actually
	// governed by makes the two agree, because it is the same config file the
	// hook resolves. `--root` still overrides, for the case where someone means
	// the subdirectory.
	const explicitRoot = args.flags.root ?? (isHook ? hookRoot() : null);
	const anchor = explicitRoot ? null : findConfig(resolve(process.cwd()));
	const root = resolve(explicitRoot ?? (anchor ? dirname(anchor) : process.cwd()));
	if (!existsSync(root)) {
		if (isHook) return emitClean(`loupe: skipped \u2014 root does not exist: ${root}`);
		process.stderr.write(`loupe: root does not exist: ${root}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Resolved for every command, not just the hook. `status` exists to say what
	// the gate will do, and it cannot do that without the settings the gate reads.
	const { options, source: optionsSource } = resolvedOptions();

	let config: Config;
	let detected: DetectedConfig | null = null;
	try {
		// An explicit path or a typed `--preset` wins; then a discovered project
		// config; then the plugin's preset setting; then whatever the project
		// itself implies. Without the last step a project with no config file
		// fell through to `generic`, which declares no component layer and
		// therefore silently disables every correlation rule.
		//
		// The plugin setting sits *below* the project config on purpose. Both the
		// README and the option's own description promise "a project's own
		// loupe.config.json always wins", and it did not: the setting reaches the
		// hook through the environment and a terminal only through a best-guess
		// read of ~/.claude/settings.json, so the two sides loaded different
		// configs — different severities, a different suppression keyword, and
		// therefore different finding keys, which means a baseline recorded on one
		// side matched nothing on the other. A setting that names a default for
		// projects that have not written a config is useful; one that quietly
		// discards a config they did write is the split this branch exists to end.
		// `--preset`, typed at the moment of use, is a different thing and still
		// wins.
		const projectConfig = args.flags.config ? null : findConfig(root);
		const optionPreset = options.preset && options.preset !== 'auto' ? options.preset : null;
		const explicitPreset = args.flags.preset ?? (projectConfig ? null : optionPreset);
		if (!args.flags.config && !explicitPreset && !projectConfig) {
			detected = detectConfig(root);
			if (options.projectPrefixes?.length)
				detected.config.namespaces = { ...detected.config.namespaces, project: options.projectPrefixes };
		}
		config = await loadConfig({
			root,
			configPath: args.flags.config ?? null,
			preset: explicitPreset,
			inline: detected?.config ?? null,
			inferred: Boolean(detected),
		});
	} catch (err) {
		// Under the hook, EXIT.CANNOT_RUN is exit 2 — which blocks the turn. A
		// mistyped preset in the plugin settings would then block every turn in
		// every project with nothing the agent could do about it. A gate that
		// cannot configure itself stands aside and says so.
		if (isHook) return emitClean(`loupe: skipped \u2014 config error: ${messageOf(err)}`);
		process.stderr.write(`loupe: config error \u2014 ${messageOf(err)}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Registries reach the engine two ways: named directly, or carried by a
	// design-system profile that the project's own imports selected. Both merge
	// with the project winning on id, because a repo that has written down its
	// own `page-header` means that one, not the shipped generic.
	const profiles = readProfiles(args.flags.profiles ? resolve(args.flags.profiles) : null);
	const active = selectProfiles(profiles, config, args.flags.profile ?? null);
	const sources: RegistrySource[] = active.map((p) => ({
		label: `profile ${p.id}`,
		patterns: p.patterns,
		components: p.components,
	}));
	if (args.flags.patterns || args.flags.components)
		sources.push({
			label: 'flags',
			patterns: args.flags.patterns ?? null,
			components: args.flags.components ?? null,
		});

	const registries = applyRegistries(config, sources, { setPatterns, setComponentRegistry });
	config.profiles = { available: profiles, active, ...registries };
	if (!isHook) {
		for (const err of registries.errors) process.stderr.write(`loupe: ${err}\n`);
		// A registry handed over and then ignored has to say so: silently dropping
		// it is indistinguishable from running it and finding nothing.
		for (const s of registries.skipped)
			process.stderr.write(
				`loupe: ${s.label} ${s.kind} registry skipped \u2014 it is scoped to ${s.packages.join(', ')}, which this project does not import\n`
			);
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
		const id = canonicalRuleId(args._[1] ?? '');
		if (!isRuleId(id)) {
			process.stderr.write(`loupe: unknown rule "${args._[1] ?? ''}"\n`);
			return EXIT.CANNOT_RUN;
		}
		const state = config.enabled[id] ? config.severityOf(id) : 'disabled (config does not satisfy its requirements)';
		process.stdout.write(`${id}  [${state}]\n  ${renderTitle(id, config.designSystem, config.suppression.keyword)}\n`);
		return EXIT.OK;
	}

	if (command === 'status') {
		// One conclusion, asked once. `blockingAllowed` answers "do the severities
		// permit blocking"; it is not the same question as "will this gate stop a
		// turn", because a silenced hook stops nothing. Deriving the two answers
		// separately is what let `status` print `hook: OFF` and `Turns are blocked
		// by: ...` seven lines apart — the same drift `isOn` closed one layer down,
		// reappearing in the conclusion instead of the predicate.
		const gateBlocks = blockingAllowed && !hookSilenced();
		const src =
			config.source.kind === 'file'
				? config.source.path
				: config.source.kind === 'preset'
					? `preset ${config.source.name}`
					: config.source.kind === 'inferred'
						? 'inferred (no config file found)'
						: config.source.kind;
		const state = stateDir(root);
		// Report the baseline separately from the retry state. They resolve
		// differently now, and the whole reason they do is that one line covering
		// both let a baseline sit in a file the hook was never reading.
		const base = findExistingBaseline(root, args.flags.baseline, config.baselinePath);
		const lines = [
			`config:     ${src}`,
			`namespaces: ${(config.raw.namespaces?.project ?? []).join(', ') || '(none \u2014 css/dead-class inactive)'}`,
			`suppress:   ${config.suppression.keyword} <ruleId> -- <reason>`,
			// A legacy hit has to say so. `loupe baseline` writes the canonical path,
			// so an unmarked legacy path here is `status` and `baseline` naming
			// different files with nothing on hand to reconcile them — the exact
			// shape of the bug that pinned the baseline to the project in the first
			// place.
			`baseline:   ${base.path}${
				base.found && readBaseline(root, base.path) === null
					? '  (unreadable \u2014 every finding in it is live again)'
					: base.fallback === 'legacy'
						? "  (0.1.x location — run 'loupe baseline' to record it in the project)"
						: base.fallback === 'default-name'
							? `  (the default name \u2014 ${config.baselinePath} is configured but not there yet)`
							: base.found
								? ''
								: '  (none recorded yet)'
			}`,
			`state:      ${state.dir}${state.scope === 'plugin-data' ? '  (retry counter only, outside your repo)' : ''}`,
			`options:    ${
				optionsSource === 'environment'
					? 'from the plugin environment (hook context)'
					: optionsSource === 'settings'
						? 'from ~/.claude settings'
						: 'none found — plugin defaults apply'
			}${options.blocking === undefined ? '' : `; blocking ${options.blocking ? 'on' : 'off'}`}`,
			`plugin:     ${isPluginContext() ? 'running as a plugin' : 'not running as a plugin'}`,
			// Asked through the same predicate the gate uses. Reporting on mere
			// truthiness meant `LOUPE_OFF=0` printed OFF while the hook went on
			// blocking — a diagnostic lying about the one thing it exists to say.
			...(hookSilenced() ? ['hook:       OFF for this session (LOUPE_OFF is set)'] : []),
			// Which design system's registries are in play, and — when none are —
			// which ones were on offer. "No composite findings" and "no composite
			// registry" look identical in a report; they must not look identical here.
			`profile:    ${
				config.profiles?.active?.length
					? config.profiles.active.map((p) => `${p.id} (${p.name})`).join(', ')
					: config.profiles?.available?.length
						? `none selected \u2014 available: ${config.profiles.available.map((p) => p.id).join(', ')}`
						: 'none available'
			}`,
			'',
			'rules:',
		];
		for (const id of RULE_IDS) {
			const def = RULES[id];
			const sev = config.severityOf(id);
			// Report what will actually happen, not the configured severity: an
			// error-severity rule under a gate that isn't allowed to block is
			// advisory in practice, and saying otherwise here is how you end up
			// debugging a gate that "should" be blocking and isn't. `gateBlocks`
			// rather than `blockingAllowed` for the same reason: a silenced hook
			// blocks nothing, whatever the severities say.
			const note = config.enabled[id]
				? sev === 'error' && gateBlocks
					? 'BLOCKS'
					: sev === 'error'
						? 'advisory (would block if enabled)'
						: 'advisory'
				: `off (${sev === 'off' ? 'disabled in config' : `needs ${def.needs.join('+')}`})`;
			lines.push(`  ${id.padEnd(32)} ${note}`);
		}
		const blockers = RULE_IDS.filter((id) => config.enabled[id] && config.severityOf(id) === 'error');
		lines.push(
			'',
			gateBlocks && blockers.length
				? `Turns are blocked by: ${blockers.join(', ')}`
				: 'Nothing blocks turns; every finding is advisory.'
		);
		if (hookSilenced()) {
			lines.push('The gate is silenced for this session: LOUPE_OFF is set in the environment.');
		} else if (config.inferred) {
			lines.push('css/dead-class is held to advisory because the namespaces were inferred, not configured.');
			if (!blockingAllowed)
				lines.push(
					'The gate reports only: this config was inferred and "Block turns on findings" is not on. Write a config with `loupe init`, or turn the setting on.'
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
		const target = join(root, 'loupe.config.json');
		if (existsSync(target) && !args.flags.force) {
			process.stderr.write(`loupe: ${target} already exists (use --force)\n`);
			return EXIT.CANNOT_RUN;
		}
		writeFileSync(target, `${JSON.stringify(info.config, null, 2)}\n`);
		process.stdout.write(`${lines.join('\n')}\n\nWrote ${target}\n`);
		return EXIT.OK;
	}

	// Writes to the canonical project path, never to wherever a legacy baseline
	// happens to sit: a backlog recorded here has to be visible to the hook, and
	// the hook is a different process with a different environment.
	if (command === 'baseline') {
		const result = await analyze(config, { scope: null });
		// `||`, not `??`: an empty `--baseline=` is not a path. `findExistingBaseline`
		// reads it as "unnamed" and falls through to the configured path, so a
		// writer that took it as nullish-only would record the backlog somewhere
		// the next `check` never looks.
		const target = baselinePath(root, args.flags.baseline || config.baselinePath);
		const { path, findings, entries } = writeBaseline(root, target, result);
		// Nothing collapsed means nothing to reconcile, and saying the same number
		// twice invents a distinction the reader then has to go and check.
		const recorded =
			findings === entries
				? `${findings} finding(s)`
				: `${findings} finding(s) as ${entries} ${entries === 1 ? 'entry' : 'entries'}`;
		process.stdout.write(`loupe: baselined ${recorded} \u2192 ${path}\n`);
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
		if (fixScope !== null && !Array.isArray(fixScope)) {
			process.stderr.write(`loupe: ${fixScope.error}\n`);
			return EXIT.CANNOT_RUN;
		}
		let toFix: AnalyzeResult;
		try {
			toFix = await analyze(config, { scope: fixScope });
		} catch (err) {
			process.stderr.write(`loupe: ${messageOf(err)}\n`);
			return EXIT.CANNOT_RUN;
		}
		const dry = Boolean(args.flags['dry-run']);
		const { applied, skipped } = applyTokenFixes(root, toFix.findings, { dry });
		const verb = dry ? 'would fix' : 'fixed';
		for (const f of applied) process.stdout.write(`${f.file}:${f.line}  ${f.prop}: ${f.value} \u2192 var(${f.token})\n`);
		for (const f of skipped) process.stdout.write(`skip ${f.file}:${f.line}  ${f.prop}: ${f.value} \u2014 ${f.why}\n`);
		const left = toFix.findings.length - applied.length;
		process.stdout.write(
			`\nloupe: ${verb} ${applied.length} finding(s)${skipped.length ? `, skipped ${skipped.length}` : ''}. ` +
				`${left} left for review.\n`
		);
		return EXIT.OK;
	}

	if (command !== 'check' && !isHook) {
		process.stderr.write(`loupe: unknown command "${command}"\n\n${USAGE}`);
		return EXIT.CANNOT_RUN;
	}

	// ── check / hook ──────────────────────────────────────────────────────────
	// A PostToolUse payload names the file just written; scope to it so drift is
	// reported at write time. Stop payloads carry no file and fall through to
	// the changed-file scope.
	const touched = isHook ? payloadFile(payload, root) : null;
	if (touched && !isSource(config.sources, touched))
		return emitClean('loupe: skipped \u2014 not a checked file type.');
	const scope: ScopeResult = touched ? [touched] : resolveScope(config, args, { defaultChanged: isHook });
	if (scope !== null && !Array.isArray(scope)) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${scope.error}`);
		process.stderr.write(`loupe: ${scope.error}\n`);
		return EXIT.CANNOT_RUN;
	}

	let result: AnalyzeResult | BaselinedResult;
	try {
		result = await analyze(config, { scope });
	} catch (err) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${messageOf(err)}`);
		process.stderr.write(`loupe: ${messageOf(err)}\n`);
		return EXIT.CANNOT_RUN;
	}

	if (!args.flags['no-baseline']) {
		// The lookup already stat'd it. Most projects have no baseline, and this
		// runs on every write, so don't pay a second stat inside `readBaseline`
		// just to be told the same thing.
		const { path: bPath, found } = findExistingBaseline(root, args.flags.baseline, config.baselinePath);
		const baseline = found ? readBaseline(root, bPath) : null;
		// A file that is present and unparseable is not the same as no file, and
		// treating it as one puts the whole backlog back with the gate blocking on
		// all of it — silently, which is how this class of bug stays unfound.
		// Conflict markers in a committed baseline are the ordinary way to get
		// here, so name the file rather than letting it fail open in silence.
		//
		// The hook says it too. Guarding this on `!isHook` kept it quiet on the one
		// surface where it bites: the agent is handed back a backlog it explicitly
		// accepted, with no reason given, and spends its retry budget on findings
		// nobody asked it to fix. `emitBlocking` already writes the report to
		// stderr and Claude Code feeds that back on exit 2, so the line is carried
		// by a channel that already exists.
		if (found && !baseline)
			process.stderr.write(`loupe: baseline at ${bPath} is unreadable \u2014 ignoring it.\n`);
		result = applyBaseline(result, baseline);
	}
	if (args.flags.severity) result = filterSeverity(result, args.flags.severity);

	if (isHook) {
		const sessionId = payload.session_id ?? payload.sessionId ?? '';
		if (!result.blocking) {
			clearAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
			return emitClean(formatSummary(result));
		}
		const attempts = bumpAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
		const max = config.hook.maxAttempts;
		if (!sessionId && payload.stop_hook_active) {
			// No session id to budget against: fall back to the conservative
			// single-pass behaviour rather than risk looping the turn.
			return emitClean('loupe: blocking findings remain (retry budget unavailable).');
		}
		if (attempts > max) {
			// Latched, not cleared. Clearing the counter here reset the budget, so
			// "gate stood down" lasted exactly one turn: the next fire blocked at
			// attempt 1 of 3 again, and an agent that could not fix a finding was
			// stopped in perpetual bursts of three for the rest of the session.
			// Leaving the count above `max` keeps the stand-down standing; the
			// clean-run branch above still releases it the moment the finding goes,
			// and `readState` ages the entry out after MAX_AGE_MS either way.
			//
			// Say it once. Repeating the stand-down line every fire is the same
			// nagging the stand-down exists to end.
			return emitClean(
				attempts === max + 1
					? `loupe: still failing after ${max} attempt(s) \u2014 gate stood down. ${formatSummary(result, { prefix: false })}`
					: formatSummary(result)
			);
		}
		const report = formatAgent({ ...result, findings: result.findings.filter((f) => f.severity === 'error') }, config, {
			maxFindings: config.hook.maxFindings,
		});
		return emitBlocking(`${report}\n\n(attempt ${attempts} of ${max})`);
	}

	const maxFindings = Number(args.flags['max-findings'] ?? 0) || 0;
	const format = args.flags.format ?? 'agent';
	if (format === 'json') process.stdout.write(`${formatJson(result, config)}\n`);
	else if (format === 'sarif') process.stdout.write(`${formatSarif(result, config)}\n`);
	else {
		process.stdout.write(`${formatAgent(result, config, { maxFindings })}\n`);
		if ('baselined' in result && result.baselined)
			process.stdout.write(`\n${result.baselined} baselined finding(s) hidden.\n`);
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
	.catch((err: unknown) => {
		process.stderr.write(`loupe: ${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = EXIT.CANNOT_RUN;
	});
