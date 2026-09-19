/**
 * Where state lives.
 *
 * Two kinds of state, two different answers.
 *
 * The hook's retry counter is ephemera about one session, and running as a
 * plugin means writing nothing into the project. It expires after six hours
 * anyway, so it goes in the plugin's data directory, or a temp directory of
 * this user's own, keyed by project path.
 *
 * The baseline is the opposite: a statement about *this repo* — which findings
 * it has agreed to live with — so it lives beside the code, always, and can be
 * committed. Keying it to plugin data made its location depend on how loupe
 * happened to be invoked, which is a bug the shape of a mystery: `loupe
 * baseline` from a shell (no `CLAUDE_PLUGIN_DATA`) recorded a backlog into the
 * project, the Stop hook then looked in plugin data, found nothing, and blocked
 * on every finding it had just been told to accept — with nothing in the log to
 * say the two runs were reading different files.
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
 * `loupe/` another user made first is not writable, so every count would be
 * lost and the gate would block at attempt 1 forever. Claude Code gives the
 * plugin a data directory of its own; the temp directory is for runs outside it.
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
 * Resolve the baseline path — always project-relative, never plugin data.
 *
 * One location regardless of how loupe was invoked is the whole fix: the CLI
 * and the hook are the same tool and must read the same file. A named path is
 * honored as given, because someone who names a file wants it where they named
 * it.
 */
export function baselinePath(root: string, named?: string | null): string {
	// Falsy, not nullish: `--baseline=` reaches here as an empty string, and the
	// readers below treat that as "nobody named one". A writer that took it as a
	// path would put the backlog somewhere the readers never look — the same
	// split this module exists to close.
	const p = named || DEFAULT_BASELINE;
	return isAbsolute(p) ? p : join(root, p);
}

/**
 * The baseline to read, or the one to write if none exists yet.
 *
 * `fallback` is 'default-name' when the config names a file that isn't there,
 * so the project's own `.loupe-baseline.json` answered instead. Dropping that
 * fallback lost every accepted finding in the window between a config change
 * landing and the file actually moving.
 *
 * `found` comes back for the same reason `path` does: this function already
 * stat'd it, and a caller that has to ask again is a caller that can get a
 * different answer.
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
