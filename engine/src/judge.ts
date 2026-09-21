/**
 * Opt-in model judgement, behind `check --judge`.
 *
 * Two halves. Here: `ask`, the transport every judgement shares — batch the
 * items, post one request per batch, hand back one answer per item — and what
 * each check does with the answers. In `judge/`, one file per *question*: what
 * to put in the state and what to ask about it, which is the half worth reading
 * and the half an eval scores — each one carries a whole example of the request
 * it posts. An eval imports the query it scores and calls `ask` with it, the
 * same call the check makes. A new judgement is a new file there and a caller
 * here.
 *
 *   judge/variant.ts   system/raw-element — which variant of the analog
 *   judge/force.ts     a pattern force, for patterns/judged-redirect
 *   judge/value.ts     tokens/hardcoded-value — which token, or deliberate
 *
 * None changes a deterministic verdict. A variant or a token is written into
 * the finding's suggestion; a redirect is its own advisory finding, written
 * after the baseline and never by the hook. Each records the answer as data on
 * `Finding.judged`. The gate stays deterministic and offline, and this runs
 * only when asked.
 */

import { readFileSync } from 'node:fs';
import { EMBEDDED_LANGUAGE } from './embedded.ts';
import type { ForceJudge } from './judge/force.ts';
import { forceQuery } from './judge/force.ts';
import { valueQuery } from './judge/value.ts';
import { around, notKey, variantQuery } from './judge/variant.ts';
import { resolveRule } from './patterns.ts';
import type { ResolveRule } from './patterns.ts';
import { RULES } from './rules.ts';
import { KEEP, planValue } from './tokens.ts';
import type { Slot } from './tokens.ts';
import type { ComponentEntry, Control, Finding, Profile, Severity, TokenSet } from './types.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// A version, not `jev-latest`: the alias moves when a release ships, and every
// floor in here was measured against the model the evals ran on. Moving to a
// new one is re-running `evals/` and changing this line in the same commit.
export const MODEL = 'jev-1.13.0';
// ponytail: one floor for every outcome. Split it per outcome if an eval shows
// `none` needs more certainty than a variant pick.
const FLOOR = 0.5;
// Requests in flight. One per control needs this to stay quick; 6 held for the
// whole eval without a 429, and the endpoint answers a single control in ~200ms.
const CONCURRENCY = 6;
// Overload is transient and a run is a hundred requests, so one 529 should not
// lose the other ninety-nine.
const RETRIES = 4;

type Fetch = typeof fetch;

export interface Choice {
	choice: string;
	/** How concentrated `probabilities` is, not the chance `choice` is right. */
	confidence: number;
	/** Every option's probability, summing to 1. */
	probabilities: Record<string, number>;
}

/** One question put to Jev, and everything that is specific to it. */
export interface Query<T> {
	/** What the model reads about one item: `state.elements[i]`. */
	element: (item: T) => object;
	/** What it is asked about `elements[index]`. */
	question: (item: T, index: number) => object;
}

/**
 * Batch, post, align.
 *
 * `state.elements[i]` is the convention every query is written against: the
 * question at index `i` talks about `elements[i]`, so instructions can name the
 * thing they are about and the answers come back in the order the items went in.
 * Every element in a batch is visible to every question in it, which is why a
 * batched question has to be scored batched — see the represents eval.
 *
 * `size` is how many items share one request. The state budget allows 40, but
 * accuracy does not survive the sharing: `represents` kept 97% of its
 * destinations one per request and 69% at 40 (`evals/represents/run.ts --batch
 * N` measures it). A control is a few lines, so one each is cheap, and the pool
 * below keeps it quick.
 *
 * Throws on a failed request; the caller reports it and keeps what it had.
 */
export async function ask<T>(
	query: Query<T>,
	items: readonly T[],
	apiKey: string,
	fetchImpl: Fetch = fetch,
	size = 1,
): Promise<(Choice | undefined)[]> {
	const batches: T[][] = [];
	for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));

	const sendBatch = async (batch: readonly T[]): Promise<(Choice | undefined)[]> => {
		const body = JSON.stringify({
			model: MODEL,
			state: { elements: batch.map(query.element) },
			questions: Object.fromEntries(batch.map((item, i) => [`e${i}`, query.question(item, i)])),
		});
		for (let attempt = 0; ; attempt++) {
			const res = await fetchImpl(ENDPOINT, {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				body,
			});
			if (res.ok) {
				const parsed = (await res.json()) as { answers: Record<string, Choice> };
				return batch.map((_, i) => parsed.answers[`e${i}`]);
			}
			const transient = res.status === 429 || res.status >= 500;
			if (!transient || attempt >= RETRIES)
				throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
			// The server's own wait when it names one, in seconds; a date or
			// nothing falls back to doubling.
			const after = Number(res.headers.get('retry-after'));
			await new Promise((r) => setTimeout(r, after > 0 ? after * 1000 : 500 * 2 ** attempt));
		}
	};

	// Bounded pool. Results are written by index, so the answers come back in
	// the order the items went in however the requests interleave.
	const done: (Choice | undefined)[][] = new Array(batches.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
			while (next < batches.length) {
				const at = next++;
				try {
					done[at] = await sendBatch(batches[at] ?? []);
				} catch (err) {
					// One failure fails the whole ask: stop the other workers rather
					// than pay for answers that are about to be thrown away.
					next = batches.length;
					throw err;
				}
			}
		}),
	);
	return done.flat();
}

