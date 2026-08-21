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
import { attemptsPath } from './paths.mjs';

const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function readStdin() {
	if (process.stdin.isTTY) return '';
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

function readState(root) {
	try {
		const p = attemptsPath(root);
		if (!p) return { sessions: {} };
		const raw = JSON.parse(readFileSync(p, 'utf8'));
		const now = Date.now();
		const sessions = {};
		for (const [id, entry] of Object.entries(raw.sessions || {}))
			if (now - (entry.at || 0) < MAX_AGE_MS) sessions[id] = entry;
		return { sessions };
	} catch {
		return { sessions: {} };
	}
}

function writeState(root, state) {
	try {
		const p = attemptsPath(root, true);
		if (p) writeFileSync(p, JSON.stringify(state));
	} catch {
		// No writable state dir just means no retry budget tracking; never let
		// bookkeeping failure take down the gate.
	}
}

export function bumpAttempts(root, sessionId) {
	if (!sessionId) return 1;
	const state = readState(root);
	const next = (state.sessions[sessionId]?.count || 0) + 1;
	state.sessions[sessionId] = { count: next, at: Date.now() };
	writeState(root, state);
	return next;
}

export function clearAttempts(root, sessionId) {
	if (!sessionId) return;
	const state = readState(root);
	if (!state.sessions[sessionId]) return;
	delete state.sessions[sessionId];
	writeState(root, state);
}

export function parsePayload(raw) {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
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
export function payloadFile(payload, root) {
	const raw = payload?.tool_input?.file_path ?? payload?.tool_input?.filePath;
	if (typeof raw !== 'string' || !raw) return null;
	const abs = isAbsolute(raw) ? raw : join(root, raw);
	const rel = relative(root, abs);
	// Outside the project: nothing to say about it.
	if (!rel || rel.startsWith('..')) return null;
	return rel.split(sep).join('/');
}

/** Where the project lives, in order of trustworthiness. */
export function hookRoot() {
	const fromEnv = process.env.CLAUDE_PROJECT_DIR;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return process.cwd();
}

/**
 * Options the user set when enabling the plugin.
 *
 * Claude Code refuses to substitute ${user_config.*} into a shell-form hook
 * command — the value would reach a shell — but it does export every option to
 * hook processes as CLAUDE_PLUGIN_OPTION_<KEY>. So read the environment.
 */
export function pluginOptions() {
	const get = (key) => {
		const v = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
		return v === undefined || v === '' ? undefined : v;
	};
	const bool = (key) => {
		const v = get(key);
		return v === undefined ? undefined : /^(1|true|yes|on)$/i.test(v);
	};
	const num = (key) => {
		const v = Number(get(key));
		return Number.isFinite(v) ? v : undefined;
	};
	const list = (key) => {
		const v = get(key);
		if (v === undefined) return undefined;
		// The option is a comma-separated string, but a `multiple: true` option
		// would arrive JSON-encoded — accept both rather than silently adopting
		// `["wf-` as a class prefix.
		if (v.startsWith('[')) {
			try {
				const parsed = JSON.parse(v);
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
 * @returns {{ options: object, source: 'environment'|'settings'|'none' }}
 */
export function resolvedOptions() {
	const fromEnv = pluginOptions();
	if (Object.values(fromEnv).some((v) => v !== undefined)) return { options: fromEnv, source: 'environment' };

	const name = pluginName();
	if (!name) return { options: fromEnv, source: 'none' };
	for (const file of ['settings.local.json', 'settings.json']) {
		try {
			const raw = JSON.parse(readFileSync(join(homedir(), '.claude', file), 'utf8'));
			const key = Object.keys(raw.pluginConfigs || {}).find((k) => k === name || k.startsWith(`${name}@`));
			const opts = key && raw.pluginConfigs[key]?.options;
			if (opts) return { options: coerce(opts), source: 'settings' };
		} catch {
			/* no settings file, or not ours to read */
		}
	}
	return { options: fromEnv, source: 'none' };
}

/** This plugin's name, from the manifest two levels above the engine. */
function pluginName() {
	const roots = [
		process.env.CLAUDE_PLUGIN_ROOT,
		join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
	].filter(Boolean);
	for (const root of roots) {
		try {
			return JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name || null;
		} catch {
			/* try the next candidate */
		}
	}
	return null;
}

/** Settings hold real JSON types; the env path hands us strings. Normalize. */
function coerce(opts) {
	const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));
	const num = (v) => (Number.isFinite(Number(v)) && str(v) !== undefined ? Number(v) : undefined);
	const list = (v) => {
		if (Array.isArray(v)) return v.map(String).filter(Boolean);
		const t = str(v);
		return t === undefined ? undefined : t.split(/[,\s]+/).filter(Boolean);
	};
	return {
		preset: str(opts.preset),
		projectPrefixes: list(opts.project_prefixes),
		blocking: opts.blocking === undefined ? undefined : /^(1|true|yes|on)$/i.test(String(opts.blocking)),
		maxAttempts: num(opts.max_attempts),
		maxFindings: num(opts.max_findings),
	};
}

export function emitClean(message) {
	process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true }));
	return 0;
}

export function emitBlocking(report) {
	process.stderr.write(`${report}\n`);
	return 2;
}
