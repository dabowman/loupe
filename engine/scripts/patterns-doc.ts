#!/usr/bin/env node
/**
 * The reach-for table, generated.
 *
 * A profile's patterns.md used to carry a hand-written table of "about to
 * build → reach for → not this" beside a registry that said the same things
 * in JSON, and the two drifted. The table is what an agent reads before it
 * writes, so it is the half that matters; this makes it a projection of the
 * registry rather than a second copy.
 *
 * It also validates: every realization key must name something the abstract
 * language defines, every `resolve` rule must consult a force its pattern
 * declares with a value the vocabulary lists, and every redirect must land on
 * a real pattern. That is as much of the registration rule as a machine can
 * check — "does this occupy an empty cell" is a judgement, but "does this
 * point at anything" is not.
 *
 *   node scripts/patterns-doc.ts            # rewrite every profile that extends the abstract file
 *   node scripts/patterns-doc.ts --check    # exit 1 if any patterns.md is stale (CI)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForceJudge } from '../src/judge/force.ts';
import type { ResolveRule } from '../src/patterns.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPEN = '<!-- generated:patterns -->';
const CLOSE = '<!-- /generated:patterns -->';

interface Resolve extends ResolveRule {
	and?: string;
}
interface Abstract {
	vocabulary: {
		intents: Record<string, string>;
		scales: Record<string, string>;
		forces: Record<string, { values: unknown[]; about: string; judge?: ForceJudge }>;
		containers?: Record<string, string>;
	};
	patterns: {
		id: string;
		intent: string;
		scale: string;
		problem: string;
		forces: string[];
		parts?: { role: string; note?: string }[];
		resolve: Resolve[];
		variants: Record<string, { summary: string; consequences?: string }>;
	}[];
}
interface Entry {
	pattern: string;
	import?: string;
	canonical?: string | null;
	verify?: boolean;
	detector?: unknown;
	instead_of?: string[];
	note?: string;
	parts?: Record<string, Omit<Entry, 'pattern' | 'parts'>>;
}
interface Realization {
	extends?: string;
	rules?: Record<string, string>;
	containers?: Record<string, { import?: string; canonical?: string; note?: string }>;
	realizations: Entry[];
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const firstSentence = (s: string | undefined): string => (s ?? '').split(/(?<=[.!?])\s/)[0] ?? '';
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Split `id.variant#part.sub` into what the abstract file has to define. */
function keyParts(key: string): { id: string; variant: string | null; part: string | null } {
	const [head, partSpec] = key.split('#', 2) as [string, string | undefined];
	const [id, variant] = head.split('.', 2) as [string, string | undefined];
	const part = partSpec ? (partSpec.split('.', 1)[0] ?? partSpec) : null;
	return { id, variant: variant ?? null, part };
}

