/**
 * Claude Code Stop-hook mode.
 *
 * Exit protocol:
 *   0 + {systemMessage}  clean, or advisory-only, or gave up after N attempts
 *   2 + stderr           blocking findings; stderr is handed back to the agent
 *
 * Bounded retry rather than an absolute bail on `stop_hook_active`: skipping
 * every hook-triggered turn means the turn that *fixes* a finding is never
 * checked. Each session gets N gated passes, then the gate stands down and says
 * so.
 *
 * Design notes: docs/design/cli.md#exit-codes-are-a-contract
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { dirsUp, toPosix } from './discover.ts';
import { readJson, writeJsonAtomic } from './json.ts';
import { attemptsPath, isOn } from './paths.ts';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** One session's gated-pass budget. */
interface Attempt {
	count: number;
	at: number;
}

interface AttemptState {
	sessions: Record<string, Attempt>;
}

/** What a Claude Code hook payload carries that this cares about. */
export interface HookPayload {
	session_id?: string;
	hook_event_name?: string;
	stop_hook_active?: boolean;
	tool_input?: { file_path?: string };
	/** PostToolUse only: what the tool returned. Edit and Write both carry `originalFile`. */
	tool_response?: unknown;
	[key: string]: unknown;
}

/** The plugin options a user set when enabling it. */
export interface PluginOptions {
	preset: string | undefined;
	projectPrefixes: string[] | undefined;
	blocking: boolean | undefined;
	maxAttempts: number | undefined;
	maxFindings: number | undefined;
	/**
	 * Silence an opted-in hook. The same axis as `blocking` — block, advise, say
	 * nothing — so it lives in the same struct, with a source like every other
	 * option, rather than in a raw environment read nothing else could see.
	 */
	off: boolean | undefined;
}

export const readStdin = async (): Promise<string> => (process.stdin.isTTY ? '' : text(process.stdin));

function readState(root: string): AttemptState {
	// A missing or unreadable file is an empty budget, not a failure.
	const raw = readJson(attemptsPath(root)) as Partial<AttemptState> | null;
	const now = Date.now();
	const sessions: Record<string, Attempt> = {};
	for (const [id, entry] of Object.entries(raw?.sessions ?? {}))
		if (now - (entry?.at ?? 0) < MAX_AGE_MS) sessions[id] = entry;
	return { sessions };
}

/** No writable state dir just means no retry budget tracking; bookkeeping never takes the gate down. */
const writeState = (root: string, state: AttemptState): void => {
	writeJsonAtomic(attemptsPath(root), state);
};

export function bumpAttempts(root: string, sessionId: string | undefined): number {
	if (!sessionId) return 1;
	const state = readState(root);
	const next = (state.sessions[sessionId]?.count ?? 0) + 1;
	state.sessions[sessionId] = { count: next, at: Date.now() };
	writeState(root, state);
	return next;
}

/** The count {@link bumpAttempts} would start from, without spending a pass. */
export function peekAttempts(root: string, sessionId: string | undefined): number {
	if (!sessionId) return 0;
	return readState(root).sessions[sessionId]?.count ?? 0;
}

export function clearAttempts(root: string, sessionId: string | undefined): void {
	if (!sessionId) return;
	const state = readState(root);
	if (!state.sessions[sessionId]) return;
	delete state.sessions[sessionId];
	writeState(root, state);
}

export function parsePayload(raw: string): HookPayload {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw) as HookPayload;
	} catch {
		return {};
	}
}

/**
 * The file a PostToolUse payload just touched, as a repo-relative path.
 *
 * Scoping to it is what turns this from a review-time gate into a write-time
 * one: the drift is reported while the agent still has the decision in hand.
 *
 * Returns null for a payload with no file (a Stop event, or a non-file tool),
 * which the caller maps to the changed-files scope, and for a file outside the
 * project.
 *
 * Inside is asked of the spelling first and of the real paths after: the root
 * comes from CLAUDE_PROJECT_DIR and the file from the tool, and the two can
 * reach one directory through different symlinks.
 */
