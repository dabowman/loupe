/**
 * Each file's contribution to the index, kept between runs.
 *
 * A hook run reports on one file but indexes every one, and three quarters of
 * that was re-parsing files nothing had touched. What a file contributes —
 * its markup scan, the class names a reference file mentions, a stylesheet's
 * rules reduced to the data the checks read — depends on the file's bytes and
 * the config, and on nothing else in the repo. The cross-file part, correlating
 * bindings with rules, is cheap and always runs live.
 *
 * Validity, per file:
 *
 *   - Same mtime and size as when it was read, and that mtime more than two
 *     seconds older than the read: trusted without opening the file. A later
 *     write in the same mtime tick is the only way past this, and a tick that
 *     old had already ended when the file was read.
 *   - Otherwise its bytes are hashed and compared; a match is a hit, and the
 *     entry is restamped so the next run trusts it on `stat` alone.
 *
 * Validity, per cache: the file is named by a fingerprint of the engine's own
 * code and of every config input a scan reads. A different config is a
 * different file, so switching presets does not thrash one; old ones age out.
 *
 * Design notes: docs/design/cli.md#caches
 */

import type { Stats } from 'node:fs';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sha256, writeJsonAtomic } from './cache.ts';
import { EMBEDDED_VERSION } from './embedded.ts';
import { projectStateDir } from './paths.ts';
import type { DeadRule, ScanResult } from './types.ts';

/** A stylesheet's rules, reduced to what the walk reads off each one. */
export interface RuleExtract {
	line: number;
	selectors: string[];
	isGrid: boolean;
	media?: string;
	decls: { prop: string; value: string; line: number }[];
	cut: DeadRule | null;
	/**
	 * No selector names a class, so no markup binds the rule: `h1 { … }`,
	 * `:root { … }`. Read by the token checks alone.
	 */
	unbound?: true;
}

export type SheetExtract =
	| {
			rules: RuleExtract[];
			/** Every custom property the sheet defines, in source order: `[name, value]`. */
			defs: [string, string][];
	  }
	/** `error` is the message, `reason` the parse error's identity: what it is keyed on. Never stored. */
	| { error: string; reason?: string | undefined };

/** A scan with its sets written out as arrays, the form JSON can hold. */
type StoredScan = Omit<ScanResult, 'imports' | 'referenced' | 'stems'> & {
	imports: string[];
	referenced: string[];
	stems: string[];
};

interface Entry {
	/** mtime, ms. */
	m: number;
	/** Size, bytes. */
	s: number;
	/** Content hash. */
	h: string;
	/** When the bytes were read, ms: the racy-mtime guard. */
	t: number;
	/** Whether the file holds a suppression directive, well-formed or not. */
	d: boolean;
	scan?: StoredScan;
	refs?: string[];
	sheet?: SheetExtract;
}

interface IndexFile {
	version: 1;
	entries: Record<string, Entry>;
}

const RACY_MS = 2_000;
// Index files for configs no run has used in this long are deleted on save.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** JSON with sets, maps and patterns spelled out, so a fingerprint sees them. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_k, v: unknown) => {
		if (v instanceof Set) return { $set: [...v].map(String).sort() };
		if (v instanceof Map) return { $map: [...v] };
		if (v instanceof RegExp) return { $re: String(v) };
		return v;
	});
}

/**
 * The engine's own code, as of this run. A version alone is not enough while
 * someone is editing `src/`: the scanner changes and the version does not.
 */
function codeStamp(): string {
	let here: string;
	try {
		here = fileURLToPath(import.meta.url);
	} catch {
		return EMBEDDED_VERSION;
	}
	const stamp = (file: string, st: Stats): string => `${file}:${st.size}:${st.mtimeMs}`;
	try {
		// The bundle is one file; the source is a tree of them.
		if (here.endsWith('.mjs')) return `${EMBEDDED_VERSION}|${stamp(here, statSync(here))}`;
		const dir = dirname(here);
		const parts: string[] = [EMBEDDED_VERSION];
		const walk = (d: string): void => {
			for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p);
				else if (e.name.endsWith('.ts')) parts.push(stamp(p, statSync(p)));
			}
		};
		walk(dir);
		return parts.join('|');
	} catch {
		// A compiled binary's modules live in a virtual filesystem: it is
		// immutable per version, so the version is the whole stamp.
		return EMBEDDED_VERSION;
	}
}

