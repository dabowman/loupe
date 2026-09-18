#!/usr/bin/env node
/**
 * The three channels and the two cross-file rules.
 *
 * Everything here reports across boundaries a single-file linter cannot see —
 * a token set assembled from the whole repo, a template literal, a composite
 * counted across files. Each is easy to break silently in a way that produces
 * *fewer* findings, which no failing build ever reveals.
 */

import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
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

// Both were ambiguities `fix` had to skip, and neither was a real choice.
await check("a property's own token family wins, and a mode's value is not the token's", async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { tokenSources: ['tokens.css'] } }),
		'tokens.css':
			':root { --wpds-dimension-padding-sm: 8px; --wpds-dimension-gap-sm: 8px; --wpds-dimension-size-4xs: 8px;\n' +
			'--wpds-border-radius-md: 4px; --wpds-border-radius-xl: 12px; }\n' +
			'[data-wpds-corner-radius="moderate"] { --wpds-border-radius-md: 12px; }',
		'styles/a.css': '.acme-card { padding: 8px; border-radius: 12px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	const tokens = at(r, 'tokens/hardcoded-value').map((f) => f.suggest?.[0]?.tokens.join(' | '));
	assert(tokens.includes('--wpds-dimension-padding-sm'), `padding not narrowed to its family: ${tokens}`);
	assert(tokens.includes('--wpds-border-radius-xl'), `a mode override made radius ambiguous: ${tokens}`);
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
	// `\s\s` alone would pass a message carrying a single tab — the very
	// character that resets the indentation the agent format groups by — so the
	// two that actually break the line are named outright.
	for (const f of found) assert(!/\s\s|[\n\t]/.test(f.message), `message spans lines: ${JSON.stringify(f.message)}`);
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

// The directive is cut at 60 characters and that cut is also the finding's
// `code`, so where the cut lands decides the baseline key. Collapsing the
// whitespace first moves it — silently invalidating every entry already
// recorded for a directive long enough to be cut, on a rule that blocks.
await check('a long malformed directive keys the same as it always did', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/D.jsx': ['export const D = () => (', '\t/* wpds-allow   layout/in-css   because  the  design  system  has  no  equivalent */', '\t<div />', ');'].join('\n'),
	});
	const f = one(at(r, 'suppression/malformed'), 'expected the malformed directive');
	assert(
		findingKey(f) === 'suppression/malformed|src/D.jsx|wpds-allow layout/in-css because the design system h',
		`baselines would break: ${findingKey(f)}`
	);
});

// The 60-character cut counts characters, like every other cut here. `slice`
// counts UTF-16 units and would halve the pair.
await check('the directive cut never splits a character', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/D.jsx': `export const D = () => (\n\t/* wpds-allow ${'a'.repeat(48)}\u{1F600} and then some more */\n\t<div />\n);`,
	});
	const f = one(at(r, 'suppression/malformed'), 'expected the malformed directive');
	assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.code ?? ''), `lone surrogate in ${JSON.stringify(f.code)}`);
});

// The selector is the only thing telling these two apart — it is not in `code`,
// and both declarations are identical. Bounding it before the dedupe ran folded
// them into one finding and dropped a real violation.
await check('two css-in-js selectors alike up to the bound are two findings', async () => {
	const sel = (tag: string): string => `& .pre${'x'.repeat(90)}${tag}`;
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/S.tsx': [
			"import styled from 'styled-components';",
			'const S = styled.div`',
			`\t${sel('AAA')} { background: #f00; } ${sel('BBB')} { background: #f00; }`,
			'`;',
			'export const S2 = () => <S />;',
		].join('\n'),
	});
	assert(at(r, 'tokens/hardcoded-value').length === 2, 'one of two distinct selectors was dropped');
});

// The same loss on the other rules the dedupe comment names: `code` there is
// only the property, so the message is the whole of what separates them.
await check('two long values of one property are two findings', async () => {
	const v = (tail: string): string => `calc(100% - ${'1px - '.repeat(12)}${tail})`;
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': `.acme-m { margin-bottom: ${v('2px')}; margin-bottom: ${v('9px')}; }`,
		'src/A.jsx': 'export const A = () => <div className="acme-m" />;',
	});
	assert(at(r, 'layout/negative-margin').length === 2, 'one of two distinct margins was dropped');
});

