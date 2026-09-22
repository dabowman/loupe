/**
 * One token set mapped onto another.
 *
 * The question the whole module exists to answer: given a token in set A, which
 * token in set B is the same decision? Answer it for every token and the two
 * systems become comparable — a design in one can be read in the other, a
 * migration has a lookup table, and the tokens B is missing are exactly the rows
 * that come back with no counterpart.
 *
 * Two halves, split the way `judge/value.ts` splits its question. Here: the
 * arithmetic — which tokens are even of the same kind, how far apart two values
 * are, how much two names have in common, whether the tiers agree — which
 * narrows a 400-token set to a shortlist of eight. In `judge/counterpart.ts`:
 * the half arithmetic cannot do, which is which of those eight plays the same
 * *role*. Names across two systems are related by meaning and not by spelling,
 * and values agree by coincidence as often as by design, so neither side alone
 * is worth much — and neither is the model, asked to read 400 options.
 *
 * Nothing here is calibrated. The weights and the floor below are a starting
 * point chosen by argument, not by measurement, which is the one way this module
 * differs from the rest of the judge: there is no `evals/` for it yet.
 *
 * Design notes: docs/design/map.md
 */

import { ask } from './judge.ts';
import type { Choice } from './judge.ts';
import { NONE, counterpartQuery } from './judge/counterpart.ts';
import type { CounterpartItem } from './judge/counterpart.ts';
import { bold, dim, green, yellow } from './color.ts';
import { TIERS, isTierWord } from './dtcg.ts';
import type { Tier, Token, TokenDoc } from './dtcg.ts';

type Fetch = typeof fetch;

// ── values ──────────────────────────────────────────────────────────────────

/** A value reduced to something two sets can be measured against. */
type Measured =
	| { kind: 'color'; lab: readonly [number, number, number]; alpha: number }
	| { kind: 'number'; n: number; unit: string }
	| null;

/** What a length is worth in px, so `1rem` and `16px` are one value. */
const AS_PX: Record<string, number> = { px: 1, rem: 16, em: 16, pt: 4 / 3 };
/** The same for time. */
const AS_MS: Record<string, number> = { ms: 1, s: 1000 };

/** `#abc`, `#aabbcc`, `#aabbccdd` and `rgb()/rgba()` as sRGB 0..1 plus alpha. */
function parseColor(text: string): { rgb: [number, number, number]; alpha: number } | null {
	const v = text.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
	if (hex && (hex.length === 3 || hex.length === 4 || hex.length === 6 || hex.length === 8)) {
		const wide = hex.length <= 4;
		const at = (i: number): number => {
			const part = wide ? hex.slice(i, i + 1).repeat(2) : hex.slice(i * 2, i * 2 + 2);
			return part ? Number.parseInt(part, 16) / 255 : 0;
		};
		const has = wide ? hex.length === 4 : hex.length === 8;
		return { rgb: [at(0), at(1), at(2)], alpha: has ? at(3) : 1 };
	}
	const fn = /^rgba?\(([^)]+)\)$/.exec(v)?.[1];
	if (!fn) return null;
	const nums = fn
		.split(/[\s,/]+/)
		.filter(Boolean)
		.map((p) => (p.endsWith('%') ? Number.parseFloat(p) / 100 : Number.parseFloat(p)));
	const [r, g, b, a] = nums;
	if (r === undefined || g === undefined || b === undefined || [r, g, b].some(Number.isNaN)) return null;
	// A `%` component is already 0..1; a plain one is 0..255.
	const scale = (n: number, pct: boolean): number => (pct ? n : n / 255);
	const parts = fn.split(/[\s,/]+/).filter(Boolean);
	return {
		rgb: [
			scale(r, parts[0]?.endsWith('%') ?? false),
			scale(g, parts[1]?.endsWith('%') ?? false),
			scale(b, parts[2]?.endsWith('%') ?? false),
		],
		alpha: a === undefined || Number.isNaN(a) ? 1 : a,
	};
}

/**
 * sRGB to OKLab (Ottosson's transform), so "how different are these two
 * colours" is a distance and not a guess.
 *
 * Distance in sRGB is not the question anyone is asking: `#000` to `#111` and
 * `#ee0000` to `#ff0000` are the same distance there and nothing alike to a
 * reader. A perceptual space is what makes "these two systems chose the same
 * grey" separable from "these two greys are three steps apart on the scale",
 * which is the whole job value closeness does in the ranking.
 */
