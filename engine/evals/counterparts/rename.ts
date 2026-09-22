/**
 * A labelled pair of token sets, built by renaming a real one.
 *
 * The hard part of scoring `map` is that nobody has written down the right
 * answers for two real systems, and a labelled set produced by the thing being
 * scored is not a labelled set. So this makes one where the answers are known by
 * construction: take a real set, rewrite every name into a different convention,
 * paraphrase every description, nudge every value, and hold some tokens back.
 * A token that survived maps to its renamed self; a token held back maps to
 * `none`. Both labels are facts about the transformation, not opinions about
 * design.
 *
 * It is a *lower bound* and should be read as one. Two systems that record the
 * same decisions under different names are the easy half of the real problem —
 * the half the user can reasonably demand work. A matcher that cannot do this
 * cannot do the hard half either, and one that can has only shown it clears the
 * floor.
 *
 * The one thing it cannot simulate is genuinely independent wording. The
 * paraphrase substitutes vocabulary and drops clauses, so the descriptions stay
 * correlated in a way two real systems' would not. Read the `description`-only
 * arm as optimistic, and see the `--set archer-common` substrate, whose values
 * are unresolved aliases, for the case where names and descriptions are all
 * there is.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTokenDoc } from '../../src/dtcg.ts';
import type { TokenDoc } from '../../src/dtcg.ts';

/**
 * Lexically disjoint synonyms, so a renamed token shares no word with its
 * original and the name comparison has to work on meaning rather than spelling.
 * Anything not in here is left alone, which keeps the rewrite honest: a set's
 * own oddities survive it.
 */
const WORDS: Record<string, string> = {
	bgcolor: 'surface',
	background: 'surface',
	bg: 'surface',
	fgcolor: 'ink',
	foreground: 'ink',
	fg: 'ink',
	text: 'ink',
	bordercolor: 'edge',
	border: 'edge',
	stroke: 'edge',
	shadow: 'depth',
	default: 'base',
	rest: 'idle',
	muted: 'quiet',
	subtle: 'faint',
	subtlest: 'faintest',
	emphasis: 'loud',
	strong: 'loud',
	weak: 'slight',
	disabled: 'inert',
	danger: 'alarm',
	error: 'alarm',
	attention: 'notice',
	warning: 'notice',
	caution: 'heed',
	success: 'affirm',
	done: 'complete',
	accent: 'highlight',
	primary: 'lead',
	secondary: 'support',
	tertiary: 'minor',
	neutral: 'plain',
	severe: 'grave',
	sponsors: 'patron',
	closed: 'shut',
	open: 'live',
	inverse: 'flipped',
	inverted: 'flipped',
	white: 'paper',
	black: 'carbon',
	transparent: 'clear',
	link: 'jump',
	hover: 'over',
	active: 'engaged',
	focus: 'aim',
	info: 'notify',
	brand: 'house',
	surface: 'plane',
	control: 'widget',
	backdrop: 'scrim',
	selection: 'picked',
	cursor: 'caret',
	page: 'sheet',
	canvas: 'field',
};

/** `bgColor` → `['bg','Color']` → `['surface','surface']`; the pieces are substituted then rejoined. */
function renameSegment(seg: string): string {
	const whole = WORDS[seg.toLowerCase()];
	if (whole) return whole;
	// camelCase and kebab pieces, each substituted on its own.
	const parts = seg
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[\s\-_]+/)
		.filter(Boolean);
	const mapped = parts.map((p) => WORDS[p.toLowerCase()] ?? p.toLowerCase());
	// Deduplicate neighbours the substitution collapsed: `bg`+`Color` both become
	// `surface`, and `surface-surface` is not a name any system writes.
	const out = mapped.filter((p, i) => p !== mapped[i - 1]);
	return out.join('-');
}

/**
 * The role word moves to the end.
 *
 * Two systems disagreeing about whether to group by role or by tone is the
 * commonest structural difference there is — `bgColor.danger.muted` against
 * `alarm.quiet.surface` — and it is the one that defeats a comparison based on
 * position rather than on the set of words.
 */
const regroup = (segs: readonly string[]): string[] =>
	segs.length < 2 ? [...segs] : [...segs.slice(1), segs[0] as string];