/** How every judged message ends: the certainty behind what it now says. */
const judgedTail = (confidence: number): string => `(judged ${confidence.toFixed(2)})`;

// ── system/raw-element: which variant? ──────────────────────────────────────

/** The registry entry with variants that a raw-element finding points at, if any. */
function targetOf(f: Finding, withVariants: readonly ComponentEntry[]): ComponentEntry | undefined {
	if (f.rule !== 'system/raw-element') return undefined;
	const analog = f.message.split('→')[1] ?? '';
	return withVariants.find((e) => new RegExp(`\\b${e.name}\\b`).test(analog));
}

/**
 * Write each answer into its finding's suggestion, in place. Returns how many
 * were written.
 *
 * The answer goes where the reader would have had to put it: `<p> → <Text>`
 * becomes `<p> → <Text variant="body-sm"> (judged 0.81)`, and a suggestion that
 * already names a placeholder, `variant="heading-*"`, has it filled. A
 * `not_` answer replaces the suggestion, since the analog was the wrong call.
 */
export async function judgeVariants(
	root: string,
	findings: readonly Finding[],
	registry: ReadonlyMap<string, ComponentEntry>,
	apiKey: string,
	fetchImpl: Fetch = fetch,
): Promise<number> {
	const withVariants = [...registry.values()].filter((e) => e.status === 'recommended' && e.variants);
	const jobs = findings.flatMap((f) => {
		const target = targetOf(f, withVariants);
		return target ? [{ f, target }] : [];
	});

	const answers = await ask(variantQuery(root), jobs, apiKey, fetchImpl);

	let annotated = 0;
	jobs.forEach(({ f, target }, i) => {
		const a = answers[i];
		if (!a || a.confidence < FLOOR) return;
		const arrow = f.message.indexOf(' → ');
		const element = f.message.slice(0, arrow);
		const analog = f.message.slice(arrow + 3);
		const tag = `<${target.name}>`;
		const not = a.choice === notKey(target);
		const span = not ? `no analog, not ${target.name} content` : `variant="${a.choice}"`;
		const suggestion = not
			? span
			: /variant="[^"]*"/.test(analog)
				? analog.replace(/variant="[^"]*"/, span)
				: analog.includes(tag)
					? analog.replace(tag, `<${target.name} ${span}>`)
					: `${analog} with ${span}`;
		const tail = judgedTail(a.confidence);
		f.message = `${element} → ${suggestion} ${tail}`;
		f.judged = { answer: a.choice, confidence: a.confidence, spans: [span, tail] };
		annotated++;
	});
	return annotated;
}

// ── patterns/judged-redirect ────────────────────────────────────────────────

interface Language {
	vocabulary: { forces: Record<string, { values: unknown[]; about: string; judge?: ForceJudge }> };
	patterns: { id: string; resolve?: ResolveRule[] }[];
}

// The abstract language, `patterns/index.json`. Nothing but the judge reads it
// at runtime: a signature is all the deterministic rules can check, and every
// force is beyond one.
export const LANGUAGE = EMBEDDED_LANGUAGE as Language;

// A redirect sends an agent to a different pattern, which is the expensive
// error, so an answer counts only where the eval found nothing wrong: every
// `represents` answer at 0.90 or above was right, and under it a third of the
// `command` picks were not.
//
// One floor for every value, though the eval argues for less on `destination`:
// 27 of 27 picks under 0.90 were right. Gutenberg says otherwise. Of its 19
// destination picks between 0.5 and 0.9, 11 were pagination buttons, a control
// the eval has no label for, and only 2 were plainly links. The cost of 0.90 is
// site-foundry's one real case, `onClick={ () => navigate( '#/new' ) }`, at 0.83.
// Label pagination into the eval before lowering it.
//
// The floor is on the pick's confidence. The class's own probability was
// scored as the gate too, on the same answers, and at 0.90 acts on one more
// destination and two more commands, one of them wrong: no reason to switch.
const REDIRECT_FLOOR = 0.9;

