/**
 * loupe — design-system conformance checking for front-end codebases.
 *
 * Exit codes are a contract; callers (CI, hooks, quality runners) depend on them:
 *   0  clean, or advisory findings only
 *   1  blocking findings
 *   2  could not run (bad usage, not a git worktree, config error)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseArgv } from 'node:util';
import { analyze } from './analyze.ts';
import { usableReplacement } from './checks/system/currency.ts';
import { CSS_FILE, applyKeeps, applyTokenFixes } from './autofix.ts';
import { judgeRedirects, judgeValues, judgeVariants, tokenDescriptions } from './judge.ts';
import { applyBaseline, readBaseline, writeBaseline } from './baseline.ts';
import { EMBEDDED_VERSION, hasPreset } from './embedded.ts';
import { findConfig, listPresets, loadConfig } from './config.ts';
import { SEV_PAINT, bold, cyan, dim, green, magenta, red, setColor, yellow } from './color.ts';
import { changedFiles, hasGitDir, isSource, isWorktree, toPosix } from './discover.ts';
import { RULES, RULE_IDS, canonicalRuleId, isRuleId, renderTitle } from './rules.ts';
import { formatAgent, formatSarif, formatSummary, reportPayload } from './report.ts';
import { formatHtml } from './report-html.ts';
import { oneLine } from './text.ts';
import { DETECT_ENTRY_BUDGET, detectConfig, detectPreset } from './detect.ts';
import { applyRegistries, readProfiles, selectProfiles } from './profiles.ts';
import type { RegistrySource } from './profiles.ts';
import { baselinePath, findExistingBaseline, isPluginContext } from './paths.ts';
import {
	bumpAttempts,
	clearAttempts,
	emitBlocking,
	emitClean,
	hookRoot,
	hookOff,
	parsePayload,
	payloadFile,
	readStdin,
	resolvedOptions,
} from './hook.ts';
import type { HookPayload } from './hook.ts';
import type { AnalyzeResult, BaselinedResult, Config } from './types.ts';
import type { DetectedConfig } from './detect.ts';

const EXIT = { OK: 0, BLOCKED: 1, CANNOT_RUN: 2 };

/** First line of an unknown throw. Anything can be thrown; only Errors carry a message. */
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The TypeSafe key, from the environment or loupe's own `.env`, or undefined.
 * `--judge` is the one network call in the engine, so its callers check this
 * before the walk, and the hook never asks.
 */
function judgeKey(): string | undefined {
	try {
		if (!process.env.TYPESAFE_API_KEY) process.loadEnvFile?.(ENV_FILE);
	} catch {
		/* no .env beside the checkout is the ordinary case */
	}
	return process.env.TYPESAFE_API_KEY;
}

/**
 * The two things stderr carries, told apart by colour as well as by wording.
 *
 * A refusal ends the run; a note is a run continuing on a partial answer. They
 * were already interleaved on one stream in the same `loupe:` voice, and a
 * reader scanning for the reason a command exited 2 had to read every line to
 * find which one it was.
 */
const fail = (msg: string): void => {
	process.stderr.write(red(msg));
};
const note = (msg: string): void => {
	process.stderr.write(yellow(msg));
};

/**
 * How far a detection result is to be trusted, coloured to match.
 *
 * `detect` prints two of these and `init` writes the config they describe, so
 * the thing worth seeing at a glance is the weaker of the two — a low-confidence
 * namespace list is the one that gets written down and then blocks turns.
 */
const confidence = (level: string): string =>
	(level === 'high' ? green : level === 'none' ? red : yellow)(`[${level} confidence]`);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Whether this is a single-file artifact rather than an installed directory.
 * A binary carries its data compiled in, so it can never see the manifest that
 * sits beside the engine — which makes that the test, with no dependence on
 * how any particular compiler spells its synthetic root.
 */
const SINGLE_FILE = !existsSync(join(HERE, '..', 'package.json'));

/** A `.env` beside the checkout; for a binary, one in the working directory. */
const ENV_FILE = SINGLE_FILE ? resolve('.env') : join(HERE, '..', '..', '.env');

/**
 * Which loupe this is: the version, whether it runs from source or the built
 * bundle, and where it lives. Three copies of the plugin can coexist on one
 * machine (a checkout, a dotfiles clone on PATH, the marketplace install the
 * hook runs), and the manifest alone cannot say which one answered. Both
 * entries sit one level below `engine/`, which is what lets one relative path
 * find the manifest from either.
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
 * The text stays one plain template above: it is also what `--help | grep`
 * gets, and threading colour through forty lines of it would put an escape
 * sequence in front of every word someone might search for. Commands and
 * options are matched where the layout already puts them — first token of an
 * indented line — so a reworded description cannot accidentally light up.
 */
