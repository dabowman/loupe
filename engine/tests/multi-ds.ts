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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.ts';
import { loadConfig } from '../src/config.ts';
import { loadComponents } from '../src/components.ts';
import { supersededEverywhere } from '../src/checks/system/currency.ts';
import { matches, toNode } from '../src/patterns.ts';
import { registryApplies } from '../src/registry.ts';
import { renderTitle } from '../src/rules.ts';
import { readProfiles, selectProfiles, applyRegistries, profileRoots, readProfileRoots } from '../src/profiles.ts';
import { declaredVersions, detectPreset } from '../src/detect.ts';
import { CLI, assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { AnalyzeResult, DesignSystem, OutOfRange, PatternNode } from '../src/types.ts';

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
		realizations: [{ pattern: 'screen#header', note: 'header', signature: PAGE_HEADER_SIG }],
	});

const configFor = (pkg: string): string =>
	JSON.stringify({
		extends: 'generic',
		designSystem: { packages: [pkg], components: { layout: ['Stack'], text: ['Text'] } },
	});

/** Analyze `root`, attaching `patternsPath` the way the CLI would. */
async function analyzeWith(root: string, patternsPath?: string | null): Promise<AnalyzeResult> {
	const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
	if (patternsPath) applyRegistries(config, [{ label: 'test', patterns: patternsPath }]);
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
	assert(registryApplies({ realizations: [] }, ['@acme/ui']), 'an unscoped registry must keep working');
	assert(registryApplies({ packages: [] }, ['@acme/ui']), 'an empty scope is no scope');
	assert(!registryApplies({ packages: ['@a/b'] }, []), 'a project with no packages has no component layer');
});

// ── qualified signatures ────────────────────────────────────────────────────

await check('a package-qualified node matches only that package', () => {
	const pattern = node(['@wordpress/components::Stack', '@wordpress/components::Button']);
	const wp = {
		name: 'Stack',
		pkg: '@wordpress/components',
		children: [{ name: 'Button', pkg: '@wordpress/components', children: [] }],
	};
	const chakra = {
		name: 'Stack',
		pkg: '@chakra-ui/react',
		children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }],
	};
	assert(matches(pattern, wp), 'should match its own package');
	assert(!matches(pattern, chakra), 'must not match another package');
});

await check('an unqualified node still matches any package', () => {
	const pattern = node(['Stack', 'Button']);
	const chakra = {
		name: 'Stack',
		pkg: '@chakra-ui/react',
		children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }],
	};
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
		}),
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
	const root = repo({
		'loupe.config.json': configFor('@chakra-ui/react'),
		'registry.json': registryFile(['@wordpress/components']),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(config, [{ label: 'profile wpds', patterns: join(root, 'registry.json') }]);
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
		const out = applyRegistries(config, [
			{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true },
		]);
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
		const out = applyRegistries(config, [
			{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true },
		]);
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
		'own.json': JSON.stringify([{ pattern: 'screen#header', note: 'ours', signature: PAGE_HEADER_SIG }]),
		'registry.json': registryFile(['@wordpress/components']),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const out = applyRegistries(config, [
			{ label: 'profile wpds', patterns: join(root, 'registry.json'), forced: true },
		]);
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
		const out = applyRegistries(config, [{ label: 'profile gone', patterns: join(root, 'missing.json') }]);
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

// Every shipped preset reaches `generic`, so two of them side by side share an
// ancestor. One `seen` set threaded through sibling entries called that a cycle,
// and the config would not load — under the hook, the gate checked nothing
// while telling the agent to fix a cycle that was not there.
await check('extends can list two configs that share an ancestor', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: ['wpds', 'base-ui', './team.json'] }),
		'team.json': JSON.stringify({ extends: 'generic', namespaces: { project: ['acme-'] } }),
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		assert(config.designSystem.name === 'Base UI', `the later entry wins: ${config.designSystem.name}`);
		assert(config.isProject('acme-x'), 'the team config, which also extends generic, is merged');
		assert(config.ruleFrom['system/override'] === 'preset base-ui', `ruleFrom: ${config.ruleFrom['system/override']}`);
		// `generic` is merged once, where it is first met. Merged again under
		// base-ui, its `references` would land over the WordPress ones wpds carries.
		const wp = JSON.parse(readFileSync(join(PRESET_DIR, 'wordpress-components.json'), 'utf8')) as {
			sources: { references: string[] };
		};
		assert(
			JSON.stringify(config.sources.references) === JSON.stringify(wp.sources.references),
			`a later branch's copy of generic undid wordpress-components: ${JSON.stringify(config.sources.references)}`,
		);
	} finally {
		cleanup(root);
	}
});

await check('a real extends cycle is still refused, through sibling entries too', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: ['generic', './a.json'] }),
		'a.json': JSON.stringify({ extends: ['./b.json'] }),
		'b.json': JSON.stringify({ extends: ['generic', './a.json'] }),
	});
	try {
		const err = await loadConfig({ root, configPath: join(root, 'loupe.config.json') }).then(
			() => undefined,
			(e: unknown) => (e instanceof Error ? e.message : String(e)),
		);
		assert(err?.startsWith('circular extends at ') && err.endsWith('a.json'), `expected a cycle at a.json, got ${err}`);
	} finally {
		cleanup(root);
	}
});

// ── a second shipped design system ──────────────────────────────────────────
// The claim the profiles directory makes is that adding a design system is
// adding a directory. Archer is the second one shipped, and it is the first
// that is neither WordPress nor headless: a styled system built on Base UI,
// with flat part exports and unprefixed tokens in seventeen families. Each of
// those is a seam that fails quietly.

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

