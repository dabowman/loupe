/**
 * The data files the engine ships, compiled into it.
 *
 * `dist/loupe.mjs` can reach its presets on disk: it sits one directory below
 * them, and `bin/loupe.mjs` keeps `dist/` at the same depth as `src/` precisely
 * so the `import.meta.url` arithmetic lands in the same place from either entry.
 * A single-file binary has no such directory. `import.meta.url` inside one
 * resolves to a synthetic root, so every `join(HERE, '..', 'presets')` becomes
 * `/presets`, and the engine comes up unable to name a single design system.
 *
 * So the data is imported rather than read, which puts a copy inside whatever
 * artifact the bundler produces — `dist/`, or a compiled binary.
 *
 * Disk still wins wherever it exists. `presets/` remains a published directory
 * of files you can read, copy and extend, and an install that has them reads
 * them; this is the floor under that, not a replacement for it. The two halves
 * cannot disagree: the import and the disk read name the same file, so there is
 * one source and two ways of reaching it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import archer from '../presets/archer.json' with { type: 'json' };
import baseUi from '../presets/base-ui.json' with { type: 'json' };
import generic from '../presets/generic.json' with { type: 'json' };
import wordpressBlockTheme from '../presets/wordpress-block-theme.json' with { type: 'json' };
import wordpressComponents from '../presets/wordpress-components.json' with { type: 'json' };
import wpds from '../presets/wpds.json' with { type: 'json' };
import patternLanguage from '../../patterns/index.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };

/** Preset name -> its parsed JSON, keyed as the files are named. */
export const EMBEDDED_PRESETS: Readonly<Record<string, unknown>> = {
	archer,
	'base-ui': baseUi,
	generic,
	'wordpress-block-theme': wordpressBlockTheme,
	'wordpress-components': wordpressComponents,
	wpds,
};

/** The version, for the artifact that cannot read its own manifest off disk. */
export const EMBEDDED_VERSION: string = manifest.version;

/** The pattern language `--judge` reads, which lives outside the package. */
export const EMBEDDED_LANGUAGE: unknown = patternLanguage;

/** Strip the `loupe/presets/` prefix a config may spell a preset with. */
export const presetKey = (spec: string): string => spec.replace(/^loupe\/presets\//, '');

/**
 * Where presets live on disk. `config.ts` and `detect.ts` each derived this
 * from their own `import.meta.url` and each had to be taught the fallback
 * separately; it is one derivation, so it is one place.
 */
export const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');

/**
 * Preset names, disk first. A readable directory is authoritative — an install
 * with `presets/` behaves exactly as it always did, and a preset dropped in by
 * hand takes effect in the run that adds it. Only when there is no directory to
 * read at all does the compiled-in set stand in.
 */
export const presetNames = (): string[] => {
	try {
		return readdirSync(PRESET_DIR)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.replace(/\.json$/, ''))
			.sort();
	} catch {
		return Object.keys(EMBEDDED_PRESETS);
	}
};

/** One preset by name, disk first. `undefined` if neither half has it. */
export const readPreset = (name: string): unknown => {
	const onDisk = join(PRESET_DIR, `${name}.json`);
	if (existsSync(onDisk)) {
		try {
			return JSON.parse(readFileSync(onDisk, 'utf8'));
		} catch {
			// A preset that will not parse is reported where it is extended, not
			// here, where it would take the whole list down with it.
			return undefined;
		}
	}
	return EMBEDDED_PRESETS[name];
};

/** Whether a spec names a shipped preset at all, however this copy carries it. */
export const hasPreset = (spec: string): boolean =>
	existsSync(join(PRESET_DIR, `${presetKey(spec)}.json`)) || Boolean(EMBEDDED_PRESETS[presetKey(spec)]);
