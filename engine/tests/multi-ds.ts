#!/usr/bin/env node
/**
 * Running more than one design system.
 *
 * The engine has always been agnostic — the rules gate on capabilities and the
 * component names arrive as config — but the plugin around it was not: it
 * handed the WPDS registries to every project it ran on. Composite signatures
 * match on component *names*, and `Stack`, `Text`, `Button` and `Modal` are
 * names almost every design system uses, so WPDS's `page-header` matched a
 * Chakra page header exactly and told the agent to import a WordPress module.
 *
 * What is checked here is that the seams hold: a registry says who it is for, a
 * signature can say whose `Stack` it means, a preset carries its own detection
 * markers, and a profile reaches only the projects that import it. Each of
 * these fails *quietly* — as a finding that does not fire, or one that fires on
 * the wrong repo — which is the failure mode no build ever catches.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.ts';
import { loadConfig, setComponentRegistry, setPatterns } from '../src/config.ts';
import { matches, toNode } from '../src/patterns.ts';
import { registryApplies } from '../src/registry.ts';
import { readProfiles, selectProfiles, applyRegistries } from '../src/profiles.ts';
import { detectPreset } from '../src/detect.ts';
import { assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { AnalyzeResult, PatternNode } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

/** `toNode` is nullable by contract; a signature written in a test is not. */
const node = (spec: unknown): PatternNode => {
	const n = toNode(spec);
	assert(n, `test signature did not parse: ${JSON.stringify(spec)}`);
	return n;
};

/** Write a throwaway repo and hand back its root. */
function repo(files: Record<string, string>): string {
	const root = scratch('loupe-mds-');
	writeAll(root, files);
	return root;
}

/** The same page header, built from whichever package the caller names. */
const pageHeader = (pkg: string, name: string): string => `import { Stack, Text, Button } from '${pkg}';
export const ${name} = () => (
  <Stack>
    <Stack><Text>Title</Text><Text>Sub</Text></Stack>
    <Stack><Button>Go</Button></Stack>
  </Stack>
);
`;

const PAGE_HEADER_SIG = ['Stack', ['Stack', 'Text', 'Text'], ['Stack', 'Button']];

const registryFile = (packages: string[]): string =>
	JSON.stringify({
		packages,
		patterns: [{ id: 'page-header', summary: 'header', signature: PAGE_HEADER_SIG }],
	});

const configFor = (pkg: string): string =>
	JSON.stringify({
		extends: 'generic',
		designSystem: { packages: [pkg], components: { layout: ['Stack'], text: ['Text'] } },
	});

/** Analyze `root`, attaching `patternsPath` the way the CLI would. */
async function analyzeWith(root: string, patternsPath?: string | null): Promise<AnalyzeResult> {
	const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
	if (patternsPath)
		applyRegistries(config, [{ label: 'test', patterns: patternsPath }], { setPatterns, setComponentRegistry });
	return analyze(config, { scope: null });
}

// ── registry scope ──────────────────────────────────────────────────────────

await check('a scoped registry does not reach a project on another design system', async () => {
	const root = repo({
		'loupe.config.json': configFor('@chakra-ui/react'),
		'registry.json': registryFile(['@wordpress/components']),
		'src/A.jsx': pageHeader('@chakra-ui/react', 'A'),
		'src/B.jsx': pageHeader('@chakra-ui/react', 'B'),
	});
	try {
		const r = await analyzeWith(root, join(root, 'registry.json'));
		const dup = r.findings.filter((f) => f.rule === 'patterns/duplicate-composite');
		assert(!dup.length, `WPDS pattern fired on a Chakra repo: ${dup.map((f) => f.message)}`);
	} finally {
		cleanup(root);
	}
});

await check('the same registry reaches the design system it names', async () => {
	const root = repo({
		'loupe.config.json': configFor('@wordpress/components'),
		'registry.json': registryFile(['@wordpress/components']),
		'src/A.jsx': pageHeader('@wordpress/components', 'A'),
		'src/B.jsx': pageHeader('@wordpress/components', 'B'),
	});
	try {
		const r = await analyzeWith(root, join(root, 'registry.json'));
		const dup = r.findings.filter((f) => f.rule === 'patterns/duplicate-composite');
		assert(dup.length === 2, `expected both files reported, got ${dup.length}`);
	} finally {
		cleanup(root);
	}
});

