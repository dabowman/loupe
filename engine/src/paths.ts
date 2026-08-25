/**
 * Where state lives.
 *
 * Two kinds of state, two different answers.
 *
 * The hook's retry counter is ephemera about one session, and running as a
 * plugin means writing nothing into the project by default — that's the whole
 * point of carrying the tool between repos rather than committing it into them.
 * So it goes in `${CLAUDE_PLUGIN_DATA}`, the directory Claude Code guarantees
 * survives plugin updates, keyed by project path.
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
import { isAbsolute, join, resolve } from 'node:path';
import type { StateScope } from './types.ts';

export const pluginDataDir = (): string | null => process.env.CLAUDE_PLUGIN_DATA ?? null;
export const isPluginContext = (): boolean => Boolean(process.env.CLAUDE_PLUGIN_ROOT);

/** Stable per-project key: basename for legibility, path hash for uniqueness. */
export function projectKey(root: string): string {
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
 * Directory for the hook's retry counter.
 *
 * `create` is off by default: reporting on where state *would* live should not
 * litter a repo with an empty `.loupe/`. Only the write paths create it.
 *
 * @param opts.create make the directory now
 */
export function stateDir(
	root: string,
	{ create = false }: { create?: boolean } = {},
): { dir: string | null; scope: StateScope } {
	const data = pluginDataDir();
	const project = join(root, '.loupe');
	if (data) {
		const dir = join(data, 'projects', projectKey(root));
		if (create) {
			const made = ensureDir(dir);
			if (made) return { dir: made, scope: 'plugin-data' };
		} else if (existsSync(dir) || !existsSync(project)) {
			// The state is there, or nothing has been written anywhere yet — in
			// which case name where a writer would try first, so `status` reports
			// the location rather than a directory that will never appear.
			return { dir, scope: 'plugin-data' };
		}
		// Falls through: the plugin-data directory does not exist but a project one
		// does, which is exactly what a writer that could not create the former
		// leaves behind. Returning the plugin-data path here regardless was the
		// bug — readers looked somewhere the writer had already given up on, so
		// the retry counter was written to one file and read from another, every
		// bump started from zero, and the gate blocked at "attempt 1 of 3" forever
		// instead of ever standing down.
	}
	if (!create) return { dir: project, scope: 'project' };
	const made = ensureDir(project);
	return made ? { dir: made, scope: 'project' } : { dir: null, scope: 'none' };
}

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
 * Baselines the configured path did not name. Read-only fallbacks, best first.
 *
 * These are 0.1.x state directories only. The project's own default filename is
 * NOT one of them: when the configured path is missing and `.loupe-baseline.json`
 * is sitting there, that file is in the project, under this tool's own default
 * name, and calling it a legacy location told the user to "move it into the
 * project" — advice that is both false and unfollowable, since `loupe baseline`
 * writes the configured path and leaves that file where it is. It is a distinct
 * case with a distinct remedy, so `findExistingBaseline` names it separately.
 */
function legacyBaselines(root: string): string[] {
	const data = pluginDataDir();
	return [
		join(root, '.loupe', 'baseline.json'),
		...(data ? [join(data, 'projects', projectKey(root), 'baseline.json')] : []),
	];
}

/**
 * The baseline to read, or the one to write if none exists yet.
 *
 * `fallback` says which of three ways the answer was reached, because each wants
 * different advice and one message for all three was wrong for two of them:
 *
 *   'none'          the configured (or default) path — nothing to explain.
 *   'default-name'  the config names a file that isn't there, so the project's
 *                   own `.loupe-baseline.json` answered instead. Dropping this
 *                   fallback lost every accepted finding in the window between a
 *                   config change landing and the file actually moving.
 *   'legacy'        a 0.1.x state directory. It was a deliberate `loupe
 *                   baseline`, so keep reading it — but it is only half a fix:
 *                   the plugin-data candidate exists only when
 *                   `CLAUDE_PLUGIN_DATA` does, so a 0.1.0 backlog recorded
 *                   inside Claude Code is invisible to `loupe check` from a
 *                   terminal. The way out is to re-run `loupe baseline`, and
 *                   nothing can suggest that unless callers can tell this case
 *                   from a canonical hit.
 *
 * `found` comes back for the same reason `path` does: this function already
 * stat'd it, and a caller that has to ask again is a caller that can get a
 * different answer.
 */
export type BaselineFallback = 'none' | 'default-name' | 'legacy';

export function findExistingBaseline(
	root: string,
	explicit?: string | null,
	configured?: string | null,
): { path: string; found: boolean; fallback: BaselineFallback } {
	if (explicit) {
		const path = baselinePath(root, explicit);
		return { path, found: existsSync(path), fallback: 'none' };
	}
	const target = baselinePath(root, configured);
	if (existsSync(target)) return { path: target, found: true, fallback: 'none' };
	const byDefaultName = join(root, DEFAULT_BASELINE);
	// Guarded, not just ordered: with no configured path `target` IS this file,
	// and re-stat'ing it to report it as a fallback would be both a wasted
	// syscall and a second answer to a question already answered above.
	if (byDefaultName !== target && existsSync(byDefaultName))
		return { path: byDefaultName, found: true, fallback: 'default-name' };
	for (const path of legacyBaselines(root))
		if (existsSync(path)) return { path, found: true, fallback: 'legacy' };
	return { path: target, found: false, fallback: 'none' };
}

/** @param create make the state directory (writers pass true) */
export function attemptsPath(root: string, create = false): string | null {
	const { dir } = stateDir(root, { create });
	return dir ? join(dir, 'attempts.json') : null;
}
