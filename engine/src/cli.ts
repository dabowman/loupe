/**
 * loupe — design-system conformance checking for front-end codebases.
 *
 * Exit codes are a contract; callers (CI, hooks, quality runners) depend on them:
 *   0  clean, or advisory findings only
 *   1  blocking findings
 *   2  could not run (bad usage, not a git worktree, config error)
 *
 * Design notes: docs/design/cli.md
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseArgv } from 'node:util';
import { analyze, declarationKeys, dedupe } from './analyze.ts';
import { supersededEverywhere, usableReplacement } from './checks/system/currency.ts';
import { applyKeeps, applyTokenFixes, settledBy } from './autofix.ts';
import {
	judgeRedirects,
	judgeRenames,
	judgeValues,
	judgeVariants,
	redirectIdentity,
	tokenDescriptions,
} from './judge.ts';
import { applyBaseline, diffBaseline, readBaseline, writeBaseline } from './baseline.ts';
import { EMBEDDED_VERSION, hasPreset, presetKey } from './embedded.ts';
import { findConfig, listPresets, loadConfig } from './config.ts';
import { SEV_PAINT, bold, cyan, dim, green, magenta, red, setColor, yellow } from './color.ts';
import {
	TreeTooLarge,
	analyzeEntryBudget,
	byBytes,
	changedFiles,
	discover,
	gitIgnores,
	hasGitDir,
	isSource,
	isWorktree,
	toPosix,
} from './discover.ts';
import { RULES, RULE_IDS, canonicalRuleId, isRuleId, renderTitle } from './rules.ts';
import { GROUP_BYS, formatAgent, formatSarif, formatSummary, isGroupBy, reportPayload } from './report.ts';
import { formatHtml } from './report-html.ts';
import { lsp } from './lsp.ts';
import { serve } from './serve.ts';
import { messageOf, oneLine } from './text.ts';
import { DETECT_ENTRY_BUDGET, detectConfig, detectPreset } from './detect.ts';
import { applyRegistries, readProfiles, selectProfiles } from './profiles.ts';
import { deliverySummary, mergeDeliveries, REMEDY_RULES } from './delivery.ts';
import type { RegistrySource } from './profiles.ts';
import {
	attemptsPath,
	baselinePath,
	findExistingBaseline,
	isPluginContext,
	legacyBaseline,
	legacyBaselineNotice,
} from './paths.ts';
import {
	bumpAttempts,
	claudeProjectDir,
	clearAttempts,
	describeOptions,
	emitAdvisory,
	emitBlocking,
	emitClean,
	hookRoot,
	hookEvent,
	hookOff,
	hookSilenced,
	parsePayload,
	payloadFile,
	preEditContent,
	readStdin,
	resolvedOptions,
} from './hook.ts';
import type { HookPayload } from './hook.ts';
import type {
	AnalyzeResult,
	BaselinedResult,
	Config,
	ConfigSuppression,
	DeliveryCheck,
	Directive,
	Finding,
	RuleId,
} from './types.ts';
import type { DetectedConfig } from './detect.ts';

const EXIT = { OK: 0, BLOCKED: 1, CANNOT_RUN: 2 };

/**
 * The TypeSafe key, or undefined. First found wins: the environment, the plugin
 * option (hooks only), loupe's own `.env`, then the user-level `.env`.
 * `--judge` is the one network call in the engine, so its callers check this
 * before the walk. The hook asks too, but a missing key there is not an error:
 * judging is what a key buys, not what the gate depends on.
 */
function judgeKey(): string | undefined {
	const option = process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY;
	if (!process.env.TYPESAFE_API_KEY && option) process.env.TYPESAFE_API_KEY = option;
	for (const file of [ENV_FILE, USER_ENV_FILE]) {
		try {
			if (!process.env.TYPESAFE_API_KEY) process.loadEnvFile?.(file);
		} catch {
			/* a missing .env is the ordinary case */
		}
	}
	return process.env.TYPESAFE_API_KEY;
}

/**
 * The two things stderr carries, told apart by colour as well as by wording: a
 * refusal ends the run, a note is a run continuing on a partial answer.
 */
const fail = (msg: string): void => {
	process.stderr.write(red(msg));
};
const note = (msg: string): void => {
	process.stderr.write(yellow(msg));
};

/**
 * How far a detection result is to be trusted, coloured to match. `detect`
 * prints two of these and `init` writes the config they describe, so what is
 * worth seeing at a glance is the weaker of the two.
 */
const confidence = (level: string): string =>
	(level === 'high' ? green : level === 'none' ? red : yellow)(`[${level} confidence]`);

/** A preset answer too weak to write down: the fallback, not a match. */
const guessedPreset = (level: string): boolean => level === 'low' || level === 'none';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Whether this is a single-file artifact rather than an installed directory. A
 * binary carries its data compiled in and can never see the manifest beside the
 * engine, which makes that the test — with no dependence on how a compiler
 * spells its synthetic root.
 */
const SINGLE_FILE = !existsSync(join(HERE, '..', 'package.json'));

/** A `.env` beside the checkout; for a binary, one in the working directory. */
const ENV_FILE = SINGLE_FILE ? resolve('.env') : join(HERE, '..', '..', '.env');

/** Per-user `.env`, outside the plugin cache that each update replaces. */
const USER_ENV_FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'loupe', '.env');

/** Where a key can come from, for messages that say it was not found. */
const KEY_SOURCES = `the environment, the plugin's API key option, ${ENV_FILE}, or ${USER_ENV_FILE}`;

/**
 * Which loupe this is: the version, whether it runs from source or the built
 * bundle, and where it lives. Three copies of the plugin can coexist on one
 * machine, and the manifest alone cannot say which one answered. Both entries
 * sit one level below `engine/`, which is what lets one relative path find the
 * manifest from either.
 */
function versionLine(): string {
	// A compiled binary has no engine directory: `execPath` is the only location
	// that means anything.
	if (SINGLE_FILE) return `loupe ${EMBEDDED_VERSION} (binary, ${process.execPath})`;
	const entry = basename(HERE) === 'src' ? 'source' : 'bundle';
	return `loupe ${EMBEDDED_VERSION} (${entry}, ${resolve(HERE, '..', '..')})`;
}

/** The keys inside a printed JSON config, painted without reserialising it. */
const jsonKeys = (json: string): string => json.replace(/"([^"\\]+)":/g, (_m, name: string) => `${dim(`"${name}"`)}:`);

/**
 * {@link USAGE}, painted at the print site.
 *
 * The text stays one plain template above: it is also what `--help | grep` gets.
 * Commands and options are matched where the layout already puts them — first
 * token of an indented line — so a reworded description cannot light up.
 */
const usage = (): string =>
	USAGE.replace(/^ {2}(--[a-z-]+)/gm, (_m, flag: string) => `  ${cyan(flag)}`)
		.replace(/^ {2}([a-z]+)\b/gm, (_m, cmd: string) => `  ${bold(cmd)}`)
		.replace(/^(Commands|Options|Environment):$/gm, (_m, head: string) => `${bold(`${head}:`)}`);

/**
 * The flags that take a value. Everything else is a boolean switch. `as const`
 * so this list and {@link Flags} cannot drift.
 */
