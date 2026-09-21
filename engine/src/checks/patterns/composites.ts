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
 *
 * Logic. First every composite the scanner read, repo-wide, is sorted into a bucket:
 *   it matches a registered pattern — largest match wins, four nodes or more:
 *     the file already imports its `canonical`  → using it, not rebuilding it; skipped
 *     otherwise                                 → bucket it under the pattern id,
 *                                                 keeping the largest per file
 *   else it matches some pattern's `avoid` tree — most specific anti-shape wins:
 *     the file already imports its `canonical`  → deliberate; skipped
 *     otherwise                                 → bucket it under the pattern id,
 *                                                 keeping the smallest per file
 *   else it is substantial — 4+ nodes, 2+ deep — and is not merely the parts of a
 *   component whose anatomy the registry declares:
 *                                               → bucket it under its own signature,
 *                                                 keeping the earliest line per file
 *   else                                        → clean
 *
 * Then each bucket is counted:
 *   a pattern bucket spanning two files or more  → patterns/duplicate-composite, in each
 *   an avoid bucket, at any file count           → patterns/superseded-composite
 *   a detector hit whose registry entry the file
 *   does not already import                      → patterns/superseded-composite
 *   a signature bucket spanning three files
 *   or more                                      → patterns/unregistered-composite, in each
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

	// Largest match wins: a page header contains an action bar.
	const bestMatch = (c: Composite): Pattern | null =>
		registry
			.filter((p) => p.node !== null && p.size >= SUBSTANTIAL.minNodes && matches(p.node, c.tree))
			.sort((a, b) => b.size - a.size)[0] ?? null;

	// The shape a pattern exists to replace — a per-file defect, not a set-level
	// one. Ties go to the most specific anti-shape that matched, not the largest.
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
			// A file importing the shared implementation is using it, not rebuilding it.
			if (hit.canonical && importsByFile.get(c.file)?.has(hit.canonical)) continue;
			const perFile = byPattern.get(hit.id) ?? new Map<string, Composite>();
			byPattern.set(hit.id, perFile);
			const prev = perFile.get(c.file);
			if (!prev || c.size > prev.size) perFile.set(c.file, { ...c, pattern: hit });
			continue;
		}
		const avoided = supEnabled ? avoidMatch(c) : null;
		if (avoided) {
			// Already importing the answer means the anti-shape beside it is deliberate.
			if (avoided.canonical && importsByFile.get(c.file)?.has(avoided.canonical)) continue;
			const perFile = bySuperseded.get(avoided.id) ?? new Map<string, Composite>();
			bySuperseded.set(avoided.id, perFile);
			// Smallest wins, the opposite of `duplicate-composite`.
			const prev = perFile.get(c.file);
			if (!prev || c.size < prev.size) perFile.set(c.file, { ...c, pattern: avoided });
			continue;
		}
		if (!newEnabled || c.size < SUBSTANTIAL.minNodes || c.depth < SUBSTANTIAL.minDepth) continue;
		// Only a tree of nothing *but* a component's own parts: `TableRow(TableCell,
		// TableCell)` is a Table's anatomy cut lower, not a composition anyone chose.
		if (anatomyRoots.some((root) => partsOf(root, c.tree))) continue;
		const perFile = bySignature.get(c.signature) ?? new Map<string, Composite>();
		bySignature.set(c.signature, perFile);
		const prev = perFile.get(c.file);
		if (!prev || c.line < prev.line) perFile.set(c.file, c);
	}

	// Signature first, remedy last in `suffix` — the part the line bound spares.
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

	// Two files or more: one instance is just the first use.
	for (const [id, files] of byPattern) {
		if (files.size < 2) continue;
		for (const c of files.values()) {
			// No canonical recorded: there is nothing to import yet.
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
	// One file is enough — a wrong choice made here, not a duplication across the
	// set. A rule hit is the same finding from below the four-node floor.
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
	// Three files: a third instance means it is the house style, not a one-off.
	for (const [sig, files] of bySignature) {
		if (files.size < 3) continue;
		for (const c of files.values())
			emit('patterns/unregistered-composite', c, sig, ` — assembled in ${files.size} files, registered in none`, sig);
	}
	return out;
}
