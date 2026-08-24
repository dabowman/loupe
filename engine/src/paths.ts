/**
 * Where state lives.
 *
 * Running as a plugin means writing nothing into the project by default —
 * that's the whole point of carrying the tool between repos rather than
 * committing it into them. `${CLAUDE_PLUGIN_DATA}` is the directory Claude
 * Code guarantees survives plugin updates, so baselines and hook retry counters
 * go there, keyed by project path.
 *
 * Outside a plugin (plain npx, CI) there's no such directory, so state falls
 * back to the project, where a committed baseline is what you'd want anyway.
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
 * Directory for this project's state.
 *
 * `create` is off by default: reporting on where state *would* live should not
 * litter a repo with an empty `.loupe/`. Only the write paths create it.
 *
 * @param opts.preferProject force project-local (an explicit --baseline path, or CI)
 * @param opts.create make the directory now
 */
export function stateDir(
	root: string,
	{ preferProject = false, create = false }: { preferProject?: boolean; create?: boolean } = {},
): { dir: string | null; scope: StateScope } {
	const data = pluginDataDir();
	if (!preferProject && data) {
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

/**
 * Resolve the baseline path.
 *
 * An explicit path is always honored and always project-relative — someone who
 * names a file wants it where they named it, usually to commit it.
 *
 * `create` is off by default for the same reason `stateDir`'s is: merely looking
 * for a baseline must not leave an empty `.loupe/` behind in the project.
 * Only the `baseline` command, which is about to write one, passes it.
 */
export function baselinePath(
	root: string,
	explicit?: string | null,
	{ create = false }: { create?: boolean } = {},
): { path: string; scope: BaselineScope } {
	if (explicit) {
		return { path: isAbsolute(explicit) ? explicit : join(root, explicit), scope: 'explicit' };
	}
	const { dir, scope } = stateDir(root, { create });
	if (!dir) return { path: join(root, '.loupe-baseline.json'), scope: 'project' };
	return { path: join(dir, 'baseline.json'), scope };
}

/**
 * Existing project-local baselines keep working: if one is checked in, it wins
 * over plugin-data state, because a committed baseline is a deliberate choice.
 */
export function findExistingBaseline(
	root: string,
	explicit?: string | null,
	configured?: string | null,
	{ create = false }: { create?: boolean } = {},
): { path: string; scope: BaselineScope } {
	if (explicit) return baselinePath(root, explicit);
	const candidates = [configured, '.loupe-baseline.json'].filter((c): c is string => Boolean(c));
	for (const candidate of candidates) {
		const p = isAbsolute(candidate) ? candidate : join(root, candidate);
		if (existsSync(p)) return { path: p, scope: 'project' };
	}
	return baselinePath(root, null, { create });
}

/** @param create make the state directory (writers pass true) */
export function attemptsPath(root: string, create = false): string | null {
	const { dir } = stateDir(root, { create });
	return dir ? join(dir, 'attempts.json') : null;
}