let CODE: string | null = null;

/** One file, as the analysis reads it: its stat, and its bytes once anyone asks. */
export interface Lookup {
	/**
	 * When the lookup began, which is no later than any read of the file this
	 * run makes: what an entry stored from it records as its read time.
	 */
	at: number;
	stat: Stats | null;
	entry: Entry | null;
	/** The bytes, when they had to be read to answer the lookup. */
	text: string | null;
}

export class IndexCache {
	readonly path: string;
	#entries: Map<string, Entry>;
	#seen = new Set<string>();
	#dirty = false;

	constructor(root: string, inputs: unknown) {
		CODE ??= codeStamp();
		const fp = sha256(`${CODE}\n${stableJson(inputs)}`).slice(0, 16);
		this.path = join(projectStateDir(root), `index-${fp}.json`);
		const raw = readJson(this.path) as Partial<IndexFile> | null;
		this.#entries = new Map(raw?.version === 1 && raw.entries ? Object.entries(raw.entries) : []);
	}

	/**
	 * What is known about a file. `entry` is non-null only when it still
	 * describes the file on disk; `text` is non-null whenever the bytes were read
	 * to decide that, so the caller never reads them twice.
	 */
	lookup(abs: string, rel: string): Lookup {
		this.#seen.add(rel);
		const at = Date.now();
		let stat: Stats | null = null;
		try {
			stat = statSync(abs);
		} catch {
			return { at, stat: null, entry: null, text: null };
		}
		const entry = this.#entries.get(rel);
		if (!entry || entry.s !== stat.size) return { at, stat, entry: null, text: null };
		if (entry.m === stat.mtimeMs && entry.m < entry.t - RACY_MS) return { at, stat, entry, text: null };
		let text: string;
		try {
			text = readFileSync(abs, 'utf8');
		} catch {
			return { at, stat, entry: null, text: null };
		}
		if (sha256(text) !== entry.h) return { at, stat, entry: null, text };
		entry.m = stat.mtimeMs;
		entry.t = at;
		this.#dirty = true;
		return { at, stat, entry, text };
	}

	/**
	 * Record what a file contributed, from the bytes just analyzed. Stamped with
	 * the lookup's time, not the time of storing: a scan can finish seconds after
	 * the read, and the racy-mtime guard is measured from the read.
	 */
	store(look: Lookup, rel: string, text: string, data: Pick<Entry, 'd' | 'scan' | 'refs' | 'sheet'>): void {
		if (!look.stat) return;
		this.#entries.set(rel, { m: look.stat.mtimeMs, s: look.stat.size, h: sha256(text), t: look.at, ...data });
		this.#dirty = true;
	}

	/**
	 * Written only when something changed, and pruned to the files this run saw:
	 * a deleted file's entry would otherwise ride along forever.
	 */
	save(): void {
		for (const rel of this.#entries.keys())
			if (!this.#seen.has(rel)) {
				this.#entries.delete(rel);
				this.#dirty = true;
			}
		if (!this.#dirty) return;
		const file: IndexFile = { version: 1, entries: Object.fromEntries(this.#entries) };
		if (writeJsonAtomic(this.path, file)) this.#dirty = false;
		// Index files for other configs, unused for a week.
		try {
			const dir = dirname(this.path);
			const now = Date.now();
			for (const name of readdirSync(dir))
				if (/^index-[0-9a-f]+\.json$/.test(name) && join(dir, name) !== this.path) {
					const p = join(dir, name);
					if (now - statSync(p).mtimeMs > STALE_MS) rmSync(p, { force: true });
				}
		} catch {
			/* pruning is housekeeping */
		}
	}
}

export const storeScan = (scan: ScanResult): StoredScan => {
	// A copy, made before the analysis touches the scan: what is stored is what
	// the scanner produced, never what a later pass did to it.
	const plain = JSON.parse(JSON.stringify({ ...scan, imports: [], referenced: [], stems: [] })) as StoredScan;
	plain.imports = [...scan.imports];
	plain.referenced = [...scan.referenced];
	plain.stems = [...scan.stems];
	return plain;
};

export const loadScan = (stored: StoredScan): ScanResult => ({
	...stored,
	imports: new Set(stored.imports),
	referenced: new Set(stored.referenced),
	stems: new Set(stored.stems),
});
