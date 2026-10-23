#!/usr/bin/env node
/**
 * The three channels and the two cross-file rules.
 *
 * Everything here reports across boundaries a single-file linter cannot see —
 * a token set assembled from the whole repo, a template literal, a composite
 * counted across files. Each is easy to break silently in a way that produces
 * *fewer* findings, which no failing build ever reveals.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, findingKey } from '../src/analyze.ts';
import { listPresets, loadConfig, setComponentRegistry, setPatterns } from '../src/config.ts';
import { SUBSTANTIAL, loadPatterns, matches, nodeCount, resolveRule, toNode } from '../src/patterns.ts';
import { loadComponents, surfacesRecorded } from '../src/components.ts';
import { readProfiles } from '../src/profiles.ts';
import { APPEARANCE_PROPS, propsOverlap } from '../src/styles.ts';
import { blockClasses, blockName } from '../src/blocks.ts';
import { LANGUAGE, ask, judgeRedirects, judgeVariants, redirectIdentity } from '../src/judge.ts';
import { forceQuery } from '../src/judge/force.ts';
import { CLI, assert, check, cleanup, finish, first, one, scratch, writeAll } from './harness.ts';
import type { AnalyzeResult, ComponentEntry, Finding, Pattern, PatternNode, RuleId } from '../src/types.ts';

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
	{
		patterns,
		components,
		judge,
		suppress,
	}: { patterns?: Pattern[]; components?: Map<string, ComponentEntry>; judge?: boolean; suppress?: boolean } = {},
): Promise<AnalyzeResult> {
	const root = scratch('loupe-feat-');
	try {
		writeAll(root, files);
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		if (patterns) setPatterns(config, patterns);
		if (components) setComponentRegistry(config, components);
		return await analyze(config, { scope: null, judge: judge ?? false, suppress: suppress ?? true });
	} finally {
		cleanup(root);
	}
}

const CONFIG = (extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] }, ...extra });
const TOKENS =
	':root { --wpds-border-radius-md: 4px; --wpds-color-fg-content-neutral: #1e1e1e;\n' +
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
	assert(f.message.includes('→ --wpds-border-radius-md'), `named nothing useful: ${f.message}`);
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
	assert(!f.message.includes('--wpds-'), `offered a background token for a foreground: ${f.message}`);
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

// A design system kept outside the project — a sibling package, a shared
// checkout — is named by an absolute path. Joined onto the root instead, it read
// nothing, and every token check went quiet with no error to say why.
await check('an absolute token source reads the same tokens as a relative one', async () => {
	const outer = scratch('loupe-feat-');
	try {
		writeAll(outer, { 'ds/tokens.css': TOKENS, 'app/src/A.jsx': 'export const A = () => <div />;' });
		const root = join(outer, 'app');
		const known = async (source: string): Promise<number> => {
			writeAll(root, { 'loupe.config.json': CONFIG({ designSystem: { tokenSources: [source] } }) });
			const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
			return (await analyze(config, { scope: null })).diagnostics.tokensKnown;
		};
		const relative = await known('../ds/tokens.css');
		const absolute = await known(join(outer, 'ds', 'tokens.css'));
		assert(relative === 4, `the relative source read ${relative} tokens, not 4`);
		assert(absolute === relative, `the absolute source read ${absolute} tokens, the relative one ${relative}`);
	} finally {
		cleanup(outer);
	}
});

await check('unknown-token stays silent when no token set was found', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': '.acme-card { color: var(--wpds-definitely-not-a-token); }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	assert(!at(r, 'tokens/unknown-token').length, 'declared a token unknown with nothing to check against');
});

// The walk adds the project's own definitions to the token set. One of them is
// not the design system's set, and checking against it calls every real token
// unknown, beside the notice that unknown ones cannot be reported.
await check("unknown-token stays silent when the only tokens found are the project's own", async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/brand.css': ':root { --wpds-brand-color: #c00; }',
		'styles/a.css':
			'.acme-card { color: var(--wpds-color-foreground-content-neutral); background: var(--wpds-color-background-surface-neutral); }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	assert(r.diagnostics.tokensKnown === 0, `the design system's sources yielded nothing: ${r.diagnostics.tokensKnown}`);
	const unknown = at(r, 'tokens/unknown-token');
	assert(!unknown.length, `checked against the project's own token: ${unknown.map((f) => f.code)}`);
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

// One verdict whichever channel the name arrives by. The inline channel and a
// rule naming no class were both read by nothing, so the same misspelling was
// renamed in `.acme-card { … }` and silent in `style={{ … }}` and `h1 { … }`.
await check('a misspelled token is reported in every channel, and in a rule naming no class', async () => {
	const typo = 'var(--wpds-colr-fg-content-neutral)';
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { tokenSources: ['tokens.css'] } }),
		'tokens.css': TOKENS,
		'styles/a.css': `.acme-card {\n\tcolor: ${typo};\n}`,
		// Nothing binds these, so nothing but the token is checked: the flex and
		// the margin are not this rule's to report.
		'styles/base.css': `h1 {\n\tdisplay: flex;\n\tmargin-bottom: 8px;\n\tcolor: ${typo};\n}\n:root {\n\t--acme-ink: ${typo};\n}`,
		'src/A.jsx': `export const A = () => <div className="acme-card" style={{ color: '${typo}' }} />;`,
		'src/B.jsx': `import styled from 'styled-components';\nexport const B = styled.div\`\n\tcolor: ${typo};\n\`;`,
	});
	const unknown = at(r, 'tokens/unknown-token');
	const where = unknown.map((f) => `${f.file}:${f.line}`).sort();
	assert(
		where.join() === 'src/A.jsx:1,src/B.jsx:3,styles/a.css:2,styles/base.css:4',
		`expected one finding per file: ${where}`,
	);
	for (const f of unknown) {
		assert(f.code === '--wpds-colr-fg-content-neutral', `${f.file}: ${f.code}`);
		assert(f.rename?.to === '--wpds-color-fg-content-neutral', `${f.file} renamed to ${f.rename?.to}`);
	}
	const inline = one(
		unknown.filter((f) => f.file === 'src/A.jsx'),
		'the inline one',
	);
	assert(inline.message.endsWith(' (inline)'), `the inline channel is named: ${inline.message}`);
	// Once per file and name: the `h1` and the `:root` rule are one finding.
	const base = one(
		unknown.filter((f) => f.file === 'styles/base.css'),
		'the classless rules',
	);
	assert(base.rename?.lines.join() === '4,7', `every line naming it: ${base.rename?.lines}`);
	const other = r.findings.filter((f) => f.file === 'styles/base.css' && f.rule !== 'tokens/unknown-token');
	assert(!other.length, `a rule naming no class was checked: ${other.map((f) => f.rule)}`);
});

// A reset has no token to reach for, and demanding one for every `inherit` is
// how a rule gets switched off.
await check('a keyword or zero is not untokenized type styling', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': '.acme-t { font-family: inherit; line-height: 0; font-weight: normal; }',
		'src/A.jsx': 'export const A = () => <span className="acme-t" />;',
	});
	assert(
		!at(r, 'typography/untokenized').length,
		`flagged inert values: ${at(r, 'typography/untokenized').map((f) => f.message)}`,
	);
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
	// An override needs a surface saying the component owns the property; a
	// text component's type declarations need only its being one.
	const button: ComponentEntry = {
		name: 'Button',
		package: '@wordpress/components',
		status: 'recommended',
		surface: { properties: { background: 'variant' } },
	};
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/Card.tsx': STYLED },
		{ components: new Map([['@wordpress/components::Button', button]]) },
	);
	const override = at(r, 'system/override');
	const typo = at(r, 'typography/in-css');
	assert(
		override.some((f) => f.line === 9),
		`styled(Button) should be an override; got ${override.map((f) => f.line)}`,
	);
	assert(
		typo.some((f) => f.line === 12),
		`styled(Text) should be typography/in-css; got ${typo.map((f) => f.line)}`,
	);
});

await check('an interpolated value produces no finding', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/Card.tsx': STYLED });
	assert(
		!r.findings.some((f) => f.line === 6),
		`guessed at an opaque value: ${r.findings.filter((f) => f.line === 6).map((f) => f.message)}`,
	);
});

// A value containing the interpolation placeholder is dropped as unknowable, so
// a placeholder an author could also write would silently drop theirs: `loupe`
// is a magnifier's name as well as this tool's.
await check('a value that only resembles the interpolation placeholder is still read', async () => {
	const src = [
		"import styled from 'styled-components';",
		'const Zoom = styled.div`',
		'\tbackground: #f00 url(loupe-edge.png);',
		'`;',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/Zoom.tsx': src });
	const hardcoded = at(r, 'tokens/hardcoded-value');
	assert(
		hardcoded.some((f) => f.line === 3),
		`a lookalike value went unread: ${r.findings.map((f) => `${f.line} ${f.rule}`)}`,
	);
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
	assert(
		JSON.stringify(keys) === JSON.stringify(want),
		`baselines would break:\n got ${JSON.stringify(keys, null, 1)}\nwant ${JSON.stringify(want, null, 1)}`,
	);
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
	assert(
		f.message.includes('in `& .outer > .inner:not(.x) + .sibling`'),
		`selector not flattened: ${JSON.stringify(f.message)}`,
	);
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
	assert(
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.message),
		`lone surrogate in ${JSON.stringify(f.message)}`,
	);
	assert(f.message.includes('\u{1F600}'), `the character itself was lost: ${f.message}`);
});

// The suppression parser quotes source as well, and a tab in a block comment
// reset the same indentation. Flattened, never capped: this message is also the
// finding's `code`, and `findingKey` already collapses whitespace.
await check('a malformed suppression is quoted on one line', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/D.jsx': [
			'export const D = () => (',
			'\t/* wpds-allow\tlayout/in-css */',
			'\t<div style={{ display: 999 }} />',
			');',
		].join('\n'),
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
		'src/D.jsx': [
			'export const D = () => (',
			'\t/* wpds-allow   layout/in-css   because  the  design  system  has  no  equivalent */',
			'\t<div />',
			');',
		].join('\n'),
	});
	const f = one(at(r, 'suppression/malformed'), 'expected the malformed directive');
	assert(
		findingKey(f) === 'suppression/malformed|src/D.jsx|wpds-allow layout/in-css because the design system h',
		`baselines would break: ${findingKey(f)}`,
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
	assert(
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.code ?? ''),
		`lone surrogate in ${JSON.stringify(f.code)}`,
	);
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
		"import { TextControl } from '@wordpress/components';",
		`export const Panel${n} = () => (`,
		'\t<Stack>',
		'\t\t<Stack><Text>Details</Text><Button>Close</Button></Stack>',
		'\t\t<div className="acme-body"><Stack><TextControl label="Title" /></Stack></div>',
		'\t</Stack>',
		');',
	].join('\n');

