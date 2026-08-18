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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const STATE_DIR = '.ds-hygiene';
const STATE_FILE = 'attempts.json';
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

export async function readStdin() {
	if (process.stdin.isTTY) return '';
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

function statePath(root) {
	return join(root, STATE_DIR, STATE_FILE);
}

function readState(root) {
	try {
		const raw = JSON.parse(readFileSync(statePath(root), 'utf8'));
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
		mkdirSync(join(root, STATE_DIR), { recursive: true });
		writeFileSync(statePath(root), JSON.stringify(state));
	} catch {
		// A read-only or missing project dir just means no retry budget tracking;
		// never let bookkeeping failure take down the gate.
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

export function emitClean(message) {
	process.stdout.write(JSON.stringify({ systemMessage: message, suppressOutput: true }));
	return 0;
}

export function emitBlocking(report) {
	process.stderr.write(`${report}\n`);
	return 2;
}