const VALUE_FLAGS = [
	'format',
	'group-by',
	'config',
	'root',
	'preset',
	'files',
	'rule',
	'max-findings',
	'severity',
	'baseline',
	'patterns',
	'components',
	'profiles',
	'profile',
	'port',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

/**
 * What `--format` accepts on the check path. A list, not a chain ending in
 * `else`: a typo that printed the agent format and exited 0 reads as a
 * successful run to a CI job that then uploads an empty artifact.
 */
const FORMATS = ['agent', 'json', 'sarif', 'html'] as const;
type Format = (typeof FORMATS)[number];
const isFormat = (f: string): f is Format => (FORMATS as readonly string[]).includes(f);

/** The value flags that may repeat; each occurrence is itself a comma list. */
const LIST_FLAGS: readonly ValueFlag[] = ['files', 'rule'];

/**
 * Parsed command-line flags. Written out rather than left as a string-keyed
 * record: `--files` carries a path list and `--all` carries nothing, and a
 * record typing both as `string | boolean` pushes that to every read site.
 */
type Flags = { [K in ValueFlag]?: string } & {
	help?: boolean;
	version?: boolean;
	all?: boolean;
	changed?: boolean;
	'no-baseline'?: boolean;
	'no-suppressions'?: boolean;
	stale?: boolean;
	'dry-run'?: boolean;
	judge?: boolean;
	concise?: boolean;
	force?: boolean;
	'no-color'?: boolean;
};

interface Args {
	_: string[];
	flags: Flags;
}

function parseArgs(args: string[]): Args {
	const { values, positionals } = parseArgv({
		args,
		options: Object.fromEntries(VALUE_FLAGS.map((f) => [f, { type: 'string', multiple: LIST_FLAGS.includes(f) }])),
		allowPositionals: true,
		strict: false,
	});
	// `--files` and `--rule` may repeat; each occurrence is itself a comma list.
	for (const f of LIST_FLAGS) {
		const given = [values[f] ?? []].flat().filter((v) => typeof v === 'string');
		values[f] = given.length ? given.join(',') : undefined;
	}
	// A value flag given no value parses as `true`; treat it as not given.
	for (const f of VALUE_FLAGS) if (typeof values[f] !== 'string') delete values[f];
	// A switch is undeclared, so `--judge=false` arrives as the string 'false',
	// which is truthy: it would turn judging on. `=false` means off.
	for (const [k, v] of Object.entries(values))
		if (typeof v === 'string' && !(VALUE_FLAGS as readonly string[]).includes(k)) values[k] = v !== 'false';
	return { _: positionals, flags: values as Flags };
}

const USAGE = `loupe <command> [options]

Commands:
  check                 Analyze the project (default)
  fix                   Apply the fixes the engine can make without judgement;
                        with --judge, also the ones TypeSafe settles
  baseline              Record current findings as the accepted backlog
  suppressions          List every active suppression directive, and every
                        rule turned off in config, with its reason
  explain <rule>        Print a rule's guidance
  presets               List bundled presets
  version               Print the version, whether it runs from source or the bundle, and where
  detect                Show the config that would be inferred for this project
  init                  Write the inferred config to loupe.config.json. Refuses
                        when no design system was recognised: name one with
                        --preset, or pass --force to write the guess anyway
  status                Show the effective config: rules, severities, what blocks
  serve                 Serve the findings to the running app, so a stylesheet
                        finding can be resolved to the elements it styles
  lsp                   Language server on stdin/stdout: diagnostics on save,
                        the rule's guidance on hover, and its fix as a quick
                        fix. Editors launch this; you do not run it by hand
  hook                  Claude Code hook mode (reads payload on stdin)

Options:
  --changed             Only report findings in files changed vs. HEAD (default for hook)
  --all                 Report across the whole repo (default for check)
  --files a,b           Only report findings in these files (a directory: the
                        source files under it)
  --rule <id>           Only report (check) or fix (fix) this rule's findings;
                        repeat it, or give a comma list, for more than one
  --format <f>          agent | json | sarif | html  (default: agent)
                        html writes a self-contained page — redirect it to a file
  --group-by <g>        rule | file — what the agent format heads each block
                        with; the other becomes the sub-heading (default: rule).
                        For suppressions, groups the list (default: ungrouped)
  --concise             Report only the group headings --group-by chose —
                        rules or files, with counts — and the summary, not the
                        findings themselves (default: the full report)
  --max-findings <n>    Cap findings shown; 0 = no cap (default: 0)
  --severity <s>        error | warn — minimum severity to report
  --baseline <path>     Read/write the baseline here instead of the configured
                        path (default: .loupe-baseline.json in the project)
  --no-baseline         Ignore the baseline file for this run
  --no-suppressions     Report what suppression directives would mute; with
                        --no-baseline, the full audit
  --stale               For suppressions, list only the directives naming a
                        rule that muted nothing — no finding left, the rule
                        off, or an id that is not a rule — and exit 1 if any
  --dry-run             Report what 'fix' would change without writing; for
                        'baseline', what it would record by rule, new and
                        fixed against the existing baseline
  --judge               Ask TypeSafe what a parse cannot see: the variant a raw
                        element needs, whether a control stands for the
                        pattern it was built as (patterns/judged-redirect), and
                        which token a hardcoded value should be, or whether it
                        is deliberate, and which real token an unknown one
                        meant. With fix, rewrites the values it settled
                        and suppresses the ones it kept; add --dry-run to
                        review them first. (TYPESAFE_API_KEY from the
                        environment or ~/.config/loupe/.env)
  --port <n>            Port for 'serve' (default: 7331)
  --force               Overwrite an existing config, or write a guessed design
                        system (init)
  --version             Same as the version command
  --no-color            Never colour the output (colour is on only when stdout
                        is a terminal; NO_COLOR and FORCE_COLOR are honoured)
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
  LOUPE=on              Turn the hook on. It is off until a project opts in:
                        "env": { "LOUPE": "on" } in .claude/settings.local.json.
                        'loupe' typed by hand always reports.
  LOUPE_OFF=1           Silence an opted-in hook: for one session as
                        'LOUPE_OFF=1 claude', or for one project as
                        "env": { "LOUPE_OFF": "1" } in .claude/settings.local.json,
                        read on every run. The plugin's "off" option does the
                        same for every project. The hook says it was skipped;
                        'loupe status' names which switch did it.
                        Both read 1/true/yes/on as on; anything else — 0 and
                        false included — as not set.
  LOUPE_MAX_ENTRIES=<n> How many entries analysis walks before it refuses to
                        report at all (default 200,000), rather than calling
                        the part of the tree it never read clean. Outranks
                        "maxEntries" in loupe.config.json for one run.

With no config file present, the project is inspected and a config inferred.
Run 'loupe detect' to see what that produces, 'init' to write it down.
`;

/**
 * Which files to report on: every file (`null`), a named set, or a refusal.
 * `null` is a real answer here, so the failure case has to be its own shape.
 */
type ScopeResult = string[] | null | { error: string };

/**
 * The refusal a run gets when there is no project here to ask git about. One
 * constant because it is said in two places — the scope resolver, and the guard
 * that runs before inference so the walk is never paid for on the way to it.
 */
const NOT_A_WORKTREE = 'not a git worktree; use --all or --files';

/** Commands that resolve the changed-file scope, and can therefore hit {@link NOT_A_WORKTREE}. */
const SCOPED_COMMANDS = new Set(['check', 'fix']);

/**
 * Would this run refuse anyway without a worktree?
 *
 * `--all` and `--files` name their own scope and never ask git anything.
 * `--changed` is only a scope on the two commands that resolve one: `detect`,
 * `baseline` and `status` ignore the flag entirely, and a guard standing in for
 * a refusal those runs would never have got is a guard inventing one.
 *
 * The hook is here for a different reason: its root falls back to the process
 * cwd whenever CLAUDE_PROJECT_DIR is unset, so it is the one caller that gets
 * pointed at a directory nobody chose.
 */
const needsProject = (command: string, args: Args, isHook: boolean): boolean => {
	if (args.flags.all || args.flags.files) return false;
	return isHook || (Boolean(args.flags.changed) && SCOPED_COMMANDS.has(command));
};

/**
 * Is there a project here, by any evidence the engine already trusts?
 *
 * Deliberately generous, because the cost of a false negative is a gate that
 * turns itself off and says so only in a message the hook suppresses. Five kinds
 * of evidence, cheapest first, none of which walks the tree:
 *
 * - a manifest, node-shaped or PHP-shaped (`composer.json` counts: a WordPress
 *   plugin is as likely to carry one as a `package.json`);
 * - a `.git` entry anywhere up the tree, searched upwards and answered off the
 *   filesystem, which survives a dubious-ownership mount and a missing `git`;
 * - git itself, which still recognises a worktree the filesystem walk cannot see.
 *   Asked after that walk, because it is a subprocess;
 * - and last, a preset that matches — the engine's own definition of a project,
 *   and the dearest of the five, though still bounded to manifests three levels
 *   down and markers in the root and its immediate children.
 *
 * Design notes: docs/design/cli.md#is-there-a-project-here
 */
const looksLikeProject = (root: string): boolean =>
	existsSync(join(root, 'package.json')) ||
	existsSync(join(root, 'composer.json')) ||
	hasGitDir(root) ||
	isWorktree(root) ||
	detectPreset(root).preset !== 'generic';

/**
 * What a run says when inference answered from part of a tree.
 *
 * Namespaces, precisely: `detectPreset` reads manifests and top-level markers
 * rather than walking, so the preset line is complete either way. A namespace
 * list drawn from a prefix looks exactly like one drawn from a whole project,
 * down to the coverage percentage, which is computed over what was read.
 *
 * Four surfaces say this — stderr, `status`, `detect`'s `scanned:` line and the
 * hook's own message — so they are built from two shared fragments.
 */
const CEILING = `${DETECT_ENTRY_BUDGET.toLocaleString('en-US')}-entry ceiling`;
const CEILING_WHY =
	'this root is larger than a project, so the namespaces are a guess from the part of it that was read';
const TRUNCATED_NOTE =
	`loupe: inference stopped at the ${CEILING} \u2014 ${CEILING_WHY}. ` +
	'Point --root at the project, then write a config with `loupe init`.\n';
/** The same fact, sized for a hook message that has to stay one line. */
const CEILING_SUFFIX = ` (inference stopped at the ${CEILING}; namespaces are a guess)`;

/**
 * `--files`, with each directory replaced by the source files under it.
 *
 * Findings are keyed by file, so a directory taken as given matched nothing and
 * the run reported clean. Read off the same walk the analysis makes, so the
 * source globs and `sources.ignore` decide what is under it exactly as they
 * decide what `--all` covers.
 */
function expandDirs(config: Config, given: readonly string[]): ScopeResult {
	const isDir = (rel: string): boolean => {
		try {
			return statSync(resolve(config.root, rel)).isDirectory();
		} catch {
			return false;
		}
	};
	const dirs = given.filter(isDir).map((d) => toPosix(relative(config.root, resolve(config.root, d))));
	if (!dirs.length) return given.filter(Boolean);
	const limit = analyzeEntryBudget(config.maxEntries);
	const found = discover({ root: config.root, sources: config.sources, limit });
	if (found.truncated) return { error: new TreeTooLarge(limit).message };
	const under = (rel: string): boolean => dirs.some((d) => d === '' || rel.startsWith(`${d}/`));
	const files = [...found.styles, ...found.markup, ...found.references].map((f) => f.rel).filter(under);
	return [...new Set([...given.filter((f) => f && !isDir(f)), ...files])];
}

function resolveScope(
	config: Config,
	args: Args,
	{ defaultChanged = false }: { defaultChanged?: boolean },
): ScopeResult {
	const given = (['all', 'changed', 'files'] as const).filter((f) => args.flags[f]);
	if (given.length > 1) return { error: `conflicting scope flags: ${given.map((f) => `--${f}`).join(' ')}` };
	if (args.flags.all) return null;
	if (args.flags.files)
		return expandDirs(
			config,
			args.flags.files
				.split(',')
				.map((f) => f.trim())
				.filter(Boolean)
				// Findings are keyed repo-relative, so an absolute path matches nothing and the
				// run reports clean.
				.map((f) => toPosix(isAbsolute(f) ? relative(config.root, resolve(f)) : f))
				.filter((f) => !f.startsWith('..')),
		);
	if (args.flags.changed || defaultChanged) {
		const changed = changedFiles(config.root);
		if (changed === null) return { error: NOT_A_WORKTREE };
		return [...changed];
	}
	return null;
}

/** What a finding is matched by across an edit: its baseline key, and its message. */
type Identity = Pick<Finding, 'rule' | 'file' | 'code' | 'message'>;

/**
 * The touched file's findings as it stood before the edit, for PostToolUse to
 * tell what the edit introduced from what it walked past.
 *
 * Empty when there is nothing to compare against — a file the write created, a
 * payload with no pre-edit content, an analysis that failed — which is the
 * absolute check, the gate as it was. Matched like the baseline, rule + file +
 * code, so a finding the edit merely moved down the file is not a new one.
 */
async function findingsBeforeEdit(
	config: Config,
	touched: string,
	before: string | null,
	{ judge, suppress }: { judge: boolean; suppress: boolean },
): Promise<Identity[]> {
	if (before === null) return [];
	try {
		const prior = await analyze(config, {
			scope: [touched],
			judge,
			suppress,
			contents: new Map([[touched, before]]),
		});
		// A judged redirect is written after analysis, from a control the analysis
		// collected (`judgeRedirects`, keyed by its component). The control standing
		// before the edit is the finding standing before it, without paying to ask
		// the judge about a file the edit has already replaced.
		return [...prior.findings, ...(prior.controls ?? []).map((c) => ({ ...redirectIdentity(c), message: '' }))];
	} catch {
		return [];
	}
}

/**
 * `fetch` under one deadline shared by every request made through it, on top
 * of each request's own signal. Combined by hand: `AbortSignal.any` is Node 20.
 */
function deadlineFetch(deadline: AbortSignal): typeof fetch {
	return (input, init) => {
		const both = new AbortController();
		// Left attached once `fetch` resolves: the body is read after that, and has
		// to stay abortable by both. The deadline ends the phase, and them with it.
		for (const s of [deadline, init?.signal]) {
			if (!s) continue;
			if (s.aborted) both.abort(s.reason);
			else s.addEventListener('abort', () => both.abort(s.reason), { once: true });
		}
		return fetch(input, { ...init, signal: both.signal });
	};
}

/**
 * The findings in `after` that the edit introduced.
 *
 * Counted, not looked up: a file with one margin on a child that now has two
 * gained one, though both share a key. Each finding standing before the edit
 * accounts for at most one after it, one with the same message first, so where
 * two differ only in their value the one reported is the one the edit wrote.
 *
 * Counted per declaration (`declarationKeys`), so a collapsed finding that lost
 * a declaration is not a new one for having changed its `code`; it is new when
 * any of its declarations is.
 */
function introducedBy(after: readonly Finding[], before: readonly Identity[]): Finding[] {
	const pool = new Map<string, string[]>();
	for (const f of before) for (const k of declarationKeys(f)) pool.set(k, [...(pool.get(k) ?? []), f.message]);
	const take = (k: string, message: string | null): boolean => {
		const left = pool.get(k);
		const i = !left ? -1 : message === null ? left.length - 1 : left.indexOf(message);
		if (!left || i < 0) return false;
		left.splice(i, 1);
		return true;
	};
	const unmatched = after.map((f) => ({ f, keys: declarationKeys(f).filter((k) => !take(k, f.message)) }));
	return unmatched.filter(({ keys }) => keys.filter((k) => !take(k, null)).length > 0).map(({ f }) => f);
}

/**
 * The rules `--rule` named, canonical, or the first one that is not a rule.
 *
 * Refused rather than ignored: a misspelled id filters every finding out, and
 * the report that follows says `clean`.
 */
function ruleScope(list: string | undefined): Set<RuleId> | null | { error: string } {
	if (list === undefined) return null;
	const out = new Set<RuleId>();
	for (const given of list.split(',').map((r) => r.trim())) {
		const id = canonicalRuleId(given);
		if (!isRuleId(id)) return { error: `unknown rule "${given}" \u2014 \`loupe status\` lists them` };
		out.add(id);
	}
	return out;
}

/** Only the named rules' findings, and whether what is left still blocks. */
function filterRules<T extends AnalyzeResult>(result: T, rules: ReadonlySet<RuleId> | null): T {
	if (!rules) return result;
	const findings = result.findings.filter((f) => rules.has(f.rule));
	return { ...result, findings, blocking: findings.some((f) => f.severity === 'error') };
}

function filterSeverity<T extends AnalyzeResult | BaselinedResult>(result: T, min: string): T {
	if (min !== 'error') return result;
	const findings = result.findings.filter((f) => f.severity === 'error');
	if (!('baselinedFindings' in result)) return { ...result, findings };
	// The accepted findings too: SARIF lists them as suppressed results, and a
	// warning the filter asked to leave out is no more wanted there.
	const baselinedFindings = result.baselinedFindings.filter((f) => f.severity === 'error');
	return { ...result, findings, baselinedFindings, baselined: baselinedFindings.length };
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const first = args._[0];
	const command = first && !first.startsWith('-') ? first : 'check';

	// Two readers are never human, whatever stdout happens to be attached to: the
	// hook, whose report is fed back to an agent, and a machine format, which is
	// parsed.
	if (command === 'hook' || args.flags['no-color'] || (args.flags.format && args.flags.format !== 'agent'))
		setColor(false);

	if (args.flags.help || command === 'help') {
		process.stdout.write(usage());
		return EXIT.OK;
	}
	if (args.flags.version || command === 'version') {
		process.stdout.write(`${versionLine()}\n`);
		return EXIT.OK;
	}
	if (command === 'presets') {
		process.stdout.write(`${listPresets().join('\n')}\n`);
		return EXIT.OK;
	}

	const isHook = command === 'hook';

	// Read the payload before anything can return: a hook that exits without
	// draining leaves Claude Code holding a pipe nobody reads, and once the payload
	// outgrows the pipe buffer that write fails with EPIPE. Every early return
	// below is downstream of this line, the off switch most of all.
	const payload: HookPayload = isHook ? parsePayload(await readStdin()) : {};

	// Resolved for every command, not just the hook. `status` exists to say what
	// the gate will do, and it cannot do that without the settings the gate reads.
	// Read from the Claude Code project, not the run's root: in a monorepo package
	// the two differ, and `status` must land where the hook does.
	const projectDir = claudeProjectDir(args.flags.root);
	const resolved = resolvedOptions(projectDir);
	const { options } = resolved;

	// Off unless the project opted in, or silenced.
	//
	// Silence, not advisory mode: an advisory finding still lands in the agent's
	// context, and an agent that sees a finding starts fixing it. Hook-only —
	// `loupe check` typed by hand is someone asking. A project that never opted in
	// hears nothing; one that opted in and was switched off is told so, like every
	// other stand-down, or a stale switch disables the gate with no trace.
	if (isHook) {
		const off = hookOff(projectDir, resolved);
		if (off) return hookSilenced(projectDir, resolved) ? emitClean(`loupe: skipped \u2014 ${off}`) : EXIT.OK;
	}

	// The project, not the directory you happen to be standing in: the hook roots
	// at CLAUDE_PROJECT_DIR, and a typed command rooting at the cwd gave the same
	// repo two roots. Anchoring to the config the run is governed by makes them
	// agree. `--root` still overrides.
	const explicitRoot = args.flags.root ?? (isHook ? hookRoot() : null);
	const anchor = explicitRoot ? null : findConfig(resolve(process.cwd()));
	const root = resolve(explicitRoot ?? (anchor ? dirname(anchor) : process.cwd()));
	if (!existsSync(root)) {
		if (isHook) return emitClean(`loupe: skipped \u2014 root does not exist: ${root}`);
		fail(`loupe: root does not exist: ${root}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Read before the config rather than with the other registry work below: a
	// profile names the preset that configures its design system, and that has
	// to be settled before the config it would configure is loaded.
	const profiles = readProfiles(args.flags.profiles ? resolve(args.flags.profiles) : null);
	const forced = args.flags.profile ? (profiles.find((p) => p.id === args.flags.profile) ?? null) : null;
	// A named profile that resolves to nothing is not a no-op: it also suppresses
	// the profile *selection* would have made, so a typo checks strictly less than
	// no flag at all.
	if (args.flags.profile && !forced && !isHook)
		note(
			`loupe: no profile "${args.flags.profile}" in ${args.flags.profiles ? resolve(args.flags.profiles) : 'any profiles directory (--profiles was not given)'}${
				profiles.length ? ` — available: ${profiles.map((p) => p.id).join(', ')}` : ''
			}\n`,
		);

	let config: Config;
	let detected: DetectedConfig | null = null;
	// Hoisted: `status` has to be able to say where an inferred config got its
	// ruleset, and "inferred" on its own does not say a profile named it.
	let profilePreset: string | null = null;
	// The config file the project wrote, when that is what is being loaded: an
	// error in it is the project's to fix, not a plugin setting's.
	let ownConfig: string | null = null;
	// Detection plus everything that outranks it. Reads `profilePreset` at call
	// time, which is what lets `detect` and `init` below reuse it after the
	// resolution above has settled.
	const runDetection = (preset: string | null = profilePreset): DetectedConfig => {
		const d = detectConfig(root, { preset });
		if (options.projectPrefixes?.length)
			d.config.namespaces = { ...d.config.namespaces, project: options.projectPrefixes };
		return d;
	};
	try {
		// An explicit path or a typed `--preset` wins; then a discovered project
		// config; then the plugin's preset setting; then whatever the project itself
		// implies. Without the last step a project with no config file fell through to
		// `generic`, which silently disables every correlation rule.
		//
		// The plugin setting sits *below* the project config on purpose: the two sides
		// read it differently, so a setting that discarded a project's own config gave
		// hook and terminal different finding keys. `--preset`, typed at the moment of
		// use, is a different thing and still wins.
		const projectConfig = args.flags.config ? null : findConfig(root);
		const optionPreset = options.preset && options.preset !== 'auto' ? options.preset : null;
		const explicitPreset = args.flags.preset ?? (projectConfig ? null : optionPreset);
		ownConfig = args.flags.config ? resolve(args.flags.config) : explicitPreset ? null : projectConfig;

		// The project-shape guard runs ahead of inference, not after it: inference
		// walks the tree, and `hookRoot()` falls back to the process cwd, so the tree
		// being indexed can be a home directory, on every edit.
		//
		// Only where there is nothing but the directory to go on: a config file,
		// `--config` or `--preset` states that *this* directory is a project. The
		// `preset` plugin option is not such a statement — it is set once, for every
		// project its owner ever opens — so it configures the run without vouching
		// for the root.
		const statedProject = Boolean(args.flags.config) || Boolean(args.flags.preset) || Boolean(projectConfig);
		if (!statedProject && needsProject(command, args, isHook) && !looksLikeProject(root)) {
			if (isHook) return emitClean(`loupe: skipped \u2014 ${NOT_A_WORKTREE}`);
			fail(`loupe: ${NOT_A_WORKTREE}\n`);
			return EXIT.CANNOT_RUN;
		}

		const unconfigured = !args.flags.config && !explicitPreset && !projectConfig;
		// A named profile's preset ranks last among the statements *about this project*
		// — --config, --preset, the plugin option's preset and the project's config
		// file each outrank it — and first against inference, which is a guess about
		// the design system `--profile` just named outright.
		if (unconfigured && forced?.preset) {
			if (hasPreset(forced.preset)) profilePreset = forced.preset;
			// A profile naming a preset this install does not carry is a broken
			// profile, not a broken project: its registries still apply, so name
			// what was ignored rather than failing the run over it.
			else if (!isHook) note(`loupe: profile ${forced.id} names preset ${forced.preset}, which is not installed\n`);
		}
		// Override the preset inference chose, not the run it produced: the namespaces
		// are a reading of *this* project, and injecting the preset instead dropped
		// them. Both overrides live here rather than at the call site because `detect`
		// and `init` re-run detection when the run did not.
		if (unconfigured) detected = runDetection();
		config = await loadConfig({
			root,
			configPath: args.flags.config ?? null,
			preset: explicitPreset,
			inline: detected?.config ?? null,
			inferred: Boolean(detected),
		});
	} catch (err) {
		// Under the hook, EXIT.CANNOT_RUN is exit 2, which blocks the turn: a mistyped
		// preset in the plugin settings would block every turn in every project. A gate
		// that cannot configure itself stands aside and says so.
		//
		// Standing aside is not the same as telling no one. An error in the project's
		// own config — a rule written in a form a release removed, say — turns the
		// gate off on every turn, and a systemMessage reaches only the user, in the
		// slot a clean run's tally fills. The agent is told too, as advisory context,
		// so it can offer the rewrite the error already names.
		if (isHook && ownConfig)
			return emitAdvisory(
				`loupe: skipped \u2014 config error: ${messageOf(err)}`,
				`loupe, the design-system gate, is checking nothing in this project: ${ownConfig} has a config error \u2014 ${messageOf(err)}. ` +
					'Until it is fixed no edit is checked. Offer the user that fix; this is advisory and blocks nothing.',
				payload,
			);
		if (isHook) return emitClean(`loupe: skipped \u2014 config error: ${messageOf(err)}`);
		fail(`loupe: config error \u2014 ${messageOf(err)}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Registries reach the engine two ways: named directly, or carried by a
	// design-system profile that the project's own imports selected. Both merge
	// with the project winning on id, because a repo that has written down its
	// own `page-header` means that one, not the shipped generic.
	const active = selectProfiles(profiles, config, args.flags.profile ?? null);
	const sources: RegistrySource[] = active.map((p) => ({
		label: `profile ${p.id}`,
		patterns: p.patterns,
		components: p.components,
		// Naming a profile has already answered the question its registries would
		// be scope-checked against.
		forced: p.id === forced?.id,
	}));
	if (args.flags.patterns || args.flags.components)
		sources.push({
			label: 'flags',
			patterns: args.flags.patterns ?? null,
			components: args.flags.components ?? null,
		});

	const registries = applyRegistries(config, sources);
	config.profiles = { available: profiles, active, ...registries };
	if (!isHook) {
		for (const err of registries.errors) fail(`loupe: ${err}\n`);
		// A scope declaration refused at load leaves its profile on the generic token
		// table, which reads exactly like one that declared nothing — so it says so.
		for (const p of active)
			for (const problem of p.problems) fail(`loupe: profile ${p.id} ${problem} \u2014 its token scopes are ignored\n`);
		// A registry handed over and then ignored has to say so: silently dropping
		// it is indistinguishable from running it and finding nothing.
		for (const s of registries.skipped)
			note(
				`loupe: ${s.label} ${s.kind} registry skipped \u2014 scoped to ${s.packages.join(', ')}, and this config declares ${
					config.designSystem.packages.length ? config.designSystem.packages.join(', ') : 'no design-system packages'
				}\n`,
			);
		// And the same for one merged past the scope check that still did not do
		// what merging it was for: `--profile` forcing a registry in does not make
		// its rules run, and forcing it onto a project on another design system
		// makes them run against components they describe nothing about.
		for (const n of registries.notes) note(`loupe: ${n.label} ${n.kind} registry ${n.note}\n`);
	}

	// Inference that stopped early is still used — a partial answer beats `generic`,
	// which switches every correlation rule off — but never silently. Under the hook
	// stderr is the wrong channel, so it is appended to the systemMessage instead.
	if (detected?.truncated && !isHook) note(TRUNCATED_NOTE);
	const ceilingSuffix = detected?.truncated ? CEILING_SUFFIX : '';

	// An inferred namespace list is a guess, and css/dead-class tells an agent to
	// delete code. Never let a guess drive a destructive rule at error severity.
	if (config.inferred && config.rules['css/dead-class']?.severity === 'error')
		config.rules['css/dead-class'].severity = 'warn';

	// Whether the gate may stop a turn.
	//
	// A config file is a deliberate statement about THIS project, so its severities
	// stand. An inferred config is a guess, and blocking a turn on a guess is
	// hostile — so it is advisory-only unless blocking is explicitly turned on.
	// The plugin option can force advisory either way.
	const blockingAllowed = options.blocking === true || (!config.inferred && options.blocking !== false);
	if (isHook && !blockingAllowed) {
		for (const def of Object.values(config.rules)) if (def.severity === 'error') def.severity = 'warn';
	}
	if (options.maxAttempts) config.hook.maxAttempts = options.maxAttempts;
	if (options.maxFindings) config.hook.maxFindings = options.maxFindings;

	// The baseline this run was told to use, or null for the configured one. Said
	// once, here: `--baseline=` arrives as an empty string, and the writer and
	// every reader must agree that it names nothing — one of them taking it as a
	// path records the backlog in a file the others never open.
	const namedBaseline = args.flags.baseline || null;

	if (command === 'explain') {
		const id = canonicalRuleId(args._[1] ?? '');
		if (!isRuleId(id)) {
			fail(`loupe: unknown rule "${args._[1] ?? ''}"\n`);
			return EXIT.CANNOT_RUN;
		}
		const state = config.enabled[id]
			? SEV_PAINT[config.severityOf(id)](config.severityOf(id))
			: dim('disabled (config does not satisfy its requirements)');
		process.stdout.write(
			`${magenta(id)}  [${state}]\n  ${renderTitle(id, config.designSystem, config.suppression.keyword)}\n`,
		);
		// The two registry-backed rules have nothing of their own to explain: what they
		// fire on is a list somebody else authored. Name the size, a few entries to
		// recognise it by, and the file — not the list, which runs to hundreds.
		const flagged =
			id === 'system/locked-component' ? 'locked' : id === 'system/superseded-component' ? 'legacy' : null;
		if (flagged) {
			const entries = [...config.componentRegistry.values()];
			// The same filter the rule applies. Counting every `legacy` entry would
			// overstate it: one whose only replacement is itself locked or
			// experimental never fires, deliberately.
			const fires = entries.filter(
				(e) => e.status === flagged && usableReplacement(config.componentRegistry, e.supersededBy),
			);
			const names = fires.slice(0, 5).map((e) => e.name);
			const src = (config.profiles?.active ?? []).filter((p) => p.components);
			process.stdout.write(
				`  ${dim(
					`${fires.length} of ${entries.length} entries in the active component registry fire it` +
						`${names.length ? `: ${names.join(', ')}${fires.length > names.length ? `, +${fires.length - names.length} more` : ''}` : ''}.`,
				)}\n`,
			);
			if (src.length)
				process.stdout.write(
					`  ${dim(`From ${src.map((p) => `${p.id} (${p.components})`).join(', ')} — each finding carries its entry's note, and \`--format json\` ships that note whole.`)}\n`,
				);
		}
		// What adopting a remedy costs is the profile's to say, and this is where a
		// reader asks what a remedy rule's note means.
		const delivery = mergeDeliveries((config.profiles?.active ?? []).map((p) => p.delivery));
		const bundled = [...(delivery?.packages ?? [])].filter(([, e]) => e.provided === 'bundled').map(([pkg]) => pkg);
		if (REMEDY_RULES.has(id) && delivery && bundled.length)
			process.stdout.write(
				`  ${dim(`A remedy naming ${bundled.join(', ')} carries "bundling required" until the project imports it: ${delivery.host} does not provide ${bundled.length > 1 ? 'them' : 'it'}, so the build compiles ${bundled.length > 1 ? 'them' : 'it'} in.`)}\n`,
			);
		// The rule runs what the profile declares, so the declaration is the
		// explanation: what counts as delivery, and what to do about none.
		if (id === 'tokens/undelivered') {
			const t = delivery?.tokens;
			const described = (e: DeliveryCheck): string =>
				`${e.kind === 'enqueue-dependency' ? `${e.calls.join('/')} listing ${e.handles.join(', ')}` : e.kind === 'import' ? `an import of ${e.specifiers.join(' or ')}` : `/${e.pattern.source}/`} in ${e.files.join(', ')}`;
			const lines = t
				? [
						`Tokens come from ${t.stylesheet}${t.handle ? `, the ${t.handle} handle` : ''}. Any one of these is delivery:`,
						...t.evidence.map((e) => `  ${described(e)}`),
						'It reports only when enqueues were found, every one was read, and none qualifies; anything it cannot read is not a finding.',
						// Named so nobody reads a build plugin as the fix: the page renders,
						// at the default theme's values.
						...(t.fallbacks.length
							? [
									"Build-time fallbacks are not delivery: they render the default theme's values, not the site's. The finding says so where one of these shows them:",
									...t.fallbacks.map((e) => `  ${described(e)}`),
								]
							: []),
						...(t.note ? [t.note] : []),
					]
				: ['No active profile declares how its tokens are delivered, so this reports nothing.'];
			for (const l of lines) process.stdout.write(`  ${dim(l)}\n`);
		}
		return EXIT.OK;
	}

	if (command === 'status') {
		// One conclusion, asked once. `blockingAllowed` answers "do the severities
		// permit blocking", which is not "will this gate stop a turn" — a silenced hook
		// stops nothing.
		const off = hookOff(projectDir, resolved);
		const gateBlocks = blockingAllowed && !off;
		const src =
			config.source.kind === 'file'
				? config.source.path
				: config.source.kind === 'preset'
					? `preset ${config.source.name}`
					: config.source.kind === 'inferred'
						? `inferred (no config file found)${profilePreset ? `, extending preset ${profilePreset}` : ''}`
						: config.source.kind;
		const base = findExistingBaseline(root, namedBaseline, config.baselinePath);
		const legacy = base.found ? null : legacyBaseline(root);
		// The hook keys its counter on the Claude Code project — its `--root`, else
		// CLAUDE_PROJECT_DIR — not on the config a package's status roots at.
		const hookDir = args.flags.root ? root : claudeProjectDir();
		const state = attemptsPath(hookDir);
		// What design system this run thinks it is checking, in the terms the rules are
		// written against — the half a skill has to read before it writes a line of UI.
		// Empty fields are printed as such: "no layout primitive" is a fact about the
		// system, and inferring it from a missing line recommends one that isn't there.
		const ds = config.designSystem;
		const delivery = mergeDeliveries((config.profiles?.active ?? []).map((p) => p.delivery));
		const orNone = (arr: readonly string[] | undefined): string => (arr?.length ? arr.join(', ') : '(none)');
		// `layout:`/`text:` get read as "what should I write", but they are
		// recognition lists and carry the superseded spellings too. Mark those, so
		// the reader takes the canonical name rather than the first one it knows.
		// Unmarked without a registry: that is currency data missing, not a clean
		// bill of health.
		const components = (arr: readonly string[] | undefined): string =>
			arr?.length
				? arr.map((n) => (supersededEverywhere(config.componentRegistry, n) ? `${n} (legacy)` : n)).join(', ')
				: '(none)';
		const lines = [
			`${dim('version:    ')}${versionLine()}`,
			`${dim('config:     ')}${src}`,
			`${dim('system:     ')}${ds.name || '(unnamed)'}`,
			`${dim('packages:   ')}${orNone(ds.packages)}`,
			`${dim('layout:     ')}${components(ds.layoutComponents)}`,
			`${dim('text:       ')}${components(ds.textComponents)}`,
			`${dim('tokens:     ')}${ds.tokenPrefixes?.length ? ds.tokenPrefixes.map((p) => `${p}*`).join(', ') : '(none \u2014 token rules inactive)'}`,
			`${dim('namespaces: ')}${(config.raw.namespaces?.project ?? []).join(', ') || '(none \u2014 css/dead-class inactive)'}`,
			`${dim('suppress:   ')}${config.suppression.keyword} <ruleId> -- <reason>`,
			`${dim('baseline:   ')}${base.path}${
				base.found && readBaseline(base.path) === null
					? '  (unreadable \u2014 every finding in it is live again)'
					: base.fallback === 'default-name'
						? `  (the default name \u2014 ${config.baselinePath} is configured but not there yet)`
						: base.found
							? ''
							: '  (none recorded yet)'
			}`,
			...(legacy ? [yellow(`            ${legacyBaselineNotice(legacy)}`)] : []),
			// Beside the baseline line, because the two used to share a directory and are
			// easy to assume still do: the retry counter is the one that stays out of the
			// repo. The marker is computed, not assumed — a root above the temp
			// directory would contain it.
			`${dim('state:      ')}${state}${relative(root, state).startsWith('..') ? '  (retry counter only, outside your repo)' : ''}`,
			// The Claude Code hook has CLAUDE_PLUGIN_DATA and a terminal does not, so
			// the line above is not the hook's file unless this run has it too.
			...(process.env.CLAUDE_PLUGIN_DATA
				? []
				: [
						dim(
							`            without CLAUDE_PLUGIN_DATA; the Claude Code hook's is ${toPosix(attemptsPath(hookDir, '$CLAUDE_PLUGIN_DATA'))}`,
						),
					]),
			`${dim('options:    ')}${describeOptions(resolved)}`,
			`${dim('plugin:     ')}${isPluginContext() ? 'running as a plugin' : 'not running as a plugin'}`,
			// The hook passes `--judge` and then turns it off silently when there is no
			// key. A report that quietly stopped asking and one that found nothing to
			// ask read identically, so name which this is.
			`${dim('judge:      ')}${
				judgeKey() ? 'on \u2014 TYPESAFE_API_KEY found' : `off \u2014 no TYPESAFE_API_KEY (${KEY_SOURCES})`
			}`,
			// Asked through the same predicate the gate uses: reporting on mere truthiness
			// meant `LOUPE_OFF=0` printed OFF while the hook went on blocking.
			...(off ? [yellow(`hook:       OFF \u2014 ${off}`)] : []),
			// Which design system's registries are in play, and — when none are — which
			// were on offer: "no composite findings" and "no composite registry" look
			// identical in a report and must not look identical here. The directory, not
			// just the id: a profile carries its authoring prose beside its registries.
			`${dim('profile:    ')}${
				config.profiles?.active?.length
					? config.profiles.active.map((p) => `${p.id} (${p.name}) \u2014 ${p.dir}`).join(', ')
					: config.profiles?.available?.length
						? `none selected \u2014 available: ${config.profiles.available.map((p) => p.id).join(', ')}`
						: 'none available'
			}`,
			// What adopting the system costs this project: which packages the host
			// provides and which get bundled, and which sheet carries the tokens. A
			// remedy naming a bundled package is a new runtime dependency, and a token
			// whose sheet never loads resolves to nothing — both read here first.
			...(delivery ? [`${dim('delivery:   ')}${deliverySummary(delivery)}`] : []),
			'',
			bold('rules:'),
		];
		for (const id of RULE_IDS) {
			const def = RULES[id];
			const sev = config.severityOf(id);
			// Report what will actually happen, not the configured severity — an
			// error-severity rule under a gate that cannot block is advisory in practice,
			// and the colour follows the words for the same reason. `gateBlocks` rather
			// than `blockingAllowed`: a silenced hook blocks nothing.
			// This one only exists under `--judge`, which the hook now passes — so its
			// severity counts like any other, and the suffix says what it costs.
			const judgeOnly = id === 'patterns/judged-redirect';
			const verdict = config.enabled[id]
				? sev === 'error' && gateBlocks
					? red(judgeOnly ? 'BLOCKS (--judge only)' : 'BLOCKS')
					: judgeOnly
						? yellow('advisory, --judge only')
						: sev === 'error'
							? yellow('advisory in the hook (would block if enabled); fails `check`')
							: yellow('advisory')
				: dim(`off (${sev === 'off' ? 'disabled in config' : `needs ${def.needs.join('+')}`})`);
			// The reason a config gave, beside what it set — for `off` above all, where
			// it is the only record of why a rule is not running.
			const reason = config.rules[id].reason;
			lines.push(`  ${magenta(id.padEnd(32))} ${verdict}${reason ? dim(` \u2014 ${reason}`) : ''}`);
		}
		const blockers = RULE_IDS.filter((id) => config.enabled[id] && config.severityOf(id) === 'error');
		// `blocking` is the hook's: it decides whether a turn stops, not whether a
		// finding is an error. `check` still exits 1 on error severity, so CI and a
		// pre-commit hook gate on the config whatever the plugin setting says — and
		// "nothing blocks" said of the tool, not the hook, was contradicted by the
		// very next `check`.
		const quiet = off
			? 'Nothing blocks turns: the hook is off.'
			: 'Nothing blocks turns; the hook reports every finding as advisory.';
		lines.push(
			'',
			gateBlocks && blockers.length
				? `${red('Turns are blocked by:')} ${blockers.map((id) => magenta(id)).join(', ')}`
				: blockers.length
					? `${green(quiet)}\n${yellow('`loupe check` still exits 1 on:')} ${blockers.map((id) => magenta(id)).join(', ')} — ${off ? 'the hook being off does not change that' : '"Block turns on findings" governs the hook, not `check`'}.`
					: green(`${quiet} No rule is at error severity, so \`loupe check\` exits 0 too.`),
		);
		if (off) {
			lines.push(`The gate is off: ${off}.`);
		} else if (config.inferred) {
			lines.push('css/dead-class is held to advisory because the namespaces were inferred, not configured.');
			if (detected?.truncated) lines.push(`Inference stopped at the ${CEILING}: ${CEILING_WHY}.`);
			if (!blockingAllowed)
				lines.push(
					'The hook reports only: this config was inferred and "Block turns on findings" is not on. Write a config with `loupe init`, or turn the setting on.',
				);
		} else if (!blockingAllowed) {
			lines.push('The hook reports only: "Block turns on findings" is off in the plugin settings.');
		}
		process.stdout.write(`${lines.join('\n')}\n`);
		return EXIT.OK;
	}

	if (command === 'detect' || command === 'init') {
		// `--preset` names the design system outright, the way `--profile` does —
		// and skipped detection to do it, so this pass is the one that applies it.
		const named = args.flags.preset ? presetKey(args.flags.preset) : profilePreset;
		const info = detected ?? runDetection(named);
		// `detected` is null only when a config file already exists, in which case
		// the note above never ran and this is the run that has to carry it.
		if (!detected && info.truncated) note(TRUNCATED_NOTE);
		if (args.flags.format === 'json') {
			process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
			return EXIT.OK;
		}
		const lines = [
			`${dim('preset:     ')}${bold(info.preset)}  ${confidence(info.presetConfidence)}`,
			dim(`            ${info.presetReasons.join('; ')}`),
			// What inference concluded is still reported; it is just no longer what the
			// run uses, and `init` writes the config below verbatim.
			...(named
				? [
						`            ${args.flags.preset ? `--preset ${args.flags.preset}` : `--profile ${forced?.id}`} overrides that: the config below extends ${named}`,
					]
				: []),
			`${dim('namespaces: ')}${info.namespaces.project.join(', ') || '(none found)'}  ${confidence(info.namespaceConfidence)}`,
			dim(`            ${Math.round(info.coverage * 100)}% of project CSS classes covered`),
			// Why the confidence above is lower than the coverage alone would make it.
			...info.namespaceNotes.map((n) => dim(`            ${n}`)),
			// Listed, never written: `init` leaves `external` for somebody to confirm.
			...(info.possibleExternal.length
				? [
						...info.possibleExternal.map(
							(c, i) =>
								`${dim(i === 0 ? 'possible external:  ' : '                    ')}${c.prefix}  ${dim(`(${c.classes} class${c.classes === 1 ? '' : 'es'}, ${c.reason})`)}`,
						),
						dim('                    confirm with `namespaces.external` in loupe.config.json'),
					]
				: []),
			dim(
				`scanned:    ${info.sampled.styles} style, ${info.sampled.markup} markup, ${info.sampled.references} reference file(s)` +
					(info.truncated ? `  (stopped at the ${CEILING})` : ''),
			),
		];
		if (command === 'detect') {
			lines.push('', bold('Inferred config:'), jsonKeys(JSON.stringify(info.config, null, 2)));
			if (config.source.kind === 'file') lines.push('', `Note: ${config.source.path} exists and takes precedence.`);
			process.stdout.write(`${lines.join('\n')}\n`);
			return EXIT.OK;
		}
		const target = join(root, 'loupe.config.json');
		// First, ahead of every refusal below that suggests `--force`: that flag also
		// overwrites, and advice to pass it that does not say a config exists is
		// advice to replace a hand-written one with a guess.
		if (existsSync(target) && !args.flags.force) {
			fail(`loupe: ${target} already exists (use --force)\n`);
			return EXIT.CANNOT_RUN;
		}
		// A written config is not a guess any more: `inferred` goes false, which turns
		// blocking back on by default and lifts the css/dead-class demotion. Inference
		// must never launder a truncated answer into an authored one.
		if (info.truncated && !args.flags.force) {
			// The note above has already said why; this says only what it refuses
			// to do about it, so the two lines do not read as one repeated twice.
			fail(
				'loupe: refusing to write that guess to a config \u2014 a written config is not held to advisory. ' +
					'Point --root at the project, or pass --force to write it anyway.\n',
			);
			return EXIT.CANNOT_RUN;
		}
		// The fallback is not an answer, and writing it down makes it permanent: once
		// the file exists inference never runs again, so the day the project gains a
		// dependency detection would have recognised, nothing notices. Hand the
		// question over instead, with what detection saw but could not rank.
		if (guessedPreset(info.presetConfidence) && !named && !args.flags.force) {
			const evidence = info.presetEvidence.length
				? ['  Evidence that was not conclusive:', ...info.presetEvidence.map((e) => `    ${e}`)]
				: ['  Nothing else in the project points at a design system either.'];
			lines.push(
				'',
				`  Cannot infer the design system. Available presets: ${listPresets().join(', ')}.`,
				'',
				...evidence,
				'',
				`  Pick one and re-run:  ${cyan('loupe init --preset <name>')}`,
				dim(`  or write ${info.preset} anyway:  loupe init --force`),
			);
			process.stdout.write(`${lines.join('\n')}\n`);
			fail('loupe: refusing to write a guessed design system to a config.\n');
			return EXIT.CANNOT_RUN;
		}
		writeFileSync(target, `${JSON.stringify(info.config, null, 2)}\n`);
		process.stdout.write(`${lines.join('\n')}\n\n${green(`Wrote ${target}`)}\n`);
		return EXIT.OK;
	}

	// What `serve` and `lsp` analyze with: fresh per request, against the config
	// loaded at startup, with the baseline applied. Both return before the shared
	// baseline block below, so they apply it here or show a backlog the project
	// has already accepted.
	const baselinedRun = (notice: (line: string) => void): (() => Promise<AnalyzeResult | BaselinedResult>) => {
		let warned = false;
		return async () => {
			const fresh = await analyze(config, { scope: null });
			if (args.flags['no-baseline']) return fresh;
			const { path: bPath, found } = findExistingBaseline(root, namedBaseline, config.baselinePath);
			const baseline = found ? readBaseline(bPath) : null;
			// Once, not per request: a long-lived process would repeat it until the
			// line meant nothing.
			if (found && !baseline && !warned) {
				warned = true;
				notice(`loupe: baseline at ${bPath} is unreadable — ignoring it.\n`);
			}
			return applyBaseline(fresh, baseline, { enabled: config.enabled });
		};
	};

	// Before every reporting path below: only framed protocol messages may reach
	// stdout once the server is running.
	if (command === 'lsp') {
		const { closed } = lsp({
			config,
			run: baselinedRun((line) => process.stderr.write(line)),
			input: process.stdin,
			output: process.stdout,
			log: (line) => process.stderr.write(`loupe: ${line}\n`),
		});
		await closed;
		return EXIT.OK;
	}

	if (command === 'serve') {
		// `0` is a legal port — it asks the OS to choose — so the floor is 0, and
		// the `??` default is what makes a bare `loupe serve` predictable.
		const port = Number(args.flags.port ?? 7331);
		if (!Number.isInteger(port) || port < 0 || port > 65535) {
			fail(`loupe: --port wants a port number, got ${args.flags.port}\n`);
			return EXIT.CANNOT_RUN;
		}
		const run = baselinedRun(note);
		const { url } = await serve({ port, config, run });
		process.stdout.write(
			`${green(`loupe serve — ${url}`)}\n` +
				`${dim('  Open that URL for the bookmarklet, then click it on the page you are developing.')}\n` +
				`${dim('  Ctrl-C to stop.')}\n`,
		);
		// Nothing resolves this: the server holds the process open until killed.
		await new Promise(() => {});
		return EXIT.OK;
	}

	// Writes to the project path: a backlog recorded here has to be visible to
	// the hook, which is a different process with a different environment.
	if (command === 'baseline') {
		const result = await analyze(config, { scope: null });
		const target = baselinePath(root, namedBaseline ?? config.baselinePath);
		// Nothing collapsed means nothing to reconcile, and saying the same number
		// twice invents a distinction the reader then has to go and check.
		const counted = (findings: number, entries: number): string =>
			findings === entries
				? `${findings} finding(s)`
				: `${findings} finding(s) as ${entries} ${entries === 1 ? 'entry' : 'entries'}`;

		// The baseline is only a gate for everyone once it is committed. Gitignored,
		// CI and every other clone run with none and report the whole accepted
		// backlog — a divergence nothing else would mention. Silent outside git.
		const ignoredWarning = (findings: number): string | null =>
			gitIgnores(root, target)
				? yellow(
						`  Warning: ${relative(root, target) || target} is gitignored. It will not reach CI or other clones,\n` +
							`  which will run without it and report all ${findings} finding(s). Un-ignore it, or \`git add -f\` it.`,
					)
				: null;

		// What recording would change, written nowhere. `check` cannot answer this:
		// it applies the existing baseline, so on a repo that has one it reports
		// nothing to confirm, and `--no-baseline` answers "everything", not "what
		// changes if I record now". Compared against the baseline in force \u2014 the one
		// `check` reads \u2014 since that is what the write would replace.
		if (args.flags['dry-run']) {
			const base = findExistingBaseline(root, namedBaseline, config.baselinePath);
			const prior = base.found ? readBaseline(base.path) : null;
			const { entries, rules } = diffBaseline(result, prior);
			const width = Math.max(0, ...rules.map((r) => r.rule.length));
			const lines = [`Would record ${counted(result.findings.length, entries)} \u2192 ${target}`, ''];
			for (const r of rules) {
				const split = [r.added ? yellow(`+${r.added} new`) : '', r.removed ? green(`-${r.removed} fixed`) : '']
					.filter(Boolean)
					.join(', ');
				lines.push(
					`  ${magenta(r.rule.padEnd(width))}  ${String(r.findings).padStart(5)}${split ? `   (${split})` : ''}`,
				);
			}
			if (!rules.length) lines.push('  (nothing to record)');
			lines.push('');
			if (!base.found) lines.push(dim('No existing baseline \u2014 every entry would be new.'));
			else if (!prior)
				lines.push(yellow(`Existing baseline at ${base.path} is unreadable \u2014 recording would replace it.`));
			else {
				const n = prior.entries.length;
				lines.push(
					`Existing baseline: ${n} ${n === 1 ? 'entry' : 'entries'}, recorded ${prior.createdAt || '(no date)'}${
						base.path === target ? '' : ` \u2014 ${base.path}`
					}`,
				);
				if (!rules.some((r) => r.added || r.removed))
					lines.push(dim('Nothing would change: recording now rewrites the same entries.'));
			}
			const ignored = ignoredWarning(result.findings.length);
			if (ignored) lines.push('', ignored);
			process.stdout.write(`${lines.join('\n')}\n`);
			return EXIT.OK;
		}

		const { path, findings, entries } = writeBaseline(target, result);
		process.stdout.write(green(`loupe: baselined ${counted(findings, entries)} \u2192 ${path}\n`));
		// Said at the moment of writing, because it is the moment the user is looking:
		// whether the file is tracked decides whether the gate means anything to
		// anyone else.
		process.stdout.write(
			`\n${
				ignoredWarning(findings) ??
				dim('  Commit this file \u2014 until it is tracked, the gate applies only to this working copy.')
			}\n`,
		);
		return EXIT.OK;
	}

	// A directive written in a keyword this config no longer asks for still mutes,
	// so the rename is named in the inventory rather than turned into a finding.
	// (One that carries the grammar's shape and breaks it still reports as
	// `suppression/malformed`, whichever keyword it was written in.)
	if (command === 'suppressions') {
		const by = args.flags['group-by'];
		if (by !== undefined && !isGroupBy(by)) {
			fail(`loupe: unknown grouping "${by}" \u2014 expected ${GROUP_BYS.join(', ')}\n`);
			return EXIT.CANNOT_RUN;
		}
		const all = (await analyze(config, { scope: null })).directives;
		const staleOnly = Boolean(args.flags.stale);
		const directives = staleOnly ? all.filter((d) => d.stale) : all;
		const kw = config.suppression.keyword;
		// Why an id muted nothing, where the config can say: otherwise the finding
		// it was written for is simply gone.
		const why = (id: string): string =>
			!isRuleId(id) ? 'not a rule' : !config.enabled[id] ? 'rule off' : 'mutes nothing';
		const staleNote = (d: Directive): string =>
			d.stale ? yellow(`  [stale: ${d.stale.map((id) => `${id} \u2014 ${why(id)}`).join('; ')}]`) : '';
		const tail = (d: Directive): string =>
			`${d.reason}${d.alias ? dim(`  (${d.alias} \u2192 ${kw})`) : ''}${staleNote(d)}`;
		// A rule turned off in config is the broadest suppression there is, so it is
		// listed, first, with its reason or the lack of one. Not under `--stale`:
		// nothing was offered to it to mute, so there is nothing to call stale.
		const offs: ConfigSuppression[] = staleOnly
			? []
			: RULE_IDS.flatMap((id) => {
					const from = config.ruleFrom[id];
					return from !== undefined && config.rules[id].severity === 'off'
						? [
								{
									scope: 'config' as const,
									file: from,
									rules: [id] as [typeof id],
									reason: config.rules[id].reason ?? null,
								},
							]
						: [];
				});
		const offTail = (o: ConfigSuppression): string => `${dim('(rule off)')}  ${o.reason ?? yellow('no reason given')}`;
		const listed: (ConfigSuppression | Directive)[] = [...offs, ...directives];
		const exit = staleOnly && directives.length ? EXIT.BLOCKED : EXIT.OK;
		if (args.flags.format === 'json') process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
		else if (!by)
			for (const d of listed)
				process.stdout.write(
					'scope' in d
						? `${dim(d.file)}  ${magenta(d.rules[0])}  ${offTail(d)}\n`
						: `${dim(`${d.file}:${d.line}`)}  ${magenta(d.rules.join(','))}  ${tail(d)}\n`,
				);
		else {
			// By rule, a directive naming two rules is listed under each. By file, a
			// rule turned off in config is listed under the file that turned it off.
			const groups = new Map<string, (ConfigSuppression | Directive)[]>();
			for (const d of listed)
				for (const key of by === 'rule' ? d.rules : [d.file]) groups.set(key, [...(groups.get(key) ?? []), d]);
			const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || byBytes(a[0], b[0]));
			const out: string[] = [];
			for (const [key, group] of sorted) {
				out.push(`${by === 'rule' ? magenta(key) : bold(key)} ${dim(`(${group.length})`)}`);
				const width = Math.max(...group.map((d) => ('scope' in d ? 0 : String(d.line).length)));
				for (const d of group)
					out.push(
						'scope' in d
							? by === 'rule'
								? `  ${dim(d.file)}  ${offTail(d)}`
								: `  ${magenta(d.rules[0])}  ${offTail(d)}`
							: by === 'rule'
								? `  ${dim(`${d.file}:${d.line}`)}  ${tail(d)}`
								: `  ${dim(String(d.line).padStart(width))}  ${magenta(d.rules.join(','))}  ${tail(d)}`,
					);
				out.push('');
			}
			process.stdout.write(out.join('\n'));
		}
		if (staleOnly && args.flags.format !== 'json')
			process.stderr.write(
				directives.length
					? `loupe: ${directives.length} stale suppression(s) of ${all.length}\n`
					: `loupe: no stale suppressions (${all.length} checked)\n`,
			);
		return exit;
	}

	// Before the walk, like `--format` below: a misspelled id would filter every
	// finding out and report clean.
	const rules = ruleScope(args.flags.rule);
	if (rules && !(rules instanceof Set)) {
		// In the hook the id is in a hook command nobody in the turn can edit, and
		// exit 2 would block every turn on it, past any retry budget.
		if (isHook) return emitClean(`loupe: skipped — ${rules.error}`);
		fail(`loupe: ${rules.error}\n`);
		return EXIT.CANNOT_RUN;
	}
	// A real id for a rule this config switched off is not a mistake, and its
	// silence is not a clean bill either.
	for (const id of rules ?? [])
		if (!config.enabled[id]) note(`loupe: ${id} is off in this config \u2014 it reports nothing.\n`);
		// Nor is a rule only the judge reports, named on a run that does not judge.
		else if (id === 'patterns/judged-redirect' && command === 'check' && !args.flags.judge)
			note(`loupe: ${id} reports only under --judge \u2014 this run reports nothing for it.\n`);

	// The one network call in the engine, so the key is checked before the walk.
	// Typed by hand, a `--judge` that cannot judge is a mistake worth refusing.
	// In the hook it is a flag the user never typed, so a missing key leaves the
	// run deterministic instead of failing every write.
	const apiKey = args.flags.judge ? judgeKey() : undefined;
	if (args.flags.judge && !apiKey && !isHook) {
		fail(`loupe: --judge needs TYPESAFE_API_KEY, from ${KEY_SOURCES}\n`);
		return EXIT.CANNOT_RUN;
	}

	// ── fix ───────────────────────────────────────────────────────────────────
	// Only substitutions the engine resolved to exactly one on-role token. The
	// baseline is deliberately ignored: burning that backlog down is the point.
	if (command === 'fix') {
		const fixScope = resolveScope(config, args, { defaultChanged: false });
		if (fixScope !== null && !Array.isArray(fixScope)) {
			fail(`loupe: ${fixScope.error}\n`);
			return EXIT.CANNOT_RUN;
		}
		let toFix: AnalyzeResult;
		try {
			// Before the judgements, so a rule left out costs no paid question.
			toFix = filterRules(await analyze(config, { scope: fixScope }), rules);
		} catch (err) {
			fail(`loupe: ${messageOf(err)}\n`);
			return EXIT.CANNOT_RUN;
		}
		// Each judgement in its own `try`, as in `check`: a failed request leaves
		// those findings unjudged, and every fix that needed no model is still
		// written below.
		const about = tokenDescriptions(config.profiles?.active ?? []);
		try {
			// Every channel: a judged replacement is written in all three. Only a
			// judged `keep` outside a stylesheet has nowhere to go, and that one is
			// reported as a skip rather than paid for silently.
			// With no design-system tokens, `judgeValues` is the one to refuse, and
			// the refusal is noted like any other failure.
			const judgeable = toFix.findings.filter((f) => f.suggest?.length);
			if (apiKey && judgeable.length) await judgeValues(root, judgeable, toFix.tokens, apiKey, about);
		} catch (err) {
			note(`loupe: --judge left hardcoded values unjudged \u2014 ${messageOf(err)}\n`);
		}
		try {
			// A judged rename is written like a spelled one, every line naming it.
			if (apiKey && toFix.tokens) await judgeRenames(root, toFix.findings, toFix.tokens, apiKey, about);
		} catch (err) {
			note(`loupe: --judge left unknown tokens unjudged \u2014 ${messageOf(err)}\n`);
		}
		const dry = Boolean(args.flags['dry-run']);
		const { applied, skipped } = applyTokenFixes(root, toFix.findings, { dry });
		// After the rewrites, which never move a line, and bottom up within a file,
		// because a directive is a line of its own.
		const kept = apiKey
			? applyKeeps(root, toFix.findings, config.suppression.keyword, { dry, directives: toFix.directives })
			: { applied: [], skipped: [] };
		const verb = dry ? 'would fix' : 'fixed';
		// Flattened at the print site rather than at capture, because the raw value is
		// what the substitution matches against. Not bounded: both lines exist to be
		// acted on, and an elided value can be matched against neither.
		// A rename has no property around it, so it prints as the bare name it is.
		const decl = (f: { prop?: string | undefined; value: string }): string =>
			oneLine(f.prop === undefined ? f.value : `${f.prop}: ${f.value}`);
		for (const f of applied) process.stdout.write(`${dim(`${f.file}:${f.line}`)}  ${decl(f)} \u2192 ${green(f.to)}\n`);
		for (const k of kept.applied)
			process.stdout.write(
				`${dim(`${k.file}:${k.line}`)}  ${decl(k)} \u2192 ${green(`${config.suppression.keyword}, ${k.reason}`)}\n`,
			);
		for (const f of [...skipped, ...kept.skipped])
			process.stdout.write(`${yellow('skip')} ${dim(`${f.file}:${f.line}`)}  ${decl(f)} \u2014 ${f.why}\n`);
		// The one token a value matched, held back because the profile scopes it
		// elsewhere: named, so the review starts from the candidate and the reason.
		for (const f of toFix.findings)
			for (const s of f.suggest ?? [])
				if (s.review && !s.judged)
					process.stdout.write(
						`${yellow('review')} ${dim(`${f.file}:${s.line ?? f.line}`)}  ${decl(s)}${s.tokens.length ? ` \u2192 ${s.tokens.join(' or ')}` : ''} \u2014 ${s.review}\n`,
					);
		// A collapsed finding is several declarations and a misspelled token is
		// every line naming it, so a substitution written is not a finding cleared.
		// What is counted as done is the finding every one of whose parts was
		// rewritten or suppressed.
		const left = toFix.findings.length - settledBy(toFix.findings, applied, kept.applied);
		const nSkipped = skipped.length + kept.skipped.length;
		process.stdout.write(
			`\nloupe: ${(applied.length ? green : dim)(`${verb} ${applied.length} substitution(s)`)}${
				apiKey ? `, ${dry ? 'would suppress' : 'suppressed'} ${kept.applied.length}` : ''
			}${nSkipped ? yellow(`, skipped ${nSkipped}`) : ''}. ${left} of ${toFix.findings.length} finding(s) left for review.\n`,
		);
		return EXIT.OK;
	}

	if (command !== 'check' && !isHook) {
		fail(`loupe: unknown command "${command}"\n\n`);
		process.stderr.write(usage());
		return EXIT.CANNOT_RUN;
	}

	// Before the analysis, not after it: a run that is going to be rejected for a
	// misspelled flag should not first walk the repo.
	const format = args.flags.format ?? 'agent';
	if (!isHook && !isFormat(format)) {
		fail(`loupe: unknown format "${format}" \u2014 expected ${FORMATS.join(', ')}\n`);
		return EXIT.CANNOT_RUN;
	}
	// Rejected here for the same reason as `--format`: a misspelled `--group-by fil`
	// falling back to the default prints a perfectly good report in the order the
	// caller did not ask for.
	const group = args.flags['group-by'] ?? 'rule';
	if (!isGroupBy(group)) {
		fail(`loupe: unknown grouping "${group}" \u2014 expected ${GROUP_BYS.join(', ')}\n`);
		return EXIT.CANNOT_RUN;
	}
	// ── check / hook ──────────────────────────────────────────────────────────
	// A PostToolUse payload names the file just written; scope to it so drift is
	// reported at write time. Stop payloads carry no file and fall through to
	// the changed-file scope.
	const touched = isHook ? payloadFile(payload, root) : null;
	// A PostToolUse with no file in the project — a note in a scratchpad, a plan
	// under ~/.claude — is not a Stop. Taken for one, it checked the whole changed
	// set absolutely and spent the Stop gate's retry budget on an edit that could
	// not have introduced anything here.
	if (isHook && !touched && hookEvent(payload) === 'PostToolUse')
		return emitClean('loupe: skipped \u2014 not a file in this project.');
	if (touched && !isSource(config.sources, touched)) return emitClean('loupe: skipped \u2014 not a checked file type.');
	const scope: ScopeResult = touched ? [touched] : resolveScope(config, args, { defaultChanged: isHook });
	if (scope !== null && !Array.isArray(scope)) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${scope.error}`);
		fail(`loupe: ${scope.error}\n`);
		return EXIT.CANNOT_RUN;
	}

	let result: AnalyzeResult | BaselinedResult;
	try {
		// Before the baseline, so the count of what it hides is this rule's too.
		result = filterRules(
			await analyze(config, { scope, judge: Boolean(apiKey), suppress: !args.flags['no-suppressions'] }),
			rules,
		);
	} catch (err) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${messageOf(err)}`);
		fail(`loupe: ${messageOf(err)}\n`);
		return EXIT.CANNOT_RUN;
	}

	if (!args.flags['no-baseline']) {
		// `found` is what lets the warning below tell an absent baseline from a
		// broken one: `readBaseline` answers null for both.
		const { path: bPath, found } = findExistingBaseline(root, namedBaseline, config.baselinePath);
		const baseline = found ? readBaseline(bPath) : null;
		// A file that is present and unparseable is not the same as no file, and
		// treating it as one puts the whole backlog back with the gate blocking on all
		// of it. Conflict markers in a committed baseline are the ordinary way here.
		//
		// The hook says it too: it is the surface where the agent is handed back a
		// backlog it accepted, with no reason given. `emitBlocking` already writes to
		// stderr, and Claude Code feeds that back on exit 2.
		if (found && !baseline) note(`loupe: baseline at ${bPath} is unreadable \u2014 ignoring it.\n`);
		// A 0.1.x baseline is no longer read, and dropping it was silent: the backlog
		// it held came back as live findings with nothing to say why. On stderr, so
		// JSON and SARIF on stdout stay what a parser expects; not from the hook.
		if (!found && !isHook) {
			const legacy = legacyBaseline(root);
			if (legacy) note(`loupe: ${legacyBaselineNotice(legacy)}\n`);
		}
		result = applyBaseline(result, baseline, { scoped: scope !== null, rules, enabled: config.enabled });
	}
	// Before the judgements: a finding the filter drops is not worth a paid question.
	if (args.flags.severity) result = filterSeverity(result, args.flags.severity);
	if (apiKey) {
		// Judged after the baseline, so accepted findings cost nothing, and a
		// judged finding never enters one: its confidence moves between runs, and
		// a baselined finding that comes and goes is noise in both directions.
		// A failed request leaves the findings as the engine wrote them.
		//
		// In the hook the phase has one deadline, `hook.timeoutMs`. Each request has
		// its own limit, but the stages run one after another, and a hook past
		// Claude Code's timeout is dropped whole, deterministic findings and all.
		// A stage the deadline has passed is not started.
		const deadline = isHook ? AbortSignal.timeout(config.hook.timeoutMs) : null;
		const judgeFetch = deadline ? deadlineFetch(deadline) : fetch;
		const inTime = (): boolean => !deadline?.aborted;
		try {
			// The same filter, for the findings this adds.
			const redirectSeverity = config.severityOf('patterns/judged-redirect');
			if (
				inTime() &&
				result.controls?.length &&
				(args.flags.severity !== 'error' || redirectSeverity === 'error') &&
				(!rules || rules.has('patterns/judged-redirect'))
			) {
				result.findings.push(...(await judgeRedirects(result.controls, apiKey, redirectSeverity, judgeFetch)));
				// Written after `analyze` returned, so past its dedupe: two controls on
				// one line judged alike are one finding, as every other rule's are.
				result.findings = dedupe(result.findings);
			}
			if (inTime()) await judgeVariants(root, result.findings, config.componentRegistry, apiKey, judgeFetch);
		} catch (err) {
			note(`loupe: --judge skipped \u2014 ${messageOf(err)}\n`);
		}
		// Its own note: the judgements above stand when this one cannot run.
		try {
			if (inTime() && result.findings.some((f) => f.suggest?.length))
				await judgeValues(
					root,
					result.findings,
					result.tokens,
					apiKey,
					tokenDescriptions(config.profiles?.active ?? []),
					judgeFetch,
				);
		} catch (err) {
			note(`loupe: --judge left hardcoded values unjudged \u2014 ${messageOf(err)}\n`);
		}
		try {
			if (inTime() && result.tokens && result.findings.some((f) => f.unknown))
				await judgeRenames(
					root,
					result.findings,
					result.tokens,
					apiKey,
					tokenDescriptions(config.profiles?.active ?? []),
					judgeFetch,
				);
		} catch (err) {
			note(`loupe: --judge left unknown tokens unjudged \u2014 ${messageOf(err)}\n`);
		}
		if (!inTime()) note(`loupe: --judge stopped at hook.timeoutMs (${config.hook.timeoutMs}ms)\n`);
		// Computed before the redirects above existed: one configured to `error`
		// has to be able to fail the run it is reported in.
		result.blocking = result.findings.some((f) => f.severity === 'error');
	}

	if (isHook) {
		const sessionId = payload.session_id ?? '';
		const budgetKey = touched ? `${sessionId}\u0000${touched}` : sessionId;
		// Two questions, one per hook. PostToolUse asks whether this edit made the
		// file worse, and blocks only on what it introduced: a refactor passes
		// through states that are worse before they are better, and a finding the
		// edit walked past is not the edit's fault. Stop asks whether the turn's work
		// is conformant, absolutely — the JSX converted and the CSS left behind is an
		// omission by then, not an intermediate state.
		//
		// The "before" is only analyzed when the "after" would block, so a clean
		// edit pays nothing for the question.
		//
		// Passing a standing finding over is a deferral only where Stop will see it.
		// Where Stop cannot resolve the files the turn changed — no git worktree, or
		// a repository git refuses to read — it stands down, and a finding passed
		// over here is never enforced at all: that is the absolute check, as before.
		const errors = result.findings.filter((f) => f.severity === 'error');
		let blocking: Finding[] = errors;
		const stopSees = (): boolean => {
			const stopScope = resolveScope(config, args, { defaultChanged: true });
			return stopScope === null || Array.isArray(stopScope);
		};
		if (touched && errors.length && stopSees()) {
			const before = await findingsBeforeEdit(config, touched, preEditContent(payload), {
				judge: Boolean(apiKey),
				suppress: !args.flags['no-suppressions'],
			});
			blocking = introducedBy(errors, before);
		}
		// What stood before the edit and still does: never more than stood before it.
		const standing = errors.length - blocking.length;
		// Said, not dropped: the agent should know what it is walking past, and that
		// Stop will hold it to them.
		const standingNote = standing
			? ` ${standing} blocking finding(s) already in ${touched} before this edit, left for the Stop check.`
			: '';
		if (!blocking.length) {
			clearAttempts(root, budgetKey);
			if (!standing) return emitClean(`${formatSummary(result)}${ceilingSuffix}`);
			// The agent hears it too, with the findings: it is the agent Stop holds to them.
			const message = `loupe: this edit added no blocking findings.${standingNote}${ceilingSuffix}`;
			const report = formatAgent({ ...result, findings: errors }, config, {
				maxFindings: config.hook.maxFindings,
				terse: true,
			});
			return emitAdvisory(message, `${message}\n\n${report}`, payload);
		}
		const attempts = bumpAttempts(root, budgetKey);
		const max = config.hook.maxAttempts;
		if (!sessionId && payload.stop_hook_active) {
			// No session id to budget against: fall back to the conservative
			// single-pass behaviour rather than risk looping the turn.
			return emitClean(`loupe: blocking findings remain (retry budget unavailable).${ceilingSuffix}`);
		}
		if (attempts > max) {
			// Latched, not cleared: clearing the counter here reset the budget, so the
			// stand-down lasted exactly one turn. The clean-run branch above releases it
			// the moment the finding goes, and `readState` ages the entry out.
			// Said once: repeating it every fire is the nagging it exists to end.
			return emitClean(
				attempts === max + 1
					? `loupe: still failing after ${max} attempt(s) \u2014 gate stood down. ${formatSummary(result, { prefix: false })}${ceilingSuffix}`
					: `${formatSummary(result)}${ceilingSuffix}`,
			);
		}
		const report = formatAgent({ ...result, findings: blocking }, config, {
			maxFindings: config.hook.maxFindings,
			terse: true,
		});
		return emitBlocking(`${report}\n\n(attempt ${attempts} of ${max})${standingNote}${ceilingSuffix}`);
	}

	const maxFindings = Number(args.flags['max-findings'] ?? 0) || 0;
	if (format === 'json') process.stdout.write(`${JSON.stringify(reportPayload(result, config), null, 2)}\n`);
	else if (format === 'sarif') process.stdout.write(`${formatSarif(result, config)}\n`);
	// Already newline-terminated, and large: it is the one format most likely to
	// be redirected, which is what the process.exitCode note below is about.
	else if (format === 'html') process.stdout.write(formatHtml(result, config));
	else {
		process.stdout.write(`${formatAgent(result, config, { maxFindings, group, concise: !!args.flags.concise })}\n`);
		if ('baselined' in result && result.baselined)
			process.stdout.write(dim(`\n${result.baselined} baselined finding(s) hidden.\n`));
		// The fallback ruleset turns most rules off, and on an inferred config that
		// was otherwise invisible on every run.
		if (detected?.config.extends === 'generic' && guessedPreset(detected.presetConfidence)) {
			const off = RULE_IDS.filter((id) => !config.enabled[id]).length;
			process.stdout.write(
				dim(
					`\nloupe: no config, and no design system recognised \u2014 ran as generic, with ${off} of ${RULE_IDS.length} rules off. Run \`loupe init\` to choose one.\n`,
				),
			);
		}
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
		// A refusal is a message, not a crash: `baseline` and `suppressions` reach
		// the tree ceiling here rather than through a catch of their own.
		fail(`loupe: ${err instanceof TreeTooLarge ? err.message : err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = EXIT.CANNOT_RUN;
	});