// Written in layout primitives, Text and Button alone and matched at any depth,
// these two fired on whole screens: the outer Stack held a label and a button
// somewhere, and two Texts in one place and a Button in another.
await check('a panel with no field is not an inspector', () => {
	const inspector = registry.find((p) => p.id === 'edit-record.inspector');
	assert(inspector?.node, 'the shipped registry should carry edit-record.inspector');
	const card = node(['Stack', ['Stack', 'Text', 'Button'], ['Stack', 'Text']]);
	assert(!matches(inspector.node, card), 'a header row over body text is a card, not an inspector');
	const panel = node(['Stack', ['Stack', 'Text', 'Button'], ['Stack', ['Stack', 'TextControl']]]);
	assert(matches(inspector.node, panel), 'a header row over a field is');
});

await check('a pinned child must be a direct child, not a descendant', () => {
	const inspector = registry.find((p) => p.id === 'edit-record.inspector');
	assert(inspector?.node, 'the shipped registry should carry edit-record.inspector');
	// A screen whose header row sits three levels down, beside an unrelated form.
	const screen = node(['Stack', ['Stack', ['Stack', ['Stack', 'Text', 'Button']]], ['Stack', 'TextControl']]);
	assert(!matches(inspector.node, screen), 'the header row has to be a child of the panel itself');
	const header = registry.find((p) => p.id === 'screen.page#header');
	assert(header?.node, 'the shipped registry should carry screen.page#header');
	const page = node(['HStack', ['VStack', 'Text', 'Text'], ['HStack', 'Button']]);
	assert(matches(header.node, page), 'a title stack beside an actions stack is a page header');
	const scattered = node([
		'VStack',
		['VStack', ['Card', ['VStack', 'Text', 'Text']]],
		['VStack', ['HStack', 'Button']],
	]);
	assert(!matches(header.node, scattered), 'two Texts deep in one branch and a Button in another is not');
});

await check('a registered pattern rebuilt in two files is reported in both', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': composite('A'),
			'src/B.jsx': composite('B'),
		},
		{ patterns: registry },
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
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'importing EmptyState is using report.empty');
});

await check('one file is a first use, not a duplicate', async () => {
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': composite('A') }, { patterns: registry });
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
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'action-cluster.bar has no shape to check');
});

// The matcher skips a shape below the floor, so an entry that says it is checked
// by its signature and carries a smaller one is checked by nothing. A part
// without a detector of its own is checked the way its parent says.
await check('a shipped entry checked by signature carries a shape at or above the floor', () => {
	type Raw = { pattern?: string; detector?: unknown; signature?: unknown; rendered_signature?: unknown };
	const short: string[] = [];
	const visit = (e: Raw & { parts?: Record<string, Raw> }, key: string, inherited: unknown): void => {
		const detector = e.detector ?? inherited;
		if ((Array.isArray(detector) ? detector : [detector]).includes('signature'))
			for (const shape of [e.signature, e.rendered_signature].map(toNode))
				if (shape && nodeCount(shape) < SUBSTANTIAL.minNodes) short.push(`${key} (${nodeCount(shape)} nodes)`);
		for (const [name, part] of Object.entries(e.parts ?? {})) visit(part, `${key}#${name}`, detector);
	};
	for (const e of JSON.parse(readFileSync(REGISTRY, 'utf8')).realizations) visit(e, e.pattern, undefined);
	assert(!short.length, `checked by a signature the matcher never runs: ${short.join(', ')}`);
});

await check('an unregistered shape needs three files before it is house style', async () => {
	const shape = (n: string): string =>
		[
			"import { __experimentalVStack as VStack, __experimentalHStack as HStack, __experimentalText as Text, Button, Notice } from '@wordpress/components';",
			`export const W${n} = () => (<VStack><Notice>n</Notice><HStack><Text>t</Text><Button>b</Button></HStack></VStack>);`,
		].join('\n');
	const two = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': shape('A'), 'src/B.jsx': shape('B') },
		{ patterns: registry },
	);
	assert(!at(two, 'patterns/unregistered-composite').length, 'two is a coincidence');
	const three = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': shape('A'), 'src/B.jsx': shape('B'), 'src/C.jsx': shape('C') },
		{ patterns: registry },
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

// The @wordpress/ui Menu is `Menu.Root`, `Menu.Trigger` and `Menu.Popup`;
// `Menu.TriggerButton` and `Menu.Popover` are the locked @wordpress/components
// Menu's parts, and signatures spelled in them matched nothing the recommended
// import produces.
const uiMenus = (n: string): string =>
	[
		"import { Menu } from '@wordpress/ui';",
		`export const Actions${n} = () => (`,
		'\t<Menu.Root>',
		'\t\t<Menu.Trigger>More</Menu.Trigger>',
		'\t\t<Menu.Popup>',
		'\t\t\t<Menu.Item>Rename</Menu.Item>',
		'\t\t\t<Menu.Item>Delete</Menu.Item>',
		'\t\t</Menu.Popup>',
		'\t</Menu.Root>',
		');',
		`export const Filter${n} = () => (`,
		'\t<Menu.Root>',
		'\t\t<Menu.Trigger>Status</Menu.Trigger>',
		'\t\t<Menu.Popup>',
		'\t\t\t<Menu.RadioGroup value="all">',
		'\t\t\t\t<Menu.RadioItem value="all">All</Menu.RadioItem>',
		'\t\t\t\t<Menu.RadioItem value="draft">Drafts</Menu.RadioItem>',
		'\t\t\t</Menu.RadioGroup>',
		'\t\t</Menu.Popup>',
		'\t</Menu.Root>',
		');',
	].join('\n');

await check('the WPDS menus are spelled in the @wordpress/ui Menu parts', async () => {
	const files = { 'loupe.config.json': CONFIG(), 'src/A.jsx': uiMenus('A'), 'src/B.jsx': uiMenus('B') };
	const shipped = await run(files, { patterns: registry });
	assert(!at(shipped, 'patterns/duplicate-composite').length, 'importing Menu is using the pattern');
	// Both entries bind `Menu`, which every file composing one imports; with that
	// lifted, the duplicate rule shows what each signature matched in real JSX.
	const ids = ['action-cluster.overflow', 'browse-collection.list#toolbar.filter'];
	const lifted = registry.map((p) => (ids.includes(p.id) ? { ...p, canonical: null } : p));
	const dup = at(await run(files, { patterns: lifted }), 'patterns/duplicate-composite');
	for (const id of ids) {
		const named = dup.filter((f) => f.message.includes(`\`${id}\``));
		assert(named.length === 2, `expected ${id} in both files, got ${named.length}: ${dup.map((f) => f.message)}`);
	}
	const overflow = registry.find((p) => p.id === 'action-cluster.overflow');
	assert(overflow?.node, 'the shipped registry should carry action-cluster.overflow');
	const locked = node(['Menu', 'Menu.TriggerButton', ['Menu.Popover', 'Menu.Item', 'Menu.Item']]);
	assert(!matches(overflow.node, locked), 'the locked @wordpress/components Menu is not the recommended shape');
});

// No canonical, so nothing lifted: the shipped entry reports as it stands.
await check('a grouped list with a @wordpress/ui Menu above its rows is browse-collection.grouped-list', async () => {
	const presets = (n: string): string =>
		[
			"import { Menu, Stack } from '@wordpress/ui';",
			"import { __experimentalItemGroup as ItemGroup, Navigator } from '@wordpress/components';",
			`export const Presets${n} = () => (`,
			'\t<Stack>',
			'\t\t<Menu.Root>',
			'\t\t\t<Menu.Trigger>Theme</Menu.Trigger>',
			'\t\t\t<Menu.Popup><Menu.Item>Reset</Menu.Item></Menu.Popup>',
			'\t\t</Menu.Root>',
			'\t\t<ItemGroup><Navigator.Button path="/preset/a">A</Navigator.Button></ItemGroup>',
			'\t</Stack>',
			');',
		].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': presets('A'), 'src/B.jsx': presets('B') },
		{ patterns: registry },
	);
	const dup = at(r, 'patterns/duplicate-composite');
	assert(dup.length === 2, `expected one per file, got ${dup.length}: ${dup.map((f) => f.message)}`);
	assert(
		dup.every((f) => f.message.includes('`browse-collection.grouped-list`')),
		`named the wrong pattern: ${dup.map((f) => f.message)}`,
	);
});

// ── registry v2 ─────────────────────────────────────────────────────────────

await check('a v2 entry loads under its pattern key, and its parts under id#part', () => {
	const ids = new Set(registry.map((p) => p.id));
	for (const id of [
		'confirm',
		'choose.segmented',
		'navigate-hierarchy#descend',
		'screen.page#header',
		'browse-collection.list#toolbar.filter',
	])
		assert(ids.has(id), `the shipped registry should carry ${id}`);
});

await check('a part inherits its parent canonical, cut to the name the code binds', () => {
	const descend = registry.filter((p) => p.id === 'navigate-hierarchy#descend');
	assert(descend.length === 2, `descend should load two shapes (plain and rendered), got ${descend.length}`);
	assert(
		descend.every((p) => p.canonical === 'Navigator'),
		`Navigator.Button binds as Navigator, got ${descend[0]?.canonical}`,
	);
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
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src, 'src/B.jsx': src.replace('A', 'B') },
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/duplicate-composite').length, 'nothing to match against');
});

await check('a v1 registry still loads unchanged', () => {
	const v1 = loadPatterns({
		patterns: [
			{
				id: 'x',
				summary: 's',
				canonical: 'Card',
				signature: ['Card.Root', 'Card.Header', 'Card.Title', 'Card.Content'],
			},
		],
	});
	const [x] = v1;
	assert(
		x && x.id === 'x' && x.size === 4 && x.canonical === 'Card' && x.rules.length === 0,
		'v1 fields map one to one',
	);
});

// ── AST rules ───────────────────────────────────────────────────────────────

const select = (options: string, extra = ''): string =>
	[
		"import { SelectControl } from '@wordpress/components';",
		extra,
		`export const A = () => (<SelectControl label="Align" options={ ${options} } />);`,
	].join('\n');
const four =
	"[ { label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }, { label: 'd', value: 'd' } ]";

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
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': select(`[ ${Array(6).fill("{ label: 'x', value: 'x' }").join(', ')} ]`),
		},
		{ patterns: registry },
	);
	assert(!at(six, 'patterns/superseded-composite').length, 'six options do not fit on a row');
	const wide = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': select(
				"[ { label: __( 'Uppercase Roman numerals' ), value: 'I' }, { label: __( 'Lowercase Roman numerals' ), value: 'i' }, { label: 'Numbers', value: '1' } ]",
			),
		},
		{ patterns: registry },
	);
	assert(!at(wide, 'patterns/superseded-composite').length, 'three long labels do not fit on a row either');
	const unread = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': select("[ { label: labels.a, value: 'a' }, { label: labels.b, value: 'b' } ]"),
		},
		{ patterns: registry },
	);
	assert(!at(unread, 'patterns/superseded-composite').length, 'a label the rule cannot read leaves the width unknown');
});