// A collapsed finding is a list of remedies, and a line bound that ends it
// mid-token leaves one the reader cannot act on and no sign of the rest.
await check('a collapsed remedy list drops whole remedies and counts them', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		// Enough on-role tokens that every declaration below resolves to one, so
		// the message really is a list of remedies rather than a list of values.
		'styles/tokens.css': [
			':root {',
			'\t--wpds-typography-font-size-md: 13px;',
			'\t--wpds-typography-font-weight-bold: 600;',
			'\t--wpds-typography-line-height-md: 1.4;',
			'\t--wpds-typography-letter-spacing-sm: 0.02em;',
			'}',
		].join('\n'),
		'styles/a.css': [
			'.acme-t {',
			'\tfont-size: 13px;',
			'\tfont-weight: 600;',
			'\tline-height: 1.4;',
			'\tletter-spacing: 0.02em;',
			'\tfont-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", Roboto, sans-serif;',
			'}',
		].join('\n'),
		'src/A.jsx': 'export const A = () => <div className="acme-t" />;',
	});
	const f = one(at(r, 'typography/untokenized'), 'expected one collapsed typography finding');
	assert([...f.message].length <= 200, `message ran to ${[...f.message].length} characters`);
	assert(/\(\+\d+ more\)$/.test(f.message), `the dropped remedies went unannounced: ${f.message}`);
	assert(!/→ var\(--[\w-]*…/.test(f.message), `a remedy was cut mid-token: ${f.message}`);
});

// ── composites ──────────────────────────────────────────────────────────────

const registry = loadPatterns(JSON.parse(await import('node:fs').then((m) => m.readFileSync(REGISTRY, 'utf8'))));
const componentRegistry = loadComponents(JSON.parse(readFileSync(COMPONENT_REGISTRY, 'utf8')));

await check('a registered pattern matches through nesting and extra siblings', () => {
	const formModal = registry.find((p) => p.id === 'edit-record.dialog');
	assert(formModal?.node, 'the shipped registry should carry edit-record.dialog');
	// The registry records the footer as a sibling of the body; real code nests it.
	const real = node(['Modal', ['Stack', 'TextControl', ['Stack', 'Button', 'Button']]]);
	assert(matches(formModal.node, real), 'nested footer should still be a form-modal');
	const noFooter = node(['Modal', ['Stack', 'TextControl']]);
	assert(!matches(formModal.node, noFooter), 'a modal with no action pair is not a form-modal');
});

// Measured on 2110 Gutenberg files: the `Stack` spelling alone missed nine real
// form-modals written with VStack/Flex, which came back as unregistered noise.
await check('a signature node names alternatives with |', () => {
	const formModal = registry.find((p) => p.id === 'edit-record.dialog');
	assert(formModal?.node, 'the shipped registry should carry edit-record.dialog');
	const legacy = node(['Modal', ['VStack', 'TextControl', ['HStack', 'Button', 'Button']]]);
	assert(matches(formModal.node, legacy), 'VStack should satisfy Stack|VStack|HStack|Flex');
	const modern = node(['Modal', ['Stack', 'TextControl', ['Stack', 'Button', 'Button']]]);
	assert(matches(formModal.node, modern), 'so should Stack');
	const unrelated = node(['Modal', ['Grid', 'TextControl', ['Grid', 'Button', 'Button']]]);
	assert(!matches(formModal.node, unrelated), 'a name outside the alternation must not match');
});

await check('a registered child must claim a distinct node', () => {
	const twoTexts = node(['VStack', 'Text', 'Text']);
	assert(!matches(twoTexts, node(['VStack', 'Text'])), 'one Text should not satisfy two');
	assert(matches(twoTexts, node(['VStack', 'Text', 'Text'])), 'two Texts should');
});

const composite = (n: string): string =>
	[
		"import { Stack, Text, Button } from '@wordpress/ui';",
		`export const Panel${n} = () => (`,
		'\t<Stack>',
		'\t\t<Stack><Text>Details</Text><Button>Close</Button></Stack>',
		'\t\t<div className="acme-body"><Stack><Text>body</Text></Stack></div>',
		'\t</Stack>',
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
	assert(named.message.includes('edit-record.inspector'), `named the wrong pattern: ${named.message}`);
});

