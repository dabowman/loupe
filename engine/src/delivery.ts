/**
 * Delivery: whether what a finding recommends can actually reach the page.
 *
 * A remedy that names `Stack (@wordpress/ui)` is a different proposal in a
 * project that already bundles `@wordpress/ui` than in one that has never
 * imported it, and `var(--wpds-*)` is a different proposal on a page that loads
 * the token stylesheet than on one that does not — there it resolves to nothing
 * and the declaration drops. Both are facts about how a design system ships,
 * not about the engine, so a profile declares them:
 *
 *   profiles/wpds/profile.json   { …, "delivery": "./delivery.json" }
 *   profiles/wpds/delivery.json  { host, packages: { pkg: { provided, handle } }, tokens: { … } }
 *
 * Read here into a `Delivery`, and consumed twice: `annotateReach` annotates the
 * findings whose remedy names a package the project cannot reach for free, and
 * `checks/tokens/undelivered.ts` runs the token block's evidence.
 *
 * Validation is per field, like the registries: an entry that does not say
 * what it means is dropped, never guessed at, and a block with nothing usable
 * left in it is no block.
 *
 * Design notes: docs/design/checks.md#delivery
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Delivery, DeliveryCheck, PackageDelivery, TokenDelivery } from './types.ts';

const asStrings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
const asString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readPackages(raw: unknown): Map<string, PackageDelivery> {
	const out = new Map<string, PackageDelivery>();
	if (!isRecord(raw)) return out;
	for (const [pkg, entry] of Object.entries(raw)) {
		if (!isRecord(entry)) continue;
		const provided = entry.provided;
		if (provided !== 'external' && provided !== 'bundled') continue;
		out.set(pkg, { provided, handle: asString(entry.handle), note: asString(entry.note) });
	}
	return out;
}

/** A check as authored → as run, or null when it does not say enough to run. */
function readCheck(raw: unknown): DeliveryCheck | null {
	if (!isRecord(raw)) return null;
	const files = asStrings(raw.files);
	const note = asString(raw.note);
	if (!files.length) return null;
	switch (raw.kind) {
		case 'enqueue-dependency': {
			const calls = asStrings(raw.calls).filter((c) => /^[A-Za-z_]\w*$/.test(c));
			const handles = asStrings(raw.handles);
			const argument = typeof raw.argument === 'number' && Number.isInteger(raw.argument) ? raw.argument : 2;
			if (!calls.length || !handles.length || argument < 0) return null;
			const enqueues = asStrings(raw.enqueues).filter((c) => calls.includes(c));
			return { kind: 'enqueue-dependency', files, calls, handles, enqueues, argument, note };
		}
		case 'import': {
			const specifiers = asStrings(raw.specifiers);
			return specifiers.length ? { kind: 'import', files, specifiers, note } : null;
		}
		case 'pattern': {
			const source = asString(raw.pattern);
			if (!source) return null;
			try {
				return { kind: 'pattern', files, pattern: new RegExp(source), note };
			} catch {
				return null;
			}
		}
		default:
			return null;
	}
}

function readTokens(raw: unknown): TokenDelivery | null {
	if (!isRecord(raw)) return null;
	const stylesheet = asString(raw.stylesheet);
	const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
		.map(readCheck)
		.filter((c): c is DeliveryCheck => c !== null);
	// Without a check there is nothing to run, and nothing to run never reports.
	if (!stylesheet || !evidence.length) return null;
	return {
		stylesheet,
		handle: asString(raw.handle),
		prefixes: asStrings(raw.prefixes),
		note: asString(raw.note),
		evidence,
	};
}

/** A parsed delivery block → a `Delivery`, or null when nothing in it is usable. */
export function loadDelivery(raw: unknown): Delivery | null {
	if (!isRecord(raw)) return null;
	const packages = readPackages(raw.packages);
	const tokens = readTokens(raw.tokens);
	if (!packages.size && !tokens) return null;
	return { host: asString(raw.host) ?? 'the host', packages, tokens };
}

/** Read and validate a delivery file. Unreadable is the same as absent. */
export function readDelivery(path: string | null): Delivery | null {
	if (!path || !existsSync(path)) return null;
	try {
		return loadDelivery(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return null;
	}
}

/** Every active profile's block, the first to describe a package winning. */
export function mergeDeliveries(deliveries: readonly (Delivery | null | undefined)[]): Delivery | null {
	const present = deliveries.filter((d): d is Delivery => Boolean(d));
	const [head] = present;
	if (!head) return null;
	const packages = new Map<string, PackageDelivery>();
	for (const d of present) for (const [pkg, entry] of d.packages) if (!packages.has(pkg)) packages.set(pkg, entry);
	return { host: head.host, packages, tokens: present.find((d) => d.tokens)?.tokens ?? null };
}

/** One line for `loupe status`: what ships how. */
export function deliverySummary(d: Delivery): string {
	const by = (kind: PackageDelivery['provided']): string[] =>
		[...d.packages].filter(([, e]) => e.provided === kind).map(([pkg, e]) => (e.handle ? `${pkg} (${e.handle})` : pkg));
	const bundled = by('bundled');
	const external = by('external');
	return [
		d.tokens ? `tokens from ${d.tokens.stylesheet}${d.tokens.handle ? ` (handle ${d.tokens.handle})` : ''}` : '',
		external.length ? `provided by ${d.host}: ${external.join(', ')}` : '',
		bundled.length ? `bundled into your build: ${bundled.join(', ')}` : '',
	]
		.filter(Boolean)
		.join('; ');
}
