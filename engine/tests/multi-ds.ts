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
import { renderTitle } from '../src/rules.ts';
import { readProfiles, selectProfiles, applyRegistries } from '../src/profiles.ts';
import { detectPreset } from '../src/detect.ts';
import { assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { AnalyzeResult, DesignSystem, PatternNode } from '../src/types.ts';

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

// Suppression keywords are read across presets, so that every rename keeps
// honoring the directives written before it — and the alias set is therefore
// assembled from whatever is in `presets/`. A term one preset refuses as a
// blanket disable must not become a mute somewhere else just because a later
// preset adopts that spelling as its keyword. Adding a preset is the workflow
// this whole directory exists for; it must not be able to widen suppression
// under a preset nobody touched.
await check('a term one preset disables can never become a muting alias', async () => {
	const name = 'zz-blanket-clash';
	const file = join(PRESET_DIR, `${name}.json`);
	assert(!existsSync(file), `${file} already exists — refusing to clobber it`);
	// Written inside the try: `presets/` is the installed package, and a throw
	// between the write and the `finally` leaves a stray preset behind that every
	// later run — in this process and the next — silently reads its vocabulary
	// from.
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: 'generic', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '/* wpds-disable tokens/hardcoded-value -- blanket under wpds */\n.acme-a { color: #826200; }\n',
	});
	try {
		writeFileSync(file, JSON.stringify({ extends: 'generic', suppression: { keyword: 'wpds-disable', blanket: [] } }));
		const r = await analyze(await loadConfig({ root }), { scope: null });
		assert(!r.directives.length, `a blanket term must not read as a directive: ${JSON.stringify(r.directives)}`);
		assert(
			r.findings.some((f) => f.rule === 'tokens/hardcoded-value'),
			'the finding must survive — a blanket term mutes nothing, whoever names it',
		);
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

// ── headless design systems ─────────────────────────────────────────────────
// Base UI, Radix, Ark and React Aria ship behaviour and no styling. They have
// no layout or text primitive at all, and styling their parts with a class is
// not drift — it is the documented way to use them. That combination used to
// leave nothing running: the compositional rules were gated on a layout/text
// list the library will never have, so the one kind of drift a headless system
// does produce — the same anatomy reassembled in five files — was off by
// construction.

/** The same dialog anatomy, twice over, from a headless package. */
const dialog = (name: string): string => `import { Dialog } from '@base-ui/react/dialog';
export const ${name} = () => (
  <Dialog.Root>
    <Dialog.Trigger className="trigger" />
    <Dialog.Portal>
      <Dialog.Backdrop />
      <Dialog.Popup className="popup"><Dialog.Title>Hi</Dialog.Title></Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
);
`;

await check('the base-ui preset is detected from the dependency alone', () => {
	const root = repo({ 'package.json': JSON.stringify({ dependencies: { '@base-ui/react': '^1.0.0' } }) });
	try {
		const got = detectPreset(root);
		assert(got.preset === 'base-ui', `expected base-ui, got ${got.preset}`);
	} finally {
		cleanup(root);
	}
});

await check('a headless system composes without a layout or text layer', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: 'base-ui' }),
		// Three files: an unregistered shape is house style at the third use.
		'src/A.jsx': dialog('A'),
		'src/B.jsx': dialog('B'),
		'src/C.jsx': dialog('C'),
		// Styling the parts is what the library asks for, not an override.
		'styles/a.css': '.popup { background: #fff; border: 1px solid #ddd; }\n.trigger { color: #333; }\n',
	});
	try {
		const r = await analyze(await loadConfig({ root, configPath: join(root, 'loupe.config.json') }), { scope: null });
		const unreg = r.findings.filter((f) => f.rule === 'patterns/unregistered-composite');
		assert(unreg.length > 0, 'the repeated dialog anatomy should report');
		const override = r.findings.filter((f) => f.rule === 'system/override' || f.rule === 'system/inline-style');
		assert(!override.length, `an unstyled library must not report its own styling: ${override.map((f) => f.message)}`);
	} finally {
		cleanup(root);
	}
});

// ── a second shipped design system ──────────────────────────────────────────
// The claim the profiles directory makes is that adding a design system is
// adding a directory. Archer is the second one shipped, and it is the first
// that is neither WordPress nor headless: a styled system built on Base UI,
// with one layout primitive, no text component, and unprefixed tokens in
// seventeen families. Each of those is a seam that fails quietly.

const PROFILES = join(HERE, '..', '..', 'profiles');

await check('the archer profile reaches a project that imports it, and only that project', async () => {
	const root = repo({ 'package.json': JSON.stringify({ dependencies: { '@dabowman/archer': '^1.0.0' } }) });
	const other = repo({ 'package.json': JSON.stringify({ dependencies: { '@chakra-ui/react': '^2.0.0' } }) });
	try {
		assert(detectPreset(root).preset === 'archer', `expected archer, got ${detectPreset(root).preset}`);
		const profiles = readProfiles(PROFILES);
		assert(
			profiles.some((p) => p.id === 'archer'),
			`the shipped profiles should include archer: ${profiles.map((p) => p.id)}`,
		);
		const on = selectProfiles(profiles, { designSystem: { packages: ['@dabowman/archer'] } });
		assert(on.length === 1 && on[0]?.id === 'archer', 'archer should select on its own package');
		const off = selectProfiles(profiles, { designSystem: { packages: ['@chakra-ui/react'] } });
		assert(!off.length, `archer must not reach another design system: ${off.map((p) => p.id)}`);
	} finally {
		cleanup(root);
		cleanup(other);
	}
});