// A styled system built on a headless one is the shape neither WPDS nor base-ui
// covered: it inherits Base UI's parts but not its licence to restyle them.
// Turning the override rules off — which is what the headless preset does — was
// the easy wrong answer, and it silently stops reporting real overrides.
//
// With a registry that records surfaces, the per-declaration form needs one to
// say the component owns what the class sets; this fixture states one for the
// component it restyles. The shipped Archer registry records none, which is the
// case the checks after the VIP one cover.
await check('a styled system on a headless library keeps its override rules', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({
			extends: 'archer',
			componentRegistry: [
				{
					name: 'Button',
					package: '@dabowman/archer',
					status: 'recommended',
					surface: { properties: { background: 'variant' } },
				},
			],
		}),
		'src/A.jsx': `import { Button } from '@dabowman/archer';\nexport const A = () => <Button className="save">Save</Button>;\n`,
		'styles/a.css': '.save { background: #c24300; }\n',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		assert(config.enabled['system/override'], 'a styled system must keep system/override');
		assert(config.enabled['layout/in-css'], 'a system with a layout primitive must keep layout/in-css');
		assert(config.enabled['typography/in-css'], 'a system with a text component must keep typography/in-css');
		const r = await analyze(config, { scope: null });
		assert(
			r.findings.some((f) => f.rule === 'system/override'),
			`restyling a component from CSS should still report: ${r.findings.map((f) => f.rule)}`,
		);
	} finally {
		cleanup(root);
	}
});

await check("the vip profile reaches a VIP project, and NewDialog's style prop is its sizing API", async () => {
	const root = repo({
		'package.json': JSON.stringify({ dependencies: { '@automattic/vip-design-system': '^2.23.0' } }),
		'src/A.jsx': `import { Box, NewDialog } from '@automattic/vip-design-system';
export const A = () => (
  <>
    <NewDialog.Root title="t" description="d" style={{ maxWidth: 600, overflowY: 'visible' }} />
    <Box style={{ background: '#c24300' }} />
  </>
);
`,
	});
	try {
		assert(detectPreset(root).preset === 'vip', `expected vip, got ${detectPreset(root).preset}`);
		const on = selectProfiles(readProfiles(PROFILES), {
			designSystem: { packages: ['@automattic/vip-design-system'] },
		});
		assert(on.length === 1 && on[0]?.id === 'vip', 'vip should select on its own package');
		const config = await loadConfig({ root, preset: 'vip' });
		const inline = (await analyze(config, { scope: null })).findings.filter((f) => f.rule === 'system/inline-style');
		assert(
			inline.length === 1 && inline[0]?.line === 5,
			`only the Box's inline style should report: ${inline.map((f) => f.line)}`,
		);
	} finally {
		cleanup(root);
	}
});

// The archer and vip registries were rewritten from the flat form into
// realizations of the pattern language. What their anatomy entries are for has
// to survive the move: a component's own parts, used correctly in three files,
// report nothing — under the new keys an entry that lost its canonical would
// turn them into extraction requests — and the anti-shape each registry
// records still reports, now naming the pattern it realizes.
const SHIPPED_SHAPES = {
	archer: {
		pkg: '@dabowman/archer',
		uses: [
			'<Dialog><DialogTrigger /><DialogPopup><DialogTitle>t</DialogTitle><DialogDescription>d</DialogDescription></DialogPopup></Dialog>',
			'<Popover><PopoverTrigger /><PopoverPopup><PopoverTitle>t</PopoverTitle><PopoverDescription>d</PopoverDescription></PopoverPopup></Popover>',
			'<Accordion><AccordionItem><AccordionHeader><AccordionTrigger>t</AccordionTrigger></AccordionHeader><AccordionPanel>p</AccordionPanel></AccordionItem></Accordion>',
			'<Autocomplete><AutocompleteInput /><AutocompletePopup><AutocompleteList><AutocompleteItem /></AutocompleteList></AutocompletePopup></Autocomplete>',
			'<NavigationMenu><NavigationMenuList><NavigationMenuItem><NavigationMenuTrigger /><NavigationMenuContent /></NavigationMenuItem></NavigationMenuList></NavigationMenu>',
			'<List><ListItem>a</ListItem><ListItem>b</ListItem><ListItem>c</ListItem></List>',
			'<TableRow><TableCell /><TableCell /><TableCell /></TableRow>',
		],
		anti: '<Stack><Button>a</Button><Button>b</Button><Separator /><Button>c</Button></Stack>',
		replaces: 'action-cluster.toolbar',
	},
	vip: {
		pkg: '@automattic/vip-design-system',
		uses: [
			'<Accordion.Root><Accordion.Item><Accordion.TriggerWithIcon>t</Accordion.TriggerWithIcon><Accordion.Content>c</Accordion.Content></Accordion.Item></Accordion.Root>',
			'<Dropdown.Root><Dropdown.Item /><Dropdown.Item /><Dropdown.Item /></Dropdown.Root>',
			'<Tabs><TabsList><TabsTrigger /><TabsTrigger /></TabsList><TabsContent /></Tabs>',
			'<TableRow><TableCell /><TableCell /><TableCell /></TableRow>',
		],
		anti: '<Flex><Button>a</Button><Button><Spinner />b</Button></Flex>',
		replaces: 'report.loading',
	},
};