/**
 * The findings the abstract language's redirects produce on these controls.
 *
 * Each control is an instance of the pattern its registry entry realizes. The
 * forces that pattern's `resolve` table consults are asked — only those the
 * vocabulary says how to ask — and an answer under the floor stays unknown.
 * `resolveRule` then runs the table on what is known, and a redirect is the
 * finding. A variant pick is not: the realization already chose a variant,
 * and a different one is a finding this does not write yet.
 */
export async function judgeRedirects(
	controls: readonly Control[],
	apiKey: string,
	severity: Severity,
	fetchImpl: Fetch = fetch,
): Promise<Finding[]> {
	const byId = new Map(LANGUAGE.patterns.map((p) => [p.id, p]));
	const abstractOf = (patternId: string): string => patternId.split('#', 1)[0]?.split('.', 1)[0] ?? patternId;
	const tableOf = (c: Control): ResolveRule[] => byId.get(abstractOf(c.patternId))?.resolve ?? [];

	const known = controls.map((): Record<string, string> => ({}));
	const sure = controls.map((): Record<string, number> => ({}));
	for (const [name, force] of Object.entries(LANGUAGE.vocabulary.forces)) {
		if (!force.judge) continue;
		const asked = controls.flatMap((c, i) => (tableOf(c).some((r) => r.when && name in r.when) ? [i] : []));
		if (!asked.length) continue;
		const answers = await ask(
			forceQuery(force.judge),
			asked.map((i) => controls[i] as Control),
			apiKey,
			fetchImpl,
		);
		asked.forEach((ci, k) => {
			const a = answers[k];
			if (!a || a.confidence < REDIRECT_FLOOR) return;
			(known[ci] as Record<string, string>)[name] = a.choice;
			(sure[ci] as Record<string, number>)[name] = a.confidence;
		});
	}

	// `<Button> (represents: destination) \u2192 \`navigate-hierarchy\` (judged 0.97)`:
	// what it was read as, where that sends it, and the least certain reading
	// the redirect rests on.
	return controls.flatMap((c, i): Finding[] => {
		const r = resolveRule(tableOf(c), known[i] ?? {});
		if (!r?.redirect) return [];
		const when = Object.entries(r.when ?? {});
		const reading = `(${when.map(([f, v]) => `${f}: ${String(v)}`).join(', ')})`;
		const confidence = Math.min(...when.map(([f]) => sure[i]?.[f] ?? 0));
		const tail = judgedTail(confidence);
		return [
			{
				rule: 'patterns/judged-redirect',
				severity,
				rank: RULES['patterns/judged-redirect'].rank,
				file: c.file,
				line: c.line,
				message: `<${c.component}> ${reading} \u2192 \`${r.redirect}\` ${tail}`,
				note: r.because,
				code: `<${c.component}>`,
				judged: { answer: when.map(([, v]) => String(v)).join(', '), confidence, spans: [reading, tail] },
			},
		];
	});
}

// ── tokens/hardcoded-value: which token, or is it deliberate? ───────────────

/**
 * What each token is for, in the design system's words: every active
 * profile's `tokenDescriptions`, merged. Token names carry their system's
 * prefix, so two profiles cannot collide.
 *
 * Measured on `evals/values`: sending these as each option's meaning took the
 * question from 85% to 92%, and cut the wrong tokens it would act on at 0.5
 * from 16 to 3 over three runs. The name alone says `track`; the description
 * says "eg. scrollbar track", which is what stops `#f0f0f1` on a badge
 * becoming one for being a digit away from its value.
 */
export function tokenDescriptions(profiles: readonly Pick<Profile, 'tokenDescriptions'>[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const p of profiles) {
		if (!p.tokenDescriptions) continue;
		try {
			const raw = JSON.parse(readFileSync(p.tokenDescriptions, 'utf8')) as Record<string, unknown>;
			for (const [name, text] of Object.entries(raw))
				if (!name.startsWith('$') && typeof text === 'string') out.set(name, text);
		} catch {
			/* a profile without readable descriptions is asked with names alone */
		}
	}
	return out;
}