function oklab([r, g, b]: readonly [number, number, number]): [number, number, number] {
	const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const [R, G, B] = [lin(r), lin(g), lin(b)];
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

/**
 * A rendered literal reduced to a comparable measure, or null.
 *
 * Null is the ordinary answer for a font stack, an easing curve or a typography
 * composite: there is no arithmetic on those, so they score on exact equality
 * and on their names, and the model settles the rest.
 */
export function measure(literal: string): Measured {
	const v = literal.trim().toLowerCase();
	if (!v) return null;
	const color = parseColor(v);
	if (color) return { kind: 'color', lab: oklab(color.rgb), alpha: color.alpha };
	const num = /^(-?\d*\.?\d+)([a-z%]*)$/.exec(v);
	if (!num) return null;
	const n = Number.parseFloat(num[1] ?? '');
	if (Number.isNaN(n)) return null;
	const unit = num[2] ?? '';
	if (unit in AS_PX) return { kind: 'number', n: n * (AS_PX[unit] ?? 1), unit: 'px' };
	if (unit in AS_MS) return { kind: 'number', n: n * (AS_MS[unit] ?? 1), unit: 'ms' };
	return { kind: 'number', n, unit };
}

/**
 * How close two colours are, as 0..1.
 *
 * Hyperbolic rather than linear, so the top of the range stays legible: the
 * pairs worth separating are all bunched near zero distance, and `1 - d` would
 * score "the same grey, rounded differently" and "a different grey" within a few
 * points of each other. {@link COLOR_STEP} is roughly one step of a well-spaced
 * palette, and a pair that far apart scores 0.5.
 */
const COLOR_STEP = 0.06;

/** How close two values are, as 0..1. Two things nothing can measure score on equality alone. */
export function valueScore(a: Token, b: Token): number {
	const [x, y] = [measure(a.literal), measure(b.literal)];
	if (!x || !y) return a.literal !== '' && a.literal === b.literal ? 1 : 0;
	if (x.kind !== y.kind) return 0;
	if (x.kind === 'color' && y.kind === 'color') {
		const d = Math.hypot(x.lab[0] - y.lab[0], x.lab[1] - y.lab[1], x.lab[2] - y.lab[2]);
		// Opacity is a large part of what a colour token means — a scrim at 0.5 is
		// not the colour it is 50% of — so it carries its own weight rather than
		// being folded into the distance.
		return 1 / (1 + (d + Math.abs(x.alpha - y.alpha) * 0.5) / COLOR_STEP);
	}
	if (x.kind === 'number' && y.kind === 'number') {
		// px and ms are already normalised; anything else has to be the same unit,
		// since `50%` and `50deg` are not near each other.
		if (x.unit !== y.unit) return 0;
		if (x.n === y.n) return 1;
		if (x.n === 0 || y.n === 0 || x.n * y.n < 0) return 0;
		// The ratio, squared: on a scale that doubles, one step away should not
		// score anything like a hit.
		const ratio = Math.min(Math.abs(x.n), Math.abs(y.n)) / Math.max(Math.abs(x.n), Math.abs(y.n));
		return ratio * ratio;
	}
	return 0;
}

// ── names ───────────────────────────────────────────────────────────────────

/** Words a path is carrying for structure rather than for meaning. */
const NOISE = /^(tokens?|values?|css|json|web|default)$/;

/** `colorForeground-primary` → `color foreground primary`, in pieces. */
const splitWords = (text: string): string[] =>
	text
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.map((w) => w.toLowerCase())
		.filter(Boolean);

/**
 * The words in a token's path that say what it is for.
 *
 * The tier words go, because they describe the file's organisation rather than
 * the token. The type's own name goes with them: every colour token in a set has
 * `color` somewhere, so counting it as agreement would add the same constant to
 * every candidate and separate none of them — and `$type` has already gated the
 * comparison on exactly that fact.
 */
export function words(t: Token): Set<string> {
	const typeWords = new Set(splitWords(t.type));
	return new Set(
		splitWords(t.path).filter((w) => !isTierWord(w) && !typeWords.has(w) && !NOISE.test(w) && !/^colou?rs?$/.test(w)),
	);
}

/** Sørensen–Dice over two word sets: the share of words they have in common. */
function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (!a.size || !b.size) return 0;
	let hit = 0;
	for (const w of a) if (b.has(w)) hit++;
	return (2 * hit) / (a.size + b.size);
}