await check('a registry naming no packages still applies anywhere', () => {
	assert(registryApplies({ patterns: [] }, ['@acme/ui']), 'an unscoped registry must keep working');
	assert(registryApplies({ packages: [] }, ['@acme/ui']), 'an empty scope is no scope');
	assert(!registryApplies({ packages: ['@a/b'] }, []), 'a project with no packages has no component layer');
});

// ── qualified signatures ────────────────────────────────────────────────────

await check('a package-qualified node matches only that package', () => {
	const pattern = node(['@wordpress/components::Stack', '@wordpress/components::Button']);
	const wp = { name: 'Stack', pkg: '@wordpress/components', children: [{ name: 'Button', pkg: '@wordpress/components', children: [] }] };
	const chakra = { name: 'Stack', pkg: '@chakra-ui/react', children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }] };
	assert(matches(pattern, wp), 'should match its own package');
	assert(!matches(pattern, chakra), 'must not match another package');
});

await check('an unqualified node still matches any package', () => {
	const pattern = node(['Stack', 'Button']);
	const chakra = { name: 'Stack', pkg: '@chakra-ui/react', children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }] };
	const unknown = { name: 'Stack', pkg: null, children: [{ name: 'Button', pkg: null, children: [] }] };
	assert(matches(pattern, chakra), 'bare names are the default and must stay permissive');
	// An import the scanner could not resolve is not evidence of a mismatch.
	assert(matches(node(['@x/y::Stack', 'Button']), unknown), 'an unknown package must not block a match');
});

// ── detection is data ───────────────────────────────────────────────────────

await check('a preset dropped into presets/ is detected without touching the engine', async () => {
	// The claim under test is that adding a design system is adding a file. The
	// only honest way to check it is to add one.
	const name = 'zz-test-ds';
	const file = join(PRESET_DIR, `${name}.json`);
	assert(!existsSync(file), `${file} already exists — refusing to clobber it`);
	writeFileSync(
		file,
		JSON.stringify({
			extends: 'generic',
			detect: { priority: 40, confidence: 'high', dependencies: ['@zz/design-system'] },
			designSystem: { name: 'ZZ', packages: ['@zz/design-system'], components: { layout: ['Row'], text: ['Copy'] } },
		})
	);
	const root = repo({ 'package.json': JSON.stringify({ dependencies: { '@zz/design-system': '^1.0.0' } }) });
	try {
		const got = detectPreset(root);
		assert(got.preset === name, `expected ${name}, got ${got.preset}`);
		assert(got.confidence === 'high', `expected high confidence, got ${got.confidence}`);
		assert(got.reasons.join(' ').includes('@zz/design-system'), `reason should name the marker: ${got.reasons}`);
	} finally {
		rmSync(file, { force: true });
		cleanup(root);
	}
});

await check('priority decides when two presets both match', async () => {
	const root = repo({
		'package.json': JSON.stringify({ dependencies: { '@wordpress/components': '^28.0.0' } }),
		'theme.json': '{"version":3}',
		'templates/index.html': '<div></div>',
	});
	try {
		// Both the component library and the block-theme markers are present. The
		// component library wins because its preset carries the token prefix and
		// severities; picking the other would silently disable them.
		assert(detectPreset(root).preset === 'wpds', 'higher priority must win');
	} finally {
		cleanup(root);
	}
});

await check('a preset with no detect block is never inferred', async () => {
	const root = repo({ 'package.json': '{}' });
	try {
		assert(detectPreset(root).preset === 'generic', 'a parent preset is not a conclusion');
	} finally {
		cleanup(root);
	}
});

// ── profiles ────────────────────────────────────────────────────────────────

function profileDir(): string {
	const root = scratch('loupe-prof-');
	writeAll(root, {
		'acme/profile.json': JSON.stringify({
			id: 'acme',
			name: 'Acme DS',
			packages: ['@acme/ui'],
			patterns: './patterns.json',
		}),
		'acme/patterns.json': registryFile(['@acme/ui']),
	});
	// A directory with no manifest is not a profile, and must not throw.
	mkdirSync(join(root, 'not-a-profile'), { recursive: true });
	return root;
}

