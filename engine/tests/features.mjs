#!/usr/bin/env node
/**
 * The three channels and the two cross-file rules.
 *
 * Everything here reports across boundaries a single-file linter cannot see —
 * a token set assembled from the whole repo, a template literal, a composite
 * counted across files. Each is easy to break silently in a way that produces
 * *fewer* findings, which no failing build ever reveals.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyze.mjs';
import { loadConfig, setComponentRegistry, setPatterns } from '../src/config.mjs';
import { loadPatterns, matches, toNode } from '../src/patterns.mjs';
import { loadComponents } from '../src/components.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY = join(HERE, '..', '..', 'patterns', 'index.json');
const COMPONENT_REGISTRY = join(HERE, '..', '..', 'components', 'index.json');

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

/** Analyze a throwaway repo. `files` maps relative path to contents. */
async function run(files, { patterns, components } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'dsh-feat-'));
	try {
		for (const [rel, body] of Object.entries(files)) {
			const p = join(root, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, body);
		}
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		if (patterns) setPatterns(config, patterns);
		if (components) setComponentRegistry(config, components);
		const result = await analyze(config, { scope: null });
		return result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const CONFIG = (extra = {}) =>
	JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] }, ...extra });
const TOKENS = ':root { --wpds-border-radius-md: 4px; --wpds-color-fg-content-neutral: #1e1e1e;\n' +
	'--wpds-color-bg-surface-neutral: #fcfcfc; --wpds-typography-font-size-md: 13px; }';
const at = (r, rule) => r.findings.filter((f) => f.rule === rule);

// ── the token set ───────────────────────────────────────────────────────────

await check('a hardcoded value names the token that carries it', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { tokenSources: ['tokens.css'] } }),
		'tokens.css': TOKENS,
		'styles/a.css': '.acme-card { border-radius: 4px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	const [f] = at(r, 'tokens/hardcoded-value');
	assert(f, 'expected a hardcoded-value finding');
	assert(f.message.includes('var(--wpds-border-radius-md)'), `named nothing useful: ${f.message}`);
});

// `#fcfcfc` is a real token — a background one. Offering it for `color` gives
// the right pixels and the wrong meaning, and that survives review.
await check('an off-role token is never offered', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { tokenSources: ['tokens.css'] } }),
		'tokens.css': TOKENS,
		'styles/a.css': '.acme-card { color: #fcfcfc; }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	const [f] = at(r, 'tokens/hardcoded-value');
	assert(f, 'expected a hardcoded-value finding');
	assert(!f.message.includes('var('), `offered a background token for a foreground: ${f.message}`);
});

await check('unknown-token stays silent when no token set was found', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': '.acme-card { color: var(--wpds-definitely-not-a-token); }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	assert(!at(r, 'tokens/unknown-token').length, 'declared a token unknown with nothing to check against');
});

await check('unknown-token fires once a token set exists', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { tokenSources: ['tokens.css'] } }),
		'tokens.css': TOKENS,
		'styles/a.css': '.acme-card { color: var(--wpds-nope); border-radius: var(--wpds-border-radius-md); }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	const found = at(r, 'tokens/unknown-token');
	assert(found.length === 1, `expected exactly one, got ${found.map((f) => f.message)}`);
	assert(found[0].message.includes('--wpds-nope'), found[0].message);
});

// A reset has no token to reach for, and demanding one for every `inherit` is
// how a rule gets switched off.
await check('a keyword or zero is not untokenized type styling', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': '.acme-t { font-family: inherit; line-height: 0; font-weight: normal; }',
		'src/A.jsx': 'export const A = () => <span className="acme-t" />;',
	});
	assert(!at(r, 'typography/untokenized').length, `flagged inert values: ${at(r, 'typography/untokenized').map((f) => f.message)}`);
});

// ── CSS-in-JS ───────────────────────────────────────────────────────────────

const STYLED = [
	"import styled from 'styled-components';",
	"import { Button, __experimentalText as Text } from '@wordpress/components';",
	'const Card = styled.div`',
	'\tdisplay: flex;',
	'\tmargin-bottom: 16px;',
	'\tcolor: ${(p) => p.theme.fg};',
	'`;',
	'const Fancy = styled(Button)`',
	'\tbackground: #f00;',
	'`;',
	'const Typo = styled(Text)`',
	'\tfont-weight: 600;',
	'`;',
].join('\n');

