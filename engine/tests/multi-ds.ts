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
import { assert, check, cleanup, finish, one, scratch, writeAll } from './harness.ts';
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