export function payloadFile(payload: HookPayload | null | undefined, root: string): string | null {
	const raw = payload?.tool_input?.file_path;
	if (typeof raw !== 'string' || !raw) return null;
	const abs = isAbsolute(raw) ? raw : join(root, raw);
	const inside = (from: string, to: string): string | null => {
		const rel = relative(from, to);
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : null;
	};
	let rel = inside(root, abs);
	if (rel === null) {
		try {
			rel = inside(realpathSync(root), realpathSync(abs));
		} catch {
			/* a path that does not resolve is not one this project holds */
		}
	}
	return rel === null ? null : toPosix(rel);
}

/**
 * The event a payload is for. Claude Code always names it; a payload carrying a
 * file is a PostToolUse one when it does not.
 */
export const hookEvent = (payload: HookPayload): string | undefined =>
	payload.hook_event_name ?? (payload.tool_input ? 'PostToolUse' : undefined);

/**
 * The touched file as it stood before the edit, or null when there is nothing
 * to compare against — a file the write created, or a payload that does not say.
 *
 * Claude Code hands PostToolUse the tool's own result, and Edit and Write both
 * return the file they replaced as `originalFile` (null when Write created it).
 * Read from there rather than snapshotted by a PreToolUse hook into the state
 * directory: a snapshot is a second process on every edit, paid before the tool
 * runs (~0.35s bundled, ~1s from source, just to start), where this costs nothing
 * until an edit would block. Nor reconstructed from `old_string`/`new_string`:
 * reversing an edit is ambiguous wherever the new text occurs twice, and
 * impossible for a Write.
 *
 * Design notes: docs/design/cli.md#the-hook-gates-what-an-edit-introduced
 */
export function preEditContent(payload: HookPayload | null | undefined): string | null {
	const response = payload?.tool_response;
	if (!response || typeof response !== 'object') return null;
	const original = (response as { originalFile?: unknown }).originalFile;
	return typeof original === 'string' ? original : null;
}

/** `CLAUDE_PROJECT_DIR`, where Claude Code set it to a directory that is there. */
const envProjectDir = (): string | undefined => {
	const dir = process.env.CLAUDE_PROJECT_DIR;
	return dir && existsSync(dir) ? dir : undefined;
};

/** Where the project lives, in order of trustworthiness. */
export const hookRoot = (): string => envProjectDir() ?? process.cwd();

export { isOn };

/**
 * The Claude Code project whose `.claude/` settings switch the hook.
 *
 * The hook roots at CLAUDE_PROJECT_DIR. `status` typed in a monorepo package
 * roots at the config that governs it, which is not where `.claude/` lives —
 * so reading the switch from the run's root reported the hook OFF while the
 * hook, reading the real file, was on. Everything that asks goes through here:
 * an explicit root, else CLAUDE_PROJECT_DIR, else the cwd, walked up to the
 * nearest `.claude/`. The walk stops at the repository's top and below the home
 * directory, whose `.claude/` is the user's settings, not a project's.
 */
export function claudeProjectDir(explicit?: string | null): string {
	if (!explicit) {
		const fromEnv = envProjectDir();
		if (fromEnv) return fromEnv;
	}
	const start = resolve(explicit ?? process.cwd());
	const home = resolve(homedir());
	for (const dir of dirsUp(start)) {
		if (dir === home) break;
		if (existsSync(join(dir, '.claude'))) return dir;
		if (existsSync(join(dir, '.git'))) break;
	}
	return start;
}

/**
 * A switch a project sets in its Claude Code settings' `env`, with where it was
 * read. Claude Code hands it to the hook as an environment variable a terminal
 * never sees — so the same files are read when the environment has nothing to
 * say, and `status` agrees with the hook.
 */
function settingsEnv(projectDir: string, name: string): { value: string; from: string } | undefined {
	const fromEnv = process.env[name];
	if (fromEnv !== undefined) return { value: fromEnv, from: `${name} in the environment` };
	const files: [path: string, label: string][] = [
		[join(projectDir, '.claude', 'settings.local.json'), '.claude/settings.local.json'],
		[join(projectDir, '.claude', 'settings.json'), '.claude/settings.json'],
		[join(homedir(), '.claude', 'settings.json'), '~/.claude/settings.json'],
	];
	for (const [file, label] of files) {
		// No settings file, or one that will not parse, has nothing to say.
		const v = (readJson(file) as { env?: Record<string, unknown> } | null)?.env?.[name];
		if (v !== undefined) return { value: String(v), from: `${name} in ${label}` };
	}
	return undefined;
}

