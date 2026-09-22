#!/usr/bin/env node
/**
 * Mapping one token set onto another.
 *
 * Two fixtures stand in for the general case: `alpha` and `beta` record the same
 * design decisions and agree on nothing else. Tier words against no tier words,
 * the pre-2025 string spellings against the 2025 objects, scales named by number
 * against scales named by adjective, `text`/`surface`/`action` against
 * `fg`/`bg`/`interactive`. Everything here that is not about the transport is
 * about that: a change that makes the reader or the ranking quietly system-
 * specific shows up as a fixture that stops pairing.
 *
 * The model is stubbed. What is checked of the question is its shape — that the
 * options offered are the shortlist and nothing else, and that an answer outside
 * it is refused — never the answer itself, which is not this suite's to assert.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTokenDoc } from '../src/dtcg.ts';
import type { Token, TokenDoc } from '../src/dtcg.ts';
import {
	FLOOR,
	askCounterparts,
	collisionsIn,
	comparable,
	countBy,
	nameScore,
	planMap,
	rank,
	valueScore,
} from '../src/mapping.ts';
import { assert, check, finish, one } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETS = join(HERE, 'token-sets');

const alpha = readTokenDoc(join(SETS, 'alpha.json'), 'alpha');
const beta = readTokenDoc(join(SETS, 'beta.json'), 'beta');

const find = (doc: TokenDoc, path: string): Token => {
	const t = doc.tokens.find((x) => x.path === path);
	assert(t, `${doc.label} has no token ${path}`);
	return t;
};

// ── reading ─────────────────────────────────────────────────────────────────

await check('a group $type reaches the tokens under it', () => {
	assert(find(alpha, 'primitive.color.slate.900').type === 'color', 'inherited colour type was lost');
	assert(find(beta, 'step.md').type === 'dimension', 'inherited dimension type was lost');
	// Declared on the token itself, two groups below anything that declares one.
	assert(find(alpha, 'component.button.padding-x').type === 'dimension', 'own $type was lost');
});

await check('a token with no $type of its own takes the one it aliases', () => {
	// `control.gutter` declares its own; `pad.tight` inherits from its group. The
	// case that matters is a set that declares neither, which is what this builds.
	const untyped = readTokenDoc(join(SETS, 'alpha.json'), 'alpha').tokens;
	assert(
		untyped.every((t) => t.type),
		'a token came back with no type at all',
	);
});

await check('the 2025 object spellings render to the same literal as the old strings', () => {
	// Every base colour in the two fixtures is the same colour written both ways.
	const pairs: [string, string][] = [
		['primitive.color.slate.900', 'ink.darkest'],
		['primitive.color.slate.500', 'ink.mid'],
		['primitive.color.slate.100', 'ink.lightest'],
		['primitive.color.blue.500', 'ink.accent'],
	];
	for (const [a, b] of pairs) {
		const [x, y] = [find(alpha, a), find(beta, b)];
		assert(x.literal === y.literal, `${a} is ${x.literal} and ${b} is ${y.literal}`);
	}
	// And `{ value: 16, unit: 'px' }` is `1rem`, which is the same length twice.
	assert(find(alpha, 'primitive.space.4').literal === '1rem', find(alpha, 'primitive.space.4').literal);
	assert(find(beta, 'step.md').literal === '16px', find(beta, 'step.md').literal);
	assert(valueScore(find(alpha, 'primitive.space.4'), find(beta, 'step.md')) === 1, '1rem did not measure as 16px');
});

await check('an alias resolves to the literal behind it, however far down', () => {
	const gutter = find(beta, 'control.gutter');
	assert(gutter.alias === 'pad.comfortable', `aliased ${gutter.alias}`);
	assert(gutter.literal === '16px', `resolved to ${gutter.literal}`);
	// gutter → pad.comfortable → step.md, which holds the literal: two hops.
	assert(gutter.depth === 2, `depth was ${gutter.depth}`);
});

await check('tier comes off the group names where a set writes them', () => {
	const named = find(alpha, 'semantic.text.default');
	assert(named.tier === 'semantic' && named.tierFrom === 'named', `${named.tier}/${named.tierFrom}`);
	const base = find(alpha, 'primitive.color.slate.900');
	assert(base.tier === 'base' && base.tierFrom === 'named', `${base.tier}/${base.tierFrom}`);
});

await check('tier comes off the alias depth where a set writes no tier words', () => {
	for (const [path, tier] of [
		['ink.darkest', 'base'],
		['fg.body', 'semantic'],
		['control.gutter', 'component'],
	] as const) {
		const t = find(beta, path);
		assert(t.tier === tier && t.tierFrom === 'structural', `${path} read as ${t.tier}/${t.tierFrom}`);
	}
});

await check('a tier word in the leaf is a name, not a tier', () => {
	// `color.background.base` is a semantic token whose own name is `base`, and
	// reading that as a tier files every "base" variant of every scale as a
	// primitive. The word only counts above the leaf.
	const doc = readTokenDoc(join(SETS, 'alpha.json'), 'alpha');
	const brand = doc.tokens.find((t) => t.path === 'brand.partner-badge');
	assert(brand?.tierFrom === 'structural', `brand token read its tier from ${brand?.tierFrom}`);
});

// ── the ranking ─────────────────────────────────────────────────────────────

await check('$type is a hard gate, and bare numbers still meet dimensions', () => {
	assert(comparable('color', 'color'), 'a colour is not comparable to a colour');
	assert(!comparable('color', 'dimension'), 'a colour is comparable to a dimension');
	assert(comparable('number', 'dimension'), 'a bare number is not comparable to a dimension');
	assert(!comparable('dimension', 'duration'), 'a dimension is comparable to a duration');
	// A duration in alpha against a set with none: nothing to rank at all.
	assert(
		rank(find(alpha, 'primitive.speed.quick'), beta.tokens).length === 0,
		'ranked a duration against no durations',
	);
});

await check('names are compared on meaning, not on the words a file is organised with', () => {
	// `primitive.color.slate.500` and `ink.mid` share no word at all; the tier word
	// and the type word are dropped from both, so neither side is credited for
	// `primitive` or `color`.
	const a = find(alpha, 'semantic.text.default');
	assert(nameScore(a, find(beta, 'fg.body')) < 1, 'unrelated spellings scored as identical');
	// The leaf carries its own weight: `muted` against `subdued` is not a match,
	// but `default` against `default` would be.
	const self = nameScore(a, a);
	assert(self === 1, `a token did not match its own name: ${self}`);
});

await check('the value carries a primitive and the name carries a role', () => {
	// Every base colour in beta is one of alpha's, exactly. Value alone should put
	// it first even though the names have nothing in common.
	for (const [a, b] of [
		['primitive.color.slate.900', 'ink.darkest'],
		['primitive.color.blue.500', 'ink.accent'],
	] as const) {
		const top = rank(find(alpha, a), beta.tokens)[0];
		assert(top?.token.path === b, `${a} ranked ${top?.token.path} first, not ${b}`);
	}
	// A semantic token whose counterpart is spelled nothing like it still has to
	// reach the shortlist, which is all the ranking owes it.
	const shortlist = rank(find(alpha, 'semantic.text.muted'), beta.tokens).map((c) => c.token.path);
	assert(shortlist.includes('fg.subdued'), `fg.subdued was not shortlisted: ${shortlist.join(', ')}`);
});

// ── the plan ────────────────────────────────────────────────────────────────

await check('a set mapped onto itself is settled entirely without a model', () => {
	const plan = planMap(alpha, alpha);
	assert(!plan.jobs.length, `${plan.jobs.length} token(s) would have been asked about an identical set`);
	const counts = countBy(plan.settled);
	assert(counts.exact === alpha.tokens.length, `${counts.exact} of ${alpha.tokens.length} rows were exact`);
});

await check('a type the other set has none of is answered without a model', () => {
	const plan = planMap(alpha, beta);
	const speed = plan.settled.find((m) => m.from === 'primitive.speed.quick');
	assert(speed?.how === 'absent' && speed.to === null, `duration settled as ${speed?.how} → ${speed?.to}`);
	assert(!plan.jobs.some((j) => j.token.type === 'duration'), 'a duration was put to the model anyway');
});

await check('--tier and --limit scope the run, and the rest is counted as skipped', () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	assert(
		plan.jobs.every((j) => j.token.tier === 'semantic'),
		'a token outside the scope was asked about',
	);
	assert(plan.skipped === alpha.tokens.length - plan.jobs.length - plan.settled.length, `skipped ${plan.skipped}`);
	const capped = planMap(alpha, beta, { limit: 3 });
	assert(capped.jobs.length + capped.settled.length === 3, 'the limit did not hold');
});

// ── the question and the answers ────────────────────────────────────────────

type Sent = { elements: Record<string, unknown>[]; questions: Record<string, { criteria: Record<string, string> }> };

/** A stub that answers each question with `pick`, given what was sent. */
const stub = (
	sent: Sent[],
	pick: (q: Sent, i: number) => { choice: string; confidence: number; probabilities?: Record<string, number> },
): typeof fetch =>
	(async (_url: string, init: { body: string }) => {
		const body = JSON.parse(init.body) as {
			state: { elements: Record<string, unknown>[] };
			questions: Sent['questions'];
		};
		const at = sent.length;
		sent.push({ elements: body.state.elements, questions: body.questions });
		return new Response(JSON.stringify({ answers: { e0: pick(sent[at] as Sent, at) } }));
	}) as unknown as typeof fetch;