for (const [id, shapes] of Object.entries(SHIPPED_SHAPES))
	await check(`the ${id} registry absorbs its components' anatomy and names what it replaces`, async () => {
		const jsx = [...shapes.uses, shapes.anti];
		const names = [...new Set(jsx.flatMap((s) => [...s.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1])))];
		const file = (body: string): string => `import { ${names.join(', ')} } from '${shapes.pkg}';\n${body}`;
		const uses = shapes.uses.map((u, i) => `export const U${i} = () => (${u});`).join('\n');
		const root = repo({
			'loupe.config.json': JSON.stringify({ extends: id, designSystem: { packages: [shapes.pkg] } }),
			'src/A.jsx': file(uses),
			'src/B.jsx': file(uses),
			'src/C.jsx': file(uses),
			'src/Anti.jsx': file(`export const Anti = () => (${shapes.anti});`),
		});
		try {
			const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
			const profile = readProfiles(PROFILES).find((p) => p.id === id);
			assert(profile?.patterns, `the ${id} profile should ship a pattern registry`);
			const out = applyRegistries(config, [{ label: `profile ${id}`, patterns: profile.patterns, forced: true }]);
			assert(!out.errors.length, `the ${id} registry did not load: ${out.errors}`);
			const found = (await analyze(config, { scope: null })).findings.filter((f) => f.rule.startsWith('patterns/'));
			const hit = one(found, `only the anti-shape should report: ${found.map((f) => `${f.file} ${f.message}`)}`);
			assert(
				hit.rule === 'patterns/superseded-composite' &&
					hit.file.endsWith('Anti.jsx') &&
					hit.message.includes(`\`${shapes.replaces}\``),
				`the anti-shape should report against ${shapes.replaces}: ${hit.rule} ${hit.message}`,
			);
		} finally {
			cleanup(root);
		}
	});

// #13 narrowed the per-declaration form to what a registry `surface` says the
// component owns, failing safe to advisory where none is recorded. That is
// right for a registry read for surfaces, whose gaps are gaps; for one that
// records none at all — VIP and Archer today, a run with no profile, a
// project's own registry — it switched the rule off. There, a class restyling a
// component blocks as it always did, with the remedy it always had.

/** Analyze through profiles' shipped registries, the way `--profiles` merges them. */
async function withProfiles(
	files: Record<string, string>,
	config: Record<string, unknown>,
	ids: readonly string[],
): Promise<AnalyzeResult> {
	const root = repo({ 'loupe.config.json': JSON.stringify(config), ...files });
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const profiles = readProfiles(PROFILES).filter((p) => ids.includes(p.id));
		assert(profiles.length === ids.length, `missing a profile: ${ids}`);
		applyRegistries(
			config,
			profiles.map((p) => ({ label: `profile ${p.id}`, patterns: null, components: p.components, forced: true })),
		);
		return await analyze(config, { scope: null });
	} finally {
		cleanup(root);
	}
}

const UNREAD = (tag: string, prop: string): string => `<${tag}> ← ${prop} — restyle via its props/tokens, not CSS`;

for (const [id, pkg] of [
	['archer', '@dabowman/archer'],
	['vip', '@automattic/vip-design-system'],
] as const)
	await check(`the ${id} registry records no surfaces, so an override there reads as it did before them`, async () => {
		const shipped = loadComponents(JSON.parse(readFileSync(join(PROFILES, id, 'components', 'index.json'), 'utf8')));
		assert(
			[...shipped.values()].every((e) => !e.surface && !e.surfaced),
			`the ${id} registry now records surfaces; this check no longer covers the fallback`,
		);
		const r = await withProfiles(
			{
				'src/A.jsx': `import { Button } from '${pkg}';\nexport const A = () => <Button className="save">Save</Button>;\n`,
				'styles/a.css': '.save { background: #c24300; border-radius: 4px; }\n',
			},
			{ extends: id },
			[id],
		);
		const overrides = r.findings.filter((f) => f.rule === 'system/override');
		const want = [UNREAD('Button', 'background'), UNREAD('Button', 'border-radius')];
		assert(
			overrides.map((f) => f.message).join('|') === want.join('|'),
			`every appearance property should report, with the props/tokens remedy: ${overrides.map((f) => f.message)}`,
		);
		// The identity it had before surfaces existed, so a baseline still matches.
		assert(
			overrides.every((f) => f.code === f.message.split(' — ')[0]),
			`code: ${overrides.map((f) => f.code)}`,
		);
		const preset = JSON.parse(readFileSync(join(PRESET_DIR, `${id}.json`), 'utf8')) as {
			rules: Record<string, string>;
		};
		assert(
			overrides.every((f) => f.severity === preset.rules['system/override']),
			`at the preset's severity: ${overrides.map((f) => f.severity)}`,
		);
	});

await check('with no registry at all, an override reads as it did before surfaces', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds' }),
		'src/A.jsx':
			'import { __experimentalText as Text } from \'@wordpress/components\';\nexport const A = () => <Text className="acme-t">x</Text>;\n',
		'styles/a.css': '.acme-t { color: #f00; }\n',
	});
	try {
		const r = await analyze(await loadConfig({ root, configPath: join(root, 'loupe.config.json') }), { scope: null });
		const f = one(
			r.findings.filter((x) => x.rule === 'system/override'),
			'a colour on a bound Text should block',
		);
		assert(f.message === UNREAD('Text', 'color') && f.severity === 'error', `${f.severity} ${f.message}`);
	} finally {
		cleanup(root);
	}
});