/**
 * How much two names have in common, as 0..1.
 *
 * The leaf carries its own weight because it is where the systems most often
 * agree outright: `foreground.primary` and `text.primary` name the same decision
 * under different groups, and whole-path overlap alone scores that pair the same
 * as `foreground.primary` against `foreground.inverted`.
 */
export function nameScore(a: Token, b: Token): number {
	const whole = dice(words(a), words(b));
	const leafA = new Set(splitWords(a.leaf));
	const leafB = new Set(splitWords(b.leaf));
	const leaf = a.leaf.toLowerCase() === b.leaf.toLowerCase() ? 1 : dice(leafA, leafB);
	return 0.6 * whole + 0.4 * leaf;
}

// ── the shortlist ───────────────────────────────────────────────────────────

/** Types that are the same question asked in different units. */
const NUMERIC = new Set(['dimension', 'duration', 'fontWeight', 'number']);

/**
 * Whether two tokens are even candidates for each other.
 *
 * `$type` is the one thing the spec makes both sets say in the same words, so it
 * is the only hard gate here — a colour is never a duration's counterpart, and
 * admitting the pair costs an option in every shortlist. A set that writes its
 * spacing scale as bare numbers is the exception the `number` row covers: it
 * means the same as `dimension` and says so in a different draft.
 */
export const comparable = (a: string, b: string): boolean =>
	a === b || (NUMERIC.has(a) && NUMERIC.has(b) && (a === 'number' || b === 'number'));

/** What each half of the ranking is worth, per tier of the token being mapped. */
const WEIGHT: Record<Tier, { value: number; name: number }> = {
	// A primitive *is* its value: two palettes are comparable by colour long
	// before they are comparable by whatever each calls its greys.
	base: { value: 0.75, name: 0.25 },
	// A role is a name. Two systems that both have a default text colour will
	// have rounded it differently, and the value is the weaker signal of the two.
	semantic: { value: 0.35, name: 0.65 },
	component: { value: 0.3, name: 0.7 },
};

/** What agreeing on the tier is worth, out of the whole score. */
const TIER_WEIGHT = 0.2;

/** How many candidates a question offers. Eight fits a reader's attention and the model's. */
export const CANDIDATES = 8;

/** One candidate and why it ranked where it did. */
export interface Scored {
	token: Token;
	score: number;
	value: number;
	name: number;
	sameTier: boolean;
}

/** Rank every comparable token in `targets` against `t`, best first. */
export function rank(t: Token, targets: readonly Token[]): Scored[] {
	const w = WEIGHT[t.tier];
	return targets
		.filter((c) => comparable(t.type, c.type))
		.map((c): Scored => {
			const value = valueScore(t, c);
			const name = nameScore(t, c);
			const sameTier = c.tier === t.tier;
			return {
				token: c,
				value,
				name,
				sameTier,
				score: TIER_WEIGHT * (sameTier ? 1 : 0) + (1 - TIER_WEIGHT) * (w.value * value + w.name * name),
			};
		})
		.sort((a, b) => b.score - a.score || a.token.path.localeCompare(b.token.path));
}

// ── the map ─────────────────────────────────────────────────────────────────

/**
 * How a row of the map was settled.
 *
 * `exact` and `absent` are answered without a model, for the same reason
 * `judgeValues` answers "no token for this property" without one: there is no
 * question to put. `unsure` is a question that was put and came back under the
 * floor — which is a row to look at by hand, not a row with no counterpart.
 */
export type How = 'exact' | 'judged' | 'none' | 'absent' | 'unsure';

/** One token of the source set, and what the target set has for it. */
export interface Mapping {
	from: string;
	/** The counterpart's path, or null where there is none or none was settled. */
	to: string | null;
	confidence: number;
	how: How;
	type: string;
	tier: Tier;
	fromValue: string;
	toValue?: string | undefined;
	/** The next most likely option, where the answer carried probabilities. Says how close the call was. */
	runnerUp?: { to: string; confidence: number } | undefined;
	/** The shortlist the answer was chosen from, best first. */
	considered: string[];
}

/** Below this a judgement is recorded as `unsure` rather than written into the map. */
export const FLOOR = 0.5;

