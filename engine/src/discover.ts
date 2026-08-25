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
 */

import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { Discovered, DiscoveredFile, SourceGlobs, SourceKind } from './types.ts';

export const toPosix = (p: string): string => p.split(sep).join('/').split('\\').join('/');

const KINDS = ['styles', 'markup', 'references'] as const satisfies readonly SourceKind[];

/** Directory names always skipped, regardless of config — cheap traversal guard. */
const HARD_SKIP = new Set(['.git', 'node_modules']);

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

	const walk = (dir: string): void => {
		if (out.truncated) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip, don't crash the gate
		}
		for (const e of entries) {
			if (out.truncated) return;
			if (seen >= budget) {
				out.truncated = true;
				return;
			}
			seen++;
			const full = join(dir, e.name);
			const rel = toPosix(relative(root, full));
			if (e.isDirectory()) {
				if (HARD_SKIP.has(e.name)) continue;
				// Probe both bare and trailing-slash forms so `**/build/**` prunes `build`.
				if (ignore(rel) || ignore(`${rel}/`)) continue;
				walk(full);
			} else if (e.isFile()) {
				if (ignore(rel)) continue;
				for (const kind of KINDS) {
					if (matchers[kind](rel)) out[kind].push({ abs: full, rel } satisfies DiscoveredFile);
				}
			}
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
		const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return out.trim() === 'true';
	} catch {
		return false;
	}
}

/**
 * Files changed relative to HEAD, plus untracked ones. Returns null when this
 * isn't a git worktree — callers map that to the "couldn't run" exit code
 * rather than silently analyzing everything.
 */
export function changedFiles(root: string): Set<string> | null {
	const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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
	try {
		add(git(['diff', '--name-only', 'HEAD']));
	} catch {
		try {
			add(git(['ls-files', '--cached']));
		} catch {
			/* not even an index yet: untracked files below are the whole story */
		}
	}
	try {
		add(git(['ls-files', '--others', '--exclude-standard']));
	} catch {
		/* ignore */
	}
	return set;
}