// Two profiles active, one read for surfaces and one not: each component is read
// by the registry it came from, not by whether the run has surfaces somewhere.
await check('with WPDS and VIP both active, each component is read by its own registry', async () => {
	const r = await withProfiles(
		{
			'src/A.jsx': [
				"import { Notice } from '@wordpress/components';",
				"import { Text } from '@wordpress/ui';",
				"import { Button } from '@automattic/vip-design-system';",
				'export const A = () => <><Notice className="acme-n">x</Notice><Text className="acme-t">t</Text><Button className="acme-b">b</Button></>;',
			].join('\n'),
			'styles/a.css': '.acme-n { color: #333; }\n.acme-t { color: #333; }\n.acme-b { color: #333; }\n',
		},
		{
			extends: 'wpds',
			designSystem: { packages: ['@wordpress/components', '@wordpress/ui', '@automattic/vip-design-system'] },
		},
		['wpds', 'vip'],
	);
	const overrides = r.findings.filter((f) => f.rule === 'system/override').map((f) => f.message);
	// Notice has no surface in a registry that records them: a gap, advisory.
	// Text's surface does not list colour: `className` doing its job. VIP's
	// Button comes from a registry that records none: blocking, as before.
	assert(overrides.join('|') === UNREAD('Button', 'color'), `only the VIP component should report: ${overrides}`);
	const plain = r.findings.filter((f) => f.rule === 'tokens/hardcoded-value').map((f) => f.line);
	assert(plain.join() === '1,2', `the WPDS colours fall through to the plain verdict: ${plain}`);
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
		styleSources: [],
		cssInJsPackages: [],
		normalizeExports: null,
		layoutComponents: [],
		textComponents: [],
		knownComponents: new Set(),
		elementMap: new Map(),
		substitutionProps: new Set(),
		allowedInlineStyles: new Map(),
	});
	const several = renderTitle('tokens/hardcoded-value', ds(['--color-', '--space-']), 'k');
	assert(!several.includes('--color-*'), `several prefixes must not be reported as the namespace: ${several}`);
	assert(several.includes('design-system'), `the fallback should be generic: ${several}`);
	const single = renderTitle('tokens/hardcoded-value', ds(['--wpds-']), 'k');
	assert(single.includes('--wpds-*'), `a single prefix is the namespace and should be named: ${single}`);
});

// `components.layout`/`.text` are recognition lists: they carry every spelling
// a rule has to match, superseded ones included. Guidance that named the first
// *two* therefore named whatever sat in second place — `layout/in-css` read
// "use <Stack>/<HStack>" under WPDS, sending every flex fix to a legacy
// component that `system/superseded-component` then reports. Both halves are
// checked: the code names one entry, and the shipped lists put the canonical
// spelling there.
await check('guidance names the canonical component, never a superseded spelling', () => {
	const ds = (layout: string[], text: string[]): DesignSystem => ({
		name: 'X',
		packages: [],
		tokenPrefixes: [],
		tokenSources: [],
		styleSources: [],
		cssInJsPackages: [],
		normalizeExports: null,
		layoutComponents: layout,
		textComponents: text,
		knownComponents: new Set(),
		elementMap: new Map(),
		substitutionProps: new Set(),
		allowedInlineStyles: new Map(),
	});
	const flex = renderTitle('layout/in-css', ds(['Stack', 'HStack', 'VStack'], []), 'k');
	assert(flex.includes('<Stack>'), `the canonical primitive should be named: ${flex}`);
	assert(!/HStack|VStack/.test(flex), `a superseded spelling must not be recommended: ${flex}`);
	const type = renderTitle('typography/untokenized', ds([], ['Text', 'Heading']), 'k');
	assert(type.includes('<Text>') && !type.includes('<Heading>'), `text guidance names the canonical: ${type}`);
	// `(none)` is a real answer, and inventing a primitive is worse than saying so.
	const bare = renderTitle('layout/in-css', ds([], []), 'k');
	assert(bare.includes('a layout primitive'), `no primitive keeps the generic phrase: ${bare}`);

	// The data half: whatever each shipped preset puts first is a name that
	// system's own registry still recommends. Reordering a list silently turns
	// every one of these titles into a recommendation to write the old name.
	for (const id of ['wpds', 'archer', 'vip']) {
		const preset = JSON.parse(readFileSync(join(PRESET_DIR, `${id}.json`), 'utf8')) as {
			designSystem?: { components?: Record<string, string[]> };
		};
		const registry = loadComponents(
			JSON.parse(readFileSync(join(HERE, '..', '..', 'profiles', id, 'components', 'index.json'), 'utf8')),
		);
		for (const axis of ['layout', 'text']) {
			const canonical = preset.designSystem?.components?.[axis]?.[0];
			if (!canonical) continue;
			assert(
				!supersededEverywhere(registry, canonical),
				`${id} preset's ${axis} list is not canonical-first — guidance would recommend ${canonical}`,
			);
		}
	}
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
		'registry.json': JSON.stringify({
			realizations: [{ pattern: 'screen.overlay', note: 'anatomy', canonical: 'Dlg', signature: sig }],
		}),
	});
	const without = repo({
		...files,
		'registry.json': JSON.stringify({ realizations: [{ pattern: 'screen.overlay', note: 'anatomy', signature: sig }] }),
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

// An anatomy entry matches from the component's root down. A file that only
// renders a row, or a menu's popup, cuts the same anatomy below that root, and
// `TableRow(TableCell,TableCell,TableCell)` then reported as house style in
// every consumer with three tables — a component's parts, in the only shape
// they come in. The negative half keeps the fix from passing by silencing the
// rule, and `Tableau` is there because "starts with Table" is not "is a part".
await check('a registered component’s own parts, cut below its root, are not a composite', async () => {
	const file = (
		name: string,
	): string => `import { TableHead, TableRow, TableHeaderCell, TableCell, Tableau, TableauItem } from '@acme/ui';
export const ${name}Head = () => (
  <TableHead><TableRow><TableHeaderCell /><TableHeaderCell /><TableHeaderCell /></TableRow></TableHead>
);
export const ${name}Row = () => (
  <TableRow><TableCell /><TableCell /><TableCell /></TableRow>
);
export const ${name}Board = () => (
  <Tableau><TableauItem /><TableauItem /><TableauItem /></Tableau>
);
`;
	const root = repo({
		'loupe.config.json': JSON.stringify({ extends: 'generic', designSystem: { packages: ['@acme/ui'] } }),
		'registry.json': JSON.stringify({
			realizations: [
				{
					pattern: 'browse-collection#items',
					canonical: 'Table',
					signature: ['Table', ['TableBody', ['TableRow', 'TableCell']]],
				},
			],
		}),
		'src/A.jsx': file('A'),
		'src/B.jsx': file('B'),
		'src/C.jsx': file('C'),
	});
	try {
		const r = await analyzeWith(root, join(root, 'registry.json'));
		const shapes = new Set(r.findings.filter((f) => f.rule.startsWith('patterns/')).map((f) => f.code));
		assert(
			[...shapes].every((s) => !s?.startsWith('TableRow') && !s?.startsWith('TableHead')),
			`a Table's own parts must not report: ${[...shapes]}`,
		);
		assert(
			shapes.has('Tableau(TableauItem,TableauItem,TableauItem)'),
			`a different component that shares a prefix still reports: ${[...shapes]}`,
		);
	} finally {
		cleanup(root);
	}
});

// Rule options were removed. A config still written in that form has to say
// so, not report `bad severity for x: warn,[object Object]`.
await check('a rule in the removed [severity, options] form fails with the fix', async () => {
	const root = repo({
		'loupe.config.json': JSON.stringify({ rules: { 'tokens/hardcoded-value': ['warn', { allowZero: true }] } }),
	});
	try {
		const err = await loadConfig({ root, configPath: join(root, 'loupe.config.json') }).then(
			() => null,
			(e: unknown) => e,
		);
		assert(err instanceof Error && /no longer supported.*"warn"/.test(err.message), `got ${String(err)}`);
	} finally {
		cleanup(root);
	}
});

// ── project profiles (#75) ──────────────────────────────────────────────────
//
// `@automattic/vip-design-system` v3 is a rebuild of the system the shipped
// `vip` profile describes, under the same package name. Selection is by
// package, so the project got the v2 profile — and the authoring skill then
// loaded v2's `authoring.md` — with no way to supply its own except a
// `--profiles` that no hook, command or skill passes, and that replaced the
// shipped set when it was passed by hand.

const VIP = '@automattic/vip-design-system';

/** The reporter's repro: a VIP v3 project carrying its own profile under `at`. */
function vipV3(config: Record<string, unknown>, at = 'loupe/profiles'): string {
	return repo({
		'package.json': JSON.stringify({ name: 'repro', dependencies: { [VIP]: '^3.0.0' } }),
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			designSystem: { name: 'VIP v3', packages: [VIP] },
			...config,
		}),
		[`${at}/vip-v3/profile.json`]: JSON.stringify({ id: 'vip-v3', name: 'VIP Design System v3', packages: [VIP] }),
		[`${at}/vip-v3/authoring.md`]: '# v3 authoring\n',
	});
}

