/**
 * What a run can reuse from the last one. Two stores, one discipline.
 *
 * - {@link AnswerCache}: answers already paid for, keyed by the exact request
 *   that bought them. The request names the model, so a model bump is a miss
 *   rather than a stale answer.
 * - The index cache (`index-cache.ts`): each file's scan, keyed by its content.
 *
 * Both live in the project's state directory (`paths.ts`), never in the repo,
 * and both are optimisations only: a missing, corrupt or unwritable cache file
 * costs time and changes no answer. Writes go through `writeJsonAtomic`
 * (`json.ts`), so two hook processes racing each other leave one complete
 * file, never a torn one.
 *
 * Design notes: docs/design/cli.md#caches
 */

import { readJson, writeJsonAtomic } from './json.ts';

/** One answer as Jev returned it; the shape `judge.ts` reads. */
interface StoredChoice {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

interface AnswerEntry {
	/** The answers, one per item in the request. */
	a: StoredChoice[];
	/** When it was bought, for ageing out. */
	t: number;
}

interface AnswerFile {
	version: 1;
	entries: Record<string, AnswerEntry>;
}

// Long enough that a backlog worked over a week is never re-asked; short enough
// that a pinned model's answers do not outlive the floors measured against it by
// much. A model bump invalidates on its own, through the key.
const ANSWER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// A request is a few kB; this bounds the file at a few MB, oldest dropped first.
const ANSWER_MAX_ENTRIES = 20_000;

/**
 * Answers already paid for.
 *
 * Read once, on first use, and written once, by {@link save} — merged with
 * whatever another process wrote in between, so a `Stop` that runs while a
 * `PostToolUse` is still saving loses neither's answers.
 */
export class AnswerCache {
	readonly path: string;
	#entries: Map<string, AnswerEntry> | null = null;
	#added = new Map<string, AnswerEntry>();

	constructor(path: string) {
		this.path = path;
	}

	#load(): Map<string, AnswerEntry> {
		if (this.#entries) return this.#entries;
		this.#entries = AnswerCache.#read(this.path);
		return this.#entries;
	}

	static #read(path: string): Map<string, AnswerEntry> {
		const raw = readJson(path) as Partial<AnswerFile> | null;
		const out = new Map<string, AnswerEntry>();
		if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== 'object') return out;
		const now = Date.now();
		for (const [key, entry] of Object.entries(raw.entries))
			if (Array.isArray(entry?.a) && typeof entry.t === 'number' && now - entry.t < ANSWER_MAX_AGE_MS)
				out.set(key, entry);
		return out;
	}

	get(key: string): StoredChoice[] | undefined {
		return this.#load().get(key)?.a;
	}

	set(key: string, answers: StoredChoice[]): void {
		const entry = { a: answers, t: Date.now() };
		this.#load().set(key, entry);
		this.#added.set(key, entry);
	}

	/** How many answers this run bought; nothing to write when it is zero. */
	get added(): number {
		return this.#added.size;
	}

	save(): void {
		if (!this.#added.size) return;
		const merged = AnswerCache.#read(this.path);
		for (const [k, v] of this.#added) merged.set(k, v);
		const kept = [...merged].sort((x, y) => y[1].t - x[1].t).slice(0, ANSWER_MAX_ENTRIES);
		const file: AnswerFile = { version: 1, entries: Object.fromEntries(kept) };
		if (writeJsonAtomic(this.path, file)) this.#added.clear();
	}
}