const usage = (): string =>
	USAGE.replace(/^ {2}(--[a-z-]+)/gm, (_m, flag: string) => `  ${cyan(flag)}`)
		.replace(/^ {2}([a-z]+)\b/gm, (_m, cmd: string) => `  ${bold(cmd)}`)
		.replace(/^(Commands|Options|Environment):$/gm, (_m, head: string) => `${bold(`${head}:`)}`);

/**
 * The flags that take a value. Everything else is a boolean switch.
 *
 * Declared `as const` so the two halves cannot drift: this list decides what
 * consumes the next argv entry, and {@link Flags} decides what type comes back.
 */
const VALUE_FLAGS = [
	'format',
	'config',
	'root',
	'preset',
	'files',
	'max-findings',
	'severity',
	'baseline',
	'patterns',
	'components',
	'profiles',
	'profile',
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];

/**
 * What `--format` accepts on the check path.
 *
 * Held as a list because the dispatch used to be a chain ending in `else`, so a
 * typo — `--format sarf` — printed the agent format and exited 0. That reads as
 * a successful run to a CI job that then uploads an empty artifact, which is
 * the worst available failure: silent, and shaped exactly like success.
 */
const FORMATS = ['agent', 'json', 'sarif', 'html'] as const;
type Format = (typeof FORMATS)[number];
const isFormat = (f: string): f is Format => (FORMATS as readonly string[]).includes(f);

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
	version?: boolean;
	all?: boolean;
	changed?: boolean;
	'no-baseline'?: boolean;
	'dry-run'?: boolean;
	judge?: boolean;
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
		options: Object.fromEntries(VALUE_FLAGS.map((f) => [f, { type: 'string' }])),
		allowPositionals: true,
		strict: false,
	});
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
  suppressions          List every active suppression directive
  explain <rule>        Print a rule's guidance
  presets               List bundled presets
  version               Print the version, whether it runs from source or the bundle, and where
  detect                Show the config that would be inferred for this project
  init                  Write the inferred config to loupe.config.json
  status                Show the effective config: rules, severities, what blocks
  hook                  Claude Code hook mode (reads payload on stdin)

