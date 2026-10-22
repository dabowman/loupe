/**
 * Opt-in model judgement, behind `check --judge`.
 *
 * Two halves. Here: `ask`, the transport every judgement shares — batch the
 * items, post one request per batch, hand back one answer per item — and what
 * each check does with the answers. In `judge/`, one file per *question*: what
 * to put in the state and what to ask about it, each carrying a whole example of
 * the request it posts. An eval imports the query it scores and calls `ask` with
 * it, the same call the check makes. A new judgement is a new file there and a
 * caller here.
 *
 *   judge/variant.ts   system/raw-element — which variant of the analog
 *   judge/force.ts     a pattern force, for patterns/judged-redirect
 *   judge/value.ts     a flagged value — which token, or deliberate
 *   judge/token.ts     tokens/unknown-token — which real token was meant
 *
 * None changes a deterministic verdict. A variant or a token is written into the
 * finding's suggestion; a redirect is its own advisory finding, written after
 * the baseline. Each records the answer as data on `Finding.judged`. The
 * verdicts stay deterministic; only the advice they carry is judged.
 *
 * Design notes, and every measurement behind the floors: docs/design/judge.md
 */

import { readFileSync } from 'node:fs';
import type { AnswerCache } from './cache.ts';
import { sha256 } from './cache.ts';
import { renameCandidates } from './checks/tokens/unknown-token.ts';
import { withoutReach } from './delivery.ts';
import { EMBEDDED_LANGUAGE } from './embedded.ts';
import type { ForceJudge } from './judge/force.ts';
import { forceQuery } from './judge/force.ts';
import { NONE, renameQuery } from './judge/token.ts';
import { valueQuery } from './judge/value.ts';
import { around, notKey, variantQuery } from './judge/variant.ts';
import { resolveRule } from './patterns.ts';
import type { ResolveRule } from './patterns.ts';
import { RULES } from './rules.ts';
import { boundMessage, messageLine, messageOf } from './text.ts';
import { DELIBERATE, KEEP, declarationMessage, planValue } from './tokens.ts';
import type { Slot } from './tokens.ts';
import type { ComponentEntry, Control, Finding, Profile, Severity, Suggestion, TokenSet } from './types.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// A version, not `jev-latest`: every floor in here was measured against the
// model the evals ran on. Moving to a new one is re-running `evals/` and
// changing this line in the same commit.
export const MODEL = 'jev-1.13.0';
// ponytail: one floor for every outcome. Split it per outcome if an eval shows
// `none` needs more certainty than a variant pick.
const FLOOR = 0.5;
// Requests in flight. One request per control needs this to stay quick.
const CONCURRENCY = 6;
// Overload is transient and a run is a hundred requests.
const RETRIES = 4;
// The longest a server's `retry-after` is honoured for: a little past the
// longest wait the doubling picks on its own (4s), so a server asking for a
// few seconds gets them. A proxy answering `retry-after: 3600` would otherwise
// hold the whole run, hook included, for an hour.
const RETRY_WAIT_MAX_MS = 5_000;
// The hook runs this inside Claude Code's 60s timeout, and `fetch` has no
// deadline of its own: one socket that never answers is otherwise a killed hook
// on every write. An abort throws, the caller notes it, the run keeps the
// deterministic findings it already has.
// ponytail: per request, so a long full-repo run is still bounded only by its
// item count. Give `ask` a whole-run deadline if that ever needs a ceiling too.
const REQUEST_TIMEOUT_MS = 20_000;

type Fetch = typeof fetch;

// Overridable for tests only, and only to this machine: an endpoint is where the
// key is sent, and a project's own settings can put variables in the hook's
// environment.
const ENDPOINT_OVERRIDE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(process.env.LOUPE_JUDGE_ENDPOINT ?? '')
	? (process.env.LOUPE_JUDGE_ENDPOINT as string)
	: null;

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

/** What a run spent, for the line that says so. */
export interface JudgeStats {
	/** Requests sent. */
	asked: number;
	/** Requests answered from the cache instead. */
	cached: number;
	/** Requests identical to one already in flight this run, which waited for it. */
	shared: number;
}