export interface PlanOptions {
	tiers?: readonly Tier[] | undefined;
	types?: readonly string[] | undefined;
	limit?: number | undefined;
	candidates?: number | undefined;
}

/** What a run will do, worked out before a single request is sent. */
export interface MapPlan {
	jobs: CounterpartItem[];
	/**
	 * The scores behind each job's shortlist, aligned with `jobs` by index.
	 *
	 * Carried rather than discarded because the ranking is the half of this that
	 * can be checked without spending anything: `--dry-run` prints it, and a
	 * shortlist that does not contain the right answer is a weighting problem no
	 * amount of model accuracy will fix.
	 */
	shortlists: Scored[][];
	/** The rows that needed no model, in source order. */
	settled: Mapping[];
	/** Tokens the `--tier`/`--type`/`--limit` scope left out. */
	skipped: number;
	from: TokenDoc;
	to: TokenDoc;
}

/**
 * Work out every row that can be settled without asking, and shortlist the rest.
 *
 * Two rows need no model. A token whose path exists verbatim in the other set at
 * a comparable type is its own counterpart — two systems that agree on the whole
 * path have agreed, and putting that to a model is paying for a lookup. A token
 * whose type the other set has none of at all has no counterpart to choose
 * among, and saying so is a fact about the second system rather than a judgement
 * about this token.
 */
export function planMap(from: TokenDoc, to: TokenDoc, opts: PlanOptions = {}): MapPlan {
	const size = opts.candidates ?? CANDIDATES;
	const byPath = new Map(to.tokens.map((t) => [t.path, t]));
	const inScope = (t: Token): boolean =>
		(!opts.tiers?.length || opts.tiers.includes(t.tier)) && (!opts.types?.length || opts.types.includes(t.type));

	const wanted = from.tokens.filter(inScope);
	const capped = opts.limit && opts.limit > 0 ? wanted.slice(0, opts.limit) : wanted;

	const jobs: CounterpartItem[] = [];
	const shortlists: Scored[][] = [];
	const settled: Mapping[] = [];
	for (const t of capped) {
		const row = {
			from: t.path,
			type: t.type,
			tier: t.tier,
			fromValue: t.literal,
		};
		const twin = byPath.get(t.path);
		if (twin && comparable(t.type, twin.type)) {
			settled.push({ ...row, to: twin.path, toValue: twin.literal, confidence: 1, how: 'exact', considered: [] });
			continue;
		}
		const ranked = rank(t, to.tokens).slice(0, size);
		if (!ranked.length) {
			settled.push({ ...row, to: null, confidence: 1, how: 'absent', considered: [] });
			continue;
		}
		jobs.push({
			token: t,
			candidates: ranked.map((c) => c.token),
			fromLabel: from.label,
			toLabel: to.label,
		});
		shortlists.push(ranked);
	}
	return { jobs, shortlists, settled, skipped: from.tokens.length - capped.length, from, to };
}

/**
 * Ask about every shortlisted token and turn the answers into rows.
 *
 * One request per token, which is what `ask` does by default and what this wants
 * anyway: two tokens sharing a state would see each other's candidates, and the
 * answers would stop being independent readings of one question.
 */
export async function askCounterparts(
	plan: MapPlan,
	apiKey: string,
	fetchImpl: Fetch = fetch,
): Promise<{ mappings: Mapping[]; answers: (Choice | undefined)[] }> {
	const answers = plan.jobs.length ? await ask(counterpartQuery, plan.jobs, apiKey, fetchImpl) : [];
	const judged = plan.jobs.map((job, i): Mapping => rowFor(job, answers[i]));
	// Back into the order the tokens were authored in: a map read by a person is
	// read beside the file it came from, and which rows needed a model is not an
	// order anyone wants it in.
	const order = new Map(plan.from.tokens.map((t, i) => [t.path, i]));
	const mappings = [...plan.settled, ...judged].sort(
		(a, b) => (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) || a.from.localeCompare(b.from),
	);
	return { mappings, answers };
}