// A styled system with no text component is the shape neither WPDS nor base-ui
// covered: the text rules have to stay off while the override rules stay on.
// Turning the pair off together — which is what the headless preset does — was
// the easy wrong answer, and it silently stops reporting real overrides.
await check('a system with a layout primitive but no text component keeps its override rules', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: 'archer' }),
		'src/A.jsx': `import { Button } from '@dabowman/archer';\nexport const A = () => <Button className="save">Save</Button>;\n`,
		'styles/a.css': '.save { background: #c24300; }\n',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		assert(config.enabled['system/override'], 'a styled system must keep system/override');
		assert(config.enabled['layout/in-css'], 'a system with a layout primitive must keep layout/in-css');
		assert(!config.enabled['typography/in-css'], 'no text component means typography/in-css cannot fire');
		const r = await analyze(config, { scope: null });
		assert(
			r.findings.some((f) => f.rule === 'system/override'),
			`restyling a component from CSS should still report: ${r.findings.map((f) => f.rule)}`,
		);
	} finally {
		cleanup(root);
	}
});

// A title interpolates one token namespace. With seventeen prefixes there is no
// "the" prefix, and naming the first told agents to fix `font-size: 18px` with
// "a --color-* type token" — a namespace that has no type tokens in it.
await check('a rule title names a token namespace only when there is one', () => {
	const ds = (tokenPrefixes: string[]): DesignSystem => ({
		name: 'X',
		packages: [],
		tokenPrefixes,
		tokenSources: [],
		cssInJsPackages: [],
		normalizeExports: null,
		layoutComponents: [],
		textComponents: [],
		knownComponents: new Set(),
		elementMap: new Map(),
		substitutionProps: new Set(),
	});
	const several = renderTitle('tokens/hardcoded-value', ds(['--color-', '--space-']), 'k');
	assert(!several.includes('--color-*'), `several prefixes must not be reported as the namespace: ${several}`);
	assert(several.includes('design-system'), `the fallback should be generic: ${several}`);
	const single = renderTitle('tokens/hardcoded-value', ds(['--wpds-']), 'k');
	assert(single.includes('--wpds-*'), `a single prefix is the namespace and should be named: ${single}`);
});

// Anatomy entries are how a library's *required* structure stops reporting as
// house style nobody wrote down. The mechanism is `canonical`: a file importing
// it is skipped before either composite rule sees it. Register the same shape
// without one and `patterns/unregistered-composite` does not go quiet — it
// becomes `patterns/duplicate-composite`, which asks for an extraction that
// must not happen. That swap is invisible in a registry diff.
await check('a registered anatomy with a canonical absorbs the shape instead of re-reporting it', async () => {
	const anatomy = (name: string): string => `import { Dlg, DlgTrigger, DlgPopup, DlgTitle } from '@acme/ui';
export const ${name} = () => (
  <Dlg><DlgTrigger /><DlgPopup><DlgTitle>Hi</DlgTitle></DlgPopup></Dlg>
);
`;
	const files = {
		'loupe.config.json': JSON.stringify({ extends: 'generic', designSystem: { packages: ['@acme/ui'] } }),
		'src/A.jsx': anatomy('A'),
		'src/B.jsx': anatomy('B'),
		'src/C.jsx': anatomy('C'),
	};
	const sig = ['Dlg', 'DlgTrigger', ['DlgPopup', 'DlgTitle']];
	const withCanonical = repo({
		...files,
		'registry.json': JSON.stringify({ patterns: [{ id: 'dlg', summary: 'anatomy', canonical: 'Dlg', signature: sig }] }),
	});
	const without = repo({
		...files,
		'registry.json': JSON.stringify({ patterns: [{ id: 'dlg', summary: 'anatomy', signature: sig }] }),
	});
	try {
		const quiet = await analyzeWith(withCanonical, join(withCanonical, 'registry.json'));
		const noisy = await analyzeWith(without, join(without, 'registry.json'));
		const composite = (r: AnalyzeResult): string[] =>
			r.findings.filter((f) => f.rule.startsWith('patterns/')).map((f) => f.rule);
		assert(!composite(quiet).length, `a canonical anatomy entry must report nothing: ${composite(quiet)}`);
		// Not merely "something fires": the specific wrong outcome is the
		// extraction request, and that is what the canonical exists to prevent.
		assert(
			composite(noisy).includes('patterns/duplicate-composite'),
			`without a canonical the same registry asks for an extraction: ${composite(noisy)}`,
		);
	} finally {
		cleanup(withCanonical);
		cleanup(without);
	}
});

finish();