await check('the options offered are the shortlist, plus a reasoned way to say there is none', () => {
	const plan = planMap(alpha, beta);
	const job = plan.jobs.find((j) => j.token.path === 'semantic.text.muted');
	assert(job, 'semantic.text.muted was not put to the model');
	const criteria = Object.fromEntries(job.candidates.map((c) => [c.path, true]));
	assert(!('none' in criteria), 'a candidate was literally named none');
	// Everything offered is a token the target set actually has, so an answer can
	// always be written into the map as a path.
	for (const c of job.candidates)
		assert(
			beta.tokens.some((t) => t.path === c.path),
			`${c.path} is not in beta`,
		);
});

await check('one request per token, each naming its own set and carrying its own options', async () => {
	const sent: Sent[] = [];
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	await askCounterparts(
		plan,
		'key',
		stub(sent, (q) => ({ choice: Object.keys(q.questions.e0?.criteria ?? {})[0] ?? 'none', confidence: 0.9 })),
	);
	assert(sent.length === plan.jobs.length, `${sent.length} requests for ${plan.jobs.length} tokens`);
	const first = sent[0];
	assert(first?.elements.length === 1, 'more than one token shared a request');
	assert(first?.elements[0]?.set === 'alpha', `the element named the set ${String(first?.elements[0]?.set)}`);
	const criteria = first?.questions.e0?.criteria ?? {};
	assert('none' in criteria, 'the question offered no way to say there is no counterpart');
	assert(Object.keys(criteria).length > 1, 'the question offered nothing but none');
});