/** One answer, read against the shortlist it was chosen from. */
function rowFor(job: CounterpartItem, answer: Choice | undefined): Mapping {
	const { token, candidates } = job;
	const row = {
		from: token.path,
		type: token.type,
		tier: token.tier,
		fromValue: token.literal,
		considered: candidates.map((c) => c.path),
	};
	if (!answer || answer.confidence < FLOOR) {
		return { ...row, to: null, confidence: answer?.confidence ?? 0, how: 'unsure' };
	}
	// The best option that is neither the pick nor `none`: how close the call was,
	// which is the thing a reader of an uncalibrated map most wants to see.
	const rest = Object.entries(answer.probabilities ?? {})
		.filter(([k]) => k !== answer.choice && k !== NONE)
		.sort((a, b) => b[1] - a[1])[0];
	const runnerUp = rest ? { runnerUp: { to: rest[0], confidence: rest[1] } } : {};
	if (answer.choice === NONE) return { ...row, to: null, confidence: answer.confidence, how: 'none', ...runnerUp };
	const picked = candidates.find((c) => c.path === answer.choice);
	// An answer that is not one of the options offered is not an answer: recorded
	// as unsure rather than written into the map as a path the target set may not
	// even have.
	if (!picked) return { ...row, to: null, confidence: answer.confidence, how: 'unsure' };
	return {
		...row,
		to: picked.path,
		toValue: picked.literal,
		confidence: answer.confidence,
		how: 'judged',
		...runnerUp,
	};
}

/**
 * The target tokens more than one source token landed on, most claimed first.
 *
 * A map is not a bijection and was never going to be, but a report that lists
 * every row as `a \u2192 b` reads like one. On WPDS against Primer, 139 judged rows
 * land on 76 distinct tokens and one of them absorbs ten: WPDS has a disabled
 * background per tone and per emphasis where Primer has a single
 * `bgColor.disabled`. Every one of those ten answers is defensible on its own,
 * which is exactly why the collapse has to be said out loud rather than left for
 * a reader to notice by sorting the file.
 *
 * It is also the interesting half of the result. "This system draws a
 * distinction the other one does not" is what someone comparing two systems came
 * to find out, and it is only visible across rows.
 */
export function collisionsIn(mappings: readonly Mapping[]): { to: string; from: string[] }[] {
	const claims = new Map<string, string[]>();
	for (const m of mappings) if (m.to) claims.set(m.to, [...(claims.get(m.to) ?? []), m.from]);
	return [...claims]
		.filter(([, from]) => from.length > 1)
		.map(([to, from]) => ({ to, from }))
		.sort((a, b) => b.from.length - a.from.length || a.to.localeCompare(b.to));
}

/** How many rows landed each way. */
export type Counts = Record<How, number>;

export const countBy = (mappings: readonly Mapping[]): Counts => {
	const counts: Counts = { exact: 0, judged: 0, none: 0, absent: 0, unsure: 0 };
	for (const m of mappings) counts[m.how]++;
	return counts;
};

// ── output ──────────────────────────────────────────────────────────────────

/** The map, as a file: what was read, how it was settled, and every row. */
export interface MapPayload {
	from: { label: string; path: string; files: number; tokens: number };
	to: { label: string; path: string; files: number; tokens: number };
	model: string;
	/** The confidence a judgement had to clear to be written as a counterpart. */
	floor: number;
	counts: Counts;
	/** Where the map is not one-to-one. See {@link collisionsIn}. */
	collisions: { to: string; from: string[] }[];
	mappings: Mapping[];
}

export const mapPayload = (plan: MapPlan, mappings: readonly Mapping[], model: string): MapPayload => ({
	from: {
		label: plan.from.label,
		path: plan.from.path,
		files: plan.from.files.length,
		tokens: plan.from.tokens.length,
	},
	to: { label: plan.to.label, path: plan.to.path, files: plan.to.files.length, tokens: plan.to.tokens.length },
	model,
	floor: FLOOR,
	counts: countBy(mappings),
	collisions: collisionsIn(mappings),
	mappings: [...mappings],
});

/** How each outcome reads in the summary line, singular count and all. */
const OUTCOMES: [How, string][] = [
	['exact', 'named identically in both'],
	['judged', 'judged'],
	['none', 'no counterpart'],
	['unsure', 'under the floor'],
	['absent', 'nothing of their type to compare'],
];

/**
 * The map as a reader reads it: grouped by tier, one line per token, the
 * counterpart and the certainty behind it painted.
 *
 * Grouped by tier rather than by outcome because the tiers are the thing a
 * reader is checking — a map whose semantic rows are all sound and whose
 * component rows are all `none` says something specific about the two systems,
 * and an outcome grouping hides exactly that.
 */