await check('a file that already imports the segmented control made its choice', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': select(
				four,
				"import { __experimentalToggleGroupControl as ToggleGroupControl } from '@wordpress/components';",
			),
		},
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
const pair =
	'\t\t<div><Button variant="tertiary" onClick={ onClose }>{ __( "Cancel" ) }</Button><Button variant="primary" isDestructive onClick={ onDelete }>{ __( "Delete permanently" ) }</Button></div>';

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
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': modal('\t\t<div><Button>{ __( "Cancel" ) }</Button><Button>{ label }</Button></div>'),
		},
		{ patterns: registry },
	);
	assert(!at(computed, 'patterns/superseded-composite').length, 'a label the rule cannot read is not a consent label');
});

await check('a file importing ConfirmDialog beside a hand-built pair is not told to use it', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'src/A.jsx': modal(pair, "import { __experimentalConfirmDialog as ConfirmDialog } from '@wordpress/components';"),
		},
		{ patterns: registry },
	);
	assert(!at(r, 'patterns/superseded-composite').length, 'the canonical import means the choice was deliberate');
});

// @wordpress/ui's SelectControl, recommended there since 0.23.0, takes the same
// `{ value, label }` shape under `items`: four of them are the same refusal.
await check('the @wordpress/ui SelectControl with four static items is refused the same way', async () => {
	const src = [
		"import { SelectControl } from '@wordpress/ui';",
		`export const A = () => (<SelectControl label="Align" items={ ${four} } />);`,
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { patterns: registry });
	const hit = one(at(r, 'patterns/superseded-composite'), 'one select, one finding');
	assert(hit.message.includes('choose.segmented') && hit.message.includes('4 short static items'), hit.message);
});

// ── component currency ────────────────────────────────────────────────────

// Upstream moved the select in one release: @wordpress/ui 0.23.0 marks its
// SelectControl and Select `recommended`, and @wordpress/components 41.0.0 marks
// its SelectControl and BaseControl `not-recommended`, naming the replacements.
await check('the select moved to @wordpress/ui, and BaseControl to Field', async () => {
	const entry = (key: string) => componentRegistry.get(key);
	assert(entry('@wordpress/ui::SelectControl')?.status === 'recommended', 'ui SelectControl is the current select');
	assert(entry('@wordpress/ui::Select')?.status === 'recommended', 'and its Select primitive');
	assert(
		JSON.stringify(entry('@wordpress/ui::SelectControl')?.surface?.properties) === '{}',
		'its root is Field.Root, which owns nothing',
	);
	const old = entry('@wordpress/components::SelectControl');
	assert(old?.status === 'legacy' && old.supersededBy === 'SelectControl (@wordpress/ui)', `${JSON.stringify(old)}`);
	const base = entry('@wordpress/components::BaseControl');
	assert(base?.status === 'legacy' && base.supersededBy === 'Field (@wordpress/ui)', `${JSON.stringify(base)}`);
	const raw = JSON.parse(readFileSync(COMPONENT_REGISTRY, 'utf8')) as { scope: { absent: string } };
	assert(!raw.scope.absent.includes('SelectControl'), 'recorded, so no longer listed as known and unrecorded');

	const src = [
		"import { SelectControl } from '@wordpress/components';",
		"import { SelectControl as UiSelect } from '@wordpress/ui';",
		'export const A = () => (<><SelectControl label="a" /><UiSelect label="b" /></>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const f = one(at(r, 'system/superseded-component'), 'only the @wordpress/components import is stale');
	assert(f.message.includes('SelectControl (@wordpress/ui)'), `names the replacement: ${f.message}`);
});

await check('a locked component is reported, its recommended sibling is not', async () => {
	const src = [
		"import { Badge } from '@wordpress/components';",
		"import { Badge as UiBadge } from '@wordpress/ui';",
		'export const A = () => (<><Badge>old</Badge><UiBadge>new</UiBadge></>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
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
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const superseded = one(
		at(r, 'system/superseded-component'),
		'two HStack usages in one file should collapse to one finding',
	);
	assert(superseded.message.includes('Stack'), `did not name the replacement: ${superseded.message}`);
});

await check('a recommended component is never flagged', async () => {
	const src = ["import { Stack } from '@wordpress/ui';", 'export const A = () => <Stack>x</Stack>;'].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(
		!at(r, 'system/locked-component').length && !at(r, 'system/superseded-component').length,
		'Stack is recommended',
	);
});

await check('an experimental component is not flagged — the call is contextual, not mechanical', async () => {
	const src = ["import { Dialog } from '@wordpress/ui';", 'export const A = () => <Dialog.Root />;'].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(
		!at(r, 'system/locked-component').length && !at(r, 'system/superseded-component').length,
		'experimental status must never auto-fire — WPDS itself says this is not yet safe to recommend broadly',
	);
});

// Two things the message could not say before, both of which an agent went and
// derived by hand: the registry's own prose was concatenated into `message` and
// lost its last clause to the display cap, and a finding anchored at the import
// gave no clue whether the migration was one edit or a dozen.
await check('a currency finding carries the registry note apart, and counts its call sites', async () => {
	const src = ["import { Grid } from '@wordpress/components';", 'export const A = () => (<><Grid /><Grid /></>);'].join(
		'\n',
	);
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
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(!at(r, 'system/locked-component').length, 'a well-formed suppression mutes the finding');
});

await check('--no-suppressions reports what a directive mutes, and still lists the directive', async () => {
	const src = [
		'/* wpds-allow system/locked-component -- reviewed, migrating later */',
		"import { Badge } from '@wordpress/components';",
		'export const A = () => <Badge>old</Badge>;',
	].join('\n');
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry, suppress: false },
	);
	one(at(r, 'system/locked-component'), 'the suppressed finding is back');
	assert(r.directives.length === 1, `the directive is still listed: ${r.directives.length}`);
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
	const src = [
		"import { DropdownMenu, MenuItem } from '@wordpress/components';",
		'export const A = () => (<DropdownMenu><MenuItem /></DropdownMenu>);',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	assert(
		!at(r, 'system/superseded-component').length,
		'Menu is core-only in one package and experimental in the other — neither is a migration target',
	);
});

// A dotted subcomponent has no entry of its own; its currency is its root's.
await check('a prose remedy still fires — it names no component to be unusable', async () => {
	const src = [
		"import { __experimentalSpacer as Spacer } from '@wordpress/components';",
		'export const A = () => <Spacer />;',
	].join('\n');
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

// `Text` alone loses what the `<h3>` was for. The mapping names the element the
// analog renders as, so the suggestion is the whole conversion.
await check('a heading is sent to Text rendered as that heading', async () => {
	const src = 'export const A = () => (\n\t<>\n\t\t<h3>title</h3>\n\t\t<H6 />\n\t\t<h6>small</h6>\n\t</>\n);';
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const got = at(r, 'system/raw-element').map((f) => `${f.line} ${f.message}`);
	const want = [
		'3 <h3> → <Text render={ <h3 /> }> (@wordpress/ui)',
		'5 <h6> → <Text render={ <h6 /> }> (@wordpress/ui)',
	];
	assert(JSON.stringify(got) === JSON.stringify(want), `got:\n${got.join('\n')}`);
	// Without a registry the preset alone still says it, minus the package.
	const bare = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': '<h2>x</h2>' });
	const b = one(at(bare, 'system/raw-element'), 'expected the heading finding without a registry');
	assert(b.message === '<h2> → <Text render={ <h2 /> }>', b.message);
});

// `render` is printed into the suggestion as JSX; anything but a tag name would
// hand the agent a remedy that does not parse.
await check('an element-map render that is not an element name is refused', async () => {
	const root = scratch('loupe-render-');
	try {
		writeAll(root, {
			'loupe.config.json': JSON.stringify({
				extends: 'wpds',
				designSystem: { elementMap: { h4: { component: 'Text', render: '<h4 />' } } },
			}),
		});
		const err = await loadConfig({ root, configPath: join(root, 'loupe.config.json') }).then(
			() => null,
			(e: Error) => e,
		);
		assert(err?.message.includes('elementMap.h4.render') ?? false, `accepted: ${err?.message}`);
	} finally {
		cleanup(root);
	}
});

// A hand-built <table> styled with tokens passes every token check; it just
// isn't DataViews. Interactive elements are flagged whether or not CSS touches them.
await check('a raw interactive element names its analog and the package to import it from', async () => {
	const src = [
		'export const A = ( { t } ) => (',
		'\t<>',
		'\t\t<button>Go</button>',
		'\t\t<input />',
		'\t\t<input type="checkbox" />',
		'\t\t<input type={ "FILE" } />',
		'\t\t<input type="submit" />',
		'\t\t<input type={ t } />',
		'\t\t<input type="hidden" name="nonce" />',
		'\t\t<select />',
		'\t\t<textarea />',
		'\t\t<table />',
		'\t\t<dialog />',
		'\t\t<progress />',
		'\t\t<details />',
		'\t\t{ /* <table> in a comment */ }',
		"\t\t{ '<button>' }",
		'\t</>',
		');',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const got = at(r, 'system/raw-element').map((f) => `${f.line} ${f.message}`);
	const want = [
		'3 <button> → <Button> (@wordpress/components)',
		'4 <input> → <InputControl> (@wordpress/ui)',
		'5 <input> → <CheckboxControl> (@wordpress/components)',
		'6 <input> → <FormFileUpload> (@wordpress/components)',
		'7 <input> → <Button> (@wordpress/components)',
		'8 <input> → <InputControl> (@wordpress/ui)',
		'10 <select> → <SelectControl> (@wordpress/ui)',
		'11 <textarea> → <TextareaControl> (@wordpress/ui)',
		'12 <table> → <DataViews> (@wordpress/dataviews)',
		'13 <dialog> → <Modal> (@wordpress/components)',
		'14 <progress> → <ProgressBar> (@wordpress/components)',
		'15 <details> → <Collapsible> (@wordpress/ui)',
	];
	assert(JSON.stringify(got) === JSON.stringify(want), `got:\n${got.join('\n')}`);
});

// The bare `grid` shorthand lays an element out in every channel, not only in a
// stylesheet (#65). The two channels that once skipped it must not drift back.
await check('an inline `grid` shorthand lays the element out, as it does in a stylesheet', async () => {
	const src = [
		'export const A = () => <div style={{ grid: "auto-flow / 1fr 1fr" }}>x</div>;',
		'export const B = () => <div style={{ grid: "auto-flow / 1fr 1fr", gap: "8px" }}>x</div>;',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src });
	assert(
		at(r, 'system/raw-element').some((f) => f.line === 1),
		'a grid-only <div> is laid out, so it maps to a layout primitive',
	);
	assert(!at(r, 'layout/in-css').length, 'the gap of a grid is not flex layout to move to a primitive');
});

// The element map's advice is only as good as the names in it: a suggestion
// the registry has never heard of is one nobody can import, and one it marks
// `legacy` is advice another rule then reports. `h1`–`h6` → `Heading` stayed in
// the map after the registry superseded `Heading`. Every shipped
// profile, against its own preset, so the next drift fails here rather than in
// someone's backlog.
for (const profile of readProfiles(join(HERE, '..', '..', 'profiles'))) {
	if (!profile.preset || !profile.components) continue;
	const { preset, components } = profile;
	await check(`every ${preset} element-map analog is one the ${profile.id} registry recommends`, async () => {
		const root = scratch('loupe-map-');
		try {
			writeAll(root, { 'loupe.config.json': JSON.stringify({ extends: preset }) });
			const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
			const registry = loadComponents(JSON.parse(readFileSync(components, 'utf8')));
			const map = [...config.designSystem.elementMap];
			assert(map.length > 0, `${preset} maps no elements — nothing was checked`);
			const stale = map.flatMap(([tag, m]) =>
				[[tag, m.component] as const, ...Object.entries(m.values ?? {}).map(([v, c]) => [`${tag}[${v}]`, c] as const)]
					// A dotted subcomponent's currency is its root's, as for an import.
					.filter(([, c]) => c !== null && c !== undefined)
					.filter(([, c]) => {
						const name = String(c).split('.')[0];
						return ![...registry.values()].some((e) => e.name === name && e.status === 'recommended');
					})
					.map(([t, c]) => `${t} → ${c}`),
			);
			assert(!stale.length, `not recommended by the registry: ${stale.join(', ')}`);
		} finally {
			cleanup(root);
		}
	});
}

// ── library internals by stylesheet ───────────────────────────────────────────
// An unprefixed system (`.field-label`, `.toast-viewport`) has no prefix for
// `namespaces.external` to match, and the component renders those classes
// itself, so no JSX binds them. A consumer rule restyling one reported nothing.

const DS_SHEET = '.field { display: flex; &-label { font-weight: 600; } }\n.toast-viewport { position: fixed; }';

await check("a class the system's stylesheets define is a library internal", async () => {
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
	assert(
		!at(r, 'system/override').length,
		`a custom property is the component's contract: ${JSON.stringify(r.findings)}`,
	);
	const mixed = await run(sheet('--field-label-color: var(--wpds-color-fg-content-neutral); color: red;'));
	one(at(mixed, 'system/override'), 'a real declaration beside the rebind is still an override');
});

// Harvesting every class a library selector mentions made the project's own
// state and context classes "library internals", and that verdict replaced the
// real findings on the rule.
await check('a state, context or module class is not a part the system styles', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({ designSystem: { styleSources: ['ds'] } }),
		'ds/tabs.scss':
			'.tab { padding: 4px; &.is-active { font-weight: 600; } }\n.dark .field-label { color: #fff; }\n.dark { --field-bg: #111; }\n.btn:not(.is-busy) { cursor: pointer; }',
		'ds/Card.module.css': '.root { display: flex; }',
		'styles/a.scss':
			'.acme-tab.is-active { margin-top: 8px; }\n.acme-app.dark { margin-bottom: 8px; }\n.acme-x.is-busy { margin-left: 8px; }',
		'styles/Card.module.css': '.root { margin-bottom: 8px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-tab acme-app acme-x" />;',
	});
	assert(
		!at(r, 'system/override').length,
		`a project rule read as a library internal: ${JSON.stringify(at(r, 'system/override'))}`,
	);
	assert(
		at(r, 'layout/margin-on-child').length === 4,
		`the real findings were replaced: ${JSON.stringify(r.findings)}`,
	);
});