await check('styled.div declarations are classified and located exactly', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/Card.tsx': STYLED });
	const layout = at(r, 'layout/in-css');
	const margin = at(r, 'layout/margin-on-child');
	assert(layout.length === 1 && layout[0].line === 4, `layout at ${layout.map((f) => f.line)}, want [4]`);
	assert(margin.length === 1 && margin[0].line === 5, `margin at ${margin.map((f) => f.line)}, want [5]`);
	assert(layout[0].message.includes('css-in-js'), 'the channel should be named in the message');
});

await check('styled(Component) inherits that component’s verdict', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/Card.tsx': STYLED });
	const override = at(r, 'system/override');
	const typo = at(r, 'typography/in-css');
	assert(override.some((f) => f.line === 9), `styled(Button) should be an override; got ${override.map((f) => f.line)}`);
	assert(typo.some((f) => f.line === 12), `styled(Text) should be typography/in-css; got ${typo.map((f) => f.line)}`);
});

await check('an interpolated value produces no finding', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/Card.tsx': STYLED });
	assert(!r.findings.some((f) => f.line === 6), `guessed at an opaque value: ${r.findings.filter((f) => f.line === 6).map((f) => f.message)}`);
});

await check('a descendant selector does not answer for the styled component', async () => {
	const src = [
		"import styled from 'styled-components';",
		"import { Button } from '@wordpress/components';",
		'const F = styled(Button)`',
		'\t.child { background: #f00; }',
		'`;',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/F.tsx': src });
	assert(!at(r, 'system/override').length, 'a .child rule is not an override of the component');
	assert(at(r, 'tokens/hardcoded-value').length === 1, 'it is still a hardcoded value');
});

await check('a tagged template from an unrelated library is left alone', async () => {
	const src = ["import gql from 'graphql-tag';", 'const q = gql`{ user { margin } }`;'].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/q.ts': src });
	assert(!r.findings.length, `read a GraphQL document as CSS: ${r.findings.map((f) => f.message)}`);
});

// ── composites ──────────────────────────────────────────────────────────────

const registry = loadPatterns(JSON.parse(await import('node:fs').then((m) => m.readFileSync(REGISTRY, 'utf8'))));
const componentRegistry = loadComponents(JSON.parse(readFileSync(COMPONENT_REGISTRY, 'utf8')));

await check('a registered pattern matches through nesting and extra siblings', () => {
	const formModal = registry.find((p) => p.id === 'form-modal');
	// The registry records the footer as a sibling of the body; real code nests it.
	const real = toNode(['Modal', ['Stack', 'TextControl', ['Stack', 'Button', 'Button']]]);
	assert(matches(formModal.node, real), 'nested footer should still be a form-modal');
	const noFooter = toNode(['Modal', ['Stack', 'TextControl']]);
	assert(!matches(formModal.node, noFooter), 'a modal with no action pair is not a form-modal');
});

await check('a registered child must claim a distinct node', () => {
	const twoTexts = toNode(['VStack', 'Text', 'Text']);
	assert(!matches(twoTexts, toNode(['VStack', 'Text'])), 'one Text should not satisfy two');
	assert(matches(twoTexts, toNode(['VStack', 'Text', 'Text'])), 'two Texts should');
});

const composite = (n) =>
	[
		"import { EmptyState, Button } from '@wordpress/ui';",
		`export const Screen${n} = () => (`,
		'\t<EmptyState.Root>',
		'\t\t<EmptyState.Title>Nothing here</EmptyState.Title>',
		'\t\t<EmptyState.Description>Try a different filter.</EmptyState.Description>',
		'\t\t<div className="acme-actions"><EmptyState.Actions><Button>A</Button></EmptyState.Actions></div>',
		'\t</EmptyState.Root>',
		');',
	].join('\n');

await check('a registered pattern rebuilt in two files is reported in both', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': composite('A'),
			'src/B.jsx': composite('B'),
		},
		{ patterns: registry }
	);
	const dup = at(r, 'patterns/duplicate-composite');
	assert(dup.length === 2, `expected one per file, got ${dup.length}`);
	assert(dup[0].message.includes('empty-state'), `named the wrong pattern: ${dup[0].message}`);
});

