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
 *
 * `data` is the plugin data directory, from the environment unless named: a
 * terminal has none, so `status` names the hook's own by passing it.
 */
export const attemptsPath = (root: string, data = process.env.CLAUDE_PLUGIN_DATA): string =>
	join(data || join(tmpdir(), `loupe-${process.getuid?.() ?? 'user'}`), projectKey(root), 'attempts.json');

/** Where a baseline goes when nothing names one. Overridable via config `baseline`. */
export const DEFAULT_BASELINE = '.loupe-baseline.json';

/**
 * Resolve the baseline path — always project-relative, never plugin data. The
 * CLI and the hook are the same tool and must read the same file. A named path
 * is honored as given.
 *
 * The one place a baseline path is resolved. `p` is never empty: an empty
 * `--baseline=` is normalized to "unnamed" once, in `main()`, and an empty
 * config `baseline` to the default name once, in `loadConfig`.
 */
export const baselinePath = (root: string, p: string): string => (isAbsolute(p) ? p : join(root, p));

/**
 * A 0.1.x baseline, which nothing reads any more: `<root>/.loupe/baseline.json`,
 * or the plugin data directory's `projects/<key>/baseline.json`. Null when
 * neither is there.
 *
 * Asked only where no current baseline exists, so a backlog accepted under
 * 0.1.x does not come back as live findings with no word as to why. Two stats,
 * and never from the hook: the hook's own feedback is the agent's, and the
 * remedy is a person's decision.
 */
export function legacyBaseline(root: string): string | null {
	const data = process.env.CLAUDE_PLUGIN_DATA;
	const candidates = [
		join(root, '.loupe', 'baseline.json'),
		...(data ? [join(data, 'projects', projectKey(root), 'baseline.json')] : []),
	];
	return candidates.find((path) => existsSync(path)) ?? null;
}

/** What `check` and `status` say about a {@link legacyBaseline}. */
export const legacyBaselineNotice = (path: string): string =>
	`${path} is a 0.1.x baseline, which this version no longer reads — re-run \`loupe baseline\` to record the backlog in the project, then delete the old file.`;

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
	explicit: string | null,
	configured: string,
): { path: string; found: boolean; fallback: 'none' | 'default-name' } {
	if (explicit !== null) {
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