function validate(abstract: Abstract, real: Realization): string[] {
	const errors: string[] = [];
	const byId = new Map(abstract.patterns.map((p) => [p.id, p]));
	const { intents, scales, forces } = abstract.vocabulary;
	const resolves = (key: string): boolean => {
		const { id, variant, part } = keyParts(key);
		const p = byId.get(id);
		if (!p) return false;
		if (variant && !p.variants[variant]) return false;
		if (part && !(p.parts ?? []).some((x) => x.role === part)) return false;
		return true;
	};
	// A force `check --judge` asks about has to define every value it can
	// answer with: an option missing from the criteria is one the model cannot
	// pick, and the redirect that needs it never fires.
	for (const [name, f] of Object.entries(forces))
		for (const v of f.judge ? f.values : [])
			if (!f.judge?.criteria[String(v)]) errors.push(`force "${name}": judge gives value "${String(v)}" no criterion`);
	for (const p of abstract.patterns) {
		if (!intents[p.intent]) errors.push(`${p.id}: intent "${p.intent}" is not in the vocabulary`);
		if (!scales[p.scale]) errors.push(`${p.id}: scale "${p.scale}" is not in the vocabulary`);
		for (const f of p.forces) if (!forces[f]) errors.push(`${p.id}: force "${f}" is not in the vocabulary`);
		const rules = p.resolve ?? [];
		rules.forEach((r, i) => {
			const last = i === rules.length - 1;
			if (r.default !== undefined) {
				if (!last) errors.push(`${p.id}: default must be the last resolve rule`);
				if (!p.variants[r.default]) errors.push(`${p.id}: default names unknown variant "${r.default}"`);
				return;
			}
			if (!r.when || !Object.keys(r.when).length) errors.push(`${p.id}: resolve rule ${i} has no when`);
			for (const [f, v] of Object.entries(r.when ?? {})) {
				if (!p.forces.includes(f)) errors.push(`${p.id}: resolve consults force "${f}" the pattern does not declare`);
				else if (!forces[f]?.values.includes(v)) errors.push(`${p.id}: force "${f}" has no value ${JSON.stringify(v)}`);
			}
			if (r.variant && !p.variants[r.variant]) errors.push(`${p.id}: resolve names unknown variant "${r.variant}"`);
			if (r.redirect && !resolves(r.redirect)) errors.push(`${p.id}: redirect to "${r.redirect}" resolves to nothing`);
			if (r.and && !resolves(r.and)) errors.push(`${p.id}: "and" names "${r.and}", which resolves to nothing`);
			if (!r.variant && !r.redirect) errors.push(`${p.id}: resolve rule ${i} neither picks a variant nor redirects`);
		});
		if (!rules.some((r) => r.default !== undefined)) errors.push(`${p.id}: no default resolve rule`);
	}
	const shipped = new Set(Object.keys(real.rules ?? {}));
	const checkDetector = (key: string, detector: unknown): void => {
		for (const d of Array.isArray(detector) ? detector : detector === undefined ? [] : [detector]) {
			if (typeof d === 'string') {
				if (!/^(signature|import|declared|rule:[\w-]+)$/.test(d)) errors.push(`${key}: unknown detector "${d}"`);
			} else if (typeof d === 'object' && d && typeof (d as { rule?: unknown }).rule === 'string') {
				const name = (d as { rule: string }).rule;
				if (!shipped.has(name)) errors.push(`${key}: rule "${name}" is not listed under rules`);
			} else errors.push(`${key}: detector entry is neither a name nor a rule object`);
		}
	};
	for (const e of real.realizations) {
		if (!resolves(e.pattern)) errors.push(`realization "${e.pattern}" names nothing in the abstract language`);
		checkDetector(e.pattern, e.detector);
		for (const [name, part] of Object.entries(e.parts ?? {})) {
			const key = `${e.pattern}#${name}`;
			if (!resolves(key)) errors.push(`realization part "${key}" names no part of ${keyParts(key).id}`);
			checkDetector(key, part.detector);
		}
	}
	return errors;
}