// `canonical` is matched against the file's local import names, so it has to be
// the name the code binds — `EmptyState`, not the `EmptyState.Root` the JSX says
// nor the import statement that produced it.
await check('a file importing the canonical component is using the pattern, not rebuilding it', async () => {
	const shipped = (n: string): string =>
		[
			"import { EmptyState, Button } from '@wordpress/ui';",
			`export const Screen${n} = () => (`,
			'\t<EmptyState.Root>',
			'\t\t<EmptyState.Title>Nothing here</EmptyState.Title>',
			'\t\t<EmptyState.Description>Try a different filter.</EmptyState.Description>',
			'\t\t<EmptyState.Actions><Button>A</Button></EmptyState.Actions>',
			'\t</EmptyState.Root>',
			');',
		].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': shipped('A'), 'src/B.jsx': shipped('B') },
		{ patterns: registry }
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'importing EmptyState is using report.empty');
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
	assert(!at(r, 'patterns/duplicate-composite').length, 'action-cluster.bar has no shape to check');
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

// The registry's answer to a shape, fired against the one file that built it —
// this is the only composite rule that does not need a second file to exist.
await check('the shape a pattern replaces is reported in the file that built it', async () => {
	const src = [
		"import { Modal, TextControl } from '@wordpress/components';",
		'export const Edit = () => (',
		'\t<Modal title="Edit">',
		'\t\t<TextControl label="Title" />',
		'\t\t<TextControl label="Tagline" />',
		'\t\t<TextControl label="Slug" />',
		'\t</Modal>',
		');',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { patterns: registry });
	const sup = first(at(r, 'patterns/superseded-composite'), 'one file is enough for a wrong choice');
	assert(sup.message.includes('edit-record.data-form'), `named the wrong pattern: ${sup.message}`);
	assert(sup.message.includes('DataForm'), `should name the remedy: ${sup.message}`);
});

await check('two fields are a form, not the anti-pattern', async () => {
	const src = [
		"import { Modal, TextControl } from '@wordpress/components';",
		'export const Edit = () => (<Modal title="Edit"><TextControl label="Title" /><TextControl label="Slug" /></Modal>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { patterns: registry });
	assert(!at(r, 'patterns/superseded-composite').length, 'below the floor is not a finding');
});

await check('a file already importing the answer is not told to use it', async () => {
	const src = [
		"import { Modal, TextControl } from '@wordpress/components';",
		"import { DataForm } from '@wordpress/dataviews';",
		'export const Edit = () => (',
		'\t<Modal title="Edit">',
		'\t\t<TextControl label="Title" /><TextControl label="Tagline" /><TextControl label="Slug" />',
		'\t\t<DataForm data={ {} } fields={ [] } form={ {} } onChange={ () => {} } />',
		'\t</Modal>',
		');',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { patterns: registry });
	assert(!at(r, 'patterns/superseded-composite').length, 'canonical import means the choice was deliberate');
});

// ── registry v2 ─────────────────────────────────────────────────────────────

await check('a v2 entry loads under its pattern key, and its parts under id#part', () => {
	const ids = new Set(registry.map((p) => p.id));
	for (const id of ['confirm', 'choose.segmented', 'navigate-hierarchy#descend', 'screen.page#header', 'browse-collection.list#toolbar.filter'])
		assert(ids.has(id), `the shipped registry should carry ${id}`);
});

await check('a part inherits its parent canonical, cut to the name the code binds', () => {
	const descend = registry.filter((p) => p.id === 'navigate-hierarchy#descend');
	assert(descend.length === 2, `descend should load two shapes (plain and rendered), got ${descend.length}`);
	assert(descend.every((p) => p.canonical === 'Navigator'), `Navigator.Button binds as Navigator, got ${descend[0]?.canonical}`);
	const stack = registry.find((p) => p.id === 'navigate-hierarchy#stack');
	assert(stack?.canonical === 'Navigator', 'a part with no canonical of its own takes the parent’s');
});

await check('an entry checked by import alone loads with no tree and never matches a composite', async () => {
	const notice = registry.find((p) => p.id === 'report.notice');
	assert(notice && notice.node === null && notice.canonical === 'NoticeList', 'report.notice is import-only');
	const src = [
		"import { __experimentalVStack as VStack, Notice } from '@wordpress/components';",
		'export const A = () => (<VStack><Notice>a</Notice><Notice>b</Notice><Notice>c</Notice></VStack>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src, 'src/B.jsx': src.replace('A', 'B') }, { patterns: registry });
	assert(!at(r, 'patterns/duplicate-composite').length, 'nothing to match against');
});

await check('a v1 registry still loads unchanged', () => {
	const v1 = loadPatterns({ patterns: [{ id: 'x', summary: 's', canonical: 'Card', signature: ['Card.Root', 'Card.Header', 'Card.Title', 'Card.Content'] }] });
	const [x] = v1;
	assert(x && x.id === 'x' && x.size === 4 && x.canonical === 'Card' && x.rules.length === 0, 'v1 fields map one to one');
});

// ── AST rules ───────────────────────────────────────────────────────────────

const select = (options: string, extra = ''): string =>
	[
		"import { SelectControl } from '@wordpress/components';",
		extra,
		`export const A = () => (<SelectControl label="Align" options={ ${options} } />);`,
	].join('\n');
const four = "[ { label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }, { label: 'd', value: 'd' } ]";

await check('a select with four static options is the segmented choice refused', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': select(four) }, { patterns: registry });
	const hit = one(at(r, 'patterns/superseded-composite'), 'one select, one finding');
	assert(hit.message.includes('choose.segmented') && hit.message.includes('ToggleGroupControl'), hit.message);
	assert(hit.message.includes('4 short static options'), hit.message);
});

await check('a same-file const array counts as static; a spread or six options does not', async () => {
	const viaConst = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select('ALIGN', `const ALIGN = ${four};`) },
		{ patterns: registry },
	);
	assert(at(viaConst, 'patterns/superseded-composite').length === 1, 'a const bound in the module is static');
	const spread = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select("[ { label: 'a', value: 'a' }, ...more ]") },
		{ patterns: registry },
	);
	assert(!at(spread, 'patterns/superseded-composite').length, 'a spread could hold anything');
	const six = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select(`[ ${Array(6).fill("{ label: 'x', value: 'x' }").join(', ')} ]`) },
		{ patterns: registry },
	);
	assert(!at(six, 'patterns/superseded-composite').length, 'six options do not fit on a row');
	const wide = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select("[ { label: __( 'Uppercase Roman numerals' ), value: 'I' }, { label: __( 'Lowercase Roman numerals' ), value: 'i' }, { label: 'Numbers', value: '1' } ]") },
		{ patterns: registry },
	);
	assert(!at(wide, 'patterns/superseded-composite').length, 'three long labels do not fit on a row either');
	const unread = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select("[ { label: labels.a, value: 'a' }, { label: labels.b, value: 'b' } ]") },
		{ patterns: registry },
	);
	assert(!at(unread, 'patterns/superseded-composite').length, 'a label the rule cannot read leaves the width unknown');
});