/** Where a channel marker sits on a message: ` (inline)`, `` in `.a` (css-in-js)``. */
const MARKER = / (?:in `[^`]*` )?\((?:inline|css-in-js)\)$/;

/** `padding: 10px → <what> <tail>`, the channel marker kept last. */
function rewrite(f: Finding, what: string, tail: string): void {
	const marker = MARKER.exec(f.message)?.[0] ?? '';
	const body = f.message.slice(0, f.message.length - marker.length);
	const head = body.includes(' → ') ? body.slice(0, body.indexOf(' → ')) : body;
	f.message = `${head} → ${what}${tail ? ` ${tail}` : ''}${marker}`;
}

/**
 * Settle every hardcoded value a single exact token did not: write the token
 * it should use, or that it stays, into the finding. Returns how many were
 * written.
 *
 * A value is asked about part by part, and settles only when every part does:
 * `padding: 10px 12px` becomes two tokens or nothing, and it is kept only when
 * every part is judged deliberate. Where the set has no token for the property
 * at all there is nothing to ask, and the answer is written without a model.
 *
 * `judged` carries the replacement value (or {@link KEEP}) so `fix --judge`
 * applies what this wrote, not a second reading of it.
 */
export async function judgeValues(
	root: string,
	findings: readonly Finding[],
	set: TokenSet,
	apiKey: string,
	about: ReadonlyMap<string, string> = new Map(),
	fetchImpl: Fetch = fetch,
): Promise<number> {
	// With nothing read, every property's family is empty, and "no padding
	// token in the design system" would be said of every value and suppressed
	// by `fix --judge` as fact. An empty set proves nothing about the system.
	// ponytail: a set read only partly passes this; a per-family check is the
	// upgrade if a token source that half-resolves turns up.
	if (!set.known.size)
		throw new Error(
			'no design tokens were read, so there is nothing to judge hardcoded values against \u2014 check designSystem.tokenSources against what the package actually ships',
		);
	type Plan = { f: Finding; parts: string[]; slots: Slot[] };
	const plans: Plan[] = [];
	let written = 0;
	for (const f of findings) {
		// The single exact token is plain `fix`'s already.
		if (
			f.rule !== 'tokens/hardcoded-value' ||
			!f.decl ||
			(f.suggest?.length === 1 && f.suggest[0]?.tokens.length === 1)
		)
			continue;
		const plan = planValue(set, f.decl.prop, f.decl.value);
		if (plan === 'none') {
			const why = `no ${f.decl.prop} token in the design system`;
			rewrite(f, why, '');
			f.judged = { answer: KEEP, confidence: 1, spans: [why] };
			written++;
		} else if (plan) plans.push({ f, ...plan });
	}

	const asked = plans.flatMap(({ f, parts, slots }) =>
		slots.flatMap((slot) => {
			if (!('candidates' in slot) || !f.decl) return [];
			return [
				{
					file: f.file,
					// Eight lines before it reach the selector of an ordinary rule, which
					// is most of what says what the value is for.
					...around(root, f.file, f.line, 8, 3),
					prop: f.decl.prop,
					value: parts.join(' '),
					part: slot.part,
					candidates: slot.candidates,
					slot,
				},
			];
		}),
	);
	const answers = await ask(valueQuery(about), asked, apiKey, fetchImpl);
	const answerOf = new Map(asked.map((item, k) => [item.slot, answers[k]]));

	for (const { f, parts, slots } of plans) {
		const got = slots.map((s) => ('token' in s ? { choice: s.token, confidence: 1 } : answerOf.get(s)));
		// The shared floor holds here: on `evals/values` it acts on 71% of the
		// literals with three wrong tokens in three runs, and no wrong keep.
		// Gating on probability instead — keep on P(keep), else the likeliest
		// token on P(any token) — was scored on the same answers and is no
		// better: at 0.90 it acts on 52% with none wrong, which the floor at
		// 0.70 matches.
		// Except where keeping was never an answer: spacing the scale covers
		// snaps whatever the confidence, and a low one there is only 6px sitting
		// exactly between 4 and 8 — every option is a snap somebody would accept.
		const unsure = (k: number): boolean => {
			const a = got[k];
			const s = slots[k];
			return !a || (a.confidence < FLOOR && !(s && 'candidates' in s && !s.candidates.keep));
		};
		if (slots.some((_, k) => unsure(k))) continue;
		const confidence = Math.min(...got.map((a) => a?.confidence ?? 0));
		const kept = got.find((a) => a?.choice === KEEP);
		// A keep beside a part that settled on a token is half an answer: keeping
		// the whole declaration would suppress the part that has a token, and
		// rewriting the rest would exempt the kept literal. Left for review.
		if (kept && got.some((a) => a?.choice !== KEEP)) continue;
		if (kept) {
			const why = 'deliberate, no token fits';
			const tail = judgedTail(kept.confidence);
			rewrite(f, why, tail);
			f.judged = { answer: KEEP, confidence: kept.confidence, spans: [why, tail] };
		} else {
			const out = [...parts];
			slots.forEach((s, k) => {
				out[s.at] = `var(${got[k]?.choice ?? ''})`;
			});
			const to = out.join(' ');
			// Settled without a question when every part was exact.
			const tail = confidence < 1 ? judgedTail(confidence) : '';
			rewrite(f, to, tail);
			f.judged = { answer: to, confidence, spans: tail ? [to, tail] : [to] };
		}
		written++;
	}
	return written;
}
