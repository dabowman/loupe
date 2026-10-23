/**
 * Version ranges, read just far enough to ask whether two of them overlap.
 *
 * A profile says which versions of a package it describes (`"<3"`), and a
 * project's `package.json` says which it accepts (`"^2.3.0"`). Neither side is
 * a version, so the question is never "does this version satisfy that range"
 * but "is there a version both admit". Each range is read into the set of
 * versions it admits — a union of intervals — and two ranges overlap when any
 * interval of one meets any interval of the other.
 *
 * Written here rather than taken from `semver`: the bundle is committed and
 * carries no runtime dependency it can avoid, and this needs a fraction of it.
 *
 * Read: `<`, `<=`, `>`, `>=`, `=` and a bare version; `^` and `~` (and `~>`);
 * `x`, `X` and `*` in any position, and partial versions (`2`, `2.3`); ranges
 * joined by spaces (all must hold) and by `||` (any may). A leading `v` is
 * dropped, and so is build metadata. Not read: hyphen ranges (`1 - 2`), and
 * anything that is not a range at all (`workspace:*`, a git URL, `latest`) —
 * {@link parseRange} answers null, and the caller decides what that means.
 *
 * Partial upper bounds stop below the next version's prereleases, as `semver`
 * desugars them: `<3` is `<3.0.0-0`, so `^3.0.0-beta.1` does not overlap it.
 * What is not applied is `semver`'s rule that a prerelease satisfies a
 * comparator only on its own `major.minor.patch`: here a prerelease is simply
 * ordered, so `<3.0.0` — written out in full — admits `3.0.0-beta.1`.
 */

/** A version: three numbers and the prerelease identifiers, numeric where they are digits. */
interface Version {
	major: number;
	minor: number;
	patch: number;
	pre: (string | number)[];
}

/** One end of an interval. */
interface Bound {
	v: Version;
	inclusive: boolean;
}

/** The versions between two bounds; a null bound is unbounded on that side. */
interface Interval {
	lo: Bound | null;
	hi: Bound | null;
}

/** The versions a range admits: any of these intervals. Empty admits nothing. */
export type Range = readonly Interval[];

const ANY: Interval = { lo: null, hi: null };

const version = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({
	major,
	minor,
	patch,
	pre,
});

/** The lowest version of a release: `3.0.0-0` sorts below every `3.0.0-*`. */
const floor = (major: number, minor: number, patch: number): Version => version(major, minor, patch, [0]);

const atLeast = (v: Version, inclusive = true): Interval => ({ lo: { v, inclusive }, hi: null });
const below = (v: Version, inclusive = false): Interval => ({ lo: null, hi: { v, inclusive } });
const between = (lo: Version, hi: Version): Interval => ({
	lo: { v: lo, inclusive: true },
	hi: { v: hi, inclusive: false },
});

function compareIds(a: string | number, b: string | number): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b;
	// A numeric identifier sorts below an alphanumeric one.
	if (typeof a === 'number') return -1;
	if (typeof b === 'number') return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence: the numbers, then a prerelease below its release, then the identifiers in turn. */
function compareVersions(a: Version, b: Version): number {
	const byNumber = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
	if (byNumber) return byNumber;
	if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
	for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
		const c = compareIds(a.pre[i] as string | number, b.pre[i] as string | number);
		if (c) return c;
	}
	return a.pre.length - b.pre.length;
}

const COMPARATOR =
	/^(<=|>=|<|>|=|\^|~>|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version part: its number, or null for a wildcard or a part left off. */
const part = (s: string | undefined): number | null => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));

/**
 * One comparator as the versions it admits: one interval, or none at all
 * (`>*`). Null when the token is not a comparator.
 */