await check('profiles are read from disk, junk directories ignored', () => {
	const dir = profileDir();
	try {
		const profile = one(readProfiles(dir), 'expected exactly 1 profile');
		assert(profile.id === 'acme' && profile.name === 'Acme DS', 'manifest fields should survive');
		assert(profile.patterns?.endsWith('patterns.json'), 'registry path should resolve against the profile dir');
		assert(readProfiles(join(dir, 'nope')).length === 0, 'a missing directory is not an error');
	} finally {
		cleanup(dir);
	}
});

// `--profile <id>` applies every profile carrying that id, and two directories
// can carry the same one. Malformed input, but the outcome is a profile applied
// twice and reported twice — so the read settles it once, in sorted order.
await check('two directories claiming one id yield one profile', () => {
	const dir = scratch('loupe-dup-');
	try {
		writeAll(dir, {
			'acme/profile.json': JSON.stringify({ id: 'acme', name: 'Acme DS', packages: ['@acme/ui'] }),
			'acme-copy/profile.json': JSON.stringify({ id: 'acme', name: 'A copy', packages: ['@acme/ui'] }),
		});
		const profile = one(readProfiles(dir), 'a duplicated id must not duplicate the profile');
		assert(profile.name === 'Acme DS', `the first directory should win, got ${profile.name}`);
	} finally {
		cleanup(dir);
	}
});

// A `profile.json` is third-party JSON: every field is whatever the author
// typed. `id` reaches a Set, `--profile`'s comparison and a sort that runs
// outside every `try` in the function — so a numeric one threw past all of it,
// and under `loupe hook` that is exit 2, a turn blocked by a stack trace. The
// contract this function states is that one bad directory cannot do that.
await check('a profile with junk field types falls back rather than throwing', () => {
	const dir = scratch('loupe-junk-');
	try {
		writeAll(dir, {
			// Sorts after `good`, which is what put it on the left of the comparator.
			'zz/profile.json': JSON.stringify({ id: 7, name: [], packages: ['@acme/ui'], patterns: 3 }),
			'good/profile.json': JSON.stringify({ id: 'good', name: 'Good', packages: ['@acme/ui'] }),
		});
		const found = readProfiles(dir);
		assert(found.length === 2, `both directories should still be read, got ${found.length}`);
		const junk = first(
			found.filter((p) => p.id !== 'good'),
			'the junk profile should fall back to its directory name',
		);
		assert(junk.id === 'zz' && junk.name === 'zz', `expected the directory name, got ${junk.id}/${junk.name}`);
		assert(junk.patterns === null, `a non-string patterns path must not be joined: ${junk.patterns}`);
	} finally {
		cleanup(dir);
	}
});

// Dedup reserved the id before the entry was built, so a directory that failed
// on the way to the list still locked its id out — and the well-formed
// directory claiming the same one was dropped behind it. `--profile acme` then
// matched neither, silently.
await check('a broken profile does not lock its id out for a good one', () => {
	const dir = scratch('loupe-poison-');
	try {
		writeAll(dir, {
			'a-broken/profile.json': '{ not json',
			'b-good/profile.json': JSON.stringify({ id: 'a-broken', name: 'Real', packages: ['@acme/ui'] }),
		});
		const profile = one(readProfiles(dir), 'a profile that never parsed must not claim its id');
		assert(profile.name === 'Real', `expected the well-formed profile, got ${profile.name}`);
	} finally {
		cleanup(dir);
	}
});

await check('a profile is selected by what the project imports', () => {
	const dir = profileDir();
	try {
		const profiles = readProfiles(dir);
		const on = { designSystem: { packages: ['@acme/ui'] } };
		const off = { designSystem: { packages: ['@chakra-ui/react'] } };
		assert(selectProfiles(profiles, on).length === 1, 'should select on a package match');
		assert(selectProfiles(profiles, off).length === 0, 'should select nothing otherwise');
		assert(selectProfiles(profiles, { designSystem: { packages: [] } }).length === 0, 'no packages, no profile');
		assert(selectProfiles(profiles, off, 'acme').length === 1, '--profile forces selection');
	} finally {
		cleanup(dir);
	}
});

await check('a skipped registry is reported, not silently dropped', async () => {
	const root = repo({ 'loupe.config.json': configFor('@chakra-ui/react'), 'registry.json': registryFile(['@wordpress/components']) });
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(config, [{ label: 'profile wpds', patterns: join(root, 'registry.json') }], {
			setPatterns,
			setComponentRegistry,
		});
		assert(out.applied.length === 0, 'nothing should have applied');
		const skip = one(out.skipped, 'the skip must be reported');
		assert(skip.packages.includes('@wordpress/components'), 'the report should name the scope');
	} finally {
		cleanup(root);
	}
});