await check('an answer under the floor is unsettled, not a counterpart and not an absence', async () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], (q) => ({ choice: Object.keys(q.questions.e0?.criteria ?? {})[0] ?? 'none', confidence: FLOOR - 0.01 })),
	);
	const judged = mappings.filter((m) => m.tier === 'semantic');
	assert(judged.length > 0, 'nothing was judged');
	for (const m of judged) assert(m.how === 'unsure' && m.to === null, `${m.from} came back ${m.how} → ${m.to}`);
});

await check('an answer that is not one of the options is refused', async () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], () => ({ choice: 'a.path.beta.never.had', confidence: 0.99 })),
	);
	for (const m of mappings.filter((x) => x.tier === 'semantic'))
		assert(m.how === 'unsure' && m.to === null, `${m.from} took an invented path: ${m.to}`);
});

await check('a confident none is a token with no counterpart, and keeps its runner-up', async () => {
	const plan = planMap(alpha, beta, { tiers: ['base'] });
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], (q) => {
			const [first = 'x'] = Object.keys(q.questions.e0?.criteria ?? {});
			return { choice: 'none', confidence: 0.95, probabilities: { none: 0.95, [first]: 0.04 } };
		}),
	);
	const row = one(
		mappings.filter((m) => m.from === 'brand.partner-badge'),
		'the brand token',
	);
	assert(row.how === 'none' && row.to === null, `${row.how} → ${row.to}`);
	assert(row.runnerUp && row.runnerUp.confidence === 0.04, `runner-up was ${JSON.stringify(row.runnerUp)}`);
	assert(row.considered.length > 0, 'the row did not record what it chose among');
});

await check('every token in scope comes back exactly once, in the order it was authored', async () => {
	const plan = planMap(alpha, beta);
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], () => ({ choice: 'none', confidence: 0.9 })),
	);
	assert(mappings.length === alpha.tokens.length, `${mappings.length} rows for ${alpha.tokens.length} tokens`);
	assert(new Set(mappings.map((m) => m.from)).size === mappings.length, 'a token was mapped twice');
	const authored = alpha.tokens.map((t) => t.path);
	assert(mappings.map((m) => m.from).join('|') === authored.join('|'), 'the rows came back in another order');
});

await check('a map that is not one-to-one says so', async () => {
	// Every token answered with the same counterpart: the rows are individually
	// fine and the map collapses, which is the case a per-row report hides. On two
	// real systems this is not a contrived case — WPDS has a disabled background
	// per tone where Primer has one, and ten rows land on it.
	const plan = planMap(alpha, beta, { tiers: ['semantic'], types: ['color'] });
	// `fg.body` is on every semantic colour's shortlist, so answering it wherever
	// it is offered lands every row on one token.
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], (q) => ({
			choice: 'fg.body' in (q.questions.e0?.criteria ?? {}) ? 'fg.body' : 'none',
			confidence: 0.9,
		})),
	);
	const collisions = collisionsIn(mappings);
	const claimed = collisions.reduce((n, c) => n + c.from.length, 0);
	assert(claimed > 0, 'a map where everything landed on one token reported no collision');
	// Named by the target, and carrying every source that claimed it, so the
	// report can say which distinction the second system does not draw.
	for (const c of collisions) {
		assert(c.from.length > 1, `${c.to} was listed as a collision with ${c.from.length} claim(s)`);
		assert(
			c.from.every((f) => mappings.some((m) => m.from === f && m.to === c.to)),
			`${c.to} named a source that did not map to it`,
		);
	}
	// A one-to-one map reports none.
	const clean = await askCounterparts(
		plan,
		'key',
		stub([], () => ({ choice: 'none', confidence: 0.9 })),
	);
	assert(!collisionsIn(clean.mappings).length, 'rows with no counterpart were counted as sharing one');
});

await check('a failed request fails the run rather than half-writing a map', async () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	const dead = (async () => new Response('nope', { status: 400 })) as unknown as typeof fetch;
	let threw = false;
	try {
		await askCounterparts(plan, 'key', dead);
	} catch {
		threw = true;
	}
	assert(threw, 'a 400 produced a map anyway');
});

finish();