// A workspace link is how an in-repo design system is usually installed, and a
// string compare of the two spellings checked its own sheets as project code —
// where every rule then reported an override of itself.
await check("the system's sheets are recognised through a link, and their tokens still count", async () => {
	const root = scratch('loupe-feat-');
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
		assert(
			f.file === 'styles/a.scss' && f.message.includes('.field-label (library internal)'),
			`wrong finding: ${f.message}`,
		);
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
	assert(
		r.diagnostics.parseErrors.some((e) => e.file === 'ds/field.css'),
		`no diagnostic: ${JSON.stringify(r.diagnostics)}`,
	);
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

// ── a project's own blocks ───────────────────────────────────────────────────
// WordPress renders `.wp-block-acme-card` on the wrapper of the block
// `acme/card`, under the `wp-block-` the WordPress presets call external, and
// no source file spells it. Read as a library internal, the override was
// blocking and hid every finding in the rule.

await check('a wrapper class is derived from the block name the way WordPress derives it', () => {
	const of = (name: string): string => JSON.stringify(blockClasses(name));
	assert(of('acme/card') === '{"wrapper":"wp-block-acme-card","prefix":"wp-block-acme-"}', of('acme/card'));
	// WordPress drops a leading `core-` from the joined name, so a core block's
	// class carries no namespace for the project to own.
	assert(of('core/group') === 'null', `a core block is WordPress's: ${of('core/group')}`);
	assert(of('core-kit/tile') === '{"wrapper":"wp-block-kit-tile","prefix":"wp-block-kit-"}', of('core-kit/tile'));
	assert(of('Acme/Card') === 'null' && of('card') === 'null', 'only a valid block name derives a class');
	assert(blockName('{ "name": "acme/card" }') === 'acme/card', 'the name is read');
	assert(blockName('{ "name": 3 }') === null && blockName('{ name: ') === null, 'a broken manifest names none');
});

await check("a project block's classes are its own; a core block's stay a library internal", async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'src/blocks/card/block.json': '{ "name": "acme/card" }',
		'src/blocks/tile/block.json': '{ "name": "core/tile" }',
		'src/blocks/card/style.css':
			'.wp-block-acme-card { margin-bottom: 1em; }\n.wp-block-acme-card__title { margin-top: 8px; }\n' +
			'.wp-block-tile { margin-top: 8px; }\n.wp-block-acmeish { margin-top: 8px; }',
	});
	const overrides = at(r, 'system/override').map((f) => f.message);
	assert(
		JSON.stringify(overrides) === '[".wp-block-tile (library internal)",".wp-block-acmeish (library internal)"]',
		`wrong overrides: ${JSON.stringify(overrides)}`,
	);
	const margins = at(r, 'layout/margin-on-child').map((f) => f.line);
	assert(JSON.stringify(margins) === '[1,2]', `the block's own declarations lost their verdicts: ${margins}`);
});

// The shipped presets already keep it out of dead-class twice over: `wp-block-`
// is no project namespace, and `wp-*` is never-dead. A config claiming the
// prefix keeps neither, and the wrapper is still referenced nowhere.
await check('a block wrapper is never dead, even where a config claims its prefix', async () => {
	const r = await run({
		'loupe.config.json': CONFIG({
			namespaces: { project: ['acme-', 'wp-block-acme-'], neverDead: [] },
			rules: { 'css/dead-class': 'error' },
		}),
		'src/blocks/card/block.json': '{ "name": "acme/card" }',
		'src/blocks/card/style.css': '.wp-block-acme-card { color: red; }\n.wp-block-acme-card__gone { color: red; }',
	});
	const dead = at(r, 'css/dead-class').map((f) => f.message);
	assert(JSON.stringify(dead) === '[".wp-block-acme-card__gone"]', `wrong dead classes: ${JSON.stringify(dead)}`);
});

// ── --judge ─────────────────────────────────────────────────────────────────

// Offline: the stub stands in for TypeSafe and hands back one answer per
// question it was sent, so the check is on what is asked and what is written.
await check(
	'--judge asks only about analogs with variants, and writes only what clears the floor into the suggestion',
	async () => {
		const root = scratch('loupe-judge-');
		try {
			writeAll(root, {
				'src/A.jsx':
					'<p className="description">Help</p>\n<span style={{ background: c }} />\n<p>Hi</p>\n<div />\n<h3>Build</h3>',
			});
			const registry = loadComponents([
				{ name: 'Text', package: '@wordpress/ui', status: 'recommended', variants: { 'body-sm': 'Help text.' } },
				{ name: 'Stack', package: '@wordpress/ui', status: 'recommended' },
			]);
			const at = (line: number, analog: string) =>
				({
					rule: 'system/raw-element',
					severity: 'warn',
					rank: 0,
					file: 'src/A.jsx',
					line,
					code: '<p>',
					message: `<p> \u2192 <${analog}>`,
				}) as const;
			// The analog a legacy `Heading` forwards to names a placeholder to fill.
			const forwarded = {
				...at(5, 'Text'),
				code: '<h3>',
				message: '<h3> \u2192 Text (@wordpress/ui) with variant="heading-*" and render for the semantic element',
			};
			const findings = [at(1, 'Text'), at(2, 'Text'), at(3, 'Text'), at(4, 'Stack'), forwarded].map(
				(f): Finding => ({ ...f }),
			);
			// Keyed by the element's own line: one request per element, in any order.
			const replies: Record<string, { choice: string; confidence: number }> = {
				'<p className="description">Help</p>': { choice: 'body-sm', confidence: 0.8 },
				'<span style={{ background: c }} />': { choice: 'not_text', confidence: 0.99 },
				'<p>Hi</p>': { choice: 'body-sm', confidence: 0.3 },
				'<h3>Build</h3>': { choice: 'heading-lg', confidence: 0.58 },
			};
			const asked: { criteria: Record<string, string> }[] = [];
			const stub = (async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body);
				asked.push(...Object.values(body.questions as Record<string, { criteria: Record<string, string> }>));
				const answers = { e0: replies[body.state.elements[0].source.split('\n')[0]] };
				return new Response(JSON.stringify({ answers }));
			}) as unknown as typeof fetch;
			const n = await judgeVariants(root, findings, registry, 'key', stub);
			assert(asked.length === 4, `asked about ${asked.length} elements, expected the 4 Text ones`);
			assert('not_text' in (asked[0]?.criteria ?? {}), 'no no-match option offered');
			assert(n === 3, `wrote ${n}, expected 3`);
			// The answer goes into the suggestion, not after it.
			assert(findings[0]?.message === '<p> \u2192 <Text variant="body-sm"> (judged 0.80)', findings[0]?.message ?? '');
			assert(
				findings[1]?.message === '<p> \u2192 no analog, not Text content (judged 0.99)',
				findings[1]?.message ?? '',
			);
			assert(findings[2]?.message === '<p> \u2192 <Text>', `a sub-floor pick was written: ${findings[2]?.message}`);
			assert(findings[3]?.message === '<p> \u2192 <Stack>', 'a component with no variants was judged');
			assert(
				findings[4]?.message ===
					'<h3> \u2192 Text (@wordpress/ui) with variant="heading-lg" and render for the semantic element (judged 0.58)',
				`the placeholder was not filled: ${findings[4]?.message}`,
			);
			// As data too, for whatever acts on a judgement without parsing prose.
			const j = findings[0]?.judged;
			assert(j?.answer === 'body-sm' && j.confidence === 0.8, JSON.stringify(j));
			assert(
				j.spans.every((s) => findings[0]?.message.includes(s)),
				`a span is not in the message: ${JSON.stringify(j.spans)}`,
			);
			assert(findings[2]?.judged === undefined, 'a sub-floor pick was recorded');
		} finally {
			cleanup(root);
		}
	},
);