await check('one file is a first use, not a duplicate', async () => {
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': composite('A') },
		{ patterns: registry }
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'a single instance is not drift');
});

// `HStack(Button,Button)` is a true description of an action bar and a useless
// finding — it matched 48 files in one repo.
await check('a signature below the floor is documentation, not a check', async () => {
	const src = [
		"import { __experimentalHStack as HStack, Button } from '@wordpress/components';",
		'export const Bar = () => (<HStack><Button>A</Button><Button>B</Button></HStack>);',
	].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src, 'src/B.jsx': src.replace('Bar', 'Bar2') },
		{ patterns: registry }
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'action-bar is too generic to check');
});

await check('an unregistered shape needs three files before it is house style', async () => {
	const shape = (n) =>
		[
			"import { __experimentalVStack as VStack, __experimentalHStack as HStack, __experimentalText as Text, Button, Notice } from '@wordpress/components';",
			`export const W${n} = () => (<VStack><Notice>n</Notice><HStack><Text>t</Text><Button>b</Button></HStack></VStack>);`,
		].join('\n');
	const two = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': shape('A'), 'src/B.jsx': shape('B') },
		{ patterns: registry }
	);
	assert(!at(two, 'patterns/unregistered-composite').length, 'two is a coincidence');
	const three = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': shape('A'), 'src/B.jsx': shape('B'), 'src/C.jsx': shape('C') },
		{ patterns: registry }
	);
	assert(at(three, 'patterns/unregistered-composite').length === 3, 'three is a pattern');
});

// ── component currency ────────────────────────────────────────────────────

await check('a locked component is reported, its recommended sibling is not', async () => {
	const src = [
		"import { Badge } from '@wordpress/components';",
		"import { Badge as UiBadge } from '@wordpress/ui';",
		'export const A = () => (<><Badge>old</Badge><UiBadge>new</UiBadge></>);',
	].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry }
	);
	const locked = at(r, 'system/locked-component');
	assert(locked.length === 1, `expected one locked finding, got ${locked.length}`);
	assert(locked[0].message.includes('@wordpress/components'), `wrong package named: ${locked[0].message}`);
	assert(!at(r, 'system/superseded-component').length, 'the @wordpress/ui sibling should not also be flagged legacy');
});

await check('a superseded component names its replacement, once per file', async () => {
	const src = [
		"import { __experimentalHStack as HStack, Button } from '@wordpress/components';",
		'export const A = () => (<HStack><Button>a</Button><Button>b</Button></HStack>);',
		'export const B = () => (<HStack><Button>c</Button></HStack>);',
	].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry }
	);
	const superseded = at(r, 'system/superseded-component');
	assert(superseded.length === 1, `two HStack usages in one file should collapse to one finding, got ${superseded.length}`);
	assert(superseded[0].message.includes('Stack'), `did not name the replacement: ${superseded[0].message}`);
});

await check('a recommended component is never flagged', async () => {
	const src = ["import { Stack } from '@wordpress/ui';", 'export const A = () => <Stack>x</Stack>;'].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry }
	);
	assert(!at(r, 'system/locked-component').length && !at(r, 'system/superseded-component').length, 'Stack is recommended');
});

await check('an experimental component is not flagged — the call is contextual, not mechanical', async () => {
	const src = ["import { Dialog } from '@wordpress/ui';", 'export const A = () => <Dialog.Root />;'].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry }
	);
	assert(
		!at(r, 'system/locked-component').length && !at(r, 'system/superseded-component').length,
		'experimental status must never auto-fire — WPDS itself says this is not yet safe to recommend broadly'
	);
});

await check('a locked-component finding can be suppressed like any other', async () => {
	const src = [
		'/* wpds-allow system/locked-component -- reviewed, migrating later */',
		"import { Badge } from '@wordpress/components';",
		'export const A = () => <Badge>old</Badge>;',
	].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry }
	);
	assert(!at(r, 'system/locked-component').length, 'a well-formed suppression mutes the finding');
});

console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
process.exit(failed ? 1 : 0);
