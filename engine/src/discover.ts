/**
 * File discovery.
 *
 * One walk of the tree, matched against the three source globs. Directories are
 * pruned against the ignore globs during traversal rather than filtered
 * afterwards, so a large node_modules is never enumerated. Dot-directories are
 * pruned too, unless a glob names one.
 *
 * The walk is unbounded by default: a scan that quietly stopped halfway would
 * report "clean" for the half it never read. A caller that is only guessing
 * passes a `limit` and reads `truncated` back.
 *
 * Design notes: docs/design/cli.md#file-discovery
 */

import { existsSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { Discovered, DiscoveredFile, SourceGlobs, SourceKind } from './types.ts';

export const toPosix = (p: string): string => p.split(sep).join('/').split('\\').join('/');

/**
 * Byte order, not collation. `localeCompare` folds case, treats `-` as
 * ignorable, and answers differently under a different ICU or `LANG`.
 */
export const byBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One directory's entries, in an order that does not depend on the machine.
 *
 * `readdirSync` hands back whatever order the filesystem holds, and Node and Bun
 * disagree on the same directory. Sorting by byte value makes a walk's result a
 * property of the tree rather than of whatever read it — which is what makes
 * "the first one wins" a fact rather than a filesystem accident.
 *
 * An unreadable directory yields nothing rather than throwing, here rather than
 * in every caller.
 */
export function readDir(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).sort((a, b) => byBytes(a.name, b.name));
	} catch {
		return [];
	}
}

/**
 * One `git` invocation, one place: both callers want the same cwd, the same
 * encoding, the same "stderr is not our business" wiring and the same timeout.
 */
const git = (root: string, args: readonly string[]): string =>
	execFileSync('git', [...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const KINDS = ['styles', 'markup', 'references'] as const satisfies readonly SourceKind[];

/** Directory names always skipped, regardless of config — cheap traversal guard. */
const HARD_SKIP = new Set(['.git', 'node_modules']);

/**
 * Could any of these globs match something *inside* a dot-directory?
 *
 * picomatch leaves `dot: false` on, so a `*` or `**` segment never matches a
 * name beginning with a dot — nothing under `.venv`, `.cache` or a pnpm store
 * can satisfy `**\/*.css`, and descending into them is pure cost.
 *
 * Only a glob naming a dot segment ahead of its filename (`.storybook/**\/*.css`)
 * can reach inside one. A project config may write that as a brace alternative,
 * which is why the test looks inside the braces.
 */
const NAMES_DOT_SEGMENT = /^\.|[{,]\./;
const reachesDotDirs = (globs: readonly string[]): boolean =>
	globs.some((g) =>
		g
			.split('/')
			.slice(0, -1)
			.some((seg) => NAMES_DOT_SEGMENT.test(seg)),
	);

export function discover({
	root,
	sources,
	limit,
}: {
	root: string;
	sources: SourceGlobs;
	/** Stop after this many directory entries have been looked at. Omit for the whole tree. */
	limit?: number;
}): Discovered {
	const ignore = picomatch(sources.ignore ?? []);
	const matchers: Record<SourceKind, (p: string) => boolean> = {
		styles: picomatch(sources.styles ?? []),
		markup: picomatch(sources.markup ?? []),
		references: picomatch(sources.references ?? []),
	};
	const out: Discovered = { styles: [], markup: [], references: [], truncated: false };
	// Every entry the walk looks at, directories included and matches irrelevant:
	// the cost being bounded is the cost of reaching an entry.
	const budget = limit ?? Infinity;
	let seen = 0;
	const pruneDotDirs = !KINDS.some((kind) => reachesDotDirs(sources[kind] ?? []));

	// Files at this level before subdirectories below it: depth-first on both at
	// once let the budget be swallowed by whichever subdirectory the filesystem
	// handed back first.
	const walk = (dir: string): void => {
		const entries = readDir(dir);
		const subdirs: string[] = [];
		for (const e of entries) {
			if (seen >= budget) {
				out.truncated = true;
				return;
			}
			seen++;
			const full = join(dir, e.name);
			const rel = toPosix(relative(root, full));
			if (e.isDirectory()) {
				if (HARD_SKIP.has(e.name)) continue;
				if (pruneDotDirs && e.name.startsWith('.')) continue;
				// Probe both bare and trailing-slash forms so `**/build/**` prunes `build`.
				if (ignore(rel) || ignore(`${rel}/`)) continue;
				subdirs.push(full);
			} else if (e.isFile()) {
				if (ignore(rel)) continue;
				for (const kind of KINDS) {
					if (matchers[kind](rel)) out[kind].push({ abs: full, rel } satisfies DiscoveredFile);
				}
			}
		}
		for (const sub of subdirs) {
			if (out.truncated) return;
			walk(sub);
		}
	};
	walk(root);
	for (const kind of KINDS) out[kind].sort((a, b) => byBytes(a.rel, b.rel));
	return out;
}

/**
 * Could this path contribute anything at all?
 *
 * The PostToolUse hook fires on every Edit and Write, and without this a README
 * edit paid for a whole-repo index.
 */
export function isSource(sources: SourceGlobs, rel: string): boolean {
	const match = picomatch(sources.ignore ?? []);
	if (match(rel)) return false;
	return KINDS.some((kind) => picomatch(sources[kind] ?? [])(rel));
}

/**
 * Is `root` inside a git worktree?
 *
 * The cheap half of {@link changedFiles}, split out so the question can be asked
 * before anything walks the tree. Asked of git rather than of the filesystem: a
 * linked worktree's `.git` is a file, a submodule's is a file too, and a
 * subdirectory of a repo has no `.git` of any kind.
 *
 * The answer is read, not inferred from the exit code — `rev-parse` exits 0 and
 * prints `false` inside a bare repo and inside a `.git` directory. A `git` that
 * refuses to answer throws, and that is a "don't know", not a no.
 */
export function isWorktree(root: string): boolean {
	try {
		return git(root, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
	} catch {
		return false;
	}
}

/**
 * Is `root` inside a repository, going by the filesystem alone?
 *
 * The fallback for when git will not answer — a dubious-ownership mount, or no
 * `git` on PATH. Walks up, because a subdirectory has no `.git` of its own.
 */
export function hasGitDir(root: string): boolean {
	let dir = resolve(root);
	for (;;) {
		if (existsSync(join(dir, '.git'))) return true;
		const up = dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

/**
 * Files changed relative to HEAD, plus untracked ones. Returns null when this
 * isn't a git worktree — callers map that to the "couldn't run" exit code
 * rather than silently analyzing everything.
 */
export function changedFiles(root: string): Set<string> | null {
	if (!isWorktree(root)) return null;
	const set = new Set<string>();
	const add = (out: string): void => {
		for (const line of out.split('\n')) {
			const f = line.trim();
			if (f) set.add(toPosix(f));
		}
	};
	// `diff HEAD` spans index + worktree, so it already covers staged files, and
	// without a HEAD it fails outright — `ls-files --others` does NOT cover the gap,
	// since staging a file stops it being "other".
	//
	// `--relative` is load-bearing: findings are keyed relative to the project root,
	// `ls-files` already is, but `diff --name-only` answers from the *repository*
	// root. It also scopes the diff to `cwd`.
	try {
		add(git(root, ['diff', '--name-only', '--relative', 'HEAD']));
	} catch {
		try {
			add(git(root, ['ls-files', '--cached']));
		} catch {
			/* not even an index yet: untracked files below are the whole story */
		}
	}
	try {
		add(git(root, ['ls-files', '--others', '--exclude-standard']));
	} catch {
		/* ignore */
	}
	return set;
}