await check('a file that already imports the segmented control made its choice', async () => {
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': select(four, "import { __experimentalToggleGroupControl as ToggleGroupControl } from '@wordpress/components';") },
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/superseded-composite').length, 'the canonical import is the deliberate signal');
});

const modal = (body: string, extra = ''): string =>
	[
		"import { Modal, Button, TextControl } from '@wordpress/components';",
		"import { __ } from '@wordpress/i18n';",
		extra,
		'export const A = ({ onClose, onDelete }) => (',
		'\t<Modal title={ __( "Delete post?" ) } onRequestClose={ onClose }>',
		'\t\t<p>{ __( "This cannot be undone." ) }</p>',
		body,
		'\t</Modal>',
		');',
	].join('\n');
const pair = '\t\t<div><Button variant="tertiary" onClick={ onClose }>{ __( "Cancel" ) }</Button><Button variant="primary" isDestructive onClick={ onDelete }>{ __( "Delete permanently" ) }</Button></div>';

await check('a modal holding only a consent pair is a confirm dialog rebuilt', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': modal(pair) }, { patterns: registry });
	const hit = one(at(r, 'patterns/superseded-composite'), 'one modal, one finding');
	assert(hit.message.includes('`confirm`') && hit.message.includes('ConfirmDialog'), hit.message);
	assert(hit.message.includes('Cancel / Delete permanently'), `labels read through __(): ${hit.message}`);
});