/**
 * Everything the asks in one run share: the key, the transport, one limit on
 * requests in flight however many passes are asking at once, the answers
 * already paid for, and the tally of what was spent.
 *
 * A bare key string where a client is expected builds a private one with no
 * cache — which is what the evals and the unit tests want: every request real,
 * none remembered.
 */
export interface JudgeClient {
	apiKey: string;
	fetchImpl: Fetch;
	cache: AnswerCache | null;
	/** Runs `fn` once a request slot is free. */
	slot: <R>(fn: () => Promise<R>) => Promise<R>;
	/** Requests in flight by key, so two passes asking the same thing pay once. */
	inflight: Map<string, Promise<(Choice | undefined)[]>>;
	stats: JudgeStats;
}

export type Auth = string | JudgeClient;

/**
 * A slot pool. A released slot is handed straight to the next waiter rather
 * than freed, so nothing arriving in between can take it and run one over.
 */
function limiter(size: number): JudgeClient['slot'] {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async (fn) => {
		if (active < size) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

export function judgeClient(
	apiKey: string,
	{ fetchImpl = fetch, cache = null }: { fetchImpl?: Fetch; cache?: AnswerCache | null } = {},
): JudgeClient {
	return {
		apiKey,
		fetchImpl,
		cache,
		slot: limiter(CONCURRENCY),
		inflight: new Map(),
		stats: { asked: 0, cached: 0, shared: 0 },
	};
}

const clientOf = (auth: Auth, fetchImpl: Fetch): JudgeClient =>
	typeof auth === 'string' ? judgeClient(auth, { fetchImpl }) : auth;

/** `judge: 4 asked, 37 from cache` — or null when nothing was judged at all. */
export function judgeSummary(client: JudgeClient): string | null {
	const { asked, cached, shared } = client.stats;
	if (!asked && !cached && !shared) return null;
	const parts = [`${asked} asked`];
	if (cached) parts.push(`${cached} from cache`);
	if (shared) parts.push(`${shared} shared`);
	return `judge: ${parts.join(', ')}`;
}

/**
 * Batch, post, align.
 *
 * `state.elements[i]` is the convention every query is written against: the
 * question at index `i` talks about `elements[i]`, so instructions can name the
 * thing they are about and the answers come back in the order the items went in.
 * Every element in a batch is visible to every question in it, so a batched
 * question has to be scored batched.
 *
 * `size` is how many items share one request; see docs/design/judge.md for why
 * it is 1. `backoff` is the first retry's wait in ms, doubling after; a test
 * passes 0. Throws on a failed request; the caller reports it and keeps what it
 * had.
 *
 * A request is keyed by its own bytes — model, endpoint, elements and questions
 * — so an answer is reused only for exactly the question it answered. Context
 * lines are part of the element, so an edit near what was asked is a new
 * question; an edit anywhere else is not.
 */
export async function ask<T>(
	query: Query<T>,
	items: readonly T[],
	auth: Auth,
	fetchImpl: Fetch = fetch,
	size = 1,
	backoff = 500,
): Promise<(Choice | undefined)[]> {
	const client = clientOf(auth, fetchImpl);
	const endpoint = ENDPOINT_OVERRIDE ?? ENDPOINT;
	const batches: T[][] = [];
	for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
	// Set when one batch fails: the others stop retrying rather than pay for
	// answers that are about to be thrown away.
	let stopped = false;

	const post = async (body: string, n: number): Promise<(Choice | undefined)[]> => {
		for (let attempt = 0; ; attempt++) {
			if (stopped) throw new Error('stopped: another request failed');
			let res: Response;
			let parsed: { answers: Record<string, Choice> } | undefined;
			try {
				res = await client.fetchImpl(endpoint, {
					method: 'POST',
					headers: { authorization: `Bearer ${client.apiKey}`, 'content-type': 'application/json' },
					body,
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				});
				// Read inside the try: a socket that drops after the headers fails
				// here, and is as transient as one that drops before them.
				if (res.ok) parsed = (await res.json()) as { answers: Record<string, Choice> };
			} catch (err) {
				// An abort is a deadline — the request's own, or the hook's — and a
				// deadline retried is no deadline. Everything else thrown is the
				// connection, as transient as a 503, so the retry budget covers both.
				const name = err instanceof Error ? err.name : '';
				if (name === 'AbortError' || name === 'TimeoutError') throw err;
				if (attempt >= RETRIES) {
					const cause = err instanceof Error && err.cause ? `: ${messageOf(err.cause)}` : '';
					throw new Error(`TypeSafe unreachable: ${messageOf(err)}${cause}`);
				}
				await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
				continue;
			}
			if (parsed) {
				const { answers } = parsed;
				return Array.from({ length: n }, (_, i) => answers[`e${i}`]);
			}
			const transient = res.status === 429 || res.status >= 500;
			if (!transient || attempt >= RETRIES)
				throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
			// The server's own wait when it names one, in seconds and capped; a
			// date or nothing falls back to doubling.
			const after = Number(res.headers.get('retry-after'));
			const wait = after > 0 ? Math.min(after * 1000, RETRY_WAIT_MAX_MS) : backoff * 2 ** attempt;
			await new Promise((r) => setTimeout(r, wait));
		}
	};

	const sendBatch = async (batch: readonly T[]): Promise<(Choice | undefined)[]> => {
		const body = JSON.stringify({
			model: MODEL,
			state: { elements: batch.map(query.element) },
			questions: Object.fromEntries(batch.map((item, i) => [`e${i}`, query.question(item, i)])),
		});
		const key = sha256(`${endpoint}\n${body}`);
		const hit = client.cache?.get(key);
		if (hit && hit.length === batch.length) {
			client.stats.cached++;
			return hit;
		}
		const pending = client.inflight.get(key);
		if (pending) {
			client.stats.shared++;
			return pending;
		}
		const request = client.slot(async () => {
			client.stats.asked++;
			const answers = await post(body, batch.length);
			// Only a whole answer is worth keeping: a gap would be served as one forever.
			if (answers.every((a) => a !== undefined)) client.cache?.set(key, answers as Choice[]);
			return answers;
		});
		client.inflight.set(key, request);
		try {
			return await request;
		} finally {
			client.inflight.delete(key);
		}
	};

	// Bounded pool. Results are written by index, so the answers come back in
	// the order the items went in however the requests interleave. The client's
	// slots bound what is on the wire across every ask sharing it; this bounds
	// how far ahead one ask runs.
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
					stopped = true;
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
	// The analog's own leading name — `<Text …>`, or `Text (…)` where a legacy
	// entry forwards — and nothing after it: the promotion tail names classes,
	// and `.Text-label` on a button is not a Text question.
	const name = /^\s*<?([A-Za-z_$][\w.$]*)/.exec(f.message.split('→')[1] ?? '')?.[1];
	return name ? withVariants.find((e) => e.name === name) : undefined;
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
	auth: Auth,
	fetchImpl: Fetch = fetch,
): Promise<number> {
	const withVariants = [...registry.values()].filter((e) => e.status === 'recommended' && e.variants);
	const jobs = findings.flatMap((f) => {
		const target = targetOf(f, withVariants);
		return target ? [{ f, target }] : [];
	});

	const answers = await ask(variantQuery(root), jobs, auth, fetchImpl);

	let annotated = 0;
	jobs.forEach(({ f, target }, i) => {
		const a = answers[i];
		if (!a || a.confidence < FLOOR) return;
		const arrow = f.message.indexOf(' → ');
		const element = f.message.slice(0, arrow);
		const analog = f.message.slice(arrow + 3);
		// `<Text>`, or `<Text render={ <h4 /> }>` when the mapping keeps the element.
		const tag = new RegExp(`<${target.name.replace(/[.$]/g, '\\$&')}(?=[ >])`);
		const not = a.choice === notKey(target);
		const span = not ? `no analog, not ${target.name} content` : `variant="${a.choice}"`;
		const suggestion = not
			? span
			: /variant="[^"]*"/.test(analog)
				? analog.replace(/variant="[^"]*"/, span)
				: tag.test(analog)
					? analog.replace(tag, `<${target.name} ${span}`)
					: `${analog} with ${span}`;
		const tail = judgedTail(a.confidence);
		// Bounded again, with the judgement kept last: `analyze` bounded this line
		// before the answer was spliced into it.
		f.message = messageLine(`${element} → ${suggestion}`, ` ${tail}`);
		f.judged = { answer: a.choice, confidence: a.confidence, spans: [span, tail] };
		// The reach note priced adopting the analog, which a `not_` answer withdrew.
		if (not) f.note = withoutReach(f.note, target.package);
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
// error. One floor for every force value, on the pick's own confidence; what was
// measured, and what would have to change to lower it, is in
// docs/design/judge.md#the-redirect-floor-is-090.
const REDIRECT_FLOOR = 0.9;

/**
 * What identifies the redirect a control would produce: everything its baseline
 * and hook-delta key is built from. Shared with the hook's pre-edit comparison,
 * which stands a control in for the redirect without paying to ask the judge,
 * so the two cannot drift into keys that never match.
 */
export const redirectIdentity = (
	c: Pick<Control, 'file' | 'component'>,
): { rule: 'patterns/judged-redirect'; file: string; code: string } => ({
	rule: 'patterns/judged-redirect',
	file: c.file,
	code: `<${c.component}>`,
});

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
	auth: Auth,
	severity: Severity,
	fetchImpl: Fetch = fetch,
): Promise<Finding[]> {
	const byId = new Map(LANGUAGE.patterns.map((p) => [p.id, p]));
	const abstractOf = (patternId: string): string => patternId.split('#', 1)[0]?.split('.', 1)[0] ?? patternId;
	const tableOf = (c: Control): ResolveRule[] => byId.get(abstractOf(c.patternId))?.resolve ?? [];

	// One client for every force, so they share its slots rather than each
	// bringing a pool of its own.
	const client = clientOf(auth, fetchImpl);
	const known = controls.map((): Record<string, string> => ({}));
	const sure = controls.map((): Record<string, number> => ({}));
	// Every force at once: each writes only its own name, and the client's slots
	// bound what is on the wire. Settled, not raced: a failed force fails the
	// call, but only once the others have finished, so what they spent lands in
	// the client's tally before anyone reads it.
	const settled = await Promise.allSettled(
		Object.entries(LANGUAGE.vocabulary.forces).map(async ([name, force]) => {
			if (!force.judge) return;
			const asked = controls.flatMap((c, i) => (tableOf(c).some((r) => r.when && name in r.when) ? [i] : []));
			if (!asked.length) return;
			const answers = await ask(
				forceQuery(force.judge),
				asked.map((i) => controls[i] as Control),
				client,
			);
			asked.forEach((ci, k) => {
				const a = answers[k];
				if (!a || a.confidence < REDIRECT_FLOOR) return;
				(known[ci] as Record<string, string>)[name] = a.choice;
				(sure[ci] as Record<string, number>)[name] = a.confidence;
			});
		}),
	);
	for (const r of settled) if (r.status === 'rejected') throw r.reason;

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
		const id = redirectIdentity(c);
		return [
			{
				...id,
				severity,
				rank: RULES[id.rule].rank,
				line: c.line,
				message: `${id.code} ${reading} \u2192 \`${r.redirect}\` ${tail}`,
				note: r.because,
				judged: { answer: when.map(([, v]) => String(v)).join(', '), confidence, spans: [reading, tail] },
			},
		];
	});
}

// ── a flagged value: which token, or is it deliberate? ─────────────────────

/**
 * What each token is for, in the design system's words: every active profile's
 * `tokenDescriptions`, merged. Token names carry their system's prefix, so two
 * profiles cannot collide.
 *
 * Sent as each option's meaning, which is worth 7 points on `evals/values` —
 * see docs/design/judge.md#which-token.
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

/**
 * Rebuild a finding's message and its own `judged` from its declarations.
 *
 * Every settled declaration is rendered by the same `declarationMessage` the
 * token pass used, so a judged finding and an unjudged one read by one set of
 * rules. The channel marker comes off `suffix`, where the walk put it, and the
 * line is bounded again, since the bound in `analyze` ran before this did.
 */
function restate(f: Finding): void {
	const parts = f.suggest ?? [];
	f.message = boundMessage(declarationMessage(parts, f.suffix ?? ''), f.suffix);
	const judged = parts.flatMap((s) => (s.judged ? [s.judged] : []));
	if (!judged.length) return;
	// The least certain answer speaks for the finding: it is the one a floor
	// downstream would stop at.
	f.judged = {
		answer: judged.map((j) => j.answer).join('; '),
		confidence: Math.min(...judged.map((j) => j.confidence)),
		spans: judged.flatMap((j) => j.spans),
	};
}

/**
 * Settle every flagged value a single exact token did not: write the token it
 * should use, or that it stays, onto the declaration. Returns how many
 * declarations were settled.
 *
 * A value is asked about part by part, and settles only when every part does:
 * `padding: 10px 12px` becomes two tokens or nothing, and it is kept only when
 * every part is judged deliberate. Where the set has no token for the property
 * at all there is nothing to ask, and the answer is written without a model.
 * Where the property has a family but the literal is of another kind —
 * `line-height: 1.4` against line heights written in px — there is no question
 * to put, and the declaration is left exactly as the engine wrote it.
 *
 * `judged` carries the replacement value (or {@link KEEP}) so `fix --judge`
 * applies what this wrote, not a second reading of it.
 */
export async function judgeValues(
	root: string,
	findings: readonly Finding[],
	set: TokenSet | undefined,
	auth: Auth,
	about: ReadonlyMap<string, string> = new Map(),
	fetchImpl: Fetch = fetch,
): Promise<number> {
	// An empty set proves nothing about the system: with nothing read, every
	// property's family is empty, and "no padding token in the design system" would
	// be said of every value and suppressed by `fix --judge` as fact. `analyze`
	// hands back no set at all when the design system's sources yielded nothing,
	// so a set the project's own definitions alone filled never reaches here.
	// ponytail: a set read only partly passes this; a per-family check is the
	// upgrade if a token source that half-resolves turns up.
	if (!set?.known.size)
		throw new Error(
			'no design tokens were read, so there is nothing to judge hardcoded values against \u2014 check designSystem.tokenSources against what the package actually ships',
		);
	type Open = { f: Finding; decl: Suggestion; line: number; parts: string[]; slots: Slot[] };
	const open: Open[] = [];
	const touched = new Set<Finding>();
	let written = 0;
	// Every rule that flags a declaration a token could stand in for arrives with
	// one `suggest` entry per declaration, so no list of which rules those are is
	// needed. A type property in a stylesheet is where that rule's first remedy,
	// the text component, is not available.
	for (const f of findings) {
		for (const decl of f.suggest ?? []) {
			// The single exact token is plain `fix`'s already. One held for review —
			// a whole value's or a part's — is outside its declared scope here, or
			// not shown to be inside it, and no answer here is in a position to say.
			if (decl.tokens.length === 1 || decl.review) continue;
			const plan = planValue(set, decl.prop, decl.value);
			if (plan === 'none') {
				decl.judged = { answer: KEEP, confidence: 1, spans: [`no ${decl.prop} token in the design system`] };
				touched.add(f);
				written++;
			} else if (plan) open.push({ f, decl, line: decl.line ?? f.line, ...plan });
		}
	}

	const asked = open.flatMap(({ f, decl, line, parts, slots }) =>
		slots.flatMap((slot) =>
			'candidates' in slot
				? [
						{
							file: f.file,
							// Eight lines before it reach the selector of an ordinary rule, which
							// is most of what says what the value is for. Read around the
							// declaration's own line, which in a collapsed finding is not the
							// line the finding is reported at.
							...around(root, f.file, line, 8, 3),
							prop: decl.prop,
							value: parts.join(' '),
							part: slot.part,
							candidates: slot.candidates,
							slot,
						},
					]
				: [],
		),
	);
	const answers = await ask(valueQuery(about), asked, auth, fetchImpl);
	const answerOf = new Map(asked.map((item, k) => [item.slot, answers[k]]));

	for (const { f, decl, parts, slots } of open) {
		const got = slots.map((s) => ('token' in s ? { choice: s.token, confidence: 1 } : answerOf.get(s)));
		// The shared floor holds here, and spacing the scale covers snaps whatever
		// the confidence — see docs/design/judge.md#which-token.
		const unsure = (k: number): boolean => {
			const a = got[k];
			const s = slots[k];
			return !a || (a.confidence < FLOOR && !(s && 'candidates' in s && !s.candidates.keep));
		};
		if (slots.some((_, k) => unsure(k))) continue;
		const confidence = Math.min(...got.map((a) => a?.confidence ?? 0));
		const kept = got.find((a) => a?.choice === KEEP);
		// A keep beside a part that settled on a token is half an answer: keeping the
		// whole declaration would suppress the part that has a token, and rewriting
		// the rest would exempt the kept literal. Left for review.
		if (kept && got.some((a) => a?.choice !== KEEP)) continue;
		if (kept) {
			const tail = judgedTail(kept.confidence);
			decl.judged = { answer: KEEP, confidence: kept.confidence, spans: [DELIBERATE, tail] };
		} else {
			const out = [...parts];
			const named = [...parts];
			slots.forEach((s, k) => {
				const token = got[k]?.choice ?? '';
				out[s.at] = `var(${token})`;
				named[s.at] = token;
			});
			// Two renderings of one answer, because they have two readers. The message
			// names the tokens the way every other suggestion does; `answer` stays the
			// CSS `fix --judge` writes into the file.
			const to = out.join(' ');
			const shown = named.join(' ');
			// Settled without a question when every part was exact.
			const tail = confidence < 1 ? judgedTail(confidence) : '';
			decl.judged = { answer: to, confidence, spans: tail ? [shown, tail] : [shown] };
		}
		touched.add(f);
		written++;
	}

	// Once, per finding, after every answer it is waiting on has landed.
	for (const f of touched) restate(f);
	return written;
}

// ── tokens/unknown-token: which token was meant? ───────────────────────────

// A rename rewrites every line of the file naming it, and a wrong one paints
// from a token that means something else under a clean report. What was
// measured: docs/design/judge.md#the-rename-floor-is-080.
const RENAME_FLOOR = 0.8;

/**
 * What an unknown name is asked to be chosen among, as `[token, meaning]`: its
 * value where it has a literal one, and what the design system says it is for.
 */
export function renameOptions(
	name: string,
	prop: string,
	set: TokenSet,
	about: ReadonlyMap<string, string> = new Map(),
): [string, string][] {
	const values = new Map([...set.byValue].flatMap(([v, names]) => names.map((n): [string, string] => [n, v])));
	return renameCandidates(name, prop, set.known, set.scopes).map((n) => [
		n,
		[values.get(n), about.get(n)].filter(Boolean).join(' \u2014 ') || n,
	]);
}

/**
 * Settle every unknown token name the check could not: the rename `fix` applies,
 * or that no real token was meant. Returns how many were settled.
 *
 * `<name> → <token> (judged 0.94)` carries a `rename` exactly like one the check
 * settled by spelling, so `fix` and the report treat the two alike.
 */
export async function judgeRenames(
	root: string,
	findings: readonly Finding[],
	set: TokenSet,
	auth: Auth,
	about: ReadonlyMap<string, string> = new Map(),
	fetchImpl: Fetch = fetch,
): Promise<number> {
	const jobs = findings.flatMap((f) => {
		if (f.rule !== 'tokens/unknown-token' || f.rename || !f.unknown || !f.code) return [];
		const { prop, lines } = f.unknown;
		const options = renameOptions(f.code, prop, set, about);
		if (!options.length) return [];
		return [{ f, lines, item: { file: f.file, ...around(root, f.file, f.line, 8, 3), name: f.code, prop, options } }];
	});
	const answers = await ask(
		renameQuery,
		jobs.map((j) => j.item),
		auth,
		fetchImpl,
	);

	let settled = 0;
	jobs.forEach(({ f, lines, item }, i) => {
		const a = answers[i];
		if (!a || a.confidence < RENAME_FLOOR) return;
		const tail = judgedTail(a.confidence);
		const span = a.choice === NONE ? 'no token means this' : a.choice;
		// The unknown name is source text, and nothing bounds this line after here.
		// It is what gives way: the answer is the half a reader acts on.
		f.message = messageLine(item.name, ` \u2192 ${span} ${tail}`);
		f.judged = { answer: a.choice, confidence: a.confidence, spans: [span, tail] };
		if (a.choice !== NONE) f.rename = { from: item.name, to: a.choice, lines };
		settled++;
	});
	return settled;
}
