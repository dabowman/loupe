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
 * `represents` is the second, and it is not wired to a rule. It reads the
 * abstract pattern language's first force — does this control stand for a
 * value, a command or a destination — off real JSX, so the `resolve` tables in
 * `patterns/index.json` have an input. `engine/evals/represents` scores it.
 *
 * An answer is appended to a message and never changes a verdict: the gate
 * stays deterministic and offline, and this runs only when asked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentEntry, Finding } from './types.ts';

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
	// pool below is what keeps it quick.
	represents: 1,
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

// ── system/raw-element: which variant? ──────────────────────────────────────

const notKey = (e: ComponentEntry): string => `not_${e.name.toLowerCase()}`;

/** The registry entry with variants that a raw-element finding points at, if any. */
function targetOf(f: Finding, withVariants: readonly ComponentEntry[]): ComponentEntry | undefined {
	if (f.rule !== 'system/raw-element') return undefined;
	const analog = f.message.split('→')[1] ?? '';
	return withVariants.find((e) => new RegExp(`\\b${e.name}\\b`).test(analog));
}

/**
 * Annotate each judgeable finding in place. Returns how many were annotated.
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
		const c = a.confidence.toFixed(2);
		f.message +=
			a.choice === notKey(target)
				? ` — judged not ${target.name} content (${c}); the analog likely does not apply`
				: ` — judged variant="${a.choice}" (${c})`;
		annotated++;
	});
	return annotated;
}

// ── represents: value, command or destination? ──────────────────────────────

/** The abstract language's first force. `patterns/index.json` resolves on it. */
export type Represents = 'value' | 'command' | 'destination' | 'none';

/** One control to ask about. `source` is the JSX element, opening tag to close. */
export interface Control {
	file: string;
	component: string;
	/** The component function the control sits in, when the parse found a name. */
	enclosing: string | null;
	source: string;
}

/**
 * Wording tracks the force's own definition in `patterns/index.json` — "what an
 * option or control stands for", deciding choose vs act vs navigate — plus one
 * disambiguating line each. Any more and the eval scores a cheat sheet.
 *
 * The no-match option stays `none` here, against the `not_text` lesson above:
 * that judgement's no-match competes with real variants on most elements, so
 * the name had to force a decision. This one is rare and the three real classes
 * separate cleanly — renaming it to `not_a_control` moved nothing but cost two
 * points on the others.
 */
export const REPRESENTS_CRITERIA: Record<Represents, string> = {
	value: 'It picks or sets a value the system already knows about — an option, a setting, a piece of data. Using it changes what some value is, not where the user is. A select, a checkbox-style menu item, a colour swatch, or a disclosure button whose visible label is the value it will change all count.',
	command:
		'It invokes a command that changes something — save, delete, duplicate, upload, undo, retry, close, or opening a dialog or panel to do one of those. Using it does something rather than going somewhere or setting a value.',
	destination:
		'It moves the user to another view, screen, route, record or URL. Using it changes where the user is, however the control happens to be styled — a button that routes is still a destination.',
	none: 'Not an interactive control at all: static text or a display-only element that happens to use a control component.',
};

/**
 * Read `represents` off each control. One answer per control, in order.
 *
 * The state carries the element and where it came from and nothing else: an
 * ablation over 100 labelled controls scored the enclosing component's source
 * exactly level with leaving it out, at 1.5x the tokens, because the slice
 * usually missed the handler it was there to supply.
 */
export async function judgeRepresents(
	controls: readonly Control[],
	apiKey: string,
	fetchImpl: Fetch = fetch,
	size: number = BATCH.represents,
): Promise<(Choice | undefined)[]> {
	return ask(
		controls,
		(c) => ({ file: c.file, component: c.component, enclosing_component: c.enclosing, source: c.source }),
		(_c, i) => ({
			type: 'choice',
			instructions: `\`elements[${i}].source\` is one interactive control taken from a React user interface. What does that control stand for to the person using it?`,
			criteria: REPRESENTS_CRITERIA,
		}),
		apiKey,
		fetchImpl,
		size,
	);
}