// A heading's suggestion already carries `render`; the variant goes into the
// same tag rather than trailing it as prose.
await check('--judge writes the variant into a suggestion that carries render', async () => {
	const root = scratch('loupe-judge-render-');
	try {
		writeAll(root, { 'src/A.jsx': '<h4>Site details</h4>' });
		const registry = loadComponents([
			{ name: 'Text', package: '@wordpress/ui', status: 'recommended', variants: { 'heading-md': 'A heading.' } },
		]);
		const f: Finding = {
			rule: 'system/raw-element',
			severity: 'warn',
			rank: 0,
			file: 'src/A.jsx',
			line: 1,
			code: '<h4>',
			message: '<h4> → <Text render={ <h4 /> }> (@wordpress/ui)',
		};
		const stub = (async () =>
			new Response(
				JSON.stringify({ answers: { e0: { choice: 'heading-md', confidence: 0.7 } } }),
			)) as unknown as typeof fetch;
		assert((await judgeVariants(root, [f], registry, 'key', stub)) === 1, 'nothing was written');
		assert(
			f.message === '<h4> → <Text variant="heading-md" render={ <h4 /> }> (@wordpress/ui) (judged 0.70)',
			f.message,
		);
	} finally {
		cleanup(root);
	}
});

// The analog is the conversion's leading `<Name`; the rest of the line is the
// promotion tail, whose class names can spell a component too. Matched anywhere
// after the arrow, `.Text-label` on a button cost a Text-variant question, and
// its answer rewrote the Button remedy to "no analog, not Text content".
await check('--judge asks a variant only of the analog itself, not of the tail after it', async () => {
	const root = scratch('loupe-judge-target-');
	try {
		writeAll(root, { 'src/A.jsx': '<button className="Text-label">Go</button>' });
		const registry = loadComponents([
			{ name: 'Text', package: '@wordpress/ui', status: 'recommended', variants: { 'body-sm': 'Help text.' } },
			{ name: 'Button', package: '@wordpress/ui', status: 'recommended' },
		]);
		const message = '<button> → <Button> (@wordpress/ui) — converted, would block: background (.Text-label)';
		const f: Finding = {
			rule: 'system/raw-element',
			severity: 'warn',
			rank: 0,
			file: 'src/A.jsx',
			line: 1,
			code: '<button>',
			message,
		};
		let asked = 0;
		const stub = (async () => {
			asked++;
			return new Response(JSON.stringify({ answers: { e0: { choice: 'not_text', confidence: 0.93 } } }));
		}) as unknown as typeof fetch;
		assert((await judgeVariants(root, [f], registry, 'key', stub)) === 0, 'a Button remedy was judged as Text');
		assert(asked === 0, `asked ${asked} paid question(s) about a class name`);
		assert(f.message === message, f.message);
	} finally {
		cleanup(root);
	}
});

// The bundling note costs adopting the remedy. Once the judge withdraws the
// remedy, "no analog, not Text content (bundling required: …)" names a cost
// of nothing.
await check('a withdrawn remedy drops the reach note that priced it', async () => {
	const root = scratch('loupe-judge-reach-');
	try {
		writeAll(root, { 'src/A.jsx': '<span>Hi</span>\n<p>Hi</p>' });
		const registry = loadComponents([
			{ name: 'Text', package: '@wordpress/ui', status: 'recommended', variants: { 'body-sm': 'Help text.' } },
		]);
		const reach = 'bundling required: @wordpress/ui is bundled into your build, not provided by WordPress';
		const at = (line: number, el: string): Finding => ({
			rule: 'system/raw-element',
			severity: 'warn',
			rank: 0,
			file: 'src/A.jsx',
			line,
			code: `<${el}>`,
			message: `<${el}> → <Text> (@wordpress/ui)`,
			note: `${reach}; an unrelated note`,
		});
		const findings = [at(1, 'span'), at(2, 'p')];
		const stub = (async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body);
			const span = body.state.elements[0].source.startsWith('<span');
			const e0 = span ? { choice: 'not_text', confidence: 0.93 } : { choice: 'body-sm', confidence: 0.8 };
			return new Response(JSON.stringify({ answers: { e0 } }));
		}) as unknown as typeof fetch;
		assert((await judgeVariants(root, findings, registry, 'key', stub)) === 2, 'not both were judged');
		assert(findings[0]?.message === '<span> → no analog, not Text content (judged 0.93)', findings[0]?.message ?? '');
		assert(findings[0]?.note === 'an unrelated note', `the withdrawn remedy kept its price: ${findings[0]?.note}`);
		assert(findings[1]?.note === `${reach}; an unrelated note`, `a kept remedy lost its note: ${findings[1]?.note}`);
	} finally {
		cleanup(root);
	}
});

// `analyze` bounded the line before the variant was spliced into it, so a long
// suggestion came back past the cap with the judgement at the end of it.
await check('a judged variant is still one bounded line, with the judgement kept last', async () => {
	const root = scratch('loupe-judge-variant-bound-');
	try {
		writeAll(root, { 'src/A.jsx': '<p className="description">Help</p>' });
		const registry = loadComponents([
			{ name: 'Text', package: '@wordpress/ui', status: 'recommended', variants: { 'body-sm': 'Help text.' } },
		]);
		const f: Finding = {
			rule: 'system/raw-element',
			severity: 'warn',
			rank: 0,
			file: 'src/A.jsx',
			line: 1,
			code: '<p>',
			message: `<p> → <Text> (@wordpress/ui), ${'and then a long note about the analog '.repeat(8)}`,
		};
		const stub = (async () =>
			new Response(
				JSON.stringify({ answers: { e0: { choice: 'body-sm', confidence: 0.8 } } }),
			)) as unknown as typeof fetch;
		assert((await judgeVariants(root, [f], registry, 'key', stub)) === 1, 'nothing was written');
		assert([...f.message].length <= 200, `${[...f.message].length} characters: ${f.message}`);
		assert(f.message.startsWith('<p> → <Text variant="body-sm"> (@wordpress/ui)'), f.message);
		assert(f.message.endsWith('… (judged 0.80)'), `the judgement did not survive the bound: ${f.message}`);
	} finally {
		cleanup(root);
	}
});

// ── --judge: forces and redirects ───────────────────────────────────────────

const represents = LANGUAGE.vocabulary.forces.represents?.judge;
assert(represents, 'patterns/index.json gives `represents` no judge block');

// The wording is scored live by evals/represents; what is pinned here is the
// wiring, which is what silently breaks: the batch boundary, the elements[i]
// reference the instructions depend on, and the order answers come back in.
await check('the force query sends one control per request, and keeps answers in order when batched', async () => {
	const controls = Array.from({ length: 41 }, (_, i) => ({
		file: `src/C${i}.jsx`,
		component: 'Button',
		enclosing: 'Screen',
		source: `<Button onClick={ go${i} }>Go ${i}</Button>`,
	}));
	type Sent = {
		elements: { file: string }[];
		questions: Record<string, { instructions: string; criteria: Record<string, string> }>;
	};
	const sent: Sent[] = [];
	const stub = (async (_url: string, init: { body: string }) => {
		const body = JSON.parse(init.body);
		sent.push({ elements: body.state.elements, questions: body.questions });
		// Answer with the question's own index, so a misplaced result is visible.
		const answers = Object.fromEntries(
			Object.keys(body.questions).map((k) => [
				k,
				{ choice: 'command', confidence: Number(`0.${k.slice(1).padStart(2, '0')}`) },
			]),
		);
		return new Response(JSON.stringify({ answers }));
	}) as unknown as typeof fetch;

	// The default is one control per request: sharing a state costs a third of
	// the destinations, which evals/represents measures. A batch default that
	// drifts back up would pass every other check in here.
	await ask(forceQuery(represents), controls.slice(0, 3), 'key', stub);
	assert(sent.length === 3, `default batched ${3 / sent.length} controls per request, expected 1`);
	assert(sent[0]?.elements.length === 1, 'default put more than one element in a request');
	for (const k of ['value', 'command', 'destination', 'none'])
		assert(k in (sent[0]?.questions.e0?.criteria ?? {}), `criteria missing "${k}"`);

	// Batched, the pool may finish requests in any order; the answers may not.
	sent.length = 0;
	const answers = await ask(forceQuery(represents), controls, 'key', stub, 40);
	assert(sent.length === 2, `sent ${sent.length} requests for 41 controls at batch 40`);
	const sizes = sent.map((r) => r.elements.length).sort((a, b) => b - a);
	assert(sizes[0] === 40 && sizes[1] === 1, `batch sizes were ${sizes.join(',')}, expected 40,1`);
	// Each question must name its own element, or every answer is about element 0.
	const full = sent.find((r) => r.elements.length === 40);
	assert(full?.questions.e0?.instructions.includes('elements[0].source'), full?.questions.e0?.instructions ?? 'no e0');
	assert(full?.questions.e7?.instructions.includes('elements[7].source'), full?.questions.e7?.instructions ?? 'no e7');
	assert(answers.length === 41, `got ${answers.length} answers for 41 controls`);
	assert(answers[7]?.confidence === 0.07, `answer 7 was ${answers[7]?.confidence}`);
	// The trailing batch re-indexes from e0; it must still land at 40, not 0.
	assert(answers[40]?.confidence === 0, `answer 40 was ${answers[40]?.confidence}`);
});