/**
 * Whether this project turned the gate on.
 *
 * Off by default: a gate firing in every repo the plugin is installed for lands
 * findings in sessions that are about something else. A project opts in at
 * `.claude/settings.local.json` → `"env": { "LOUPE": "on" }`.
 */
function optedIn(projectDir: string): boolean {
	const v = settingsEnv(projectDir, 'LOUPE');
	return v !== undefined && isOn(v.value);
}

/**
 * Why the hook says nothing, or null when it runs. Asked once, so a diagnostic
 * saying the hook is off is one that watched the same values the hook did.
 * `projectDir` is `claudeProjectDir()`'s answer, never the run's root.
 *
 * The opt-in is asked first: the `off` option is set once for every project
 * its owner opens, and a project that never switched the gate on was not
 * silenced by it.
 */
export function hookOff(projectDir: string, resolved: ResolvedOptions = resolvedOptions(projectDir)): string | null {
	if (!optedIn(projectDir))
		return 'this project has not opted in; add "env": { "LOUPE": "on" } to .claude/settings.local.json';
	if (resolved.options.off === true) {
		const from = resolved.sources.off ?? '';
		return `silenced by ${from.startsWith('LOUPE_OFF') ? from : `the plugin's "off" option (${from})`}`;
	}
	return null;
}

/** Opted in, then switched off — as opposed to never switched on. */
export const hookSilenced = (projectDir: string, resolved: ResolvedOptions): boolean =>
	resolved.options.off === true && optedIn(projectDir);

/** Each `userConfig` key, as `plugin.json` spells it, and the field it fills. */
const FIELDS = {
	preset: 'preset',
	project_prefixes: 'projectPrefixes',
	blocking: 'blocking',
	max_attempts: 'maxAttempts',
	max_findings: 'maxFindings',
	off: 'off',
} as const satisfies Record<string, keyof PluginOptions>;

export type OptionKey = keyof typeof FIELDS;
const OPTION_KEYS = Object.keys(FIELDS) as OptionKey[];

/** The options in effect, and where each one that is set was read. */
export interface ResolvedOptions {
	options: PluginOptions;
	/** Keyed as `userConfig` spells it; an option nobody set has no entry. */
	sources: Partial<Record<OptionKey, string>>;
	/**
	 * The `pluginConfigs` keys found when none of them was this plugin's. Matching
	 * is a guess at the marketplace's spelling, and a guess that misses reads
	 * exactly like having configured nothing — so the miss is kept to be named.
	 */
	unmatched: string[];
}

/** Claude Code keys a plugin's settings `<name>@<marketplace>`. */
const isOurs = (key: string): boolean => key === 'loupe' || key.startsWith('loupe@');

/**
 * Options the user set when enabling the plugin.
 *
 * Claude Code exports every option to hook processes as
 * CLAUDE_PLUGIN_OPTION_<KEY> — to hook processes only, not to terminals, so
 * `status` typed by hand cannot see them. They are also in the settings file
 * under this plugin's key.
 *
 * Merged key by key, never chosen between: the settings files first, the
 * environment over them. Choosing whichever side had anything to say let one
 * exported key discard every other option the file carried, so the hook and a
 * terminal resolved different options for the same project. Each key keeps its
 * source, so a stale answer is recognizable as one.
 *
 * `off` has one more door: `LOUPE_OFF`, from the environment or the Claude Code
 * project's settings `env` — the per-project, per-person place the opt-in
 * lives. It can only switch the hook off, and it feeds the same field, so
 * nothing downstream has to know which door was used.
 */
