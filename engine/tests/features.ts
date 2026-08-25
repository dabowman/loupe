#!/usr/bin/env node
/**
 * The three channels and the two cross-file rules.
 *
 * Everything here reports across boundaries a single-file linter cannot see —
 * a token set assembled from the whole repo, a template literal, a composite
 * counted across files. Each is easy to break silently in a way that produces
 * *fewer* findings, which no failing build ever reveals.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, findingKey } from '../src/analyze.ts';
import { loadConfig, setComponentRegistry, setPatterns } from '../src/config.ts';
import { loadPatterns, matches, toNode } from '../src/patterns.ts';
import { loadComponents } from '../src/components.ts';
import { assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { AnalyzeResult, ComponentEntry, Pattern, PatternNode, RuleId } from '../src/types.ts';

/** `toNode` is nullable by contract; a signature written in a test is not. */
const node = (spec: unknown): PatternNode => {
	const n = toNode(spec);
	assert(n, `test signature did not parse: ${JSON.stringify(spec)}`);
	return n;
};

const HERE = dirname(fileURLToPath(import.meta.url));
// The shipped registries live in the design-system profile that owns them.
const PROFILE = join(HERE, '..', '..', 'profiles', 'wpds');
const REGISTRY = join(PROFILE, 'patterns', 'index.json');
const COMPONENT_REGISTRY = join(PROFILE, 'components', 'index.json');

/** Analyze a throwaway repo. `files` maps relative path to contents. */
async function run(
	files: Record<string, string>,
	{ patterns, components }: { patterns?: Pattern[]; components?: Map<string, ComponentEntry> } = {},
): Promise<AnalyzeResult> {
	const root = scratch('dsh-feat-');
	try {
		writeAll(root, files);
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		if (patterns) setPatterns(config, patterns);
		if (components) setComponentRegistry(config, components);
		return await analyze(config, { scope: null });
	} finally {
		cleanup(root);
	}
}

const CONFIG = (extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] }, ...extra });
const TOKENS = ':root { --wpds-border-radius-md: 4px; --wpds-color-fg-content-neutral: #1e1e1e;\n' +
	'--wpds-color-bg-surface-neutral: #fcfcfc; --wpds-typography-font-size-md: 13px; }';
const at = (r: AnalyzeResult, rule: RuleId) => r.findings.filter((f) => f.rule === rule);

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
	const found = one(at(r, 'tokens/unknown-token'), 'expected exactly one unknown token');
	assert(found.message.includes('--wpds-nope'), found.message);
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
	const layout = one(at(r, 'layout/in-css'), 'expected one layout finding');
	const margin = one(at(r, 'layout/margin-on-child'), 'expected one margin finding');
	assert(layout.line === 4, `layout at ${layout.line}, want 4`);
	assert(margin.line === 5, `margin at ${margin.line}, want 5`);
	assert(layout.message.includes('css-in-js'), 'the channel should be named in the message');
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

// ── one line per finding ────────────────────────────────────────────────────
// A gradient, a `box-shadow` list or a `grid-template-areas` map spans source
// lines. The report is one line per finding — and the hook hands that same text
// back as blocking feedback — so a value carried through verbatim resets the
// indentation the format uses to group findings under a rule.

const GRADIENT = [
	'linear-gradient(',
	'\t\t90deg,',
	'\t\ttransparent 0%,',
	'\t\trgba( 255, 255, 255, 0.45 ) 50%,',
	'\t\ttransparent 100%',
	'\t)',
].join('\n');

/** The same gradient as one line — written out, not computed, so it is a pin. */
const FLAT = 'background: linear-gradient( 90deg, transparent 0%, rgba( 255, 255, 255, 0.45 ) 50%, transparent 100% )';

const MULTILINE = {
	'loupe.config.json': CONFIG(),
	'styles/a.css': `.acme-card {\n\tbackground: ${GRADIENT};\n}`,
	'src/A.tsx': [
		"import styled from 'styled-components';",
		'const Panel = styled.div`',
		`\tbackground: ${GRADIENT};`,
		'`;',
		'export const A = () => (',
		`\t<div className="acme-card" style={{ background: \`${GRADIENT}\` }}>`,
		'\t\t<Panel />',
		'\t</div>',
		');',
	].join('\n'),
};

