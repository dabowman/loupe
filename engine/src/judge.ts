/**
 * Opt-in model judgement for `system/raw-element`, behind `check --judge`.
 *
 * `<p> → <Text>` is right about the component and silent about the variant,
 * which is the half an agent has to guess — and on a real plugin it is wrong
 * about the component often enough to matter: a `<span>` that is a colour
 * swatch, a `<p>` that only wraps a button. Neither is decidable from the tag
 * and its classes; both are obvious from reading the element.
 *
 * So one TypeSafe request reads every such element and picks from the
 * variants the profile's component registry declares, plus `not_<name>`. The answer
 * is appended to the message and never changes a verdict: the gate stays
 * deterministic and offline, and this runs only when asked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentEntry, Finding } from './types.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// ponytail: one floor for every outcome. Split it per outcome if an eval shows
// `none` needs more certainty than a variant pick.
const FLOOR = 0.5;
// Each element is a few hundred tokens and the state budget is 32k.
const BATCH = 40;

type Fetch = typeof fetch;

interface Choice {
	choice: string;
	confidence: number;
}

const notKey = (e: ComponentEntry): string => `not_${e.name.toLowerCase()}`;

/** The registry entry with variants that a raw-element finding points at, if any. */
function targetOf(f: Finding, withVariants: readonly ComponentEntry[]): ComponentEntry | undefined {
	if (f.rule !== 'system/raw-element') return undefined;
	const analog = f.message.split('→')[1] ?? '';
	return withVariants.find((e) => new RegExp(`\\b${e.name}\\b`).test(analog));
}

/**
 * Annotate each judgeable finding in place. Returns how many were annotated.
 * Throws on a failed request; the caller reports it and keeps the findings.
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

	const answers: (Choice | undefined)[] = [];
	for (let at = 0; at < jobs.length; at += BATCH) {
		const batch = jobs.slice(at, at + BATCH);
		const elements = batch.map(({ f }) => {
			const lines = readFileSync(join(root, f.file), 'utf8').split('\n');
			const i = f.line - 1;
			return {
				file: f.file,
				// The flagged element opens on the first line of `source`; the lines
				// before it are its parent, which is often what decides the role.
				context_before: lines.slice(Math.max(0, i - 5), i).join('\n'),
				source: lines.slice(i, i + 10).join('\n'),
			};
		});
		const questions = Object.fromEntries(
			batch.map(({ f, target }, i) => [
				`e${i}`,
				{
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
				},
			]),
		);
		const res = await fetchImpl(ENDPOINT, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'jev-latest', state: { elements }, questions }),
		});
		if (!res.ok) throw new Error(`TypeSafe ${res.status}: ${(await res.text()).slice(0, 200)}`);
		const body = (await res.json()) as { answers: Record<string, Choice> };
		batch.forEach((_, i) => answers.push(body.answers[`e${i}`]));
	}

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