// An abort is a deadline: the request's own 20s, or the hook's whole judge
// phase. Retried like a dropped socket, a request that timed out would run four
// more times, and a hook past its deadline would go on asking.
await check('a timed-out or aborted request is not retried', async () => {
	for (const name of ['TimeoutError', 'AbortError']) {
		let calls = 0;
		const stub = (async () => {
			calls++;
			throw new DOMException('the operation was aborted', name);
		}) as unknown as typeof fetch;
		let thrown: unknown = null;
		try {
			await ask(
				forceQuery(represents),
				[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
				'key',
				stub,
				1,
				0,
			);
		} catch (err) {
			thrown = err;
		}
		assert(calls === 1, `${name}: ${calls} calls, expected one`);
		assert(thrown instanceof Error && thrown.name === name, `${name}: threw ${String(thrown)}`);
	}
	// Nor a whole body that is not JSON: a proxy's page answers the same each time.
	let pages = 0;
	const proxy = (async () => {
		pages++;
		return new Response('<html>sign in to continue</html>', { status: 200 });
	}) as unknown as typeof fetch;
	let said = '';
	try {
		await ask(
			forceQuery(represents),
			[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
			'key',
			proxy,
			1,
			0,
		);
	} catch (err) {
		said = String(err);
	}
	assert(pages === 1, `a page that is not JSON was asked for ${pages} times`);
	assert(/not JSON/.test(said), `said: ${said}`);
});

await check('a dropped connection is retried, not thrown away', async () => {
	// A reset arrives as a throw rather than a status, so it has to be caught where
	// the status retries are.
	let calls = 0;
	const stub = (async () => {
		if (++calls <= 2) throw new TypeError('fetch failed');
		return new Response(JSON.stringify({ answers: { e0: { choice: 'command', confidence: 1 } } }));
	}) as unknown as typeof fetch;
	// Backoff 0: the retries are what is under test, not the waits between them.
	const [a] = await ask(
		forceQuery(represents),
		[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
		'key',
		stub,
		1,
		0,
	);
	assert(calls === 3 && a?.choice === 'command', `${calls} calls, answer ${JSON.stringify(a)}`);

	// A socket that drops after the headers fails in the body read, and is retried too.
	let reads = 0;
	const midBody = (async () => {
		if (++reads === 1) {
			const body = new ReadableStream({
				start(c) {
					c.enqueue(new TextEncoder().encode('{"answ'));
					c.error(new TypeError('terminated'));
				},
			});
			return new Response(body);
		}
		return new Response(JSON.stringify({ answers: { e0: { choice: 'command', confidence: 1 } } }));
	}) as unknown as typeof fetch;
	const [b] = await ask(
		forceQuery(represents),
		[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
		'key',
		midBody,
		1,
		0,
	);
	assert(reads === 2 && b?.choice === 'command', `${reads} calls, answer ${JSON.stringify(b)}`);

	// And a host that is simply gone still fails the run, once the budget is out.
	let tries = 0;
	const dead = (async () => {
		tries++;
		throw new TypeError('fetch failed');
	}) as unknown as typeof fetch;
	let threw = '';
	try {
		await ask(
			forceQuery(represents),
			[{ file: 'a.jsx', component: 'B', enclosing: 'C', source: '<B />' }],
			'k',
			dead,
			1,
			0,
		);
	} catch (err) {
		threw = err instanceof Error ? err.message : String(err);
	}
	assert(threw.includes('unreachable'), `an unreachable host reported: ${threw || 'nothing'}`);
	assert(tries === 5, `retried ${tries} times, expected the budget of 5`);
});

await check('a 429 waits as long as retry-after says, then asks again', async () => {
	let calls = 0;
	const stub = (async () =>
		++calls === 1
			? new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } })
			: new Response(
					JSON.stringify({ answers: { e0: { choice: 'command', confidence: 1 } } }),
				)) as unknown as typeof fetch;
	const started = Date.now();
	const [a] = await ask(
		forceQuery(represents),
		[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
		'key',
		stub,
	);
	assert(calls === 2 && a?.choice === 'command', `${calls} calls, answer ${JSON.stringify(a)}`);
	// Without the header the first wait is 500ms.
	assert(Date.now() - started < 400, `waited ${Date.now() - started}ms for a 10ms retry-after`);
});

// Honoured verbatim, one `retry-after: 3600` held the run for an hour. The
// waits are recorded rather than slept, so this costs nothing.
await check('a retry-after of an hour is capped at a few seconds', async () => {
	let calls = 0;
	const stub = (async () =>
		++calls === 1
			? new Response('slow down', { status: 429, headers: { 'retry-after': '3600' } })
			: new Response(
					JSON.stringify({ answers: { e0: { choice: 'command', confidence: 1 } } }),
				)) as unknown as typeof fetch;
	const waits: number[] = [];
	const real = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		waits.push(ms ?? 0);
		return real(fn, 0);
	}) as typeof setTimeout;
	try {
		await ask(
			forceQuery(represents),
			[{ file: 'src/C.jsx', component: 'Button', enclosing: 'C', source: '<Button />' }],
			'key',
			stub,
		);
	} finally {
		globalThis.setTimeout = real;
	}
	assert(calls === 2, `${calls} calls`);
	const wait = one(waits, 'one wait between the two attempts');
	assert(wait === 5_000, `waited ${wait}ms for a retry-after of 3600s, not the 5s cap`);
});

await check('resolve runs on known forces, and stops at a row it cannot decide', async () => {
	const table = [
		{ when: { represents: 'command' }, redirect: 'menu' },
		{ when: { represents: 'destination' }, redirect: 'nav' },
		{ when: { set: 'open' }, variant: 'combobox' },
		{ when: { multiplicity: 'many', cardinality: 'few' }, variant: 'checklist' },
		{ default: 'select' },
	];
	assert(resolveRule(table, { represents: 'destination' })?.redirect === 'nav', 'a known force decides its row');
	// `value` rules out both redirects, then `set` is unknown: the combobox row
	// might have matched, so nothing below it may answer.
	assert(resolveRule(table, { represents: 'value' }) === null, 'answered past a row it could not decide');
	assert(resolveRule(table, {}) === null, 'nothing known decides nothing');
	// One known force contradicting a row skips it, whatever else it asks.
	assert(
		resolveRule(table, { represents: 'value', set: 'closed', cardinality: 'many' })?.default === 'select',
		'a contradicted row was not skipped',
	);
});

// The shipped WPDS realization carries the detectors, so this is the real
// wiring: which elements are asked, which are not, and what one becomes.
await check(
	'--judge turns a destination read off a Button into judged-redirect, and asks only what it must',
	async () => {
		const file = [
			"import { Button, SelectControl } from '@wordpress/components';",
			'export function Screen() {',
			'	return (<>',
			"		<Button onClick={ () => history.navigate( '/pages' ) }>Pages</Button>",
			'		<Button href="/wp-admin">Admin</Button>',
			'		<Button render={ <Link href="/wp-admin" /> }>Admin</Button>',
			'		<Button { ...linkProps }>Revisions</Button>',
			'		<Button onClick={ save }>Save</Button>',
			'		<SelectControl label="Size" options={ sizes } onChange={ setSize } />',
			'	</>);',
			'}',
		].join('\n');
		const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': file }, { patterns: registry, judge: true });
		const controls = r.controls ?? [];
		// `href`, or a `render` that swaps the element, already realizes the
		// redirect's target, and a spread might carry either: none is asked.
		assert(controls.length === 3, `collected ${controls.map((c) => c.line).join(',')}, expected lines 4, 8 and 9`);
		assert(
			controls.every((c) => c.enclosing === 'Screen'),
			`enclosing ${controls.map((c) => c.enclosing).join(',')}`,
		);
		assert(
			controls[0]?.source.startsWith('<Button onClick') && controls[0]?.source.endsWith('</Button>'),
			controls[0]?.source ?? '',
		);

		// Under the floor is unknown, not a finding: a destination at 0.83 here is
		// the pagination band Gutenberg showed, and a command at 0.85 on a select
		// would fire the menu redirect on a third-wrong guess.
		const replies: Record<string, { choice: string; confidence: number }> = {
			Pages: { choice: 'destination', confidence: 0.97 },
			Save: { choice: 'destination', confidence: 0.83 },
			Size: { choice: 'command', confidence: 0.85 },
		};
		const stub = (async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body);
			const src: string = body.state.elements[0].source;
			const key = Object.keys(replies).find((k) => src.includes(k)) ?? '';
			return new Response(JSON.stringify({ answers: { e0: replies[key] } }));
		}) as unknown as typeof fetch;
		const found = await judgeRedirects(controls, 'key', 'warn', stub);
		const f = one(found, 'one redirect');
		assert(f.rule === 'patterns/judged-redirect' && f.line === 4, `${f.rule} at ${f.line}`);
		assert(f.message === '<Button> (represents: destination) \u2192 `navigate-hierarchy` (judged 0.97)', f.message);
		assert(f.judged?.answer === 'destination' && f.judged.confidence === 0.97, JSON.stringify(f.judged));
		assert(Boolean(f.note), "the redirect's `because` was dropped");
		// The hook's pre-edit comparison keys a control as the redirect it would
		// be, without asking: the two keys have to be the same string.
		const control = first(
			controls.filter((c) => c.line === 4),
			'the control on line 4',
		);
		assert(
			findingKey(f) === findingKey({ ...redirectIdentity(control), message: '' }),
			`the pre-edit key ${findingKey({ ...redirectIdentity(control), message: '' })} is not the finding's ${findingKey(f)}`,
		);

		// Off unless asked: a plain check and the hook never collect a control.
		const plain = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': file }, { patterns: registry });
		assert(plain.controls === undefined, 'collected controls without --judge');
	},
);

// Redirects are written after `analyze` returns, so its dedupe never saw them:
// two Buttons on one line judged alike came out as two identical findings.
// Through the CLI, with `fetch` replaced before it loads, because the push it
// has to dedupe is the command's own.
await check('two controls on one line judged alike are one redirect', () => {
	const root = scratch('loupe-judge-dedupe-');
	try {
		writeAll(root, {
			'loupe.config.json': CONFIG(),
			'src/A.jsx': [
				"import { Button } from '@wordpress/components';",
				'export function Screen() {',
				"	return (<><Button onClick={ () => go( '/a' ) }>A</Button><Button onClick={ () => go( '/a' ) }>A</Button></>);",
				'}',
			].join('\n'),
		});
		const destination = `data:text/javascript,${encodeURIComponent(
			"globalThis.fetch = async () => new Response(JSON.stringify({ answers: { e0: { choice: 'destination', confidence: 0.99 } } }));",
		)}`;
		// The pattern registry rides on the profile, which only `--profiles` merges.
		const argv = ['check', '--root', root, '--all', '--judge', '--profiles', dirname(PROFILE), '--format', 'json'];
		const r = spawnSync(process.execPath, ['--import', destination, CLI, ...argv], {
			encoding: 'utf8',
			env: { ...process.env, TYPESAFE_API_KEY: 'key' },
		});
		assert(r.status === 0, `exited ${r.status}: ${r.stderr}`);
		const found = (JSON.parse(r.stdout) as { findings: Finding[] }).findings.filter(
			(f) => f.rule === 'patterns/judged-redirect',
		);
		one(found, 'one redirect for two controls on line 3');
	} finally {
		cleanup(root);
	}
});

// ── the feedback from a wpds audit ─────────────────────────────────────────────

// WPDS `Text` has no color prop, and its own docs set color through `style`. A
// suppression on every one of those was a quarter of one project's directives.
await check('color on Text is the sanctioned inline style, and its value is still checked', async () => {
	const src = (style: string): string =>
		[
			"import { Text, Stack } from '@wordpress/ui';",
			`export const A = ({ tone, rest }) => <Text variant="body-md" style={ ${style} }>x</Text>;`,
		].join('\n');
	const clean = await run({
		'loupe.config.json': CONFIG(),
		'src/A.jsx': src("{ color: 'var(--wpds-color-foreground-content-warning)' }"),
	});
	assert(!at(clean, 'system/inline-style').length, 'a token color on Text is sanctioned');
	assert(!at(clean, 'tokens/hardcoded-value').length, 'and a token is a token');
	const dynamic = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src('{ color: tone }') });
	assert(!at(dynamic, 'system/inline-style').length, 'an expression for color is still color');
	const raw = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src("{ color: '#d63638' }") });
	assert(!at(raw, 'system/inline-style').length, 'the sanction is about the property');
	one(at(raw, 'tokens/hardcoded-value'), 'a raw colour there is still a hardcoded value');
	const mixed = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src("{ color: 'var(--x)', marginTop: 4 }") });
	const f = one(at(mixed, 'system/inline-style'), 'anything beside color is the old finding');
	assert(f.message.includes('margin-top') && !f.message.includes('color'), `named the sanctioned one: ${f.message}`);
	const spread = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src("{ color: 'var(--x)', ...rest }") });
	one(at(spread, 'system/inline-style'), 'a spread could carry anything');
	const stack = await run({
		'loupe.config.json': CONFIG(),
		'src/A.jsx': [
			"import { Stack } from '@wordpress/ui';",
			"export const A = () => <Stack style={ { color: 'var(--x)' } }>x</Stack>;",
		].join('\n'),
	});
	one(at(stack, 'system/inline-style'), 'the sanction is Text-only');
});