/** Substitute the vocabulary inside prose, and drop a trailing clause so the wording is not a copy. */
function paraphrase(text: string): string {
	const swapped = text.replace(/[A-Za-z][A-Za-z-]*/g, (w) => {
		const to = WORDS[w.toLowerCase()];
		if (!to) return w;
		return /^[A-Z]/.test(w) ? to[0]?.toUpperCase() + to.slice(1) : to;
	});
	// Half the descriptions lose their last clause: a real second system says
	// less, or says more, about the same token — it does not say the same thing.
	const at = swapped.lastIndexOf(', ');
	return at > 24 && swapped.length - at > 8 ? `${swapped.slice(0, at)}.` : swapped;
}

/** Deterministic 32-bit hash, so a run is reproducible without carrying a PRNG. */
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Nudge a hex colour, so an exact value match cannot stand in for understanding it. */
function nudge(hex: string, seed: number): string {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = Number.parseInt(m[1] as string, 16);
	const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c, i) => {
		const delta = ((seed >> (i * 5)) % 11) - 5; // ±5/255, about 2%
		return Math.max(0, Math.min(255, c + delta));
	});
	return `#${chan.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The target's value for a renamed token.
 *
 * A hex is nudged. An alias is renamed through the same vocabulary, which is the
 * part that matters: a set whose values are all unresolved references — Archer's
 * common colours are — would otherwise hand the target the source's own strings,
 * and every correct pair would score a perfect value match for free. The eval
 * would then be measuring a leak.
 */
function renameValue(literal: string, seed: number): string {
	if (/^#[0-9a-f]{6}$/i.test(literal)) return nudge(literal, seed);
	const alias = /^\{([^{}]+)\}$/.exec(literal.trim());
	if (alias) return `{${regroup((alias[1] as string).split('.').map(renameSegment)).join('.')}}`;
	return literal || '#000000';
}

export interface Labelled {
	source: TokenDoc;
	target: TokenDoc;
	/** Source path → the target path that is its counterpart, or `none`. */
	truth: Map<string, string>;
	/** How many source tokens were deliberately given no counterpart. */
	heldOut: number;
}

export const NONE = 'none';

/**
 * Build the labelled pair.
 *
 * `holdOut` is the share of tokens removed from the target, chosen by hash so
 * the same set always yields the same split. They are what `none` is scored on,
 * and without them an eval rewards a matcher that never declines.
 */
export function labelledPair(setPath: string, holdOut = 0.2): Labelled {
	const source = readTokenDoc(setPath, 'alpha');
	const tree: Record<string, unknown> = {};
	const truth = new Map<string, string>();
	let heldOut = 0;

	for (const t of source.tokens) {
		const renamed = regroup(t.segments.map(renameSegment));
		const path = renamed.join('.');
		const seed = hash(t.path);
		// Held out by hash on the path, so the split is stable across runs and
		// across ablation arms — every arm is scored on the same question.
		if ((seed % 1000) / 1000 < holdOut) {
			truth.set(t.path, NONE);
			heldOut++;
			continue;
		}
		truth.set(t.path, path);
		let at = tree;
		for (const seg of renamed.slice(0, -1)) {
			at[seg] ??= {};
			at = at[seg] as Record<string, unknown>;
		}
		at[renamed.at(-1) as string] = {
			$value: renameValue(t.literal, seed),
			$type: t.type || 'color',
			...(t.description ? { $description: paraphrase(t.description) } : {}),
		};
	}

	const dir = mkdtempSync(join(tmpdir(), 'loupe-eval-'));
	const file = join(dir, 'beta.json');
	writeFileSync(file, JSON.stringify(tree, null, 2));
	const target = readTokenDoc(file, 'beta');

	// A rename that collided would make two source tokens share one answer, and
	// the label for both would be a coin flip. Better to fail loudly here.
	const kept = [...truth.values()].filter((v) => v !== NONE);
	if (new Set(kept).size !== kept.length) throw new Error('the rename was not injective — labels would be ambiguous');
	if (target.tokens.length !== kept.length)
		throw new Error(`target has ${target.tokens.length} tokens for ${kept.length} labels`);
	return { source, target, truth, heldOut };
}

/** What the rename did, for the eval's header. */
export function describePair(p: Labelled): string {
	const sample = p.source.tokens.find((t) => p.truth.get(t.path) !== NONE);
	const to = sample ? p.truth.get(sample.path) : '';
	return (
		`${p.source.tokens.length} source tokens → ${p.target.tokens.length} target, ` +
		`${p.heldOut} held out (answer is \`${NONE}\`)\n` +
		(sample ? `  e.g. ${sample.path} → ${to}\n       "${sample.description ?? ''}"\n` : '')
	);
}

/** Read a vendored set's raw JSON, for a caller that wants the file rather than the doc. */
export const readRaw = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
