/**
 * Reading what JSON happened to hold.
 *
 * Every file the engine reads that it did not write — a config, a profile, a
 * registry, a delivery block, a token set, a settings file — arrives as
 * `unknown`, and each reader used to carry its own "is this a plain object",
 * "is this a usable string" and "parse this file or give up". Those are the
 * same three questions everywhere, so they are answered here once, and a
 * reader that coerces differently from the rest is a reader that imported
 * something else.
 *
 * Nothing here coerces: a value that is not what was asked for is dropped
 * (`undefined`, `[]`, `null`), never guessed at. Whether dropping is right or
 * a refusal is owed is the caller's call — see
 * docs/design/cli.md#coercion-throws-because-the-silent-reading-is-worse.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureDir } from './paths.ts';

/** A plain object: not null, not an array. What a JSON block is when it is one. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** A field that has to be a usable string, or nothing. Nothing else is coerced. */
export const asString = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The usable strings of a list, or none where it is not a list. */
export const asStrings = (v: unknown): string[] =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/** One thing, or a list of them, as a list: `extends: "wpds"` and `extends: ["wpds"]` say the same. */
export const listOf = <T>(v: T | readonly T[] | undefined | null): T[] =>
	v === undefined || v === null ? [] : Array.isArray(v) ? [...(v as readonly T[])] : [v as T];

/** A JSON file, or null when it is missing or unreadable — a cold cache, an absent setting, either way. */
export function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Whole-file and atomic — written beside, then renamed over — so two processes
 * racing each other leave one complete file, never a torn one. False when the
 * directory is not writable.
 */
export function writeJsonAtomic(path: string, data: unknown): boolean {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		if (!ensureDir(dirname(path))) return false;
		writeFileSync(tmp, JSON.stringify(data));
		renameSync(tmp, path);
		return true;
	} catch {
		rmSync(tmp, { force: true });
		return false;
	}
}
