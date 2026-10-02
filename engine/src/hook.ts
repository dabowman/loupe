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
import { dirname, isAbsolute, join, relative } from 'node:path';
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
 * Whether this project turned the gate on.
 *
 * Off by default: a gate firing in every repo the plugin is installed for lands
 * findings in sessions that are about something else. A project opts in at
 * `.claude/settings.local.json` → `"env": { "LOUPE": "on" }`, which Claude Code
 * hands the hook as an environment variable a terminal never sees — so the same
 * files are read when the environment has nothing to say.
 */
function optedIn(root: string): boolean {
	if (process.env.LOUPE !== undefined) return isOn(process.env.LOUPE);
	for (const file of [
		join(root, '.claude', 'settings.local.json'),
		join(root, '.claude', 'settings.json'),
		join(homedir(), '.claude', 'settings.json'),
	]) {
		try {
			const v = (JSON.parse(readFileSync(file, 'utf8')) as { env?: Record<string, unknown> }).env?.LOUPE;
			if (v !== undefined) return isOn(String(v));
		} catch {
			/* no settings file */
		}
	}
	return false;
}

/**
 * Why the hook says nothing, or null when it runs. Asked once, so a diagnostic
 * saying the hook is off is one that watched the same values the hook did.
 */
export function hookOff(root: string): string | null {
	// Per-session off switch: `LOUPE_OFF=1 claude` silences an opted-in project.
	if (isOn(process.env.LOUPE_OFF)) return 'LOUPE_OFF is set for this session';
	if (!optedIn(root))
		return 'this project has not opted in; add "env": { "LOUPE": "on" } to .claude/settings.local.json';
	return null;
}

const OPTION_KEYS = ['preset', 'project_prefixes', 'blocking', 'max_attempts', 'max_findings'] as const;

/**
 * Options the user set when enabling the plugin.
 *
 * Claude Code exports every option to hook processes as
 * CLAUDE_PLUGIN_OPTION_<KEY> — to hook processes only, not to terminals, so
 * `status` typed by hand cannot see them. They are also in the settings file
 * under this plugin's key: read them there when the environment has nothing to
 * say, and report the source so a stale answer is recognizable as one.
 */
export function resolvedOptions(): {
	options: PluginOptions;
	source: 'environment' | 'settings' | 'none';
} {
	const fromEnv = coerce(
		Object.fromEntries(OPTION_KEYS.map((k) => [k, process.env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`]])),
	);
	if (Object.values(fromEnv).some((v) => v !== undefined)) return { options: fromEnv, source: 'environment' };

	for (const file of ['settings.local.json', 'settings.json']) {
		try {
			const raw = JSON.parse(readFileSync(join(homedir(), '.claude', file), 'utf8')) as {
				pluginConfigs?: Record<string, { options?: Record<string, unknown> }>;
			};
			const configs = raw.pluginConfigs ?? {};
			const key = Object.keys(configs).find((k) => k === 'loupe' || k.startsWith('loupe@'));
			const opts = key === undefined ? undefined : configs[key]?.options;
			if (opts) return { options: coerce(opts), source: 'settings' };
		} catch {
			/* no settings file, or not ours to read */
		}
	}
	return { options: fromEnv, source: 'none' };
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