export function resolvedOptions(projectDir: string): ResolvedOptions {
	const options = coerce({});
	const sources: Partial<Record<OptionKey, string>> = {};
	const overlay = (layer: PluginOptions, from: string): void => {
		for (const k of OPTION_KEYS) {
			const field = FIELDS[k];
			if (layer[field] === undefined) continue;
			(options as unknown as Record<string, unknown>)[field] = layer[field];
			sources[k] = from;
		}
	};

	// Least specific first: each layer overlays the one before it.
	const seen: string[] = [];
	let matched = false;
	for (const file of ['settings.json', 'settings.local.json']) {
		// No settings file, or not ours to read: nothing to overlay.
		const configs = (
			readJson(join(homedir(), '.claude', file)) as {
				pluginConfigs?: Record<string, { options?: Record<string, unknown> }>;
			} | null
		)?.pluginConfigs;
		if (!configs || typeof configs !== 'object') continue;
		const key = Object.keys(configs).find(isOurs);
		if (key === undefined) {
			seen.push(...Object.keys(configs));
			continue;
		}
		matched = true;
		const opts = configs[key]?.options;
		if (opts) overlay(coerce(opts), `~/.claude/${file}`);
	}

	overlay(
		coerce(Object.fromEntries(OPTION_KEYS.map((k) => [k, process.env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`]]))),
		'environment',
	);
	const silence = settingsEnv(projectDir, 'LOUPE_OFF');
	if (silence && isOn(silence.value)) {
		options.off = true;
		sources.off = silence.from;
	}
	return { options, sources, unmatched: matched ? [] : seen };
}

/**
 * The `options:` line of `status`: each option that is set and where it was
 * read, and a `pluginConfigs` lookup that missed named as a miss.
 */
export function describeOptions({ options, sources, unmatched }: ResolvedOptions): string {
	const value = (k: OptionKey): string => {
		const v = options[FIELDS[k]];
		// `off on` says the opposite of what it means.
		if (typeof v === 'boolean') return k === 'off' ? (v ? 'yes' : 'no') : v ? 'on' : 'off';
		return Array.isArray(v) ? v.join(', ') : String(v);
	};
	const set = OPTION_KEYS.filter((k) => sources[k] !== undefined).map((k) => `${k} ${value(k)} (${sources[k]})`);
	const miss = unmatched.length
		? `; no pluginConfigs entry is named loupe or loupe@… (found ${unmatched.join(', ')})`
		: '';
	return `${set.length ? set.join('; ') : 'none set — plugin defaults apply'}${miss}`;
}

/** Settings hold real JSON types; the environment hands us strings. Normalize both. */
function coerce(opts: Record<string, unknown>): PluginOptions {
	const str = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : String(v));
	const num = (v: unknown): number | undefined =>
		Number.isFinite(Number(v)) && str(v) !== undefined ? Number(v) : undefined;
	const list = (v: unknown): string[] | undefined => {
		let parsed = v;
		// A `multiple: true` option arrives in the environment JSON-encoded —
		// accept it rather than silently adopting `["wf-` as a class prefix.
		if (typeof v === 'string' && v.startsWith('[')) {
			try {
				parsed = JSON.parse(v);
			} catch {
				/* not JSON after all; fall through to the split */
			}
		}
		if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
		const t = str(v);
		return t === undefined ? undefined : t.split(/[,\s]+/).filter(Boolean);
	};
	return {
		preset: str(opts.preset),
		projectPrefixes: list(opts.project_prefixes),
		blocking: str(opts.blocking) === undefined ? undefined : isOn(String(opts.blocking)),
		maxAttempts: num(opts.max_attempts),
		maxFindings: num(opts.max_findings),
		off: str(opts.off) === undefined ? undefined : isOn(String(opts.off)),
	};
}

/**
 * What a non-blocking hook says: a `systemMessage` for the user, nothing in
 * the transcript, and whatever else the event admits. Exit 0.
 */
const say = (message: string, extra: Record<string, unknown> = {}): number => {
	process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true, ...extra }));
	return 0;
};

export const emitClean = (message: string): number => say(message);

/**
 * A stand-down the agent has to hear about as well as the user: exit 0, never
 * blocking, with `message` for the user and `context` for the agent.
 *
 * PostToolUse has a non-blocking way into the agent's context,
 * `hookSpecificOutput.additionalContext`. Stop has none — its only channel to
 * the agent is `decision: "block"`, which is exactly what a gate that cannot
 * configure itself must not do — so there it is the user's message alone.
 */
export const emitAdvisory = (message: string, context: string, payload: HookPayload): number =>
	say(
		message,
		hookEvent(payload) === 'PostToolUse'
			? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }
			: {},
	);

export function emitBlocking(report: string): number {
	process.stderr.write(`${report}\n`);
	return 2;
}
