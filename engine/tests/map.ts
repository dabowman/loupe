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
import { literalOf, readTokenDoc, tierOf } from '../src/dtcg.ts';
import type { Token, TokenDoc } from '../src/dtcg.ts';
import {
	FLOOR,
	askCounterparts,
	collisionsIn,
	comparable,
	countBy,
	mapPayload,
	nameScore,
	planMap,
	rank,
	valueScore,
	words,
} from '../src/mapping.ts';
import { counterpartQuery } from '../src/judge/counterpart.ts';
import { assert, check, cleanup, finish, one, scratch, write } from './harness.ts';

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

/** A set written for one test, read the way `map` reads one. */
const setOf = (json: object | string, name = 'set.json'): TokenDoc => {
	const root = scratch('loupe-map-');
	try {
		write(root, name, typeof json === 'string' ? json : JSON.stringify(json));
		return readTokenDoc(join(root, name), 'probe');
	} finally {
		cleanup(root);
	}
};

await check('a token with no $type of its own takes the one it aliases', () => {
	// Nothing in the chain declares a type on `body` itself, and its value alone
	// would infer `number`: only the alias chain can say `fontWeight`.
	const doc = setOf({
		weight: { regular: { $type: 'fontWeight', $value: 400 } },
		text: { body: { $value: '{weight.regular}' } },
	});
	assert(find(doc, 'text.body').type === 'fontWeight', `typed ${find(doc, 'text.body').type}`);
	// The spec types a reference by its target ahead of its group.
	const mixed = setOf({
		radius: { $type: 'dimension', md: { $value: '8px' } },
		button: { $type: 'color', bg: { $value: '#3366ff' }, corner: { $value: '{radius.md}' } },
	});
	assert(find(mixed, 'button.corner').type === 'dimension', `typed ${find(mixed, 'button.corner').type}`);
	assert(find(mixed, 'button.bg').type === 'color', 'a literal lost its group $type');
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

await check('a set that never states a tier gets no tier, rather than one guessed from alias depth', () => {
	// `beta` writes no tier words and sits in no folders. Depth used to answer
	// here — literal/one-hop/two-hop read as base/semantic/component — which
	// measures the plumbing rather than the meaning, and gets the interesting
	// case backwards: a component token that merely re-aliases a common one is
	// the shallow chain, and the one that reaches past the common tier for a
	// different primitive is the deep one.
	for (const path of ['ink.darkest', 'fg.body', 'control.gutter']) {
		const t = find(beta, path);
		assert(t.tier === 'unknown' && t.tierFrom === 'unstated', `${path} read as ${t.tier}/${t.tierFrom}`);
	}
	// And an unknown tier is never agreement: two sets that both failed to say
	// have not said the same thing.
	const [top] = rank(find(alpha, 'semantic.text.muted'), beta.tokens);
	assert(top && !top.sameTier, 'an unstated tier counted as a tier match');
});

await check('a tier word in the leaf is a name, not a tier', () => {
	// `color.background.base` is a semantic token whose own name is `base`, and
	// reading that as a tier files every "base" variant of every scale as a
	// primitive. The word only counts above the leaf.
	const doc = setOf({
		ink: { white: { $type: 'color', $value: '#ffffff' } },
		color: { background: { base: { $value: '{ink.white}' } } },
	});
	const t = find(doc, 'color.background.base');
	assert(t.tier === 'unknown' && t.tierFrom === 'unstated', `${t.tier}/${t.tierFrom}`);
	// And above the leaf, the outermost group decides: `base` here is a variant.
	const variant = tierOf(['component', 'button', 'base', 'padding']);
	assert(variant.tier === 'component', `component.button.base.padding read as ${variant.tier}`);
});

await check('a $root token is read, and an alias to it resolves', () => {
	const doc = setOf({
		color: { $type: 'color', accent: { $root: { $value: '#0969da' }, light: { $value: '#54aeff' } } },
		link: { default: { $value: '{color.accent.$root}' } },
	});
	const link = find(doc, 'link.default');
	assert(link.literal === '#0969da' && link.type === 'color', `resolved to ${link.literal} (${link.type})`);
});

await check('a file saved with a byte-order mark still reads', () => {
	const doc = setOf('\uFEFF{"size":{"$type":"dimension","sm":{"$value":"4px"}}}');
	assert(find(doc, 'size.sm').literal === '4px', 'the BOM-prefixed set did not read');
});

await check('a colour with a hex fallback keeps its alpha', () => {
	// The spec's hex is six digits and leaves alpha out of it.
	const scrim = literalOf({ colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.5, hex: '#000000' });
	assert(scrim === '#00000080', `a 50% scrim rendered as ${scrim}`);
	// And a `none` component converts as 0, the way CSS reads it.
	const grey = literalOf({ colorSpace: 'hsl', components: ['none', 0, 50] });
	assert(grey === '#808080', `an achromatic hsl grey rendered as ${grey}`);
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
	const kept = [...words(find(alpha, 'primitive.color.slate.500'))];
	assert(kept.join(' ') === 'slate 500', `the tier and type words were kept: ${kept.join(' ')}`);
});

await check('the value carries a primitive and the name carries a role', () => {
	// Every base colour in beta is one of alpha's, exactly. Value alone has to
	// carry them onto the shortlist, since the names have nothing in common —
	// but not necessarily to the top of it: beta states no tier, so an exact
	// value match against several candidates is a tie the ranking cannot break,
	// and `evals/counterparts` says being *offered* is what decides the answer.
	for (const [a, b] of [
		['primitive.color.slate.900', 'ink.darkest'],
		['primitive.color.blue.500', 'ink.accent'],
	] as const) {
		const ranked = rank(find(alpha, a), beta.tokens);
		const at = ranked.findIndex((c) => c.token.path === b);
		assert(at >= 0 && at < 4, `${a} ranked ${b} at ${at}, outside the first four`);
		assert(ranked[at]?.value === 1, `${a} did not measure as the same colour as ${b}`);
	}
	// A semantic token whose counterpart is spelled nothing like it still has to
	// reach the shortlist, which is all the ranking owes it.
	const shortlist = rank(find(alpha, 'semantic.text.muted'), beta.tokens).map((c) => c.token.path);
	assert(shortlist.includes('fg.subdued'), `fg.subdued was not shortlisted: ${shortlist.join(', ')}`);
});

await check('a value measures the same however it is spelled', () => {
	const colour = (literal: string): Token => ({ ...find(alpha, 'primitive.color.slate.900'), literal });
	for (const spelled of ['hsl(0, 100%, 50%)', 'hwb(0 0% 0%)', 'rgb(255 0 0)'])
		assert(valueScore(colour(spelled), colour('#ff0000')) === 1, `${spelled} did not measure as #ff0000`);
	assert(valueScore(colour('white'), colour('#ffffff')) === 1, 'white did not measure as #ffffff');
	// A bare number is the `number` row `comparable` admits against a dimension.
	const bare: Token = { ...find(beta, 'step.md'), type: 'number', literal: '16' };
	assert(valueScore(bare, find(beta, 'step.md')) === 1, '16 did not measure as 16px');
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
	// The tokens the cap cut are skipped too, and the JSON says so: a partial map
	// must not read as the whole set.
	const skipped = alpha.tokens.length - 3;
	assert(capped.skipped === skipped, `skipped ${capped.skipped}, expected ${skipped}`);
	assert(mapPayload(capped, [], 'model').skipped === skipped, 'the payload did not carry the skipped count');
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
	// The question itself offers the shortlist and `none`, and nothing else.
	const offered = Object.keys((counterpartQuery().question(job, 0) as { criteria: object }).criteria);
	const expected = [...job.candidates.map((c) => c.path), 'none'];
	assert(offered.join('|') === expected.join('|'), `offered ${offered.join(', ')}`);
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
	for (const m of judged) {
		assert(m.how === 'unsure' && m.to === null, `${m.from} came back ${m.how} → ${m.to}`);
		// The claim is withheld; the answer behind it is not. A row a person has to
		// settle by hand is a different job with a name on it than without one.
		assert(m.leaning?.to === m.considered[0], `${m.from} lost the answer along with the claim`);
	}
});

await check('an unsure row leaning toward no counterpart says which way, and is still unsure', async () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], () => ({ choice: 'none', confidence: FLOOR - 0.01 })),
	);
	const judged = mappings.filter((m) => m.tier === 'semantic');
	assert(judged.length > 0, 'nothing was judged');
	for (const m of judged) {
		// `none` under the floor is not a gap in the target system. Admitting it as
		// one on a reading the floor refused is the collapse the floor exists to stop.
		assert(m.how === 'unsure' && m.to === null, `a none under the floor came back ${m.how}`);
		assert(m.leaning !== undefined && m.leaning.to === null, `${m.from} did not say which way it leaned`);
	}
	assert(countBy(mappings).none === 0, 'an unsure none was counted as a token with no counterpart');
});

await check('an answer that is not one of the options is refused', async () => {
	const plan = planMap(alpha, beta, { tiers: ['semantic'] });
	const { mappings } = await askCounterparts(
		plan,
		'key',
		stub([], () => ({ choice: 'a.path.beta.never.had', confidence: 0.99 })),
	);
	for (const m of mappings.filter((x) => x.tier === 'semantic')) {
		assert(m.how === 'unsure' && m.to === null, `${m.from} took an invented path: ${m.to}`);
		// Not even as a leaning: a path the target set may not have is worse than a
		// blank wherever it appears, and `leaning` is read by people too.
		assert(m.leaning === undefined, `${m.from} leaned toward a path that was never offered`);
	}
});

await check('a confident none is a token with no counterpart, and keeps its runner-up', async () => {
	// Scoped by type rather than tier: `brand.partner-badge` sits in no tier
	// folder and carries no tier word, so its tier is unknown.
	const plan = planMap(alpha, beta, { types: ['color'] });
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
	// per tone where Primer has one, and nine rows land on it.
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