/**
 * `loupe status`'s `profile:` line, run from the project the way the hooks run
 * it: the shipped `--profiles` and nothing about the project's own.
 */
function profileLine(root: string, ...extra: string[]): { line: string; stderr: string } {
	const home = scratch('loupe-pp-home-');
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_')) delete env[k];
		const r = spawnSync(process.execPath, [CLI, 'status', '--profiles', PROFILES, ...extra], {
			cwd: root,
			encoding: 'utf8',
			env,
		});
		if (r.error) throw r.error;
		const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('profile:')) ?? '';
		return { line, stderr: r.stderr ?? '' };
	} finally {
		cleanup(home);
	}
}

await check('a project profile from the config wins over the shipped one on its package', () => {
	const root = vipV3({ profiles: './loupe/profiles' });
	try {
		const { line } = profileLine(root);
		assert(
			line.includes(`vip-v3 (VIP Design System v3) — ${join(root, 'loupe', 'profiles', 'vip-v3')}`),
			`status should name the project's profile and its directory, got: ${line}`,
		);
		assert(!/\bvip \(/.test(line), `the shipped vip profile must not be selected beside it: ${line}`);
	} finally {
		cleanup(root);
	}
});

await check('.loupe/profiles is read with no config key and no flag', () => {
	const root = vipV3({}, '.loupe/profiles');
	try {
		const { line } = profileLine(root);
		assert(line.includes(`vip-v3 (VIP Design System v3) — ${join(root, '.loupe', 'profiles', 'vip-v3')}`), line);
	} finally {
		cleanup(root);
	}
});

await check('project profiles are merged with the shipped set, not swapped for it', () => {
	const root = vipV3({});
	try {
		const all = readProfileRoots(
			profileRoots({ root, configured: [join(root, 'loupe', 'profiles')], shipped: PROFILES }),
		);
		const ids = all.map((p) => p.id);
		for (const id of ['vip-v3', 'vip', 'wpds', 'archer'])
			assert(ids.includes(id), `expected ${id} among the merged profiles, got ${ids.join(', ')}`);
		assert(all.find((p) => p.id === 'vip-v3')?.origin === 'project', 'the project profile is marked as such');
		assert(all.find((p) => p.id === 'wpds')?.origin === 'shipped', 'a shipped profile is marked as such');
		// The shipped set still selects for the projects it describes…
		const wp = selectProfiles(all, { designSystem: { packages: ['@wordpress/components'] } });
		assert(wp.map((p) => p.id).join() === 'wpds', `wpds should still select, got ${wp.map((p) => p.id)}`);
		// …and the shadowed one can still be named outright.
		assert(selectProfiles(all, { designSystem: { packages: [VIP] } }, 'vip')[0]?.id === 'vip', 'vip by id');
	} finally {
		cleanup(root);
	}
});

await check('a project profile shadows a shipped one only over packages the project imports', () => {
	const all = [
		{ id: 'acme', packages: ['@acme/ui', '@wordpress/components'], ranges: new Map(), origin: 'project' },
		{ id: 'wpds', packages: ['@wordpress/components', '@wordpress/ui'], ranges: new Map(), origin: 'shipped' },
	] as unknown as Parameters<typeof selectProfiles>[0];
	const ids = (pkgs: string[]): string =>
		selectProfiles(all, { designSystem: { packages: pkgs } })
			.map((p) => p.id)
			.join();
	const apart = ids(['@acme/ui', '@wordpress/ui']);
	assert(apart === 'acme,wpds', `no package imported by both, both select: ${apart}`);
	const shared = ids(['@acme/ui', '@wordpress/components']);
	assert(shared === 'acme', `a package imported by both shadows the shipped one: ${shared}`);
});

await check('a profile with the reserved id "none" is not read', () => {
	const root = repo({
		'none/profile.json': JSON.stringify({ packages: ['@acme/ui'] }),
		'acme/profile.json': JSON.stringify({ id: 'none', packages: ['@acme/ui'] }),
	});
	try {
		const ids = readProfiles(root).map((p) => p.id);
		assert(ids.length === 0, `got ${ids.join(', ')}`);
	} finally {
		cleanup(root);
	}
});

await check('a project profile wins on a shared id', () => {
	const root = repo({
		'package.json': JSON.stringify({ name: 'repro', dependencies: { [VIP]: '^3.0.0' } }),
		'loupe.config.json': JSON.stringify({ extends: 'generic', designSystem: { packages: [VIP] } }),
		'.loupe/profiles/vip/profile.json': JSON.stringify({ id: 'vip', name: 'VIP, rebuilt', packages: [VIP] }),
	});
	try {
		const { line } = profileLine(root);
		assert(line.includes(`vip (VIP, rebuilt) — ${join(root, '.loupe', 'profiles', 'vip')}`), line);
	} finally {
		cleanup(root);
	}
});

await check('a config profiles path is relative to the config file that wrote it', async () => {
	const root = repo({
		'shared/loupe.base.json': JSON.stringify({ extends: 'generic', profiles: './profiles' }),
		'shared/profiles/acme/profile.json': JSON.stringify({ id: 'acme', packages: ['@acme/ui'] }),
		'app/loupe.config.json': JSON.stringify({ extends: '../shared/loupe.base.json' }),
	});
	try {
		const config = await loadConfig({ root: join(root, 'app') });
		assert(
			config.profileDirs.join() === join(root, 'shared', 'profiles'),
			`expected the shared config's own directory, got ${config.profileDirs}`,
		);
	} finally {
		cleanup(root);
	}
});

await check('"profile" pins selection, and --profile outranks it', () => {
	const off = vipV3({ profile: 'none' });
	try {
		const { line } = profileLine(off);
		assert(/^profile:\s+none selected — pinned to "none"/.test(line), `got: ${line}`);
	} finally {
		cleanup(off);
	}
	const pinned = vipV3({ profiles: './loupe/profiles', profile: 'wpds' });
	try {
		const { line } = profileLine(pinned);
		assert(/^profile:\s+wpds \(/.test(line) && !line.includes('vip'), `the pin should select wpds alone: ${line}`);
	} finally {
		cleanup(pinned);
	}
	const typed = vipV3({ profiles: './loupe/profiles', profile: 'none' });
	try {
		const { line } = profileLine(typed, '--profile', 'vip-v3');
		assert(/^profile:\s+vip-v3 \(/.test(line), `--profile should win over the config, got: ${line}`);
	} finally {
		cleanup(typed);
	}
});

// The workaround the issue had to use — `"packages": []` — took every rule
// that needs packages down with the wrong profile.
await check('"profile": "none" keeps the rules that need packages on', async () => {
	const root = vipV3({ profile: 'none' });
	try {
		const config = await loadConfig({ root });
		assert(config.profilePin === 'none', `got ${config.profilePin}`);
		assert(config.designSystem.packages.join() === VIP, 'the packages survive the pin');
		assert(config.enabled['patterns/unregistered-composite'], 'unregistered-composite stays on');
		const all = readProfileRoots(profileRoots({ root, shipped: PROFILES }));
		assert(selectProfiles(all, config, config.profilePin).length === 0, 'none selects nothing');
	} finally {
		cleanup(root);
	}
});

await check('a pin naming no profile says so', () => {
	const root = vipV3({ profile: 'nope' });
	try {
		const { stderr } = profileLine(root);
		assert(/no profile "nope" \(the config's "profile"\)/.test(stderr), `got: ${stderr}`);
	} finally {
		cleanup(root);
	}
});

await check('a project profile that fails to load says so, rather than leaving the shipped one silently', () => {
	const root = vipV3({ profiles: './loupe/profiles' });
	try {
		writeFileSync(join(root, 'loupe', 'profiles', 'vip-v3', 'profile.json'), '{ "id": "vip-v3", ');
		// On v2, which the shipped profile covers: on v3 its range keeps it out anyway.
		writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [VIP]: '^2.30.0' } }));
		const { line, stderr } = profileLine(root);
		assert(
			stderr.includes(
				`project profile skipped, could not load ${join(root, 'loupe', 'profiles', 'vip-v3', 'profile.json')}`,
			),
			`got: ${stderr}`,
		);
		// What it warns about: the shipped profile it was written to replace is back.
		assert(/\bvip \(/.test(line), `the shipped vip profile selects in its place: ${line}`);
	} finally {
		cleanup(root);
	}
});

await check('a malformed profiles or profile key is a config error, not "none"', async () => {
	for (const bad of [{ profiles: 3 }, { profiles: [''] }, { profile: '' }, { profile: ['vip'] }]) {
		const root = repo({ 'loupe.config.json': JSON.stringify(bad) });
		try {
			const err = await loadConfig({ root }).then(
				() => null,
				(e: unknown) => e,
			);
			assert(err instanceof Error && /^profiles? must be/.test(err.message), `${JSON.stringify(bad)}: ${String(err)}`);
		} finally {
			cleanup(root);
		}
	}
});

// ── any listed package selects (#187) ───────────────────────────────────────
//
// The wpds profile lists five packages. The two newest are the design system's
// too, and a project on either alone is on WPDS — so either one, declared on
// its own, selects the profile.

for (const pkg of ['@wordpress/admin-ui', '@wordpress/ui'])
	await check(`a config declaring only ${pkg} selects the wpds profile`, async () => {
		const root = repo({
			'loupe.config.json': JSON.stringify({ extends: 'generic', designSystem: { packages: [pkg] } }),
		});
		try {
			const config = await loadConfig({ root });
			const ids = selectProfiles(readProfiles(PROFILES), config).map((p) => p.id);
			assert(ids.join() === 'wpds', `expected wpds alone, got ${ids.join(', ') || 'nothing'}`);
		} finally {
			cleanup(root);
		}
	});

// ── the shipped profiles need no flag (#80) ─────────────────────────────────
//
// `bin/loupe` added `--profiles <shipped>` only when the caller named none, so a
// `--profiles` typed to try one directory silently dropped the shipped set —
// and the registries of any shipped system the project also imports with it.

/** `loupe status` with exactly the flags given: no `--profiles` unless the caller passes one. */
function statusOf(root: string, ...args: string[]): { stdout: string; stderr: string; line: string } {
	const home = scratch('loupe-st-home-');
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_')) delete env[k];
		const r = spawnSync(process.execPath, [CLI, 'status', ...args], { cwd: root, encoding: 'utf8', env });
		if (r.error) throw r.error;
		const stdout = r.stdout ?? '';
		return { stdout, stderr: r.stderr ?? '', line: stdout.split('\n').find((l) => l.startsWith('profile:')) ?? '' };
	} finally {
		cleanup(home);
	}
}

/** A directory holding one profile, `acme`, for `@acme/ui`. */
function acmeProfiles(name = 'Acme'): string {
	const dir = scratch('loupe-acme-');
	writeAll(dir, { 'acme/profile.json': JSON.stringify({ id: 'acme', name, packages: ['@acme/ui'] }) });
	return dir;
}

/** A project on two systems: one the shipped set describes, one it does not. */
const bothSystems = (): string =>
	repo({
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			designSystem: { packages: ['@acme/ui', '@wordpress/components'] },
		}),
	});

