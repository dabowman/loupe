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
import { isAbsolute, join, relative, sep } from 'node:path';
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

export function emitClean(message) {
	process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true }));
	return 0;
}

export function emitBlocking(report) {
	process.stderr.write(`${report}\n`);
	return 2;
}