function render(abstract: Abstract, real: Realization, profileId: string): string {
	const byId = new Map(abstract.patterns.map((p) => [p.id, p]));
	const out: string[] = [];
	out.push(
		OPEN,
		'',
		`_Generated from \`patterns/index.json\` and the abstract language by \`engine/scripts/patterns-doc.ts\`. Edit those, then run \`npm run patterns-doc\` in \`engine/\`._`,
		'',
	);

	// 1. Redirects: the wrong-pattern gate.
	out.push(
		'### Before choosing a shape',
		'',
		'Most bad choices are the wrong pattern, not the wrong variant. Each row is a force to settle first.',
		'',
	);
	out.push('| Building | If | Go to | Because |', '| --- | --- | --- | --- |');
	for (const p of abstract.patterns)
		for (const r of p.resolve ?? [])
			if (r.redirect) {
				const cond = Object.entries(r.when ?? {})
					.map(([f, v]) => `${f} = ${String(v)}`)
					.join(', ');
				out.push(`| \`${p.id}\` (${p.intent}) | ${cell(cond)} | \`${r.redirect}\` | ${cell(r.because ?? '')} |`);
			}
	out.push('');

	// 2. Reach for: one row per realization, in registry order.
	out.push('### About to build', '', '| About to build | Reach for | Not this |', '| --- | --- | --- |');
	const row = (
		key: string,
		e: Omit<Entry, 'pattern' | 'parts'>,
		inheritedImport?: string,
		inheritedCanonical?: string | null,
	): void => {
		const { id, variant, part } = keyParts(key);
		const p = byId.get(id);
		if (!p) return;
		// A sub-part (`toolbar.filter`) is the profile's own subdivision, so its
		// own note is the description; an abstract part or variant speaks for
		// itself; the profile's note is the fallback when the abstract is silent.
		const subPart = key.includes('#') && (key.split('#')[1] ?? '').includes('.');
		const about =
			(subPart ? firstSentence(e.note) : '') ||
			(part ? firstSentence((p.parts ?? []).find((x) => x.role === part)?.note) : '') ||
			(variant ? firstSentence(p.variants[variant]?.summary) : '') ||
			firstSentence(e.note) ||
			firstSentence(p.problem);
		const canonical = 'canonical' in e ? e.canonical : inheritedCanonical;
		const pkg = e.import ?? inheritedImport;
		const reach = canonical
			? `\`${key}\` → \`${canonical}\`${pkg ? ` (\`${pkg}\`)` : ''}${e.verify ? ' (unverified)' : ''}`
			: `\`${key}\` — not shipped; extract the project's own`;
		out.push(`| ${cell(about)} | ${cell(reach)} | ${cell((e.instead_of ?? []).join('; '))} |`);
	};
	for (const e of real.realizations) {
		row(e.pattern, e);
		for (const [name, part] of Object.entries(e.parts ?? {})) row(`${e.pattern}#${name}`, part, e.import, e.canonical);
	}
	out.push('');

	// 3. Containers: vocabulary from the abstract file, component from the profile.
	if (real.containers) {
		out.push('### Containers', '', 'A pattern declares where it happens; the profile picks the container.', '');
		out.push('| Container | For | Here |', '| --- | --- | --- |');
		for (const [name, c] of Object.entries(real.containers)) {
			const when = abstract.vocabulary.containers?.[name] ?? '';
			const what = c.canonical ? `\`${c.canonical}\`${c.import ? ` (\`${c.import}\`)` : ''}` : '';
			out.push(`| ${name} | ${cell(when)} | ${cell(`${what}${c.note ? ` — ${c.note}` : ''}`)} |`);
		}
		out.push('');
	}

	// 4. What the engine checks below the four-node floor, and what is only specified.
	const rules = Object.entries(real.rules ?? {});
	if (rules.length) {
		const shipped = rules.filter(([, d]) => /^Shipped\b/.test(d)).map(([n]) => `\`${n}\``);
		const spec = rules.filter(([, d]) => !/^Shipped\b/.test(d)).map(([n]) => `\`${n}\``);
		out.push('### Checked by rule', '');
		if (shipped.length) out.push(`Below the four-node floor the engine runs ${shipped.join(', ')}.`);
		if (spec.length) out.push(`Specified but not shipped: ${spec.join(', ')}.`);
		out.push('');
	}

	// 5. Gaps, so an agent knows when it is off the map.
	const realized = new Set<string>();
	for (const e of real.realizations) realized.add(e.pattern);
	const missing: string[] = [];
	for (const p of abstract.patterns)
		for (const v of Object.keys(p.variants))
			if (!realized.has(`${p.id}.${v}`) && !realized.has(p.id)) missing.push(`\`${p.id}.${v}\``);
	if (missing.length)
		out.push(
			`No ${profileId} realization yet: ${missing.join(', ')}. Building one of these is registering one, not inventing a pattern.`,
			'',
		);
	out.push(CLOSE);
	return out.join('\n');
}

function main(): void {
	const check = process.argv.includes('--check');
	const profilesDir = join(ROOT, 'profiles');
	let failed = false;
	for (const id of readdirSync(profilesDir)) {
		const regPath = join(profilesDir, id, 'patterns', 'index.json');
		if (!existsSync(regPath)) continue;
		const real = readJson<Realization>(regPath);
		if (!real.extends) continue; // a v1 registry has no abstract layer to project
		const abstract = readJson<Abstract>(resolve(dirname(regPath), real.extends));
		const errors = validate(abstract, real);
		if (errors.length) {
			failed = true;
			console.error(`${id}: ${errors.length} registry error(s)`);
			for (const e of errors) console.error(`  ${e}`);
			continue;
		}
		const docPath = join(profilesDir, id, 'patterns.md');
		const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
		const open = doc.indexOf(OPEN);
		const close = doc.indexOf(CLOSE);
		if (open === -1 || close === -1 || close < open) {
			failed = true;
			console.error(`${id}: patterns.md needs ${OPEN} … ${CLOSE} markers to receive the table`);
			continue;
		}
		const next = doc.slice(0, open) + render(abstract, real, id) + doc.slice(close + CLOSE.length);
		if (next === doc) {
			console.log(`${id}: patterns.md is current`);
		} else if (check) {
			failed = true;
			console.error(`${id}: patterns.md is stale — run npm run patterns-doc in engine/`);
		} else {
			writeFileSync(docPath, next);
			console.log(`${id}: patterns.md rewritten`);
		}
	}
	process.exit(failed ? 1 : 0);
}

main();