await check('a form control inside, a third button, or a computed label makes it a form, not a question', async () => {
	const withField = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': modal(`\t\t<TextControl label="Reason" />\n${pair}`) },
		{ patterns: registry },
	);
	assert(!at(withField, 'patterns/superseded-composite').length, 'a control makes it a form');
	const three = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': modal(`${pair}\n\t\t<Button>{ __( "Cancel" ) }</Button>`) },
		{ patterns: registry },
	);
	assert(!at(three, 'patterns/superseded-composite').length, 'three buttons is not a pair');
	const computed = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': modal('\t\t<div><Button>{ __( "Cancel" ) }</Button><Button>{ label }</Button></div>') },
		{ patterns: registry },
	);
	assert(!at(computed, 'patterns/superseded-composite').length, 'a label the rule cannot read is not a consent label');
});

await check('a file importing ConfirmDialog beside a hand-built pair is not told to use it', async () => {
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': modal(pair, "import { __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';") },
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/superseded-composite').length, 'the canonical import means the choice was deliberate');
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

// Two things the message could not say before, both of which an agent went and
// derived by hand: the registry's own prose was concatenated into `message` and
// lost its last clause to the display cap, and a finding anchored at the import
// gave no clue whether the migration was one edit or a dozen.
await check('a currency finding carries the registry note apart, and counts its call sites', async () => {
	const src = [
		"import { Grid } from '@wordpress/components';",
		'export const A = () => (<><Grid /><Grid /></>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const f = one(at(r, 'system/superseded-component'), 'expected one Grid finding');
	assert(/\u00d72/.test(f.message), `the message did not say how many call sites: ${f.message}`);
	assert(!/Storybook/.test(f.message), `the note is back in the capped field: ${f.message}`);
	assert(f.note?.endsWith('not Grid.'), `the note lost the half worth acting on: ${String(f.note)}`);
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

// ── where a directive has to sit ──────────────────────────────────────────────
// Every case here failed silently: the directive parsed, named the right rule,
// and muted nothing, so the report was identical to having written none. Two
// models in a row burned most of a session rediscovering the placement by
// trial and error, which is the cost of an escape hatch that does not say why
// it did not open.

await check('a superseded component reports on its own specifier line', async () => {
	const src = [
		'import {',
		'\tButton,',
		'\t// wpds-allow system/superseded-component -- reviewed for this one name only',
		'\t__experimentalVStack as VStack,',
		'\t__experimentalHStack as HStack,',
		"} from '@wordpress/components';",
		'export const A = () => (<Button><VStack /><HStack /></Button>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const f = one(at(r, 'system/superseded-component'), 'the directive should mute VStack and only VStack');
	assert(f.message.startsWith('HStack'), `the wrong specifier survived: ${f.message}`);
	assert(f.line === 5, `HStack should report on its own line, got ${f.line}`);
});

// The declaration line is where every specifier used to report, so directives
// already written against it must keep muting what they were signed off for.
await check('a directive on the `import {` line still mutes the declaration', async () => {
	const src = [
		'// wpds-allow system/superseded-component -- the whole import, as it was written before',
		'import {',
		'\t__experimentalVStack as VStack,',
		'\t__experimentalHStack as HStack,',
		"} from '@wordpress/components';",
		'export const A = () => (<><VStack /><HStack /></>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(!at(r, 'system/superseded-component').length, 'a directive written for the declaration still covers it');
});

// Prettier wraps a reason worth writing, and the wrapped form anchored to
// nothing: `isSuppressed` reads the finding's line and the one above it, and a
// comment that closes two lines higher is on neither.
await check('a directive in a wrapped block comment covers the lines it spans', async () => {
	const src = [
		'export const A = () => (',
		'\t<>',
		'\t\t{ /* wpds-allow system/raw-element -- the reason runs long enough that',
		'\t\t     the formatter wraps it onto a second physical line */ }',
		'\t\t<p className="acme-note">x</p>',
		'\t</>',
		');',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src, 'src/a.css': '.acme-note { color: red }' });
	assert(!at(r, 'system/raw-element').length, 'a wrapped directive must mute what the one-line form would');
});

// The span is bounded. A comment that runs for pages is a licence nobody read,
// and reading one as a suppression is how a typo becomes the blanket disable
// this grammar exists to refuse. (An unterminated comment needs no guard: the
// file stops parsing, so there is nothing left to mute.)
await check('a block comment that runs too long stops covering what follows', async () => {
	const filler = Array.from({ length: 50 }, (_, i) => `\t\t   line ${i} of a very long comment`);
	const src = [
		'export const A = () => (',
		'\t<>',
		'\t\t{ /* wpds-allow system/raw-element -- opens here',
		...filler,
		'\t\t   and only closes here */ }',
		'\t\t<p className="acme-note">x</p>',
		'\t</>',
		');',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src, 'src/a.css': '.acme-note { color: red }' });
	assert(at(r, 'system/raw-element').length > 0, 'a directive that far away must not still be muting');
});

// ── a replacement has to be one you could actually adopt ──────────────────────

await check('a component whose only replacements are locked or in flux does not fire', async () => {
	const src = ["import { DropdownMenu, MenuItem } from '@wordpress/components';", 'export const A = () => (<DropdownMenu><MenuItem /></DropdownMenu>);'].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(
		!at(r, 'system/superseded-component').length,
		'Menu is core-only in one package and experimental in the other — neither is a migration target',
	);
});

// A dotted subcomponent has no entry of its own; its currency is its root's.
await check('a prose remedy still fires — it names no component to be unusable', async () => {
	const src = ["import { __experimentalSpacer as Spacer } from '@wordpress/components';", 'export const A = () => <Spacer />;'].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const f = one(at(r, 'system/superseded-component'), 'a hand-written remedy is still a remedy');
	assert(f.message.includes('gap'), `the remedy was lost: ${f.message}`);
});

// `system/raw-element` read the element map and `system/superseded-component`
// read the registry, and nothing reconciled them: taking the first finding's
// advice earned the second, which is a loop rather than a fix.
await check('a raw element is never sent to a component the registry supersedes', async () => {
	const src = 'export const A = () => <h3>title</h3>;';
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const f = one(at(r, 'system/raw-element'), 'expected the heading finding');
	assert(!/<Heading>/.test(f.message), `sent to a legacy component: ${f.message}`);
	assert(f.message.includes('@wordpress/ui'), `did not forward to the current analog: ${f.message}`);
});

// ── library internals by stylesheet ───────────────────────────────────────────
// An unprefixed system (`.field-label`, `.toast-viewport`) has no prefix for
// `namespaces.external` to match, and the component renders those classes
// itself, so no JSX binds them. A consumer rule restyling one reported nothing.

const DS_SHEET = '.field { display: flex; &-label { font-weight: 600; } }\n.toast-viewport { position: fixed; }';

await check('a class the system\'s stylesheets define is a library internal', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/field.scss': DS_SHEET,
		'styles/a.scss': '.acme-bar .field-label { font-size: 11px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-bar" />;',
	});
	const f = one(at(r, 'system/override'), 'one override for the restyled part');
	assert(f.message.includes('.field-label (library internal)'), `wrong message: ${f.message}`);
	assert(!at(r, 'typography/untokenized').length, 'the library-internal verdict supersedes per-declaration findings');
});

await check('without styleSources an unprefixed library class stays invisible', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'ds/field.scss': DS_SHEET,
		'styles/a.scss': '.acme-bar .field-label { color: red; }',
		'src/A.jsx': 'export const A = () => <div className="acme-bar" />;',
	});
	assert(!r.findings.some((f) => f.message.includes('library internal')), 'nothing declared, nothing inferred');
});