await check('a multi-line declaration prints on one line in all three channels', async () => {
	const r = await run(MULTILINE);
	const found = at(r, 'tokens/hardcoded-value');
	assert(found.length === 3, `expected one finding per channel; got ${found.length}`);
	for (const f of found) assert(!/\s\s|\n/.test(f.message), `message spans lines: ${JSON.stringify(f.message)}`);
});

await check('a value too long to print is capped, and still names its property', async () => {
	const r = await run(MULTILINE);
	for (const f of at(r, 'tokens/hardcoded-value')) {
		assert(f.message.startsWith('background: linear-gradient('), `lost the property: ${f.message}`);
		assert(f.message.includes('…'), `an over-long value should be elided: ${f.message}`);
	}
});

// The keys are written out rather than derived, because a key computed the same
// way the engine computes it would agree with any change to how it is computed.
// These three are what the engine wrote BEFORE the cap existed: capping the
// printed snippet must leave every existing baseline entry matching.
await check('the baseline key is byte-for-byte what it was before the cap', async () => {
	const r = await run(MULTILINE);
	const keys = at(r, 'tokens/hardcoded-value').map(findingKey).sort();
	const want = [
		`tokens/hardcoded-value|src/A.tsx|${FLAT}`,
		`tokens/hardcoded-value|src/A.tsx|css-in-js:${FLAT}`,
		`tokens/hardcoded-value|styles/a.css|${FLAT}`,
	].sort();
	assert(JSON.stringify(keys) === JSON.stringify(want), `baselines would break:\n got ${JSON.stringify(keys, null, 1)}\nwant ${JSON.stringify(want, null, 1)}`);
});

// The cap is on what a finding PRINTS, so it must not reach the dedupe key:
// these two declarations agree for their first 80 characters and differ after,
// and a linter that silently drops one of them is worse than the formatting the
// cap exists to fix.
await check('two declarations alike up to the cap are two findings', async () => {
	const shadow = (rgba: string): string =>
		`box-shadow: 0 0 0 1px rgba(0,0,0,0.05), 0 0 0 2px rgba(0,0,0,0.05), 0 0 0 3px rgba( ${rgba} )`;
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': `.acme-dup { ${shadow('11,11,11,0.3')}; ${shadow('22,22,22,0.9')}; }`,
		'src/A.jsx': 'export const A = () => <div className="acme-dup" />;',
	});
	const found = at(r, 'tokens/hardcoded-value');
	assert(found.length === 2, `one of two distinct shadows was dropped; got ${found.length}`);
	assert(new Set(found.map(findingKey)).size === 2, 'they must also be two baseline entries');
});

// The other direction: `code` is deliberately coarser than the message on the
// rules that key on the property alone, so it cannot stand in for it either.
await check('two values of one property on one line are two findings', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': '.acme-m { margin-bottom: 4px; margin-bottom: 8px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-m" />;',
	});
	assert(at(r, 'layout/margin-on-child').length === 2, 'a repeated property is still two declarations');
});

// A selector is captured source too, and postcss keeps the newlines inside one.
await check('a multi-line selector is flattened into the finding', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/F.tsx': [
			"import styled from 'styled-components';",
			'const F = styled.div`',
			'\t& .outer',
			'\t\t> .inner:not(.x)',
			'\t\t+ .sibling {',
			'\t\tbackground: #f00;',
			'\t}',
			'`;',
		].join('\n'),
	});
	const f = one(at(r, 'tokens/hardcoded-value'), 'expected the nested declaration');
	assert(f.message.includes('in `& .outer > .inner:not(.x) + .sibling`'), `selector not flattened: ${JSON.stringify(f.message)}`);
	assert(!/[\n\t]/.test(f.message), `message spans lines: ${JSON.stringify(f.message)}`);
});