await check('the engine reads the shipped profiles with no --profiles at all', () => {
	const root = bothSystems();
	try {
		const { line } = statusOf(root);
		assert(line.includes(`wpds (WordPress Design System) — ${join(PROFILES, 'wpds')}`), `got: ${line}`);
	} finally {
		cleanup(root);
	}
});

await check('--profiles adds to the shipped profiles instead of replacing them', () => {
	const root = bothSystems();
	const extra = acmeProfiles();
	try {
		const { line } = statusOf(root, '--profiles', extra);
		assert(/\bacme \(Acme\)/.test(line), `the directory passed should be read: ${line}`);
		assert(/\bwpds \(/.test(line), `the shipped wpds profile should still select: ${line}`);
	} finally {
		cleanup(root);
		cleanup(extra);
	}
});

await check('--profiles repeats, read in order, the first to carry an id keeping it', () => {
	const root = bothSystems();
	const before = acmeProfiles('Acme, first');
	const after = acmeProfiles('Acme, second');
	try {
		writeAll(after, { 'beta/profile.json': JSON.stringify({ id: 'beta', packages: ['@acme/ui'] }) });
		const { line } = statusOf(root, '--profiles', before, '--profiles', after);
		assert(/\bacme \(Acme, first\)/.test(line) && !line.includes('second'), `the first acme should win: ${line}`);
		assert(/\bbeta \(/.test(line), `the second directory should still be read: ${line}`);
		assert(/\bwpds \(/.test(line), `and the shipped set: ${line}`);
	} finally {
		cleanup(root);
		cleanup(before);
		cleanup(after);
	}
});

await check('the shipped directory passed again, by any path to it, is read once', () => {
	const root = bothSystems();
	const link = join(scratch('loupe-link-'), 'profiles');
	try {
		symlinkSync(PROFILES, link);
		const roots = profileRoots({ root, shipped: PROFILES, flags: [PROFILES, link] });
		assert(roots.filter((r) => r.origin === 'shipped').length === 1, `got ${roots.map((r) => r.dir).join(', ')}`);
		// The hooks and commands still pass it, as `${CLAUDE_PLUGIN_ROOT}/profiles`.
		const { line, stderr } = statusOf(root, '--profiles', link);
		assert(line.includes(`wpds (WordPress Design System) — ${join(PROFILES, 'wpds')}`), `got: ${line}`);
		assert(!stderr.includes('loupe:'), `reading it twice should say nothing: ${stderr}`);
	} finally {
		cleanup(root);
		cleanup(dirname(link));
	}
});

await check('--patterns leaves the shipped profiles out, and a pin says that is why', () => {
	const root = bothSystems();
	try {
		writeAll(root, { 'registry.json': JSON.stringify({ realizations: [] }) });
		const { line, stderr } = statusOf(root, '--patterns', join(root, 'registry.json'), '--profile', 'wpds');
		assert(!/\bwpds \(/.test(line), `the shipped set should be left out: ${line}`);
		assert(/--patterns leaves the shipped profiles out/.test(stderr), `got: ${stderr}`);
	} finally {
		cleanup(root);
	}
});

// ── version ranges (#79) ────────────────────────────────────────────────────
//
// Selection by name alone gave a VIP v3 project the profile written for v2.

/** One profile claiming `@acme/ui` for `range`, read the way the CLI reads it. */
function rangedProfile(range: unknown, origin: 'project' | 'shipped' = 'shipped') {
	const dir = scratch('loupe-ranged-');
	try {
		writeAll(dir, { 'acme/profile.json': JSON.stringify({ id: 'acme', packages: { '@acme/ui': range } }) });
		const unreadable: string[] = [];
		return { profiles: readProfiles(dir, origin, unreadable), unreadable };
	} finally {
		cleanup(dir);
	}
}

const acme = { designSystem: { packages: ['@acme/ui'] } };
const declares = (range: string) => () => ({ range, manifest: 'package.json' });

await check('packages may map each package to the range it describes', () => {
	const { profiles } = rangedProfile('<3');
	const p = one(profiles, 'the object form should read');
	assert(p.packages.join() === '@acme/ui', `got ${p.packages.join()}`);
	assert(p.ranges.get('@acme/ui') === '<3', `got ${p.ranges.get('@acme/ui')}`);
	const dir = profileDir();
	try {
		const listed = one(readProfiles(dir), 'the list form should still read');
		assert(listed.ranges.size === 0, 'a listed package is claimed at any version');
	} finally {
		cleanup(dir);
	}
});

await check('a range that does not read is a profile that does not load, and says so', () => {
	for (const bad of ['=>3', 'latest', 3, null]) {
		const { profiles, unreadable } = rangedProfile(bad, 'project');
		assert(!profiles.length, `${JSON.stringify(bad)} should not load`);
		assert(
			unreadable.some((u) => u.includes(`${JSON.stringify(bad)} for @acme/ui is not a version range`)),
			`got: ${unreadable.join('; ')}`,
		);
	}
});

await check('a declared range selects a ranged profile where the two overlap', () => {
	const { profiles } = rangedProfile('<3');
	const pick = (range: string, outOfRange: OutOfRange[] = []): string =>
		selectProfiles(profiles, acme, null, { declared: declares(range), outOfRange })
			.map((p) => p.id)
			.join();
	for (const range of ['^2.3.0', '~2.9.1', '>=2', '*', '^1 || ^3', 'workspace:*', 'latest', 'github:acme/ui'])
		assert(pick(range) === 'acme', `${range} overlaps <3, or says nothing a range can check`);
	const outOfRange: OutOfRange[] = [];
	assert(pick('^3.0.0', outOfRange) === '', '^3.0.0 does not overlap <3');
	assert(
		JSON.stringify(outOfRange) ===
			JSON.stringify([{ profile: 'acme', pkg: '@acme/ui', range: '<3', declared: '^3.0.0', manifest: 'package.json' }]),
		`the profile left out should be recorded: ${JSON.stringify(outOfRange)}`,
	);
	assert(selectProfiles(profiles, acme).length === 1, 'nothing declared is any version');
	assert(
		selectProfiles(profiles, acme, 'acme', { declared: declares('^3.0.0') }).length === 1,
		'a pin skips the range',
	);
});

await check('a profile out of range on one package still selects on another', () => {
	const dir = scratch('loupe-two-');
	try {
		writeAll(dir, {
			'acme/profile.json': JSON.stringify({ id: 'acme', packages: { '@acme/ui': '<3', '@acme/icons': '*' } }),
		});
		const outOfRange: OutOfRange[] = [];
		const ids = selectProfiles(readProfiles(dir), { designSystem: { packages: ['@acme/ui', '@acme/icons'] } }, null, {
			declared: declares('^3.0.0'),
			outOfRange,
		}).map((p) => p.id);
		assert(ids.join() === 'acme' && !outOfRange.length, `got ${ids.join()} / ${JSON.stringify(outOfRange)}`);
	} finally {
		cleanup(dir);
	}
});

await check('a project profile out of range shadows nothing', () => {
	const { profiles: own } = rangedProfile('>=4', 'project');
	const { profiles: shipped } = rangedProfile('<4');
	const picked = selectProfiles([...own, ...shipped], acme, null, { declared: declares('^3.1.0') });
	const origins = picked.map((p) => p.origin).join();
	assert(origins === 'shipped', `the shipped profile covers ^3.1.0 and should select alone: ${origins}`);
});

await check('the declared range is the shallowest manifest naming the package, installed field first', () => {
	const root = repo({
		'package.json': JSON.stringify({ name: 'mono', devDependencies: { '@wordpress/env': '^10' } }),
		'apps/web/package.json': JSON.stringify({
			peerDependencies: { [VIP]: '^2 || ^3' },
			devDependencies: { [VIP]: '^3.1.0' },
		}),
		'apps/web/old/package.json': JSON.stringify({ dependencies: { [VIP]: '^2.0.0' } }),
	});
	try {
		const declared = declaredVersions(root);
		const vip = declared(VIP);
		assert(vip?.range === '^3.1.0' && vip.manifest === 'apps/web/package.json', `got ${JSON.stringify(vip)}`);
		assert(declared('@acme/ui') === null, 'a package no manifest names has no declared range');
	} finally {
		cleanup(root);
	}
});

await check('the shipped vip profile describes v2 only', () => {
	const vip = first(
		readProfiles(PROFILES).filter((p) => p.id === 'vip'),
		'the vip profile ships',
	);
	assert(vip.ranges.get(VIP) === '<3', `got ${vip.ranges.get(VIP)}`);
});

await check('a v3 project does not get the v2 profile, and status names the range that kept it out', () => {
	const config = JSON.stringify({ extends: 'generic', designSystem: { packages: [VIP] } });
	const v3 = repo({
		'package.json': JSON.stringify({ dependencies: { [VIP]: '^3.0.0' } }),
		'loupe.config.json': config,
	});
	const v2 = repo({
		'package.json': JSON.stringify({ dependencies: { [VIP]: '^2.23.0' } }),
		'loupe.config.json': config,
	});
	try {
		const out = statusOf(v3);
		assert(/^profile:\s+none selected/.test(out.line), `got: ${out.line}`);
		const why = out.stdout.split('\n').filter((l) => l.includes('not selected'));
		assert(
			why.length === 1 &&
				why[0]?.trim() === `vip not selected — ${VIP} is ^3.0.0 in package.json, outside the <3 it describes`,
			`expected one line naming the range, got:\n${why.join('\n')}`,
		);
		const on = statusOf(v2);
		assert(/^profile:\s+vip \(/.test(on.line), `a v2 project should still get it: ${on.line}`);
		assert(!on.stdout.includes('not selected'), `nothing was kept out on v2:\n${on.stdout}`);
	} finally {
		cleanup(v3);
		cleanup(v2);
	}
});

finish();
