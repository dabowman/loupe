/**
 * Claude Code Stop-hook mode.
 *
 * This replaces the hand-written bash wrapper. Folding it into the CLI removes
 * the `jq` dependency, the shell quoting, the ANSI stripping, and — the part
 * that actually rots — a second artifact that has to stay in sync with this one.
 *
 * Exit protocol:
 *   0 + {systemMessage}  clean, or advisory-only, or gave up after N attempts
 *   2 + stderr           blocking findings; stderr is handed back to the agent
 *
 * Bounded retry rather than an absolute bail on `stop_hook_active`. Skipping
 * every hook-triggered turn means the turn that *fixes* a finding is never
 * checked, so you never confirm the fix. Instead each session gets N gated
 * passes, then the gate stands down and says so.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { attemptsPath } from './paths.ts';

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
	/** The camelCase spelling some payloads use instead. */
	sessionId?: string;
	stop_hook_active?: boolean;
	tool_input?: { file_path?: string; filePath?: string };
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

export async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return '';
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

function readState(root: string): AttemptState {
	try {
		const p = attemptsPath(root);
		if (!p) return { sessions: {} };
		const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AttemptState>;
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
		const p = attemptsPath(root, true);
		if (p) writeFileSync(p, JSON.stringify(state));
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
 * one: the drift is reported while the agent still has the decision in hand,
 * rather than forty tool calls later once the pattern is load-bearing and every
 * argument for keeping it has become locally true.
 *
 * Returns null for a payload with no file (a Stop event, or a non-file tool),
 * which the caller maps to the changed-files scope.
 */
export function payloadFile(payload: HookPayload | null | undefined, root: string): string | null {
	const raw = payload?.tool_input?.file_path ?? payload?.tool_input?.filePath;
	if (typeof raw !== 'string' || !raw) return null;
	const abs = isAbsolute(raw) ? raw : join(root, raw);
	const rel = relative(root, abs);
	// Outside the project: nothing to say about it.
	if (!rel || rel.startsWith('..')) return null;
	return rel.split(sep).join('/');
}

/** Where the project lives, in order of trustworthiness. */
export function hookRoot(): string {
	const fromEnv = process.env.CLAUDE_PROJECT_DIR;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return process.cwd();
}

/**
 * One spelling of "on" for every switch this tool reads.
 *
 * The set was written out three times — plugin options from the environment,
 * the same options from the settings file, and the `LOUPE_OFF` gate — which is
 * two chances for a switch to mean something different depending on which door
 * it came through. It also made `status` disagree with the gate: `LOUPE_OFF=0`
 * reported the hook OFF while the hook went right on blocking.
 */
export const isOn = (v: string | undefined): boolean =>
	v !== undefined && /^(1|true|yes|on)$/i.test(v);

/**
 * The per-session off switch, asked once.
 *
 * Both the gate and `status` call this, so a diagnostic that says the hook is
 * silenced is a diagnostic that watched the same value the hook did.
 */
export const hookSilenced = (): boolean => isOn(process.env.LOUPE_OFF);

/**
 * Options the user set when enabling the plugin.
 *
 * Claude Code refuses to substitute ${user_config.*} into a shell-form hook
 * command — the value would reach a shell — but it does export every option to
 * hook processes as CLAUDE_PLUGIN_OPTION_<KEY>. So read the environment.
 */
export function pluginOptions(): PluginOptions {
	const get = (key: string): string | undefined => {
		const v = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
		return v === undefined || v === '' ? undefined : v;
	};
	const bool = (key: string): boolean | undefined => {
		const v = get(key);
		return v === undefined ? undefined : isOn(v);
	};
	const num = (key: string): number | undefined => {
		const v = Number(get(key));
		return Number.isFinite(v) ? v : undefined;
	};
	const list = (key: string): string[] | undefined => {
		const v = get(key);
		if (v === undefined) return undefined;
		// The option is a comma-separated string, but a `multiple: true` option
		// would arrive JSON-encoded — accept both rather than silently adopting
		// `["wf-` as a class prefix.
		if (v.startsWith('[')) {
			try {
				const parsed: unknown = JSON.parse(v);
				if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
			} catch {
				/* not JSON after all; fall through to the split */
			}
		}
		return v.split(/[,\s]+/).filter(Boolean);
	};
	return {
		preset: get('preset'),
		projectPrefixes: list('project_prefixes'),
		blocking: bool('blocking'),
		maxAttempts: num('max_attempts'),
		maxFindings: num('max_findings'),
	};
}

/**
 * The same options, for a run that is not a hook.
 *
 * Claude Code exports `CLAUDE_PLUGIN_OPTION_*` to hook processes only — not to
 * terminals, and not to tool calls. So `status`, whose entire job is to say
 * what the gate will actually do, could never see the blocking switch and
 * reported every inferred config as advisory no matter how it was configured.
 * A diagnostic that cannot observe the setting it is diagnosing is worse than
 * no diagnostic: it sends you looking for the bug somewhere else.
 *
 * The values are in the settings file, under a key naming this plugin. Read
 * them there when the environment has nothing to say, and report the source so
 * a stale answer is recognizable as one.
 *
 */
export function resolvedOptions(): {
	options: PluginOptions;
	source: 'environment' | 'settings' | 'none';
} {
	const fromEnv = pluginOptions();
	if (Object.values(fromEnv).some((v) => v !== undefined)) return { options: fromEnv, source: 'environment' };

	const name = pluginName();
	if (!name) return { options: fromEnv, source: 'none' };
	for (const file of ['settings.local.json', 'settings.json']) {
		try {
			const raw = JSON.parse(readFileSync(join(homedir(), '.claude', file), 'utf8')) as {
				pluginConfigs?: Record<string, { options?: Record<string, unknown> }>;
			};
			const configs = raw.pluginConfigs ?? {};
			const key = Object.keys(configs).find((k) => k === name || k.startsWith(`${name}@`));
			const opts = key === undefined ? undefined : configs[key]?.options;
			if (opts) return { options: coerce(opts), source: 'settings' };
		} catch {
			/* no settings file, or not ours to read */
		}
	}
	return { options: fromEnv, source: 'none' };
}

/** This plugin's name, from the manifest two levels above the engine. */
function pluginName(): string | null {
	const roots = [
		process.env.CLAUDE_PLUGIN_ROOT,
		join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
	].filter((r): r is string => Boolean(r));
	for (const root of roots) {
		try {
			const manifest = JSON.parse(
				readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
			) as { name?: string };
			return manifest.name ?? null;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/** Settings hold real JSON types; the env path hands us strings. Normalize. */
function coerce(opts: Record<string, unknown>): PluginOptions {
	const str = (v: unknown): string | undefined =>
		v === undefined || v === null || v === '' ? undefined : String(v);
	const num = (v: unknown): number | undefined =>
		Number.isFinite(Number(v)) && str(v) !== undefined ? Number(v) : undefined;
	const list = (v: unknown): string[] | undefined => {
		if (Array.isArray(v)) return v.map(String).filter(Boolean);
		const t = str(v);
		return t === undefined ? undefined : t.split(/[,\s]+/).filter(Boolean);
	};
	return {
		preset: str(opts['preset']),
		projectPrefixes: list(opts['project_prefixes']),
		blocking: opts['blocking'] === undefined ? undefined : isOn(String(opts['blocking'])),
		maxAttempts: num(opts['max_attempts']),
		maxFindings: num(opts['max_findings']),
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
