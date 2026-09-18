/**
 * Opt-in model judgement, behind `check --judge`.
 *
 * Two things live here and they are different halves. `ask` is the transport
 * every judgement shares: batch the items, post one request per batch, hand
 * back one answer per item. Everything else is a *question* — what to put in
 * the state and what to ask about it — and stays specific to the thing being
 * judged, because that is the half worth reading and the half an eval scores.
 *
 * `system/raw-element` was the first: `<p> → <Text>` is right about the
 * component and silent about the variant, which is the half an agent has to
 * guess — and on a real plugin it is wrong about the component often enough to
 * matter: a `<span>` that is a colour swatch, a `<p>` that only wraps a button.
 * Neither is decidable from the tag and its classes; both are obvious from
 * reading the element.
 *
 * Forces are the second. The `resolve` tables in `patterns/index.json` decide
 * on things a signature cannot see — does this control stand for a value, a
 * command or a destination — so most of them never ran. A force the vocabulary
 * says how to ask is read off real JSX here, the table runs in code, and a
 * redirect becomes `patterns/judged-redirect`. `engine/evals/represents` scores
 * the one force wired so far.
 *
 * Neither changes a deterministic verdict. The variant answer is written into
 * the finding's suggestion; the redirect is its own advisory finding, written
 * after the baseline and never by the hook. Both record the answer as data on
 * `Finding.judged`. The gate stays deterministic and offline,
 * and this runs only when asked.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRule } from './patterns.ts';
import type { ResolveRule } from './patterns.ts';
import { RULES } from './rules.ts';
import type { ComponentEntry, Control, Finding, Severity } from './types.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// ponytail: one floor for every outcome. Split it per outcome if an eval shows
// `none` needs more certainty than a variant pick.
const FLOOR = 0.5;
// How many elements share one request. Not one number: the state budget allows
// 40, but a question's accuracy does not always survive sharing its state with
// 39 others. `evals/represents/run.ts --batch N` is how these were picked.
// Requests in flight. One per control needs this to stay quick; 6 held for the
// whole eval without a 429, and the endpoint answers a single control in ~200ms.
const CONCURRENCY = 6;
// Overload is transient and a run is a hundred requests, so one 529 should not
// lose the other ninety-nine.
const RETRIES = 4;

const BATCH = {
	// As shipped when this judgement was written.
	variants: 40,
	// Measured, one run over the eval's 100 controls — destination recall is the
	// column that decides it, because every redirect in the abstract language
	// fires on that class:
	//
	//   batch   all   destination P/R
	//      40   81%      91% / 69%
	//      20   90%      96% / 83%
	//      10   90%     100% / 86%
	//       4   91%     100% / 90%
	//       1   93%     100% / 97%
	//
	// Sharing a state with 39 other controls costs nearly a third of the
	// destinations. A control is a few lines, so one request each is cheap; the
	// pool below is what keeps it quick. Every force is asked this way until its
	// own eval says otherwise: this table is `represents`, not forces in general.
	forces: 1,
};

type Fetch = typeof fetch;

export interface Choice {
	choice: string;
	confidence: number;
}

/**
 * Batch, post, align.
 *
 * `state.elements[i]` is the convention both judgements are written against: the
 * question at index `i` talks about `elements[i]`, so instructions can name the
 * thing they are about and the answers come back in the order the items went in.
 * Every element in a batch is visible to every question in it, which is why a
 * batched question has to be scored batched — see the represents eval.
 *
 * Throws on a failed request; the caller reports it and keeps what it had.
 */
async function ask<T>(
	items: readonly T[],
	elementOf: (item: T) => object,
	questionOf: (item: T, index: number) => object,
	apiKey: string,
	fetchImpl: Fetch,
	size: number,
): Promise<(Choice | undefined)[]> {
	const batches: T[][] = [];
	for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));

	const sendBatch = async (batch: readonly T[]): Promise<(Choice | undefined)[]> => {
		const body = JSON.stringify({
			model: 'jev-latest',
			state: { elements: batch.map(elementOf) },
			questions: Object.fromEntries(batch.map((item, i) => [`e${i}`, questionOf(item, i)])),
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
			if (!transient || attempt >= RETRIES) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
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
				done[at] = await sendBatch(batches[at] ?? []);
			}
		}),
	);
	return done.flat();
}

/** How every judged message ends: the certainty behind what it now says. */
const judgedTail = (confidence: number): string => `(judged ${confidence.toFixed(2)})`;

// ── system/raw-element: which variant? ──────────────────────────────────────