Options:
  --changed             Only report findings in files changed vs. HEAD (default for hook)
  --all                 Report across the whole repo (default for check)
  --files a,b           Only report findings in these files
  --format <f>          agent | json | sarif | html  (default: agent)
                        html writes a self-contained page — redirect it to a file
  --max-findings <n>    Cap findings shown; 0 = no cap (default: 0)
  --severity <s>        error | warn — minimum severity to report
  --baseline <path>     Read/write the baseline here instead of the configured
                        path (default: .loupe-baseline.json in the project)
  --no-baseline         Ignore the baseline file for this run
  --dry-run             Report what 'fix' would change without writing
  --judge               Ask TypeSafe what a parse cannot see: the variant a raw
                        element needs, whether a control stands for the
                        pattern it was built as (patterns/judged-redirect), and
                        which token a hardcoded value should be, or whether it
                        is deliberate. With fix, rewrites the values it settled
                        and suppresses the ones it kept; add --dry-run to
                        review them first. (TYPESAFE_API_KEY from the
                        environment or loupe's own .env)
  --force               Overwrite an existing config (init)
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
  LOUPE_OFF=1           Silence an opted-in hook for this session. Start Claude
                        Code as 'LOUPE_OFF=1 claude'.
                        Both read 1/true/yes/on as on; anything else — 0 and
                        false included — as not set.

With no config file present, the project is inspected and a config inferred.
Run 'loupe detect' to see what that produces, 'init' to write it down.
`;

/**
 * Which files to report on: every file (`null`), a named set, or a refusal.
 * `null` is a real answer here, so the failure case has to be its own shape.
 */
type ScopeResult = string[] | null | { error: string };

/**
 * The refusal a run gets when there is no project here to ask git about.
 *
 * One constant because it is now said in two places — once by the scope
 * resolver, and once by the guard that runs before inference so the walk is
 * never paid for on the way to it — and a gate that phrases the same refusal
 * two ways is a gate whose callers cannot match on either.
 */
const NOT_A_WORKTREE = 'not a git worktree; use --all or --files';

/** Commands that resolve the changed-file scope, and can therefore hit {@link NOT_A_WORKTREE}. */
const SCOPED_COMMANDS = new Set(['check', 'fix']);

/**
 * Would this run refuse anyway without a worktree?
 *
 * `--all` and `--files` name their own scope and never ask git anything, so
 * they work perfectly well in a directory that is neither a package nor a
 * worktree — and did, before the guard that reads this existed. `--changed` is
 * only a scope on the two commands that resolve one: `detect --changed`,
 * `baseline --changed` and `status --changed` ignore the flag entirely, and a
 * guard standing in for a refusal those runs would never have got is a guard
 * inventing one.
 *
 * The hook is here for a different reason. Its root is a fallback to the
 * process cwd whenever CLAUDE_PROJECT_DIR is unset, so it is the one caller
 * that gets pointed at a directory nobody chose — and a PostToolUse payload
 * naming a file short-circuits the scope resolver, so on that path the refusal
 * below is genuinely new rather than merely earlier.
 */
const needsProject = (command: string, args: Args, isHook: boolean): boolean => {
	if (args.flags.all || args.flags.files) return false;
	return isHook || (Boolean(args.flags.changed) && SCOPED_COMMANDS.has(command));
};

/**
 * Is there a project here, by any evidence the engine already trusts?
 *
 * Deliberately generous, because the cost of a false negative is a gate that
 * turns itself off and says so only in a message the hook suppresses. Five
 * kinds of evidence, cheapest first, none of which walks the tree:
 *
 * - a manifest, node-shaped or PHP-shaped. `composer.json` is here because a
 *   WordPress plugin is as likely to carry one as a `package.json`, and this
 *   plugin's audience is more likely to be in one than in a React app;
 * - a `.git` entry anywhere up the tree. Searched upwards, because the case
 *   that needs answering is the subdirectory, and a subdirectory has no `.git`
 *   of its own — and answered off the filesystem, which survives the two cases
 *   where asking git fails rather than answers: a dubious-ownership mount, the
 *   normal state inside a container, and no `git` binary on PATH at all;
 * - git itself, which is what still recognises a worktree the filesystem walk
 *   above cannot see — one told by `GIT_DIR`, say. Asked after that walk and
 *   not before it, because it is a subprocess and the walk is a handful of
 *   `existsSync` calls;
 * - and last, a preset that matches, which is the engine's own definition of a
 *   project. A deployed block theme in `wp-content/themes/` has a `theme.json`
 *   and a `templates/` directory and frequently none of the above, and
 *   `detectPreset` identifies it at high confidence. Refusing to gate a
 *   directory this same binary confidently identifies is indefensible.
 *
 * `detectPreset` reads manifests three levels down and the markers in the root
 * and its immediate children — bounded, and nowhere near `discover`, so this
 * stays off the walk that the guard exists to avoid. It is still the dearest of
 * the five, which is why it is asked last.
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
 * rather than walking, so the preset line stays as good as it ever was and can
 * still legitimately read `high`. It is the namespace list that came from a
 * prefix — and a namespace list drawn from a prefix looks exactly like one
 * drawn from a whole project, down to the confident-looking coverage
 * percentage, which is computed over what was read.
 *
 * Four surfaces say this — stderr, `status`, `detect`'s `scanned:` line and the
 * hook's own message — so they are built from two shared fragments rather than
 * written out four times, and rewording it stays one edit. The ceiling carries
 * its thousands separator: `${DETECT_ENTRY_BUDGET}` alone renders `50000`
 * against the `50,000` both READMEs document.
 */
const CEILING = `${DETECT_ENTRY_BUDGET.toLocaleString('en-US')}-entry ceiling`;
const CEILING_WHY =
	'this root is larger than a project, so the namespaces are a guess from the part of it that was read';
const TRUNCATED_NOTE =
	`loupe: inference stopped at the ${CEILING} \u2014 ${CEILING_WHY}. ` +
	'Point --root at the project, then write a config with `loupe init`.\n';
/** The same fact, sized for a hook message that has to stay one line. */
const CEILING_SUFFIX = ` (inference stopped at the ${CEILING}; namespaces are a guess)`;

function resolveScope(
	config: Config,
	args: Args,
	{ defaultChanged = false }: { defaultChanged?: boolean },
): ScopeResult {
	const given = (['all', 'changed', 'files'] as const).filter((f) => args.flags[f]);
	if (given.length > 1) return { error: `conflicting scope flags: ${given.map((f) => `--${f}`).join(' ')}` };
	if (args.flags.all) return null;
	if (args.flags.files)
		return (
			args.flags.files
				.split(',')
				.map((f) => f.trim())
				.filter(Boolean)
				// Findings are keyed repo-relative, so an absolute path matched nothing
				// and the run reported clean — the worst answer a gate can give.
				.map((f) => toPosix(isAbsolute(f) ? relative(config.root, resolve(f)) : f))
				.filter((f) => f && !f.startsWith('..'))
		);
	if (args.flags.changed || defaultChanged) {
		const changed = changedFiles(config.root);
		if (changed === null) return { error: NOT_A_WORKTREE };
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

	// Two readers are never human, whatever stdout happens to be attached to:
	// the hook, whose report is fed back to an agent, and a machine format,
	// which is parsed. Both would otherwise colour when someone runs them by
	// hand in a terminal to see what they emit — and the escapes they emitted
	// then would be exactly the ones the real consumer chokes on unseen.
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

	// Off unless the project opted in, or silenced for the session.
	//
	// Silence, not advisory mode. An advisory finding still lands in the agent's
	// context, and an agent that sees a finding starts fixing it — which is the
	// whole complaint. The only way to work on something else is for the gate to
	// say nothing at all. Deliberately hook-only: `loupe check` typed by hand is
	// someone asking, and answering "nothing" would be a lie.
	if (isHook && hookOff(args.flags.root ?? hookRoot())) return EXIT.OK;

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
		fail(`loupe: root does not exist: ${root}\n`);
		return EXIT.CANNOT_RUN;
	}

	// Resolved for every command, not just the hook. `status` exists to say what
	// the gate will do, and it cannot do that without the settings the gate reads.
	const { options, source: optionsSource } = resolvedOptions();

	// Read before the config rather than with the other registry work below: a
	// profile names the preset that configures its design system, and that has
	// to be settled before the config it would configure is loaded.
	const profiles = readProfiles(args.flags.profiles ? resolve(args.flags.profiles) : null);
	const forced = args.flags.profile ? (profiles.find((p) => p.id === args.flags.profile) ?? null) : null;
	// A named profile that resolves to nothing used to be a silent no-op — no
	// registries, no preset, exit 0 — which is indistinguishable from the profile
	// applying and finding nothing. Worse, it also suppresses the profile
	// *selection* would have made, so a typo checks strictly less than no flag at
	// all. The sibling failure one screen down already warns; this one has to.
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
	// Detection plus everything that outranks it. Reads `profilePreset` at call
	// time, which is what lets `detect` and `init` below reuse it after the
	// resolution above has settled.
	const runDetection = (): DetectedConfig => {
		const d = detectConfig(root, { preset: profilePreset });
		if (options.projectPrefixes?.length)
			d.config.namespaces = { ...d.config.namespaces, project: options.projectPrefixes };
		return d;
	};
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

		// The project-shape guard runs ahead of inference, not after it.
		//
		// Inference walks the tree; the scope resolver further down is what
		// decides there is no project here. In that order the whole walk was
		// paid for on the way to the refusal — and `hookRoot()` falls back to
		// the process cwd whenever CLAUDE_PROJECT_DIR is unset, so the tree
		// being indexed was sometimes a home directory, on every edit, past
		// the hook's timeout.
		//
		// Only where there is nothing but the directory to go on: a config file,
		// `--config` or `--preset` is somebody stating that *this* directory is a
		// project, and that statement outranks anything guessed from shape. The
		// `preset` plugin option is not such a statement — it is set once, for
		// every project its owner ever opens — so it configures the run without
		// vouching for the root, and leaving it in this test switched the guard
		// off everywhere for anyone who had pinned one.
		const statedProject = Boolean(args.flags.config) || Boolean(args.flags.preset) || Boolean(projectConfig);
		if (!statedProject && needsProject(command, args, isHook) && !looksLikeProject(root)) {
			if (isHook) return emitClean(`loupe: skipped \u2014 ${NOT_A_WORKTREE}`);
			fail(`loupe: ${NOT_A_WORKTREE}\n`);
			return EXIT.CANNOT_RUN;
		}

		const unconfigured = !args.flags.config && !explicitPreset && !projectConfig;
		// A named profile's preset ranks last among the statements *about this
		// project* — --config, --preset, the plugin option's own preset and the
		// project's config file each outrank it — and first against inference,
		// which is a guess about the design system `--profile` just named
		// outright. Until this it was read by nothing at all: naming a profile
		// merged its registries into a config that knew none of its components
		// and left every severity at the generic default.
		if (unconfigured && forced?.preset) {
			if (hasPreset(forced.preset)) profilePreset = forced.preset;
			// A profile naming a preset this install does not carry is a broken
			// profile, not a broken project: its registries still apply, so name
			// what was ignored rather than failing the run over it.
			else if (!isHook) note(`loupe: profile ${forced.id} names preset ${forced.preset}, which is not installed\n`);
		}
		// Override the preset inference chose, not the run it produced. The
		// namespaces are a reading of *this* project and hold whoever picked the
		// design system; skipping detection to inject the preset instead dropped
		// them, which switched css/dead-class off on a repo where it had been
		// running and left `init` writing that loss to disk.
		//
		// Both overrides live here rather than at the call site because `detect`
		// and `init` re-run detection when the run did not, and a config written
		// to someone's repo without them is a wrong artifact that outlives the
		// process that made it.
		if (unconfigured) detected = runDetection();
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

	// Inference that stopped early is still used — a partial answer beats
	// `generic`, which switches every correlation rule off — but it is never used
	// silently. Under the hook stderr is the wrong channel (a clean run's is
	// discarded, and a blocking one's is the agent's report), so the hook says it
	// where it speaks: appended to the systemMessage, which is one line either
	// way. The hook is the caller this ceiling exists for; it cannot be the one
	// caller that never hears about it.
	if (detected?.truncated && !isHook) note(TRUNCATED_NOTE);
	const ceilingSuffix = detected?.truncated ? CEILING_SUFFIX : '';

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
			fail(`loupe: unknown rule "${args._[1] ?? ''}"\n`);
			return EXIT.CANNOT_RUN;
		}
		const state = config.enabled[id]
			? SEV_PAINT[config.severityOf(id)](config.severityOf(id))
			: dim('disabled (config does not satisfy its requirements)');
		process.stdout.write(
			`${magenta(id)}  [${state}]\n  ${renderTitle(id, config.designSystem, config.suppression.keyword)}\n`,
		);
		// The two registry-backed rules have nothing of their own to explain: what
		// they fire on is a list somebody else authored, and a title that says
		// "a current component now covers this job" without saying whose list
		// decided that leaves a reader with nothing to check. Name the size, a few
		// entries to recognise it by, and the file — not the list itself, which
		// runs to hundreds.
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
		return EXIT.OK;
	}

	if (command === 'status') {
		// One conclusion, asked once. `blockingAllowed` answers "do the severities
		// permit blocking"; it is not the same question as "will this gate stop a
		// turn", because a silenced hook stops nothing. Deriving the two answers
		// separately is what let `status` print `hook: OFF` and `Turns are blocked
		// by: ...` seven lines apart — the same drift `isOn` closed one layer down,
		// reappearing in the conclusion instead of the predicate.
		const off = hookOff(root);
		const gateBlocks = blockingAllowed && !off;
		const src =
			config.source.kind === 'file'
				? config.source.path
				: config.source.kind === 'preset'
					? `preset ${config.source.name}`
					: config.source.kind === 'inferred'
						? `inferred (no config file found)${profilePreset ? `, extending preset ${profilePreset}` : ''}`
						: config.source.kind;
		const base = findExistingBaseline(root, args.flags.baseline, config.baselinePath);
		// What design system this run thinks it is checking, in the terms the
		// rules are written against. The rules roster below says which checks are
		// live; it does not say what they will name as the remedy, and that is the
		// half a skill authored for no design system in particular has to read
		// before it writes a line of UI. Empty fields are printed as such: "no
		// layout primitive" is a fact about the system, and inferring it from a
		// missing line is how a skill ends up recommending one that isn't there.
		const ds = config.designSystem;
		const orNone = (arr: readonly string[] | undefined): string => (arr?.length ? arr.join(', ') : '(none)');
		const lines = [
			`${dim('version:    ')}${versionLine()}`,
			`${dim('config:     ')}${src}`,
			`${dim('system:     ')}${ds.name || '(unnamed)'}`,
			`${dim('packages:   ')}${orNone(ds.packages)}`,
			`${dim('layout:     ')}${orNone(ds.layoutComponents)}`,
			`${dim('text:       ')}${orNone(ds.textComponents)}`,
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
			`${dim('options:    ')}${
				optionsSource === 'environment'
					? 'from the plugin environment (hook context)'
					: optionsSource === 'settings'
						? 'from ~/.claude settings'
						: 'none found — plugin defaults apply'
			}${options.blocking === undefined ? '' : `; blocking ${options.blocking ? 'on' : 'off'}`}`,
			`${dim('plugin:     ')}${isPluginContext() ? 'running as a plugin' : 'not running as a plugin'}`,
			// Asked through the same predicate the gate uses. Reporting on mere
			// truthiness meant `LOUPE_OFF=0` printed OFF while the hook went on
			// blocking — a diagnostic lying about the one thing it exists to say.
			...(off ? [yellow(`hook:       OFF \u2014 ${off}`)] : []),
			// Which design system's registries are in play, and — when none are —
			// which ones were on offer. "No composite findings" and "no composite
			// registry" look identical in a report; they must not look identical here.
			// The directory, not just the id: a profile carries the authoring prose
			// for its design system beside its registries, and the skills that read
			// it are written for no design system in particular. Told only "archer",
			// a skill has to guess where that lives \u2014 and guesses wrong the moment
			// the profiles root is a project's own rather than the plugin's.
			`${dim('profile:    ')}${
				config.profiles?.active?.length
					? config.profiles.active.map((p) => `${p.id} (${p.name}) \u2014 ${p.dir}`).join(', ')
					: config.profiles?.available?.length
						? `none selected \u2014 available: ${config.profiles.available.map((p) => p.id).join(', ')}`
						: 'none available'
			}`,
			'',
			bold('rules:'),
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
			// Coloured by what it does, not by the rule's configured severity —
			// same reason the words are: an error-severity rule under a gate that
			// cannot block is advisory, and painting it red says otherwise.
			// The hook never judges, so this one cannot stop a turn at any severity.
			const judgeOnly = id === 'patterns/judged-redirect';
			const verdict = config.enabled[id]
				? sev === 'error' && gateBlocks && !judgeOnly
					? red('BLOCKS')
					: judgeOnly
						? yellow(`${sev === 'error' ? 'error' : 'advisory'}, --judge only`)
						: sev === 'error'
							? yellow('advisory (would block if enabled)')
							: yellow('advisory')
				: dim(`off (${sev === 'off' ? 'disabled in config' : `needs ${def.needs.join('+')}`})`);
			lines.push(`  ${magenta(id.padEnd(32))} ${verdict}`);
		}
		const blockers = RULE_IDS.filter(
			(id) => config.enabled[id] && config.severityOf(id) === 'error' && id !== 'patterns/judged-redirect',
		);
		lines.push(
			'',
			gateBlocks && blockers.length
				? `${red('Turns are blocked by:')} ${blockers.map((id) => magenta(id)).join(', ')}`
				: green('Nothing blocks turns; every finding is advisory.'),
		);
		if (off) {
			lines.push(`The gate is off: ${off}.`);
		} else if (config.inferred) {
			lines.push('css/dead-class is held to advisory because the namespaces were inferred, not configured.');
			if (detected?.truncated) lines.push(`Inference stopped at the ${CEILING}: ${CEILING_WHY}.`);
			if (!blockingAllowed)
				lines.push(
					'The gate reports only: this config was inferred and "Block turns on findings" is not on. Write a config with `loupe init`, or turn the setting on.',
				);
		} else if (!blockingAllowed) {
			lines.push('The gate reports only: "Block turns on findings" is off in the plugin settings.');
		}
		process.stdout.write(`${lines.join('\n')}\n`);
		return EXIT.OK;
	}

	if (command === 'detect' || command === 'init') {
		const info = detected ?? runDetection();
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
			// What inference concluded still gets reported; it is just no longer
			// what the run uses. `init` writes the config below verbatim, so the
			// two lines disagreeing without explanation is a file someone would
			// have to reverse-engineer.
			...(profilePreset
				? [`            --profile ${forced?.id} overrides that: the config below extends ${profilePreset}`]
				: []),
			`${dim('namespaces: ')}${info.namespaces.project.join(', ') || '(none found)'}  ${confidence(info.namespaceConfidence)}`,
			dim(`            ${Math.round(info.coverage * 100)}% of project CSS classes covered`),
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
		// A written config is not a guess any more: `config.inferred` goes false,
		// which turns blocking back on by default and lifts the css/dead-class
		// demotion. A namespace list drawn from the part of the tree that was
		// read would then block turns and tell an agent to delete classes it
		// never read the stylesheet for — so the one thing inference must never
		// do silently is launder a truncated answer into an authored one.
		if (info.truncated && !args.flags.force) {
			// The note above has already said why; this says only what it refuses
			// to do about it, so the two lines do not read as one repeated twice.
			fail(
				'loupe: refusing to write that guess to a config \u2014 a written config is not held to advisory. ' +
					'Point --root at the project, or pass --force to write it anyway.\n',
			);
			return EXIT.CANNOT_RUN;
		}
		if (existsSync(target) && !args.flags.force) {
			fail(`loupe: ${target} already exists (use --force)\n`);
			return EXIT.CANNOT_RUN;
		}
		writeFileSync(target, `${JSON.stringify(info.config, null, 2)}\n`);
		process.stdout.write(`${lines.join('\n')}\n\n${green(`Wrote ${target}`)}\n`);
		return EXIT.OK;
	}

	// Writes to the project path: a backlog recorded here has to be visible to
	// the hook, which is a different process with a different environment.
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
		process.stdout.write(green(`loupe: baselined ${recorded} \u2192 ${path}\n`));
		return EXIT.OK;
	}

	// A directive written in a keyword this config no longer asks for still
	// mutes. It is doing its job, so the rename is named here rather than turned
	// into a finding of its own — the inventory is where you would come looking
	// for it. (A directive that carries the grammar's shape and breaks it —
	// missing reason, missing rule ids, bare keyword — still reports as
	// `suppression/malformed`, whichever keyword it was written in.)
	if (command === 'suppressions') {
		const { directives } = await analyze(config, { scope: null });
		const kw = config.suppression.keyword;
		if (args.flags.format === 'json') process.stdout.write(`${JSON.stringify(directives, null, 2)}\n`);
		else
			for (const d of directives)
				process.stdout.write(
					`${dim(`${d.file}:${d.line}`)}  ${magenta(d.rules.join(','))}  ${d.reason}${
						d.alias ? dim(`  (${d.alias} \u2192 ${kw})`) : ''
					}\n`,
				);
		return EXIT.OK;
	}

	// The one network call in the engine, so the key is checked before the walk
	// and the hook never makes it.
	const apiKey = args.flags.judge && !isHook ? judgeKey() : undefined;
	if (args.flags.judge && !isHook && !apiKey) {
		fail(`loupe: --judge needs TYPESAFE_API_KEY, in the environment or ${ENV_FILE}\n`);
		return EXIT.CANNOT_RUN;
	}

	// ── fix ───────────────────────────────────────────────────────────────────
	// Only substitutions the engine resolved to exactly one on-role token. The
	// baseline is deliberately ignored: it exists to stop the gate blocking on an
	// accepted backlog, and burning that backlog down is the point of this
	// command.
	if (command === 'fix') {
		const fixScope = resolveScope(config, args, { defaultChanged: false });
		if (fixScope !== null && !Array.isArray(fixScope)) {
			fail(`loupe: ${fixScope.error}\n`);
			return EXIT.CANNOT_RUN;
		}
		let toFix: AnalyzeResult;
		try {
			toFix = await analyze(config, { scope: fixScope });
			// Only what `fix` can write: an answer about a JSX value is paid for and dropped.
			const judgeable = toFix.findings.filter((f) => f.rule === 'tokens/hardcoded-value' && CSS_FILE.test(f.file));
			if (apiKey && toFix.tokens && judgeable.length)
				await judgeValues(root, judgeable, toFix.tokens, apiKey, tokenDescriptions(config.profiles?.active ?? []));
		} catch (err) {
			fail(`loupe: ${messageOf(err)}\n`);
			return EXIT.CANNOT_RUN;
		}
		const dry = Boolean(args.flags['dry-run']);
		const { applied, skipped } = applyTokenFixes(root, toFix.findings, { dry });
		// After the rewrites, which never move a line, and bottom up within a file,
		// because a directive is a line of its own.
		const kept = apiKey
			? applyKeeps(root, toFix.findings, config.suppression.keyword, { dry, directives: toFix.directives })
			: { applied: [], skipped: [] };
		const verb = dry ? 'would fix' : 'fixed';
		// The value is held raw — it is what the substitution matches against —
		// so this is the one place the flattening belongs at the print site
		// rather than at capture: a multi-line declaration is exactly the kind
		// `fix` skips, and it reported the skip across six lines.
		//
		// Flattened but not bounded. Both lines exist to be acted on — the skip
		// names a value the reader now has to find and edit by hand, and the
		// applied line is the preview `--dry-run` exists to give — and an elided
		// value is one neither of them can be matched against.
		const decl = (f: { prop: string; value: string }): string => oneLine(`${f.prop}: ${f.value}`);
		for (const f of applied) process.stdout.write(`${dim(`${f.file}:${f.line}`)}  ${decl(f)} \u2192 ${green(f.to)}\n`);
		for (const k of kept.applied)
			process.stdout.write(
				`${dim(`${k.file}:${k.line}`)}  ${decl(k)} \u2192 ${green(`${config.suppression.keyword}, ${k.reason}`)}\n`,
			);
		for (const f of [...skipped, ...kept.skipped])
			process.stdout.write(`${yellow('skip')} ${dim(`${f.file}:${f.line}`)}  ${decl(f)} \u2014 ${f.why}\n`);
		const left = toFix.findings.length - applied.length - kept.applied.length;
		const nSkipped = skipped.length + kept.skipped.length;
		process.stdout.write(
			`\nloupe: ${(applied.length ? green : dim)(`${verb} ${applied.length} finding(s)`)}${
				apiKey ? `, ${dry ? 'would suppress' : 'suppressed'} ${kept.applied.length}` : ''
			}${nSkipped ? yellow(`, skipped ${nSkipped}`) : ''}. ${left} left for review.\n`,
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
	// ── check / hook ──────────────────────────────────────────────────────────
	// A PostToolUse payload names the file just written; scope to it so drift is
	// reported at write time. Stop payloads carry no file and fall through to
	// the changed-file scope.
	const touched = isHook ? payloadFile(payload, root) : null;
	if (touched && !isSource(config.sources, touched)) return emitClean('loupe: skipped \u2014 not a checked file type.');
	const scope: ScopeResult = touched ? [touched] : resolveScope(config, args, { defaultChanged: isHook });
	if (scope !== null && !Array.isArray(scope)) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${scope.error}`);
		fail(`loupe: ${scope.error}\n`);
		return EXIT.CANNOT_RUN;
	}

	let result: AnalyzeResult | BaselinedResult;
	try {
		result = await analyze(config, { scope, judge: Boolean(apiKey) });
	} catch (err) {
		if (isHook) return emitClean(`loupe: skipped \u2014 ${messageOf(err)}`);
		fail(`loupe: ${messageOf(err)}\n`);
		return EXIT.CANNOT_RUN;
	}

	if (!args.flags['no-baseline']) {
		// The lookup already stat'd it. Most projects have no baseline, and this
		// runs on every write, so don't pay a second stat inside `readBaseline`
		// just to be told the same thing.
		const { path: bPath, found } = findExistingBaseline(root, args.flags.baseline, config.baselinePath);
		const baseline = found ? readBaseline(bPath) : null;
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
		if (found && !baseline) note(`loupe: baseline at ${bPath} is unreadable \u2014 ignoring it.\n`);
		result = applyBaseline(result, baseline);
	}
	// Before the judgements: a finding the filter drops is not worth a paid question.
	if (args.flags.severity) result = filterSeverity(result, args.flags.severity);
	if (apiKey) {
		// Judged after the baseline, so accepted findings cost nothing, and a
		// judged finding never enters one: its confidence moves between runs, and
		// a baselined finding that comes and goes is noise in both directions.
		// A failed request leaves the findings as the engine wrote them.
		try {
			// The same filter, for the findings this adds.
			const redirectSeverity = config.severityOf('patterns/judged-redirect');
			if (result.controls?.length && (args.flags.severity !== 'error' || redirectSeverity === 'error'))
				result.findings.push(...(await judgeRedirects(result.controls, apiKey, redirectSeverity)));
			await judgeVariants(root, result.findings, config.componentRegistry, apiKey);
		} catch (err) {
			note(`loupe: --judge skipped \u2014 ${messageOf(err)}\n`);
		}
		// Its own note: the judgements above stand when this one cannot run.
		try {
			if (result.tokens && result.findings.some((f) => f.rule === 'tokens/hardcoded-value'))
				await judgeValues(
					root,
					result.findings,
					result.tokens,
					apiKey,
					tokenDescriptions(config.profiles?.active ?? []),
				);
		} catch (err) {
			note(`loupe: --judge left hardcoded values unjudged \u2014 ${messageOf(err)}\n`);
		}
		// Computed before the redirects above existed: one configured to `error`
		// has to be able to fail the run it is reported in.
		result.blocking = result.findings.some((f) => f.severity === 'error');
	}

	if (isHook) {
		const sessionId = payload.session_id ?? '';
		if (!result.blocking) {
			clearAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
			return emitClean(`${formatSummary(result)}${ceilingSuffix}`);
		}
		const attempts = bumpAttempts(root, touched ? `${sessionId}\u0000${touched}` : sessionId);
		const max = config.hook.maxAttempts;
		if (!sessionId && payload.stop_hook_active) {
			// No session id to budget against: fall back to the conservative
			// single-pass behaviour rather than risk looping the turn.
			return emitClean(`loupe: blocking findings remain (retry budget unavailable).${ceilingSuffix}`);
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
					? `loupe: still failing after ${max} attempt(s) \u2014 gate stood down. ${formatSummary(result, { prefix: false })}${ceilingSuffix}`
					: `${formatSummary(result)}${ceilingSuffix}`,
			);
		}
		const report = formatAgent({ ...result, findings: result.findings.filter((f) => f.severity === 'error') }, config, {
			maxFindings: config.hook.maxFindings,
			terse: true,
		});
		return emitBlocking(`${report}\n\n(attempt ${attempts} of ${max})${ceilingSuffix}`);
	}

	const maxFindings = Number(args.flags['max-findings'] ?? 0) || 0;
	if (format === 'json') process.stdout.write(`${JSON.stringify(reportPayload(result, config), null, 2)}\n`);
	else if (format === 'sarif') process.stdout.write(`${formatSarif(result, config)}\n`);
	// Already newline-terminated, and large: it is the one format most likely to
	// be redirected, which is what the process.exitCode note below is about.
	else if (format === 'html') process.stdout.write(formatHtml(result, config));
	else {
		process.stdout.write(`${formatAgent(result, config, { maxFindings })}\n`);
		if ('baselined' in result && result.baselined)
			process.stdout.write(dim(`\n${result.baselined} baselined finding(s) hidden.\n`));
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
		fail(`loupe: ${err instanceof Error ? err.stack : String(err)}\n`);
		process.exitCode = EXIT.CANNOT_RUN;
	});
