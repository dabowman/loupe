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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { text } from 'node:stream/consumers';
import { toPosix } from './discover.ts';
import { attemptsPath, ensureDir } from './paths.ts';

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
	stop_hook_active?: boolean;
	tool_input?: { file_path?: string };
	[key: string]: unknown;
}

/** The plugin options a user set when enabling it. */
export interface PluginOptions {
	preset: string | undefined;
	projectPrefixes: string[] | undefined;
	blocking: boolean | undefined;
	maxAttempts: number | undefined;
	maxFindings: number | undefined;
}

export const readStdin = async (): Promise<string> => (process.stdin.isTTY ? '' : text(process.stdin));

function readState(root: string): AttemptState {
	try {
		const raw = JSON.parse(readFileSync(attemptsPath(root), 'utf8')) as Partial<AttemptState>;
		const now = Date.now();
		const sessions: Record<string, Attempt> = {};
		for (const [id, entry] of Object.entries(raw.sessions ?? {}))
			if (now - (entry?.at ?? 0) < MAX_AGE_MS) sessions[id] = entry;
		return { sessions };
	} catch {
		return { sessions: {} };
	}
}

function writeState(root: string, state: AttemptState): void {
	try {
		const p = attemptsPath(root);
		ensureDir(dirname(p));
		writeFileSync(p, JSON.stringify(state));
	} catch {
		// No writable state dir just means no retry budget tracking; never let
		// bookkeeping failure take down the gate.
	}
}

export function bumpAttempts(root: string, sessionId: string | undefined): number {
	if (!sessionId) return 1;
	const state = readState(root);
	const next = (state.sessions[sessionId]?.count ?? 0) + 1;
	state.sessions[sessionId] = { count: next, at: Date.now() };
	writeState(root, state);
	return next;
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
 * which the caller maps to the changed-files scope.
 */
export function payloadFile(payload: HookPayload | null | undefined, root: string): string | null {
	const raw = payload?.tool_input?.file_path;
	if (typeof raw !== 'string' || !raw) return null;
	const abs = isAbsolute(raw) ? raw : join(root, raw);
	const rel = relative(root, abs);
	// Outside the project: nothing to say about it.
	if (!rel || rel.startsWith('..')) return null;
	return toPosix(rel);
}

/** Where the project lives, in order of trustworthiness. */
export function hookRoot(): string {
	const fromEnv = process.env.CLAUDE_PROJECT_DIR;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return process.cwd();
}

/**
 * One spelling of "on" for every switch this tool reads. Written out per door,
 * it let `status` disagree with the gate: `LOUPE_OFF=0` reported the hook OFF
 * while the hook went right on blocking.
 */
export const isOn = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v);

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
		const fromEnv = process.env.CLAUDE_PROJECT_DIR;
		if (fromEnv && existsSync(fromEnv)) return fromEnv;
	}
	const start = resolve(explicit ?? process.cwd());
	const home = resolve(homedir());
	for (let dir = start; dir !== home; dir = dirname(dir)) {
		if (existsSync(join(dir, '.claude'))) return dir;
		if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
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
		try {
			const v = (JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> }).env?.[name];
			if (v !== undefined) return { value: String(v), from: `${name} in ${label}` };
		} catch {
			/* no settings file */
		}
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
 */
export function hookOff(projectDir: string): string | null {
	// Per-session off switch: `LOUPE_OFF=1 claude` silences an opted-in project.
	if (isOn(process.env.LOUPE_OFF)) return 'LOUPE_OFF is set for this session';
	if (!optedIn(projectDir))
		return 'this project has not opted in; add "env": { "LOUPE": "on" } to .claude/settings.local.json';
	return null;
}

/** Each `userConfig` key, as `plugin.json` spells it, and the field it fills. */
const FIELDS = {
	preset: 'preset',
	project_prefixes: 'projectPrefixes',
	blocking: 'blocking',
	max_attempts: 'maxAttempts',
	max_findings: 'maxFindings',
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
 */
export function resolvedOptions(): ResolvedOptions {
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
		let configs: Record<string, { options?: Record<string, unknown> }> | undefined;
		try {
			configs = (
				JSON.parse(readFileSync(join(homedir(), '.claude', file), 'utf8')) as {
					pluginConfigs?: Record<string, { options?: Record<string, unknown> }>;
				}
			).pluginConfigs;
		} catch {
			continue; // no settings file, or not ours to read
		}
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
	return { options, sources, unmatched: matched ? [] : seen };
}

/**
 * The `options:` line of `status`: each option that is set and where it was
 * read, and a `pluginConfigs` lookup that missed named as a miss.
 */
export function describeOptions({ options, sources, unmatched }: ResolvedOptions): string {
	const value = (k: OptionKey): string => {
		const v = options[FIELDS[k]];
		if (typeof v === 'boolean') return v ? 'on' : 'off';
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
	};
}

export function emitClean(message: string): number {
	process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true }));
	return 0;
}

export function emitBlocking(report: string): number {
	process.stderr.write(`${report}\n`);
	return 2;
}