const notKey = (e: ComponentEntry): string => `not_${e.name.toLowerCase()}`;

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

	const answers = await ask(
		jobs,
		({ f }) => {
			const lines = readFileSync(join(root, f.file), 'utf8').split('\n');
			const i = f.line - 1;
			return {
				file: f.file,
				// The flagged element opens on the first line of `source`; the lines
				// before it are its parent, which is often what decides the role.
				context_before: lines.slice(Math.max(0, i - 5), i).join('\n'),
				source: lines.slice(i, i + 10).join('\n'),
			};
		},
		({ f, target }, i) => ({
			type: 'choice',
			instructions: `The ${f.code ?? 'element'} on the first line of \`elements[${i}].source\` is flagged to be replaced by the design system's ${target.name} component. Which ${target.name} variant matches the role this element plays in its interface?`,
			// The option name is sent to the model too, so it says what it means:
			// `none` scored the same elements 0.3 lower than `not_text`. Wording
			// that forced a decision ("holds no text of its own") cleared the
			// floor more often and called real text `not_text` doing it.
			criteria: {
				...target.variants,
				[notKey(target)]: `The element is not a run of content ${target.name} renders — a wrapper around controls, an icon holder or colour swatch, a layout box — so no ${target.name} variant applies.`,
			},
		}),
		apiKey,
		fetchImpl,
		BATCH.variants,
	);

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

// ── forces: what the abstract language resolves on ──────────────────────────

/** How a force is asked: its `judge` block in `patterns/index.json`. */
export interface ForceJudge {
	question: string;
	/** One per value of the force, plus the no-match option the question needs. */
	criteria: Record<string, string>;
}

export interface Language {
	vocabulary: { forces: Record<string, { values: unknown[]; about: string; judge?: ForceJudge }> };
	patterns: { id: string; resolve?: ResolveRule[] }[];
}

// The abstract language sits at the checkout's root beside the profiles that
// realize it, and nothing but the judge reads it at runtime: a signature is
// all the deterministic rules can check, and every force is beyond one.
const LANGUAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'patterns', 'index.json');

export const loadLanguage = (path: string = LANGUAGE): Language => JSON.parse(readFileSync(path, 'utf8')) as Language;

/**
 * Read one force off each control. One answer per control, in order.
 *
 * The wording is the force's own, from the vocabulary, so the definition an
 * author reads beside `about` is the one the model is scored on. `represents`
 * was tuned against `evals/represents`: one disambiguating line per value and
 * no more, or the eval scores a cheat sheet; and its no-match stays `none`,
 * against the `not_text` lesson above, because it is rare and the three real
 * classes separate cleanly — `not_a_control` moved nothing and cost two points.
 *
 * The state carries the element and where it came from and nothing else: an
 * ablation over 100 labelled controls scored the enclosing component's source
 * exactly level with leaving it out, at 1.5x the tokens, because the slice
 * usually missed the handler it was there to supply.
 */
export async function judgeForce(
	force: ForceJudge,
	controls: readonly Pick<Control, 'file' | 'component' | 'enclosing' | 'source'>[],
	apiKey: string,
	fetchImpl: Fetch = fetch,
	size: number = BATCH.forces,
): Promise<(Choice | undefined)[]> {
	return ask(
		controls,
		(c) => ({ file: c.file, component: c.component, enclosing_component: c.enclosing, source: c.source }),
		(_c, i) => ({
			type: 'choice',
			instructions: `\`elements[${i}].source\` is one interactive control taken from a React user interface. ${force.question}`,
			criteria: force.criteria,
		}),
		apiKey,
		fetchImpl,
		size,
	);
}

// ── patterns/judged-redirect ────────────────────────────────────────────────

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
	language: Language = loadLanguage(),
): Promise<Finding[]> {
	const byId = new Map(language.patterns.map((p) => [p.id, p]));
	const abstractOf = (patternId: string): string => patternId.split('#', 1)[0]?.split('.', 1)[0] ?? patternId;
	const tableOf = (c: Control): ResolveRule[] => byId.get(abstractOf(c.patternId))?.resolve ?? [];

	const known = controls.map((): Record<string, string> => ({}));
	const sure = controls.map((): Record<string, number> => ({}));
	for (const [name, force] of Object.entries(language.vocabulary.forces)) {
		if (!force.judge) continue;
		const asked = controls.flatMap((c, i) => (tableOf(c).some((r) => r.when && name in r.when) ? [i] : []));
		if (!asked.length) continue;
		const answers = await judgeForce(force.judge, asked.map((i) => controls[i] as Control), apiKey, fetchImpl);
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
