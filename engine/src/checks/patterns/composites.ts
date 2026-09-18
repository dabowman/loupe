/**
 * The pattern registry's composite rules:
 *
 *   patterns/duplicate-composite     a registered pattern rebuilt in two files or more
 *   patterns/superseded-composite    a shape a registered pattern exists to replace,
 *                                    by its `avoid` tree or by a detector hit
 *   patterns/unregistered-composite  one unregistered shape assembled in three files
 *
 * The only findings that cannot exist in one file. A sixth bespoke page header
 * is not a defect anywhere in particular — it is a defect in the set, so the
 * index is whole-repo even when the report is scoped to one file.
 */

import type { Candidate } from '../../analyze.ts';
import { SUBSTANTIAL, matches, nodeCount, partsOf } from '../../patterns.ts';
import type { Composite, Pattern, RuleHit, RuleId } from '../../types.ts';

export function composites({
	found,
	hits,
	registry,
	importsByFile,
	enabled,
}: {
	/** Every design-system composite the scanner read, repo-wide. */
	found: readonly Composite[];
	/** Where a registry detector matched: the same finding from below the four-node floor. */
	hits: readonly (RuleHit & { file: string })[];
	registry: readonly Pattern[];
	/** Every local name each file imports. */
	importsByFile: ReadonlyMap<string, ReadonlySet<string>>;
	enabled: (rule: RuleId) => boolean;
}): Candidate[] {
	const dupEnabled = enabled('patterns/duplicate-composite');
	const newEnabled = enabled('patterns/unregistered-composite');
	const supEnabled = enabled('patterns/superseded-composite');
	if (!(dupEnabled || newEnabled || supEnabled) || !(found.length || hits.length)) return [];
	const out: Candidate[] = [];

	// Components whose anatomy the registry declares: an entry whose
	// `canonical` is the root of its own signature.
	const anatomyRoots = registry.flatMap((p) =>
		p.node && p.canonical && p.canonical === p.node.name.split('.')[0] ? [p.canonical] : [],
	);

	// Largest match wins: a page header contains an action bar, and reporting
	// both says the same thing twice at two levels of the same tree.
	const bestMatch = (c: Composite): Pattern | null =>
		registry
			.filter((p) => p.node !== null && p.size >= SUBSTANTIAL.minNodes && matches(p.node, c.tree))
			.sort((a, b) => b.size - a.size)[0] ?? null;

	// The shape a pattern exists to replace. Unlike the two rules below this
	// one, it is a per-file defect and not a set-level one: the file in hand
	// built the clunky version, and that is already worth saying once.
	//
	// Ties go to the most specific anti-shape that matched, not to the largest
	// replacement: a pattern's own `size` says nothing about how well its
	// anti-shape fit, and ranking by it means the smallest entry in the
	// registry can never win a tie it deserves.
	const avoidMatch = (c: Composite): Pattern | null => {
		let best: { pattern: Pattern; fit: number } | null = null;
		for (const p of registry) {
			let fit = 0;
			for (const a of p.avoid) if (matches(a, c.tree)) fit = Math.max(fit, nodeCount(a));
			if (fit && (!best || fit > best.fit)) best = { pattern: p, fit };
		}
		return best?.pattern ?? null;
	};

	const byPattern = new Map<string, Map<string, Composite>>(); // pattern id -> file -> best instance
	const bySuperseded = new Map<string, Map<string, Composite>>(); // pattern id -> file -> first instance
	const bySignature = new Map<string, Map<string, Composite>>(); // signature -> file -> best instance
	for (const c of found) {
		const hit = dupEnabled ? bestMatch(c) : null;
		if (hit) {
			// A file that already imports the shared implementation is using the
			// pattern, not rebuilding it.
			if (hit.canonical && importsByFile.get(c.file)?.has(hit.canonical)) continue;
			const perFile = byPattern.get(hit.id) ?? new Map<string, Composite>();
			byPattern.set(hit.id, perFile);
			const prev = perFile.get(c.file);
			if (!prev || c.size > prev.size) perFile.set(c.file, { ...c, pattern: hit });
			continue;
		}
		const avoided = supEnabled ? avoidMatch(c) : null;
		if (avoided) {
			// Already importing the answer means the anti-shape sitting beside it
			// is deliberate, not a rebuild waiting to happen.
			if (avoided.canonical && importsByFile.get(c.file)?.has(avoided.canonical)) continue;
			const perFile = bySuperseded.get(avoided.id) ?? new Map<string, Composite>();
			bySuperseded.set(avoided.id, perFile);
			// Smallest wins, the opposite of `duplicate-composite`. Containment
			// means an outer wrapper matches whatever its children match, and
			// the whole form's tree is a worse answer to "where" than the one
			// field that should have been a Field.
			const prev = perFile.get(c.file);
			if (!prev || c.size < prev.size) perFile.set(c.file, { ...c, pattern: avoided });
			continue;
		}
		if (!newEnabled || c.size < SUBSTANTIAL.minNodes || c.depth < SUBSTANTIAL.minDepth) continue;
		// An anatomy entry matches from the component's root down, but a file
		// that renders only a row or a popup cuts the same anatomy lower —
		// `TableRow(TableCell,TableCell,TableCell)` is a Table's parts, not a
		// composition anyone chose. Only a tree of nothing *but* parts: a
		// `DialogPopup` holding a form is still the form.
		if (anatomyRoots.some((root) => partsOf(root, c.tree))) continue;
		const perFile = bySignature.get(c.signature) ?? new Map<string, Composite>();
		bySignature.set(c.signature, perFile);
		const prev = perFile.get(c.file);
		if (!prev || c.line < prev.line) perFile.set(c.file, c);
	}

	// These rules lead with a signature and close with the remedy, and a
	// signature is as big as the tree it describes — a five-column card runs
	// past the line bound on its own. The remedy goes in `suffix`, which that
	// bound is built to spare: eliding the shape still names the file count
	// and what to do about it, where eliding the end left neither.
	const emit = (
		rule: RuleId,
		c: Pick<Composite, 'file' | 'line' | 'signature'>,
		signature: string,
		tail: string,
		group: string,
	): void => {
		out.push({
			rule,
			file: c.file,
			line: c.line,
			message: `${signature}${tail}`,
			suffix: tail,
			code: c.signature,
			group,
		});
	};

	// Two files is already a pattern being rebuilt; one is just the first use.
	for (const [id, files] of byPattern) {
		if (files.size < 2) continue;
		for (const c of files.values()) {
			// With no canonical implementation recorded there is nothing to import
			// yet, and telling an agent to import it would send it looking for a
			// module that does not exist.
			const remedy = c.pattern?.canonical ? `import \`${c.pattern.canonical}\`` : 'extract one shared implementation';
			emit(
				'patterns/duplicate-composite',
				c,
				c.signature,
				` — rebuilds \`${id}\`, also in ${files.size - 1} other file(s); ${remedy}`,
				id,
			);
		}
	}
	// One file is enough: this is a wrong choice made here, not a duplication
	// that only exists across the set.
	// A rule hit is the same finding from below the floor: the file in hand
	// made the choice the entry exists to replace. The canonical import means
	// the choice was deliberate, exactly as it does for a matched anti-shape.
	if (supEnabled)
		for (const h of hits) {
			const entry = registry.find((p) => p.id === h.patternId);
			if (!entry) continue;
			if (entry.canonical && importsByFile.get(h.file)?.has(entry.canonical)) continue;
			const remedy = entry.canonical ? `use \`${entry.canonical}\`` : `follow the \`${entry.id}\` pattern`;
			emit(
				'patterns/superseded-composite',
				{ file: h.file, line: h.line, signature: `rule:${h.rule}:${h.detail}` },
				h.detail,
				` — \`${entry.id}\` covers this; ${remedy}`,
				entry.id,
			);
		}
	for (const [id, files] of bySuperseded) {
		for (const c of files.values()) {
			const remedy = c.pattern?.canonical ? `use \`${c.pattern.canonical}\`` : `follow the \`${id}\` pattern`;
			emit('patterns/superseded-composite', c, c.signature, ` — \`${id}\` covers this; ${remedy}`, id);
		}
	}
	// Three for an unregistered shape: nothing says the second one was wrong,
	// but a third means it is the house style and belongs in the registry.
	for (const [sig, files] of bySignature) {
		if (files.size < 3) continue;
		for (const c of files.values())
			emit('patterns/unregistered-composite', c, sig, ` — assembled in ${files.size} files, registered in none`, sig);
	}
	return out;
}
