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

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { loadConfig, setComponentRegistry, setPatterns } from '../src/config.mjs';
import { matches, toNode } from '../src/patterns.mjs';
import { registryApplies } from '../src/registry.mjs';
import { readProfiles, selectProfiles, applyRegistries } from '../src/profiles.mjs';
import { detectPreset } from '../src/detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_DIR = join(HERE, '..', 'presets');

let failed = 0;
const check = async (name, fn) => {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL ${name}\n     ${err.message}`);
	}
};
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

/** Write a throwaway repo and hand back its root. */
function repo(files) {
	const root = mkdtempSync(join(tmpdir(), 'loupe-mds-'));
	for (const [rel, body] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
	return root;
}

/** The same page header, built from whichever package the caller names. */
const pageHeader = (pkg, name) => `import { Stack, Text, Button } from '${pkg}';
export const ${name} = () => (
  <Stack>
    <Stack><Text>Title</Text><Text>Sub</Text></Stack>
    <Stack><Button>Go</Button></Stack>
  </Stack>
);
`;

const PAGE_HEADER_SIG = ['Stack', ['Stack', 'Text', 'Text'], ['Stack', 'Button']];

const registryFile = (packages) =>
	JSON.stringify({
		packages,
		patterns: [{ id: 'page-header', summary: 'header', signature: PAGE_HEADER_SIG }],
	});

const configFor = (pkg) =>
	JSON.stringify({
		extends: 'generic',
		designSystem: { packages: [pkg], components: { layout: ['Stack'], text: ['Text'] } },
	});

/** Analyze `root`, attaching `patternsPath` the way the CLI would. */
async function analyzeWith(root, patternsPath) {
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
		rmSync(root, { recursive: true, force: true });
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
		rmSync(root, { recursive: true, force: true });
	}
});

await check('a registry naming no packages still applies anywhere', () => {
	assert(registryApplies({ patterns: [] }, ['@acme/ui']), 'an unscoped registry must keep working');
	assert(registryApplies({ packages: [] }, ['@acme/ui']), 'an empty scope is no scope');
	assert(!registryApplies({ packages: ['@a/b'] }, []), 'a project with no packages has no component layer');
});

// ── qualified signatures ────────────────────────────────────────────────────

await check('a package-qualified node matches only that package', () => {
	const pattern = toNode(['@wordpress/components::Stack', '@wordpress/components::Button']);
	const wp = { name: 'Stack', pkg: '@wordpress/components', children: [{ name: 'Button', pkg: '@wordpress/components', children: [] }] };
	const chakra = { name: 'Stack', pkg: '@chakra-ui/react', children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }] };
	assert(matches(pattern, wp), 'should match its own package');
	assert(!matches(pattern, chakra), 'must not match another package');
});

await check('an unqualified node still matches any package', () => {
	const pattern = toNode(['Stack', 'Button']);
	const chakra = { name: 'Stack', pkg: '@chakra-ui/react', children: [{ name: 'Button', pkg: '@chakra-ui/react', children: [] }] };
	const unknown = { name: 'Stack', pkg: null, children: [{ name: 'Button', pkg: null, children: [] }] };
	assert(matches(pattern, chakra), 'bare names are the default and must stay permissive');
	// An import the scanner could not resolve is not evidence of a mismatch.
	assert(matches(toNode(['@x/y::Stack', 'Button']), unknown), 'an unknown package must not block a match');
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
		rmSync(root, { recursive: true, force: true });
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
		rmSync(root, { recursive: true, force: true });
	}
});

await check('a preset with no detect block is never inferred', async () => {
	const root = repo({ 'package.json': '{}' });
	try {
		assert(detectPreset(root).preset === 'generic', 'a parent preset is not a conclusion');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── profiles ────────────────────────────────────────────────────────────────

function profileDir() {
	const root = mkdtempSync(join(tmpdir(), 'loupe-prof-'));
	mkdirSync(join(root, 'acme'), { recursive: true });
	writeFileSync(
		join(root, 'acme', 'profile.json'),
		JSON.stringify({ id: 'acme', name: 'Acme DS', packages: ['@acme/ui'], patterns: './patterns.json' })
	);
	writeFileSync(join(root, 'acme', 'patterns.json'), registryFile(['@acme/ui']));
	// A directory with no manifest is not a profile, and must not throw.
	mkdirSync(join(root, 'not-a-profile'), { recursive: true });
	return root;
}

await check('profiles are read from disk, junk directories ignored', () => {
	const dir = profileDir();
	try {
		const profiles = readProfiles(dir);
		assert(profiles.length === 1, `expected 1 profile, got ${profiles.length}`);
		assert(profiles[0].id === 'acme' && profiles[0].name === 'Acme DS', 'manifest fields should survive');
		assert(profiles[0].patterns.endsWith('patterns.json'), 'registry path should resolve against the profile dir');
		assert(readProfiles(join(dir, 'nope')).length === 0, 'a missing directory is not an error');
	} finally {
		rmSync(dir, { recursive: true, force: true });
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
		rmSync(dir, { recursive: true, force: true });
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
		assert(out.skipped.length === 1, 'the skip must be reported');
		assert(out.skipped[0].packages.includes('@wordpress/components'), 'the report should name the scope');
	} finally {
		rmSync(root, { recursive: true, force: true });
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
		rmSync(root, { recursive: true, force: true });
	}
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