export function formatMap(plan: MapPlan, mappings: readonly Mapping[]): string {
	const width = (xs: readonly string[]): number => Math.min(48, Math.max(0, ...xs.map((x) => x.length)));
	const pathW = width(mappings.map((m) => m.from));
	const valueW = width(mappings.map((m) => m.fromValue));
	const pad = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

	const collisions = collisionsIn(mappings);
	const shared = new Map(collisions.map((c) => [c.to, c.from.length]));

	const out: string[] = [`${bold(`${plan.from.label} → ${plan.to.label}`)}\n`];
	for (const tier of TIERS) {
		const rows = mappings.filter((m) => m.tier === tier);
		if (!rows.length) continue;
		out.push(`${bold(tier)} ${dim(`(${rows.length})`)}\n`);
		for (const m of rows) {
			const head = `  ${pad(m.from, pathW)}  ${dim(pad(m.fromValue, valueW))}  →  `;
			// Marked on the row as well as listed below, because a row read on its own
			// is where the one-to-one reading is formed.
			const many = m.to ? shared.get(m.to) : undefined;
			out.push(`${head}${verdict(m)}${many ? dim(`  shared ×${many}`) : ''}\n`);
		}
		out.push('\n');
	}
	if (collisions.length) {
		const claimed = collisions.reduce((n, c) => n + c.from.length, 0);
		out.push(
			`${bold('not one-to-one')} ${dim(
				`(${collisions.length} token(s) in ${plan.to.label} claimed by ${claimed} in ${plan.from.label})`,
			)}\n`,
		);
		for (const c of collisions) {
			out.push(`  ${yellow(c.to)} ${dim(`×${c.from.length}`)}\n`);
			for (const f of c.from) out.push(`      ${dim(f)}\n`);
		}
		out.push('\n');
	}
	const counts = countBy(mappings);
	const said = OUTCOMES.filter(([how]) => counts[how]).map(([how, text]) => `${counts[how]} ${text}`);
	const scoped = plan.skipped ? dim(` (${plan.skipped} token(s) outside this run's scope)`) : '';
	out.push(`${mappings.length} token(s): ${said.join(', ')}.${scoped}\n`);
	return out.join('');
}

/** One row's right-hand side: the counterpart, or why there isn't one. */
function verdict(m: Mapping): string {
	const sure = m.how === 'exact' ? dim('identical') : dim(`${m.confidence.toFixed(2)}`);
	if (m.to) return `${green(m.to)}  ${dim(m.toValue ?? '')}  ${sure}`;
	if (m.how === 'absent') return dim(`nothing of type ${m.type || 'unknown'} to compare`);
	if (m.how === 'unsure') return `${yellow('unsettled')}  ${dim(`best was ${m.confidence.toFixed(2)}`)}`;
	return `${dim('no counterpart')}  ${sure}`;
}

/**
 * The plan, without spending anything: what each token would be asked about.
 *
 * This is the half of a mapping run that can be checked for free. A shortlist
 * that does not contain the right answer cannot be rescued by the model, so the
 * first thing to look at on a new pair of sets is whether the ranking is putting
 * the counterpart in front of it at all.
 */
export function formatPlan(plan: MapPlan, show: number): string {
	const out: string[] = [`${bold(`${plan.from.label} → ${plan.to.label}`)} ${dim('(dry run)')}\n\n`];
	for (const [i, job] of plan.jobs.entries()) {
		const t = job.token;
		out.push(`${t.path}  ${dim(`${t.literal}  ${t.tier}`)}\n`);
		for (const c of (plan.shortlists[i] ?? []).slice(0, show))
			out.push(
				`    ${dim(c.score.toFixed(2))}  ${c.token.path}  ${dim(
					`${c.token.literal}  ${c.token.tier}  value ${c.value.toFixed(2)} name ${c.name.toFixed(2)}`,
				)}\n`,
			);
		out.push('\n');
	}
	const counts = countBy(plan.settled);
	const said = OUTCOMES.filter(([how]) => counts[how]).map(([how, text]) => `${counts[how]} ${text}`);
	const scoped = plan.skipped ? dim(` (${plan.skipped} token(s) outside this run's scope)`) : '';
	out.push(
		`${plan.jobs.length + plan.settled.length} token(s): ${
			said.length ? `${said.join(', ')}, ` : ''
		}${plan.jobs.length} would be asked.${scoped}\n`,
	);
	return out.join('');
}