// Every message is one bounded line, whatever assembled it — several collapsed
// declarations, a token suggestion, a selector and a channel marker — and the
// marker survives the cap, because which channel a finding came from is not
// recoverable from the rest of the line.
await check('a message assembled from several snippets is still one bounded line', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/L.tsx': [
			"import styled from 'styled-components';",
			'const L = styled.div`',
			`\t& .${'x'.repeat(120)} {`,
			'\t\tfont-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", Roboto, "Noto Sans", sans-serif;',
			'\t\tfont-size: 13.5px;',
			'\t\tletter-spacing: 0.0123em;',
			'\t}',
			'`;',
		].join('\n'),
	});
	const f = one(at(r, 'typography/untokenized'), 'expected one collapsed typography finding');
	assert([...f.message].length <= 200, `message ran to ${[...f.message].length} characters`);
	assert(f.message.endsWith('(css-in-js)'), `the channel marker was eaten by the cap: ${f.message}`);
});

// `slice` counts UTF-16 units, so a cap landing mid-surrogate-pair emits a lone
// surrogate: harmless on a terminal, rejected outright by a strict JSON reader.
await check('the cap never splits a character', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': `.acme-u { font-family: ${'a'.repeat(65)}\u{1F600}zzzz; }`,
		'src/A.jsx': 'export const A = () => <div className="acme-u" />;',
	});
	const f = one(at(r, 'typography/untokenized'), 'expected the type finding');
	assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.message), `lone surrogate in ${JSON.stringify(f.message)}`);
	assert(f.message.includes('\u{1F600}'), `the character itself was lost: ${f.message}`);
});

// The suppression parser quotes source as well, and a tab in a block comment
// reset the same indentation. Flattened, never capped: this message is also the
// finding's `code`, and `findingKey` already collapses whitespace.
await check('a malformed suppression is quoted on one line', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/D.jsx': ['export const D = () => (', '\t/* wpds-allow\tlayout/in-css */', '\t<div style={{ display: 999 }} />', ');'].join('\n'),
	});
	const f = one(at(r, 'suppression/malformed'), 'expected the malformed directive');
	assert(!/[\n\t]/.test(f.message), `message carries a tab: ${JSON.stringify(f.message)}`);
});

// ── composites ──────────────────────────────────────────────────────────────

const registry = loadPatterns(JSON.parse(await import('node:fs').then((m) => m.readFileSync(REGISTRY, 'utf8'))));
const componentRegistry = loadComponents(JSON.parse(readFileSync(COMPONENT_REGISTRY, 'utf8')));

await check('a registered pattern matches through nesting and extra siblings', () => {
	const formModal = registry.find((p) => p.id === 'form-modal');
	assert(formModal, 'the shipped registry should carry form-modal');
	// The registry records the footer as a sibling of the body; real code nests it.
	const real = node(['Modal', ['Stack', 'TextControl', ['Stack', 'Button', 'Button']]]);
	assert(matches(formModal.node, real), 'nested footer should still be a form-modal');
	const noFooter = node(['Modal', ['Stack', 'TextControl']]);
	assert(!matches(formModal.node, noFooter), 'a modal with no action pair is not a form-modal');
});

await check('a registered child must claim a distinct node', () => {
	const twoTexts = node(['VStack', 'Text', 'Text']);
	assert(!matches(twoTexts, node(['VStack', 'Text'])), 'one Text should not satisfy two');
	assert(matches(twoTexts, node(['VStack', 'Text', 'Text'])), 'two Texts should');
});

const composite = (n: string): string =>
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
	const named = first(dup, 'expected a duplicate-composite finding');
	assert(named.message.includes('empty-state'), `named the wrong pattern: ${named.message}`);
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
	const shape = (n: string): string =>
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
	const locked = one(at(r, 'system/locked-component'), 'expected one locked finding');
	assert(locked.message.includes('@wordpress/components'), `wrong package named: ${locked.message}`);
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
	const superseded = one(
		at(r, 'system/superseded-component'),
		'two HStack usages in one file should collapse to one finding',
	);
	assert(superseded.message.includes('Stack'), `did not name the replacement: ${superseded.message}`);
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

finish();