function comparator(token: string): Interval[] | null {
	const m = COMPARATOR.exec(token);
	if (!m) return null;
	const op = m[1] ?? '';
	const major = part(m[2]);
	let minor = part(m[3]);
	let patch = part(m[4]);
	// Once one part is a wildcard, the parts after it are too: `2.x.5` is `2.x`.
	if (major === null) minor = patch = null;
	else if (minor === null) patch = null;
	const pre = m[5];
	// A prerelease belongs to a whole version; on a partial one it names nothing.
	if (pre !== undefined && patch === null) return null;
	const ids = pre === undefined ? [] : pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id));
	if ([major, minor, patch].some((n) => n !== null && !Number.isSafeInteger(n))) return null;

	if (major === null) return op === '<' || op === '>' ? [] : [ANY];
	// The narrowest release the written parts fix, and the first one past it.
	const lo = version(major, minor ?? 0, patch ?? 0, ids);
	const next = minor === null ? floor(major + 1, 0, 0) : patch === null ? floor(major, minor + 1, 0) : null;

	switch (op) {
		case '':
		case '=':
			return [next ? between(lo, next) : { lo: { v: lo, inclusive: true }, hi: { v: lo, inclusive: true } }];
		case '>=':
			return [atLeast(lo)];
		case '>':
			// `>2` is everything past 2.x, not past 2.0.0.
			return [next ? atLeast(version(next.major, next.minor, next.patch)) : atLeast(lo, false)];
		case '<':
			return [below(next ? floor(lo.major, lo.minor, lo.patch) : lo)];
		case '<=':
			return [next ? below(next) : below(lo, true)];
		case '^': {
			// The leftmost non-zero part is the one that may not change.
			const hi =
				major > 0 || minor === null
					? floor(major + 1, 0, 0)
					: minor > 0 || patch === null
						? floor(0, minor + 1, 0)
						: floor(0, 0, patch + 1);
			return [between(lo, hi)];
		}
		default: {
			// `~` and `~>`: the patch may move, or the minor when only the major is given.
			const hi = minor === null ? floor(major + 1, 0, 0) : floor(major, minor + 1, 0);
			return [between(lo, hi)];
		}
	}
}

const higherLo = (a: Bound | null, b: Bound | null): Bound | null => {
	if (!a || !b) return a ?? b;
	const c = compareVersions(a.v, b.v);
	return c > 0 ? a : c < 0 ? b : { v: a.v, inclusive: a.inclusive && b.inclusive };
};

const lowerHi = (a: Bound | null, b: Bound | null): Bound | null => {
	if (!a || !b) return a ?? b;
	const c = compareVersions(a.v, b.v);
	return c < 0 ? a : c > 0 ? b : { v: a.v, inclusive: a.inclusive && b.inclusive };
};

const intersect = (a: Interval, b: Interval): Interval => ({ lo: higherLo(a.lo, b.lo), hi: lowerHi(a.hi, b.hi) });

const nonEmpty = ({ lo, hi }: Interval): boolean => {
	if (!lo || !hi) return true;
	const c = compareVersions(lo.v, hi.v);
	return c < 0 || (c === 0 && lo.inclusive && hi.inclusive);
};

/**
 * The versions `text` admits, or null when it is not a range this reads. An
 * empty string, like `*`, admits every version.
 */
export function parseRange(text: string): Range | null {
	const out: Interval[] = [];
	for (const alternative of text.split('||')) {
		// An operator may stand apart from its version: `>= 2.3`.
		const tokens = alternative
			.trim()
			.replace(/(<=|>=|<|>|=|\^|~>|~)\s+/g, '$1')
			.split(/\s+/)
			.filter(Boolean);
		let all: Interval[] = [ANY];
		for (const token of tokens) {
			const admitted = comparator(token);
			if (!admitted) return null;
			all = all.flatMap((a) => admitted.map((b) => intersect(a, b))).filter(nonEmpty);
		}
		out.push(...all);
	}
	return out;
}

/** Whether some version is admitted by both ranges. */
export const overlaps = (a: Range, b: Range): boolean => a.some((x) => b.some((y) => nonEmpty(intersect(x, y))));