// `--profile <id>` is the user answering the question the scope gate asks, and
// it was asked anyway: the named profile was selected and both of its
// registries dropped, so every rule the profile exists to enable stayed off.
await check('a profile named outright applies its registries anyway', async () => {
	const root = repo({
		'loupe.config.json': configFor('@chakra-ui/react'),
		'registry.json': registryFile(['@wordpress/components']),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(
			config,
			[{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true }],
			{ setPatterns, setComponentRegistry },
		);
		assert(!out.skipped.length, 'a forced registry must not be re-gated on scope');
		assert(out.applied.length === 1, `expected the registry applied, got ${out.applied.length}`);
		assert(config.enabled['patterns/duplicate-composite'], 'the rule the registry exists to enable stayed off');
		// Forcing it in is what the flag asked for; doing it silently is not.
		// This registry is scoped to WPDS and the config names Chakra, so its
		// bare-name signatures now match a codebase they describe nothing about
		// — `Modal(Text,Stack(Button,Button))` fits both, and the finding tells
		// the agent to import `__experimentalConfirmDialog`.
		const note = one(out.notes, 'forcing a registry onto another design system must be reported');
		assert(
			/scoped to @wordpress\/components/.test(note.note) && /@chakra-ui\/react/.test(note.note),
			`the note should name both sides of the mismatch: ${note.note}`,
		);
	} finally {
		cleanup(root);
	}
});

// Forcing a registry in merges it; it does not make its rules run. A composite
// signature still needs a component layer to match against, and a merged
// registry that enables nothing is exactly as invisible as a skipped one —
// which is the whole reason skips are reported.
await check('a forced registry that enables nothing says so', async () => {
	const root = repo({
		// In scope — the config names the package the registry is scoped to — so
		// the only thing left to report is that the merge came to nothing.
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			designSystem: { packages: ['@wordpress/components'] },
		}),
		'registry.json': registryFile(['@wordpress/components']),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(
			config,
			[{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true }],
			{ setPatterns, setComponentRegistry },
		);
		assert(!out.skipped.length && out.applied.length === 1, 'the forced registry should still merge');
		const note = one(out.notes, 'a merge that changed nothing must be reported');
		// Named precisely: a merged component *registry* never feeds
		// `designSystem.components`, so "no components" on its own sent the
		// reader to a file that had nothing wrong with it.
		assert(/no designSystem\.components/.test(note.note), `the note should name what is missing: ${note.note}`);
	} finally {
		cleanup(root);
	}
});

// The report used to read the merged totals rather than what this source added,
// so a forced registry whose every id the project had already defined merged,
// contributed nothing, and was reported as fine — because some *other* source
// had filled the same list. That is the invisibility the note exists to prevent.
await check('a forced registry the project already covers is not reported as fine', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			designSystem: { packages: ['@wordpress/components'], components: { layout: ['Stack'], text: ['Text'] } },
			patterns: './own.json',
		}),
		'own.json': JSON.stringify([{ id: 'page-header', summary: 'ours', signature: PAGE_HEADER_SIG }]),
		'registry.json': registryFile(['@wordpress/components']),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(
			config,
			[{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true }],
			{ setPatterns, setComponentRegistry },
		);
		assert(config.enabled['patterns/duplicate-composite'], 'the project’s own registry should still enable the rule');
		const note = one(out.notes, 'a forced registry that added nothing must be reported');
		assert(/added no patterns/.test(note.note), `the note should say it added nothing: ${note.note}`);
	} finally {
		cleanup(root);
	}
});

await check('an unreadable registry is an error, not a crash', async () => {
	const root = repo({ 'loupe.config.json': configFor('@acme/ui') });
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(config, [{ label: 'profile gone', patterns: join(root, 'missing.json') }], {
			setPatterns,
			setComponentRegistry,
		});
		assert(out.errors.length === 1, 'the failure should be reported');
		assert(config.enabled['patterns/duplicate-composite'] === false, 'the rule stays off rather than half-configured');
	} finally {
		cleanup(root);
	}
});

finish();
