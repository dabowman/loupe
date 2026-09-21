/**
 * Where state lives. Two kinds of state, two different answers.
 *
 * The hook's retry counter is ephemera about one session, and running as a
 * plugin means writing nothing into the project — so it goes in the plugin's
 * data directory, or a temp directory of this user's own, keyed by project path.
 *
 * The baseline is the opposite: a statement about *this repo*, so it lives
 * beside the code, always, and can be committed.
 *
 * Design notes: docs/design/cli.md#where-state-lives
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const isPluginContext = (): boolean => Boolean(process.env.CLAUDE_PLUGIN_ROOT);

/** Stable per-project key: basename for legibility, path hash for uniqueness. */
function projectKey(root: string): string {
	const full = resolve(root);
	const hash = createHash('sha256').update(full).digest('hex').slice(0, 10);
	const name = full.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
	return `${name.replace(/[^\w.-]/g, '-')}-${hash}`;
}

export function ensureDir(dir: string): string | null {
	try {
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return null;
	}
}

/**
 * The hook's retry counter. Writers create the directory.
 *
 * Per user, never shared: on Linux `tmpdir()` is the one `/tmp`, where a
 * `loupe/` another user made first is not writable, so every count would be lost
 * and the gate would block at attempt 1 forever.
 */
export const attemptsPath = (root: string): string =>
	join(
		process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), `loupe-${process.getuid?.() ?? 'user'}`),
		projectKey(root),
		'attempts.json',
	);

/** Where a baseline goes when nothing names one. Overridable via config `baseline`. */
export const DEFAULT_BASELINE = '.loupe-baseline.json';

/**
 * Resolve the baseline path — always project-relative, never plugin data. The
 * CLI and the hook are the same tool and must read the same file. A named path
 * is honored as given.
 */
export function baselinePath(root: string, named?: string | null): string {
	// Falsy, not nullish: `--baseline=` reaches here as an empty string, and the
	// readers below treat that as "nobody named one".
	const p = named || DEFAULT_BASELINE;
	return isAbsolute(p) ? p : join(root, p);
}

/**
 * The baseline to read, or the one to write if none exists yet.
 *
 * `fallback` is 'default-name' when the config names a file that isn't there, so
 * the project's own `.loupe-baseline.json` answered instead — dropping that lost
 * every accepted finding while a config change and a file move were out of step.
 *
 * `found` comes back for the same reason `path` does: this function already
 * stat'd it, and a caller that has to ask again can get a different answer.
 */
export function findExistingBaseline(
	root: string,
	explicit?: string | null,
	configured?: string | null,
): { path: string; found: boolean; fallback: 'none' | 'default-name' } {
	if (explicit) {
		const path = baselinePath(root, explicit);
		return { path, found: existsSync(path), fallback: 'none' };
	}
	const target = baselinePath(root, configured);
	if (existsSync(target)) return { path: target, found: true, fallback: 'none' };
	const byDefaultName = join(root, DEFAULT_BASELINE);
	// Guarded, not just ordered: with no configured path `target` IS this file.
	if (byDefaultName !== target && existsSync(byDefaultName))
		return { path: byDefaultName, found: true, fallback: 'default-name' };
	return { path: target, found: false, fallback: 'none' };
}