// Both of these were found by a reviewer by hand, after the check ran clean.
await check('a raw colour inside a border shorthand is a hardcoded value', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.css': [
			'.acme-a { border: 1px solid #dcdcde; }',
			'.acme-b { border-top: var(--wpds-border-width-xs) solid rgba(214,54,56,.3); }',
			'.acme-c { outline: 2px solid hsl(0 0% 50%); }',
			'.acme-ok { border: 1px solid var(--wpds-color-stroke-surface-neutral); }',
			'.acme-fallback { border-bottom: 1px solid var(--wpds-color-stroke-surface-neutral, #ccc); }',
			'.acme-url { background-image: url(icons.svg#face); }',
		].join('\n'),
		'src/A.jsx': [
			'export const A = () => (<>',
			'\t<div className="acme-a acme-b acme-c acme-ok acme-fallback acme-url" />',
			"\t<div style={ { borderBottom: '1px solid #dcdcde' } } />",
			'</>);',
		].join('\n'),
	});
	const lines = at(r, 'tokens/hardcoded-value').map((f) => `${f.file}:${f.line}`);
	for (const want of ['styles/a.css:1', 'styles/a.css:2', 'styles/a.css:3', 'src/A.jsx:3'])
		assert(lines.includes(want), `missed ${want}: ${lines.join(', ')}`);
	assert(lines.length === 4, `flagged a token, a fallback or a url: ${lines.join(', ')}`);
});

await check('a directive that mutes nothing is reported stale', async () => {
	const src = [
		'/* wpds-allow system/locked-component -- reviewed, migrating later */',
		"import { Badge } from '@wordpress/components';",
		'export const A = () => <Badge>old</Badge>;',
		'// wpds-allow system/raw-element -- nothing here any more',
		'export const B = () => null;',
		'// wpds-allow system/raw-element, system/locked-compnent -- one live, one typo',
		'export const C = () => <p>x</p>;',
	].join('\n');
	const r = await run({ 'loupe.config.json': CONFIG(), 'src/A.jsx': src }, { components: componentRegistry });
	const [live, dead, half] = r.directives;
	assert(live && !live.stale, `a directive that muted a finding is live: ${JSON.stringify(live)}`);
	assert(dead?.stale?.join() === 'system/raw-element', `the dead one: ${JSON.stringify(dead)}`);
	assert(half?.stale?.join() === 'system/locked-compnent', `only the typo is stale: ${JSON.stringify(half)}`);
	const off = await run(
		{ 'loupe.config.json': CONFIG(), 'src/A.jsx': src },
		{ components: componentRegistry, suppress: false },
	);
	assert(
		off.directives.every((d) => !d.stale),
		'with suppressions off nothing was offered to them, so nothing is stale',
	);
});

// An import is canonicalised by `normalizeExports` before the layout and text
// lists are consulted, so a listed name the pattern would rewrite can never
// match: `__unstableMotion` sat in the wpds layout list as `Motion` (#108).
await check('every shipped preset lists its layout and text components by canonical name', async () => {
	const root = scratch('loupe-feat-');
	try {
		for (const name of listPresets()) {
			const { designSystem: ds } = await loadConfig({ root, preset: name });
			for (const c of [...ds.layoutComponents, ...ds.textComponents]) {
				const canonical = ds.normalizeExports ? c.replace(ds.normalizeExports, '') : c;
				assert(canonical === c, `${name}: ${c} is read as ${canonical}, so the entry never matches`);
			}
		}
	} finally {
		cleanup(root);
	}
});

// ── styling surfaces ────────────────────────────────────────────────────────
// `system/override` used to fire on any appearance property on any class bound
// to a component, so converting a raw element as `system/raw-element` asks
// turned the same unchanged CSS from advisory to blocking — with a remedy, "use
// its props", naming props that do not exist. It now blocks only where the
// registry records that the component owns the property.

const blocking = (r: AnalyzeResult): Finding[] => r.findings.filter((f) => f.severity === 'error');

await check('converting a raw element to Text does not promote its CSS to blocking', async () => {
	const css = '.acme-title { color: #826200; text-transform: uppercase; letter-spacing: 0.05em; }';
	const before = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': css,
			'src/A.tsx': 'export const A = () => <h4 className="acme-title">Hi</h4>;',
		},
		{ components: componentRegistry },
	);
	const after = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': css,
			'src/A.tsx': [
				"import { Text } from '@wordpress/ui';",
				'export const A = () => <Text variant="heading-md" render={ <h4 /> } className="acme-title">Hi</Text>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const css_ = (r: AnalyzeResult) =>
		r.findings
			.filter((f) => f.file.endsWith('.scss'))
			.map((f) => `${f.severity} ${f.rule} ${f.message}`)
			.sort();
	assert(!blocking(after).length, `the conversion added blocking findings: ${JSON.stringify(blocking(after))}`);
	assert(
		JSON.stringify(css_(after)) === JSON.stringify(css_(before)),
		`the same CSS classified differently on the component:\n${css_(before).join('\n')}\n---\n${css_(after).join('\n')}`,
	);
	assert(!at(after, 'system/raw-element').length, 'the converted element still reports as raw');
});

await check('a property the component owns still blocks, and the message names the prop', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-t { font-size: 14px; }\n.acme-b { background: #f00; border-color: #00f; }',
			'src/A.tsx': [
				"import { Text } from '@wordpress/ui';",
				"import { Button } from '@wordpress/components';",
				'export const A = () => <><Text className="acme-t">x</Text><Button className="acme-b">y</Button></>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const type = one(at(r, 'typography/in-css'), 'font-size on Text is the variant’s');
	assert(type.message === 'font-size on <Text> — set via its variant prop', `message: ${type.message}`);
	assert(type.severity === 'error', 'an owned property is blocking');
	const overrides = at(r, 'system/override').map((f) => f.message);
	assert(
		overrides.includes('<Button> ← background — set via its variant prop'),
		`background on Button: ${overrides.join('; ')}`,
	);
	// `border-color` is a longhand of the `border` the surface lists.
	assert(
		overrides.includes('<Button> ← border-color — set via its variant prop'),
		`a longhand of an owned shorthand is owned: ${overrides.join('; ')}`,
	);
	// The explanation is not part of the finding's identity: a baseline taken
	// before the message said why must still recognise it.
	assert(
		at(r, 'system/override').every((f) => f.code === f.message.split(' — ')[0]),
		'the code stays the component and the property',
	);
});

// A class can be bound to several text components. `letter-spacing` is not
// `@wordpress/ui` Text's, but `Truncate` records no surface, so its claim on the
// type stands; reading only the first binding made the verdict follow file order.
await check('typography/in-css reads every text component a class is bound to, whatever the file order', async () => {
	const verdicts: string[] = [];
	for (const [text, truncate] of [
		['src/A.tsx', 'src/B.tsx'],
		['src/C.tsx', 'src/B.tsx'],
	] as const) {
		const r = await run(
			{
				'loupe.config.json': CONFIG(),
				'styles/a.scss': '.acme-l { letter-spacing: 1px; }',
				[text]: 'import { Text } from \'@wordpress/ui\';\nexport const T = () => <Text className="acme-l">x</Text>;',
				[truncate]:
					'import { Truncate } from \'@wordpress/components\';\nexport const U = () => <Truncate className="acme-l">x</Truncate>;',
			},
			{ components: componentRegistry },
		);
		const css = r.findings.filter((f) => f.file.endsWith('.scss'));
		verdicts.push(css.map((f) => `${f.severity} ${f.rule} ${f.message}`).join('; '));
	}
	assert(verdicts[0] === verdicts[1], `the verdict followed file order:\n${verdicts.join('\n')}`);
	assert(verdicts[0] === 'error typography/in-css letter-spacing on <Truncate>', `verdict: ${verdicts[0]}`);
});

// The code is the finding's baseline identity, and before every binding was read
// it was the first one's. The message names the binding that owns the property;
// the code stays on the first, as system/override's does, so a baselined entry
// still matches.
await check('typography/in-css keeps its code on the first text component', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-l { font-size: 13px; }',
			'src/B.tsx':
				'import { Truncate } from \'@wordpress/components\';\nexport const U = () => <Truncate className="acme-l">x</Truncate>;',
			'src/C.tsx': 'import { Text } from \'@wordpress/ui\';\nexport const T = () => <Text className="acme-l">x</Text>;',
		},
		{ components: componentRegistry },
	);
	const f = one(
		r.findings.filter((x) => x.rule === 'typography/in-css'),
		'one typography/in-css finding',
	);
	assert(f.message.startsWith('font-size on <Text> — set via'), `the owner is named: ${f.message}`);
	assert(f.code === 'font-size on <Truncate>', `the code stays on the first binding: ${f.code}`);
});

