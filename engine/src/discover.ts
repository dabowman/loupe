/**
 * File discovery.
 *
 * One walk of the tree, matched against the three source globs. Directories are
 * pruned against the ignore globs during traversal rather than filtered
 * afterwards, so a large node_modules is never enumerated.
 *
 * The walk is unbounded by default, because a scan that quietly stopped
 * halfway would report "clean" for the half it never read. A caller that is
 * only guessing — inference, which has to answer inside a hook timeout and is
 * sometimes pointed at a home directory — passes a `limit` on the entries it
 * will look at, and reads `truncated` back.
 *
 * Dot-directories are pruned too, unless a glob names one: with picomatch's
 * `dot: false`, nothing inside `.venv`, `.cache` or a pnpm store can match a
 * `**` glob anyway, so descending into them buys nothing and spends both the
 * clock and the entry budget.
 */

import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { Discovered, DiscoveredFile, SourceGlobs, SourceKind } from './types.ts';

export const toPosix = (p: string): string => p.split(sep).join('/').split('\\').join('/');

/**
 * One `git` invocation, one place. Both callers here want the same cwd, the
 * same encoding and the same "stderr is not our business" wiring, and a
 * timeout added to one of two copies is a timeout that does not apply.
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
 * name beginning with a dot: nothing under `.venv`, `.cache`, `.cargo`,
 * `.yarn/cache` or a pnpm store can ever satisfy `**\/*.css`. Descending into
 * them is therefore pure cost — and under an entry ceiling it is worse than
 * cost, because the budget is spent on entries that could not have contributed
 * and the project's own files are never reached.
 *
 * Only a glob naming a dot segment ahead of its filename — `.storybook/**\/*.css`
 * — can reach inside one, so that is what makes the prune unsafe. No shipped
 * preset writes one; a project config may, and it may write it as a brace
 * alternative (`{.storybook,src}/**\/*.css`), which is why the test looks
 * inside the braces rather than only at the first character.
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
	// Every entry the walk looks at, directories included and matches irrelevant.
	// Counting only files left the budget blind to the shape a home directory
	// actually has — `~/.cache`, `~/.cargo/registry`, a pnpm store: hundreds of
	// thousands of directories holding almost no files at all. The cost being
	// bounded is the cost of reaching an entry, so an entry is what is counted.
	const budget = limit ?? Infinity;
	let seen = 0;
	const pruneDotDirs = !KINDS.some((kind) => reachesDotDirs(sources[kind] ?? []));

	// Files at this level before subdirectories below it. Depth-first on both at
	// once meant the budget could be swallowed whole by the first subdirectory
	// the filesystem happened to hand back, and a walk that stopped there
	// reported zero source files for a project whose own were sitting in the
	// root — an answer that reads identically to "this project has none".
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip, don't crash the gate
		}
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
	for (const kind of KINDS) out[kind].sort((a, b) => a.rel.localeCompare(b.rel));
	return out;
}

/**
 * Could this path contribute anything at all?
 *
 * The PostToolUse hook fires on every Edit and Write, and without this a README
 * edit paid for a whole-repo index to be told there was nothing to say about a
 * README. On a large repo that alone was past the hook timeout.
 */
export function isSource(sources: SourceGlobs, rel: string): boolean {
	const match = picomatch(sources.ignore ?? []);
	if (match(rel)) return false;
	return KINDS.some((kind) => picomatch(sources[kind] ?? [])(rel));
}

/**
 * Is `root` inside a git worktree?
 *
 * The cheap half of {@link changedFiles}, split out so the question can be
 * asked before anything walks the tree. Asked of git rather than of the
 * filesystem on purpose: a linked worktree's `.git` is a file, a submodule's is
 * a file too, and a subdirectory of a repo has no `.git` of any kind while
 * still being a perfectly good root to run in.
 *
 * The answer is read, not inferred from the exit code. `rev-parse` exits 0 and
 * prints `false` inside a bare repo and inside a `.git` directory — neither of
 * which has a worktree to diff against — so a caller that only checked for a
 * throw was told yes in exactly the two places the question means no. A `git`
 * that refuses to answer (dubious ownership, or no `git` on PATH) throws, and
 * that is a "don't know", not a no: callers that treat this as evidence about
 * whether a project exists have to weigh other evidence too.
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
 * The fallback for when git will not answer — a dubious-ownership mount, which
 * is the normal state inside a container, or no `git` binary on PATH at all.
 * Checking only `root` covered the top of a repo and nothing else: a
 * subdirectory has no `.git` of its own, which is precisely the case
 * {@link isWorktree} was added to catch and precisely the case that has no
 * answer left when git declines. So walk up.
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
	// `diff HEAD` spans index + worktree, so it already covers staged files.
	// Without a HEAD it fails outright, and `ls-files --others` below does NOT
	// cover the gap: staging a file stops it being "other", so a fresh repo
	// whose work is staged reported an empty scope and the gate passed clean.
	// Before the first commit, every tracked file is new by definition.
	//
	// `--relative` is load-bearing. Findings are keyed relative to the project
	// root, and `ls-files` is already relative to `cwd` — but `diff --name-only`
	// answers from the *repository* root, so when the project sits in a
	// subdirectory of the worktree the two halves of this one Set were in
	// different coordinate systems and nothing in it ever matched a finding.
	// `--changed` is the hook's default scope, so a gate on a monorepo package
	// reported "clean" without checking anything. It also scopes the diff to
	// `cwd`, which is what a root-relative Set means in the first place.
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