// Keyed on a library part, or the custom-property guard is never reached: a
// project class is not an override whatever it declares.
await check('rebinding a slot is not an override, even on a library part', async () => {
	const sheet = (decls: string) => ({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/field.scss': DS_SHEET,
		'styles/a.scss': `.acme-bar .field-label { ${decls} }`,
		'src/A.jsx': 'export const A = () => <div className="acme-bar" />;',
	});
	const r = await run(sheet('--field-label-color: var(--wpds-color-fg-content-neutral);'));
	assert(!at(r, 'system/override').length, `a custom property is the component's contract: ${JSON.stringify(r.findings)}`);
	const mixed = await run(sheet('--field-label-color: var(--wpds-color-fg-content-neutral); color: red;'));
	one(at(mixed, 'system/override'), 'a real declaration beside the rebind is still an override');
});

// Harvesting every class a library selector mentions made the project's own
// state and context classes "library internals", and that verdict replaced the
// real findings on the rule.
await check('a state, context or module class is not a part the system styles', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/tabs.scss': '.tab { padding: 4px; &.is-active { font-weight: 600; } }\n.dark .field-label { color: #fff; }\n.dark { --field-bg: #111; }\n.btn:not(.is-busy) { cursor: pointer; }',
		'ds/Card.module.css': '.root { display: flex; }',
		'styles/a.scss': '.acme-tab.is-active { margin-top: 8px; }\n.acme-app.dark { margin-bottom: 8px; }\n.acme-x.is-busy { margin-left: 8px; }',
		'styles/Card.module.css': '.root { margin-bottom: 8px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-tab acme-app acme-x" />;',
	});
	assert(!at(r, 'system/override').length, `a project rule read as a library internal: ${JSON.stringify(at(r, 'system/override'))}`);
	assert(at(r, 'layout/margin-on-child').length === 4, `the real findings were replaced: ${JSON.stringify(r.findings)}`);
});

