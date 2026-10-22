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
import { join } from 'node:path';
import type {
	ComponentImport,
	Delivery,
	DeliveryCheck,
	Finding,
	PackageDelivery,
	RuleId,
	TokenDelivery,
} from './types.ts';

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
	const fallbacks = (Array.isArray(raw.fallbacks) ? raw.fallbacks : [])
		.map(readCheck)
		.filter((c): c is DeliveryCheck => c !== null);
	return {
		stylesheet,
		handle: asString(raw.handle),
		prefixes: asStrings(raw.prefixes),
		note: asString(raw.note),
		evidence,
		fallbacks,
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

// ── reachability ────────────────────────────────────────────────────────────

/** The rules whose message names, after its arrow, the component to move to. */
export const REMEDY_RULES: ReadonlySet<RuleId> = new Set<RuleId>([
	'system/raw-element',
	'system/superseded-component',
	'system/locked-component',
]);

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export const packageRoot = (spec: string): string => {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
};

/**
 * The packages a remedy names: every `(pkg` after the message's first arrow,
 * where `pkg` is scoped or one of the design system's own. What comes before
 * the arrow is what the code has now, not what it is asked to write.
 */
export function remedyPackages(message: string, dsPackages: readonly string[]): string[] {
	const arrow = message.indexOf('→');
	if (arrow < 0) return [];
	const named = [...message.slice(arrow).matchAll(/\(\s*([^\s,()]+)/g)].map((m) => String(m[1]));
	return [...new Set(named.filter((p) => (p.startsWith('@') && p.includes('/')) || dsPackages.includes(p)))];
}

/**
 * The project's declared dependencies, or null when that cannot be said: no
 * `package.json`, one that does not parse, or a workspace root whose packages
 * declare their own.
 */
export function projectDependencies(root: string): Set<string> | null {
	try {
		const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
		if (pkg.workspaces) return null;
		const out = new Set<string>();
		for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
			if (isRecord(pkg[field])) for (const name of Object.keys(pkg[field])) out.add(name);
		return out;
	} catch {
		return null;
	}
}

/**
 * What it would cost to adopt `pkg`, or nothing when it costs nothing new.
 *
 *   the project already imports it                → nothing: that cost is paid
 *   the profile says the host provides it          → nothing: an external
 *   the profile says it is bundled                 → bundling required
 *   the profile does not say, and `package.json`
 *   is readable and does not list it               → a new dependency
 *   otherwise                                      → nothing: unknown is not a cost
 */
export function reachNote(
	pkg: string,
	{
		delivery,
		imported,
		dependencies,
	}: { delivery: Delivery | null; imported: ReadonlySet<string>; dependencies: ReadonlySet<string> | null },
): string | null {
	const root = packageRoot(pkg);
	if (imported.has(root)) return null;
	const entry = delivery?.packages.get(pkg) ?? delivery?.packages.get(root);
	if (entry?.provided === 'external') return null;
	// Not the package.json half as well: the agent format spares a note 100
	// characters, and an unimported bundled package is a new dependency either way.
	if (entry?.provided === 'bundled')
		return `bundling required: ${root} is bundled into your build, not provided by ${delivery?.host ?? 'the host'}`;
	return dependencies !== null && !dependencies.has(root) ? `new dependency: ${root} is not in package.json` : null;
}

/**
 * `note` without the `reachNote`s that priced adopting `pkg`, for a remedy
 * withdrawn after `annotateReach` ran. Any other note stays.
 */
export function withoutReach(note: string | undefined, pkg: string): string | undefined {
	if (!note) return note;
	const root = packageRoot(pkg);
	const kept = note
		.split('; ')
		.filter((n) => !n.startsWith(`bundling required: ${root} `) && !n.startsWith(`new dependency: ${root} `));
	return kept.length ? kept.join('; ') : undefined;
}

/**
 * Append the reachability note to every finding whose remedy needs it, in
 * place. `note`, not `message`: the baseline keys on `code`, falling back to
 * `message`, and a note is shipped whole by every format and spared by the one
 * with a line budget.
 */
export function annotateReach(
	findings: Finding[],
	{
		delivery,
		imports,
		dependencies,
		dsPackages,
	}: {
		delivery: Delivery | null;
		imports: readonly ComponentImport[];
		dependencies: ReadonlySet<string> | null;
		dsPackages: readonly string[];
	},
): void {
	const imported = new Set(imports.map((ci) => packageRoot(ci.package)));
	for (const f of findings) {
		if (!REMEDY_RULES.has(f.rule)) continue;
		const notes = remedyPackages(f.message, dsPackages)
			.map((pkg) => reachNote(pkg, { delivery, imported, dependencies }))
			.filter((n): n is string => n !== null);
		if (!notes.length) continue;
		f.note = [f.note, ...notes].filter(Boolean).join('; ');
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
