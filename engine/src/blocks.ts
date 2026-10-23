/**
 * The project's own WordPress blocks, read off the `block.json` each one ships.
 *
 * WordPress renders a block's wrapper with a class built from its name:
 * `wp-block-`, then the name with `/` as `-` and a leading `core-` dropped
 * (`acme/card` → `.wp-block-acme-card`, `core/group` → `.wp-block-group`). A
 * block plugin's stylesheet styles that class under `wp-block-`, which the
 * WordPress presets list as external, and no source file spells it. So a class
 * under the prefix of the block's namespace (`wp-block-acme-`) is never a
 * library internal, and the wrapper class itself is never dead. A `core/` block
 * is WordPress's, and stays external.
 *
 * Read from the files the walk already lists as references — the WordPress
 * presets name `**\/block.json` there — so no second walk finds them.
 *
 * Design notes: docs/design/checks.md#a-blocks-own-wrapper-is-not-a-library-internal
 */

import { readFileSync } from 'node:fs';
import { byBytes } from './discover.ts';
import type { DiscoveredFile } from './types.ts';

/** A block's name as `block.json`'s schema requires it: `namespace/name`. */
const BLOCK_NAME = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Is this discovered file a block manifest? */
export const isBlockManifest = (rel: string): boolean => rel === 'block.json' || rel.endsWith('/block.json');

/** The block a manifest names, or null when it is not JSON or names no valid block. */
export function blockName(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const name = (parsed as { name?: unknown } | null)?.name;
	return typeof name === 'string' && BLOCK_NAME.test(name) ? name : null;
}

/**
 * The wrapper class WordPress renders on a block (`acme/card` → `wp-block-acme-card`)
 * and its namespace's prefix (`wp-block-acme-`); null for a `core/` block, whose
 * class carries no namespace, and for a name that is not a block's.
 */
export function blockClasses(name: string): { wrapper: string; prefix: string } | null {
	if (!BLOCK_NAME.test(name)) return null;
	const wrapper = `wp-block-${name.replace('/', '-').replace(/^core-/, '')}`;
	const prefix = wrapper.slice(0, wrapper.length - (name.length - name.indexOf('/') - 1));
	return prefix === 'wp-block-' ? null : { wrapper, prefix };
}

/** One wrapper prefix the project owns, and the blocks that gave it. */
export interface BlockPrefix {
	prefix: string;
	blocks: string[];
}

/** Block names grouped by the prefix each gives, both in byte order. Core blocks give none. */
export function blockPrefixes(names: Iterable<string>): BlockPrefix[] {
	const by = new Map<string, Set<string>>();
	for (const name of names) {
		const prefix = blockClasses(name)?.prefix;
		if (prefix) by.set(prefix, (by.get(prefix) ?? new Set<string>()).add(name));
	}
	return [...by]
		.sort(([a], [b]) => byBytes(a, b))
		.map(([prefix, blocks]) => ({ prefix, blocks: [...blocks].sort(byBytes) }));
}

/** Every block the manifests among these files name. An unreadable one names none. */
export function blocksIn(files: readonly DiscoveredFile[]): string[] {
	const out: string[] = [];
	for (const { abs, rel } of files) {
		if (!isBlockManifest(rel)) continue;
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			continue;
		}
		const name = blockName(text);
		if (name) out.push(name);
	}
	return out;
}

/** `wp-block-acme- (block.json: acme/card, acme/hero)`, for `status` and `detect`. */
export const describeBlocks = (list: readonly BlockPrefix[]): string =>
	list
		.map(({ prefix, blocks }) => {
			const shown = blocks.slice(0, 3).join(', ');
			const more = blocks.length > 3 ? `, +${blocks.length - 3} more` : '';
			return `${prefix} (block.json: ${shown}${more})`;
		})
		.join('; ');