// `import * as UI` binds the package, so `<UI.Button>` is the package's Button.
// Keyed as a part of `UI`, it found no surface while the package counted as
// surfaced, and the override fell to an advisory hardcoded value.
await check('a namespace import’s member is the component, and keeps its surface', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-t { font-size: 14px; }\n.acme-b { background: #f00; }',
			'src/A.tsx': [
				"import * as UI from '@wordpress/ui';",
				"import * as WP from '@wordpress/components';",
				'export const A = () => <><UI.Text className="acme-t">x</UI.Text><WP.Button className="acme-b">y</WP.Button></>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const type = one(at(r, 'typography/in-css'), 'font-size on UI.Text is the variant’s');
	assert(type.severity === 'error' && type.message.endsWith('set via its variant prop'), `type: ${type.message}`);
	const override = one(at(r, 'system/override'), 'background on WP.Button is the variant’s');
	assert(override.severity === 'error' && override.message.endsWith('set via its variant prop'), override.message);
	assert(!at(r, 'tokens/hardcoded-value').length, 'neither falls through to a plain hardcoded value');
});

await check('a class on several components keeps the first one in its code, whichever owns the property', async () => {
	// Before surfaces, `system/override` named the first component the class is
	// bound to, and that is what a baseline recorded then holds. The message may
	// now name another binding — the one whose surface owns the property — but
	// the identity must not move with it, or upgrading resurfaces accepted work.
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.css': '.acme-x { color: #f00; }',
			'src/A.tsx': [
				"import { Notice } from '@wordpress/components';",
				'export const A = () => <Notice className="acme-x">x</Notice>;',
			].join('\n'),
			'src/B.tsx': [
				"import { Button } from '@wordpress/components';",
				'export const B = () => <Button className="acme-x">y</Button>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const f = one(at(r, 'system/override'), 'one override on the shared class');
	assert(f.message.startsWith('<Button> ← color — set via'), `the message names the owner: ${f.message}`);
	// The key a baseline recorded before surfaces: the first binding, by code.
	const recorded = findingKey({ rule: 'system/override', file: f.file, code: '<Notice> ← color', message: '' });
	assert(findingKey(f) === recorded, `the pre-surface key ${recorded} is not the finding's ${findingKey(f)}`);
});

await check('a component that sets a property with no prop for it says so, and still blocks', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-field { font-size: 14px; border: 1px solid #ccc; border-radius: 2px; }',
			'src/A.tsx': [
				"import { TextControl } from '@wordpress/components';",
				'export const A = () => <TextControl className="acme-field" label="x" value="" onChange={ () => {} } />;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const f = one(at(r, 'system/override'), 'only the font-size is the wrapper’s own');
	assert(
		f.message === '<TextControl> ← font-size — it sets this itself and has no prop for it',
		`message: ${f.message}`,
	);
	assert(f.severity === 'error', 'owned with no prop is still an override');
	// The class lands on the wrapper around label, input and help, which sets no
	// border: that is the box `className` hands you, styled as any other.
	const plain = at(r, 'tokens/hardcoded-value').map((f) => f.message);
	assert(
		plain.includes('border: 1px solid #ccc') && plain.includes('border-radius: 2px'),
		`the unowned declarations fall through to the plain verdict: ${plain.join('; ')}`,
	);
});

await check('a component with no recorded surface is advisory, and promises no prop', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-n { color: #333; text-transform: uppercase; }',
			'src/A.tsx': [
				"import { Notice } from '@wordpress/components';",
				'export const A = () => <Notice className="acme-n">x</Notice>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	assert(!componentRegistry.get('@wordpress/components::Notice')?.surface, 'the fixture needs a surface-less entry');
	assert(!at(r, 'system/override').length, `no surface, no override: ${JSON.stringify(at(r, 'system/override'))}`);
	assert(!blocking(r).length, `nothing blocks: ${JSON.stringify(blocking(r))}`);
	one(at(r, 'tokens/hardcoded-value'), 'the raw colour still owes its token');
});

await check('a compound part is its own element: Card.Root owns its surface, Card.Content does not', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-card { background-color: #eee; }\n.acme-body { background-color: #eee; }',
			'src/A.tsx': [
				"import { Card } from '@wordpress/ui';",
				'export const A = () => <Card.Root className="acme-card"><Card.Content className="acme-body">x</Card.Content></Card.Root>;',
			].join('\n'),
		},
		{ components: componentRegistry },
	);
	const f = one(at(r, 'system/override'), 'Card.Root sets its own background');
	assert(f.line === 1, `the override is the root's: line ${f.line}`);
	assert(
		at(r, 'tokens/hardcoded-value').some((h) => h.line === 2),
		'the content part has no surface, so its colour is a plain hardcoded value',
	);
});

// What converting would change is said before the conversion, on the
// `system/raw-element` finding that asks for it: #13's 41 blockers arrived
// after the fact. The message grows a tail; `code` does not, so a baseline
// keyed on `<h4>` survives it.

const TITLE_CSS = '.acme-title { color: #826200; text-transform: uppercase; letter-spacing: 0.05em; font-size: 14px; }';
const H4 = 'export const A = () => <h4 className="acme-title">Hi</h4>;';

await check('a raw element names the declarations its conversion would promote', async () => {
	const r = await run(
		{ 'loupe.config.json': CONFIG(), 'styles/a.scss': TITLE_CSS, 'src/A.tsx': H4 },
		{ components: componentRegistry },
	);
	const f = one(at(r, 'system/raw-element'), 'the <h4> should report');
	// Text's surface owns font-size through `variant`, and nothing else here.
	assert(
		f.message === '<h4> → <Text render={ <h4 /> }> (@wordpress/ui) — converted, would block: font-size (.acme-title)',
		`message: ${f.message}`,
	);
	assert(f.code === '<h4>', `the identity does not move: ${f.code}`);
});

await check('a raw element whose conversion changes nothing says nothing more', async () => {
	const r = await run(
		{
			'loupe.config.json': CONFIG(),
			'styles/a.scss': '.acme-title { color: #826200; letter-spacing: 0.05em; }',
			'src/A.tsx': H4,
		},
		{ components: componentRegistry },
	);
	const f = one(at(r, 'system/raw-element'), 'the <h4> should report');
	assert(f.message === '<h4> → <Text render={ <h4 /> }> (@wordpress/ui)', `message: ${f.message}`);
});

await check('where no registry records surfaces, every appearance property is named', async () => {
	const r = await run({
		'loupe.config.json': CONFIG(),
		'styles/a.scss': `${TITLE_CSS}\n.acme-big { border: 1px solid #ccc; }`,
		'src/A.tsx': 'export const A = () => <h4 className="acme-title acme-big acme-x">Hi</h4>;',
	});
	const f = one(at(r, 'system/raw-element'), 'the <h4> should report');
	assert(
		f.message ===
			'<h4> → <Text render={ <h4 /> }> — converted, would block: color, text-transform, letter-spacing, font-size (+1 more) (.acme-title, .acme-big)',
		`message: ${f.message}`,
	);
	// The keys of a run that says it and one that cannot.
	const quiet = await run({
		'loupe.config.json': CONFIG({ rules: { 'system/override': 'off', 'typography/in-css': 'off' } }),
		'styles/a.scss': `${TITLE_CSS}\n.acme-big { border: 1px solid #ccc; }`,
		'src/A.tsx': 'export const A = () => <h4 className="acme-title acme-big acme-x">Hi</h4>;',
	});
	const bare = one(at(quiet, 'system/raw-element'), 'the <h4> should still report');
	assert(bare.message === '<h4> → <Text render={ <h4 /> }>', `with nothing to promote: ${bare.message}`);
	assert(findingKey(bare) === findingKey(f), `the baseline key moved: ${findingKey(bare)} / ${findingKey(f)}`);
});

await check('a malformed surface is dropped rather than half-read', () => {
	const loaded = loadComponents([
		{ name: 'A', package: 'p', status: 'recommended', surface: { properties: { color: 3 } } },
		{ name: 'B', package: 'p', status: 'recommended', surface: { properties: [] } },
		{ name: 'C', package: 'p', status: 'recommended', surface: { properties: { 'Font-Size': ['variant'] } } },
		{ name: 'D', package: 'p', status: 'recommended', surface: { properties: {} } },
	]);
	assert(!loaded.get('p::A')?.surface, 'a non-prop value invalidates the surface');
	assert(!loaded.get('p::B')?.surface, 'properties must be an object');
	assert(loaded.get('p::C')?.surface?.properties['font-size']?.[0] === 'variant', 'property names are lower-cased');
	assert(loaded.get('p::D')?.surface !== undefined, 'an empty surface is a verified answer, and is kept');
	assert(loaded.get('p::A')?.surfaced, 'every entry of a registry recording a surface is read by surface');
});

// Where the registry records no surface anywhere, a missing one is not a gap in
// one entry, and the rule keeps the reading it had before surfaces existed.
await check('whether a registry records surfaces is the loader’s to say, per component', () => {
	const none = loadComponents([
		{ name: 'A', package: 'p', status: 'recommended', surfaced: true },
		{ name: 'B', package: 'p', status: 'recommended', surface: { properties: { color: 3 } } },
	]);
	assert(
		[...none.values()].every((e) => !e.surfaced),
		'neither a claimed flag nor a malformed surface makes a registry surfaced',
	);
	const merged = new Map([
		...none,
		...loadComponents([{ name: 'C', package: 'q', status: 'recommended', surface: { properties: {} } }]),
	]);
	const recorded = surfacesRecorded(merged);
	assert(!recorded('p', 'A'), 'an entry from a registry recording none');
	assert(!recorded('p', 'Z'), 'an unlisted component, from a package only that registry lists');
	assert(recorded('q', 'C.Item'), 'a part, by its namespace’s entry');
	assert(recorded('r', 'X'), 'a package nobody lists: whether anything in the run records surfaces');
	assert(recorded(undefined, 'X'), 'no package to key on: the same');
	assert(!surfacesRecorded(none)(undefined, 'X'), 'and nothing in the run does');
});

await check('a shorthand and its longhands overlap; neighbouring families do not', () => {
	const yes: [string, string][] = [
		['border', 'border-top-color'],
		['border-color', 'border'],
		['font', 'font-size'],
		['background', 'background-color'],
		['border-radius', 'border-top-left-radius'],
	];
	const no: [string, string][] = [
		['border', 'border-radius'],
		['font-size', 'font-weight'],
		['color', 'background-color'],
	];
	for (const [a, b] of yes) assert(propsOverlap(a, b) && propsOverlap(b, a), `${a} / ${b} should overlap`);
	for (const [a, b] of no) assert(!propsOverlap(a, b), `${a} / ${b} should not overlap`);
});

// What the shipped surfaces claim is checked against what the rules can see: a
// property neither rule reads is data nobody acts on, and a surface with no
// provenance is a guess.
await check('every shipped surface is sourced, and lists only properties the rules read', () => {
	const raw = JSON.parse(readFileSync(COMPONENT_REGISTRY, 'utf8')) as {
		scope?: { covers?: unknown; absent?: unknown };
		components: { name: string; package: string; surface?: unknown }[];
	};
	assert(Array.isArray(raw.scope?.covers) && typeof raw.scope?.absent === 'string', 'the file declares its scope');
	const surfaced = raw.components.filter((c) => c.surface !== undefined);
	assert(surfaced.length > 0, 'no entry carries a surface');
	for (const c of surfaced) {
		const s = componentRegistry.get(`${c.package}::${c.name}`)?.surface;
		assert(s, `${c.package}::${c.name}: the surface did not load`);
		assert(/\d{4}-\d{2}-\d{2}/.test(s.verifiedAgainst ?? ''), `${c.name}: no dated verifiedAgainst`);
		const unread = Object.keys(s.properties).filter((p) => !APPEARANCE_PROPS.has(p));
		assert(!unread.length, `${c.package}::${c.name} lists properties no rule reads: ${unread.join(', ')}`);
	}
	// Issue #21's family: each control's surface is a recorded answer, even
	// where the answer is that it owns nothing a class can reach.
	for (const name of [
		'TextControl',
		'SelectControl',
		'ToggleControl',
		'CheckboxControl',
		'RadioControl',
		'TextareaControl',
		'ComboboxControl',
		'RangeControl',
		'SearchControl',
	])
		assert(componentRegistry.get(`@wordpress/components::${name}`)?.surface, `${name} has no surface`);
});

finish();
