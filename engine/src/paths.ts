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

/** Where a baseline was found: one of the state scopes, or a path someone named. */
type BaselineScope = StateScope | 'explicit';

export const pluginDataDir = (): string | null => process.env.CLAUDE_PLUGIN_DATA ?? null;
export const isPluginContext = (): boolean => Boolean(process.env.CLAUDE_PLUGIN_ROOT);

/** Stable per-project key: basename for legibility, path hash for uniqueness. */
export function projectKey(root: string): string {
	const full = resolve(root);
	const hash = createHash('sha256').update(full).digest('hex').slice(0, 10);
	const name = full.split(/[/\\]/).filter(Boolean).pop() ?? 'project';
	return `${name.replace(/[^\w.-]/g, '-')}-${hash}`;
}

function ensureDir(dir: string): string | null {
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
	if (data) {
		const dir = join(data, 'projects', projectKey(root));
		if (!create) return { dir, scope: 'plugin-data' };
		const made = ensureDir(dir);
		if (made) return { dir: made, scope: 'plugin-data' };
	}
	const dir = join(root, '.loupe');
	if (!create) return { dir, scope: 'project' };
	const made = ensureDir(dir);
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
export function baselinePath(
	root: string,
	named?: string | null,
): { path: string; scope: BaselineScope } {
	const p = named || DEFAULT_BASELINE;
	return { path: isAbsolute(p) ? p : join(root, p), scope: named ? 'explicit' : 'project' };
}

/** Baselines written before the path was pinned to the project. Read-only fallbacks. */
function legacyBaselines(root: string): { path: string; scope: BaselineScope }[] {
	const data = pluginDataDir();
	return [
		{ path: join(root, '.loupe', 'baseline.json'), scope: 'project' },
		...(data
			? [{ path: join(data, 'projects', projectKey(root), 'baseline.json'), scope: 'plugin-data' as const }]
			: []),
	];
}

/**
 * The baseline to read, or the one to write if none exists yet.
 *
 * A baseline an older version stashed in a state directory still counts — it
 * was a deliberate `loupe baseline` — so keep reading it until the next
 * `baseline` run rewrites it in the project.
 */
export function findExistingBaseline(
	root: string,
	explicit?: string | null,
	configured?: string | null,
): { path: string; scope: BaselineScope } {
	if (explicit) return baselinePath(root, explicit);
	const target = baselinePath(root, configured);
	if (existsSync(target.path)) return target;
	for (const legacy of legacyBaselines(root)) if (existsSync(legacy.path)) return legacy;
	return target;
}

/** @param create make the state directory (writers pass true) */
export function attemptsPath(root: string, create = false): string | null {
	const { dir } = stateDir(root, { create });
	return dir ? join(dir, 'attempts.json') : null;
}