// A workspace link is how an in-repo design system is usually installed, and a
// string compare of the two spellings checked its own sheets as project code —
// where every rule then reported an override of itself.
await check("the system's sheets are recognised through a link, and their tokens still count", async () => {
	const root = scratch('dsh-feat-');
	try {
		writeAll(root, {
			'loupe.config.json': CONFIG({
				designSystem: { tokenSources: ['tokens.css'], styleSources: ['node_modules/@acme/ui/src'] },
			}),
			'tokens.css': TOKENS,
			'packages/ui/src/field.scss': `:root { --wpds-color-fg-brand: #3858e9; }\n${DS_SHEET}`,
			'styles/a.scss': '.acme-bar .field-label { font-size: 11px; }\n.acme-card { color: var(--wpds-color-fg-brand); }',
			'src/A.jsx': 'export const A = () => <div className="acme-bar acme-card" />;',
		});
		mkdirSync(join(root, 'node_modules', '@acme'), { recursive: true });
		symlinkSync(join('..', '..', 'packages', 'ui'), join(root, 'node_modules', '@acme', 'ui'));
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const r = await analyze(config, { scope: null });
		const f = one(r.findings, `only the consumer's override: ${JSON.stringify(r.findings)}`);
		assert(f.file === 'styles/a.scss' && f.message.includes('.field-label (library internal)'), `wrong finding: ${f.message}`);
	} finally {
		cleanup(root);
	}
});

await check('an unreadable system sheet is reported, not silently dropped', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/field.css': '.field-label { font-weight: 600; }\n.x { color }',
		'src/A.jsx': 'export const A = () => <div />;',
	});
	assert(r.diagnostics.parseErrors.some((e) => e.file === 'ds/field.css'), `no diagnostic: ${JSON.stringify(r.diagnostics)}`);
	assert(!at(r, 'stylesheet/unparsed').length, 'the library sheet is not project code to fix');
});

await check('styleSources must be a list of paths, not one', async () => {
	let threw = '';
	await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: 'ds' } }),
		'styles/a.scss': '.acme-x { margin-top: 8px; }',
	}).catch((err: unknown) => {
		threw = err instanceof Error ? err.message : String(err);
	});
	assert(/styleSources must be an array/.test(threw), `a bare string was walked: ${threw || 'no throw'}`);
});

await check('a project class never reads as a library internal, even when the system defines it', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/field.scss': '.acme-bar { color: blue; }',
		'styles/a.scss': '.acme-bar { color: red; }',
		'src/A.jsx': 'export const A = () => <div className="acme-bar" />;',
	});
	assert(!r.findings.some((f) => f.message.includes('library internal')), 'the project prefix wins');
});

finish();
