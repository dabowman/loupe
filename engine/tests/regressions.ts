#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestStems } from '../src/markup.ts';
import { isSource } from '../src/discover.ts';
import { loadConfig } from '../src/config.ts';
import { analyze } from '../src/analyze.ts';
import { assert, check, cleanup, execFailure, finish, one, scratch, writeAll } from './harness.ts';
import type { Finding } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'loupe.mjs');

const tmpRepo = (files: Record<string, string>): string => {
	const root = scratch('dsh-regress-');
	writeAll(root, files);
	return root;
};

// A 10MB generated file made the old `/([A-Za-z_][\w-]*)\$\{/g` backtrack
// quadratically: a gutenberg scan took 100s, past every hook timeout, so the
// gate silently never ran. The bound is loose on purpose — it is there to catch
// a return to quadratic, not to police milliseconds.
await check('harvestStems stays linear on a long word run', () => {
	const t = Date.now();
	harvestStems(`${'a'.repeat(4_000_000)}\${x}`);
	const ms = Date.now() - t;
	assert(ms < 1000, `4MB word run took ${ms}ms — quadratic backtracking is back`);
});

await check('harvestStems still finds interpolated stems', () => {
	const got = [...harvestStems('`wf-item-${id}` `x${y}` `deep-nested-${z}`')];
	assert(got.includes('wf-item-') && got.includes('deep-nested-'), `got ${JSON.stringify(got)}`);
	assert(!got.includes('x'), 'a stem with no hyphen is not a class stem');
});

// The PostToolUse hook fires on every Edit and Write. Without this, a README
// edit paid for a whole-repo index to be told there was nothing to say.
await check('isSource rejects files no rule can reach', () => {
	const sources = {
		styles: ['**/*.css'],
		markup: ['**/*.jsx'],
		references: ['**/*.php'],
		ignore: ['**/node_modules/**'],
	};
	assert(!isSource(sources, 'README.md'), 'README.md is not a source file');
	assert(!isSource(sources, 'node_modules/x/a.jsx'), 'ignored paths are not sources');
	assert(isSource(sources, 'src/App.jsx'), 'markup is a source file');
	assert(isSource(sources, 'style.css'), 'styles are source files');
});

// `wp-parsely-loading` matched the `wp-` external prefix and reported as a
// library internal — sending the agent to stop styling a class the project owns.
await check('a project prefix beats a library prefix', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({
			extends: 'wordpress-components',
			namespaces: { project: ['wp-parsely-'] },
		}),
		'src/App.jsx': 'export const App = () => <div className="wp-parsely-loading" />;',
		'style.css': '.wp-parsely-loading { color: #f00; }',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const { findings } = await analyze(config, { scope: null });
		const internal = findings.filter((f) => String(f.message).includes('library internal'));
		assert(!internal.length, `reported as a library internal: ${JSON.stringify(internal)}`);
	} finally {
		cleanup(root);
	}
});

// `--files /abs/path` matched no repo-relative finding, so the run reported
// clean. `/loupe-audit <path>` hands it absolute paths routinely.
await check('--files accepts an absolute path', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'generic', rules: { 'layout/margin-on-child': 'warn' } }),
		'style.css': '.a { margin-bottom: 16px; }',
	});
	try {
		const run = (arg: string): string =>
			execFileSync('node', [CLI, 'check', '--root', root, '--files', arg, '--format', 'json'], {
				encoding: 'utf8',
			});
		const abs = JSON.parse(run(join(root, 'style.css'))) as { summary: { total: number } };
		const rel = JSON.parse(run('style.css')) as { summary: { total: number } };
		assert(rel.summary.total > 0, 'fixture should produce a finding');
		assert(abs.summary.total === rel.summary.total, `absolute path found ${abs.summary.total}, relative found ${rel.summary.total}`);
	} finally {
		cleanup(root);
	}
});

// A mistyped preset in the plugin settings made loadConfig throw, which under
// the hook is exit 2 — blocking every turn in every project, with nothing the
// agent could do about it.
await check('a config error never blocks a turn', () => {
	const root = tmpRepo({ 'src/App.jsx': 'export const App = () => <div />;' });
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"x","tool_input":{"file_path":"src/App.jsx"}}',
			env: { ...process.env, CLAUDE_PLUGIN_OPTION_PRESET: 'no-such-preset' },
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(parsed.systemMessage?.includes('config error'), `unexpected output: ${out}`);
	} catch (err) {
		const f = execFailure(err);
		throw new Error(`hook exited non-zero on a config error: ${f.status} ${f.stderr}`);
	} finally {
		cleanup(root);
	}
});

// The wordpress-components markup glob was `**/src/**`, which made 59% of a real
// repo invisible — and every class referenced only there reported as dead.
await check('markup outside src/ still counts as a reference', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({
			extends: 'wordpress-components',
			namespaces: { project: ['acme-'] },
		}),
		'routes/panel/index.tsx': 'export const P = () => <div className="acme-panel" />;',
		'routes/panel/style.css': '.acme-panel { color: #f00; }',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const { findings } = await analyze(config, { scope: null });
		const dead = findings.filter((f) => f.rule === 'css/dead-class');
		assert(!dead.length, `reported live classes as dead: ${JSON.stringify(dead.map((f) => f.message))}`);
	} finally {
		cleanup(root);
	}
});

// Claude Code exports CLAUDE_PLUGIN_OPTION_* to hook processes only. `status`
// therefore never saw the blocking switch and reported every inferred config as
// advisory, however it was configured — while the hook happily blocked. A
// diagnostic that cannot observe the setting it diagnoses sends you hunting for
// the bug somewhere else.
await check('status reports the blocking switch it cannot see in the environment', () => {
	const home = scratch('dsh-home-');
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx': 'export const A = () => <div className="acme-a" />;',
	});
	try {
		mkdirSync(join(home, '.claude'), { recursive: true });
		writeFileSync(
			join(home, '.claude', 'settings.json'),
			JSON.stringify({ pluginConfigs: { 'loupe@somewhere': { options: { blocking: true } } } })
		);
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
		delete env['CLAUDE_PLUGIN_ROOT'];
		const out = execFileSync('node', [CLI, 'status', '--root', root], { encoding: 'utf8', env });
		assert(/blocking on/.test(out), `status did not read the setting:\n${out}`);
		assert(/Turns are blocked by/.test(out), `status still claims nothing blocks:\n${out}`);
	} finally {
		cleanup(home);
		cleanup(root);
	}
});

// The other half of the same bug: what status promises has to be what the hook
// does, or the diagnostic is just a different kind of wrong.
await check('the hook blocks when the setting says it should', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	try {
		execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"blk","tool_input":{"file_path":"styles/a.css"}}',
			env: { ...process.env, CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		throw new Error('hook exited 0 — it did not block');
	} catch (err) {
		const f = execFailure(err);
		if (f.message.includes('did not block')) throw err;
		assert(f.status === 2, `expected exit 2, got ${f.status}`);
		assert(/system\/override|typography\/in-css/.test(f.stderr), `no report handed back:\n${f.stderr}`);
	} finally {
		cleanup(root);
	}
});

// `loupe baseline` from a shell has no CLAUDE_PLUGIN_DATA; the Stop hook always
// has one. State keyed off that variable meant the two processes read different
// files, so a recorded backlog was invisible to the gate that was supposed to
// honor it — and the gate blocked with nothing in its output to say why.
await check('a baseline recorded from a shell is visible to the plugin hook', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	const pluginData = scratch('dsh-plugin-data-');
	try {
		const shell = { ...process.env };
		delete shell['CLAUDE_PLUGIN_DATA'];
		const recorded = execFileSync('node', [CLI, 'baseline', '--root', root], { encoding: 'utf8', env: shell });
		assert(/baselined [1-9]/.test(recorded), `nothing baselined:\n${recorded}`);

		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"base","tool_input":{"file_path":"styles/a.css"}}',
			env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		assert(!/blocking/i.test(out), `hook did not honor the baseline:\n${out}`);
	} finally {
		cleanup(root);
		cleanup(pluginData);
	}
});

// Advisory mode is not an off switch: an advisory finding still reaches the
// agent's context, and an agent that sees a finding starts fixing it. The
// escape hatch has to produce nothing at all.
await check('LOUPE_OFF silences a hook that would otherwise block', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"off","tool_input":{"file_path":"styles/a.css"}}',
			env: { ...process.env, LOUPE_OFF: '1', CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		assert(out === '', `expected no output, got: ${out}`);
	} finally {
		cleanup(root);
	}
});

/** Analyze one throwaway markup file under the WPDS preset. */
const findingsFor = async (source: string, designSystem?: Record<string, unknown>): Promise<Finding[]> => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', ...(designSystem ? { designSystem } : {}) }),
		'src/A.tsx': source,
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'loupe.config.json') });
		const { findings } = await analyze(config, { scope: null });
		return findings;
	} finally {
		cleanup(root);
	}
};

const rawOnly = (findings: readonly Finding[]): Finding[] => findings.filter((f) => f.rule === 'system/raw-element');

// `render={ <h4 /> }` is how WPDS gives a text component its semantic element —
// the component registry names that idiom as `Heading`'s replacement. Reporting
// the `<h4>` inside it fired the rule on the result of obeying the rule, leaving
// nothing to do but undo the conversion or suppress.
await check('an element handed to a substitution prop is not raw markup', async () => {
	const findings = rawOnly(
		await findingsFor(
			[
				"import { Text } from '@wordpress/ui';",
				'export const A = () => <Text variant="heading-md" render={ <h4 /> }>Hi</Text>;',
				'export const B = () => <Text variant="heading-md" render={ ( props ) => <h4 { ...props } /> }>Hi</Text>;',
				'export const C = () => <Text render={ ( props ) => { return <h4 { ...props } />; } }>Hi</Text>;',
				'export const D = () => <Text render={ big ? <h2 /> : <h4 /> }>Hi</Text>;',
				'export const E = () => <Text as={ <h4 /> }>Hi</Text>;',
				// A callback that touches its props destructures before it returns —
				// the return is still the one element, whatever the block does first.
				'export const F = () => <Text render={ ( { cls, ...rest } ) => { const c = cls; return <h4 className={ c } { ...rest } />; } }>Hi</Text>;',
				'export const G = () => <Text render={ function ( props ) { return <h4 { ...props } />; } }>Hi</Text>;',
				// A type assertion is not a different value: a narrower prop type is
				// what makes an author reach for one, and .tsx is a first-class input.
				'export const H = () => <Text render={ ( <h4 /> ) as never }>Hi</Text>;',
				'export const I = () => <Text render={ ( <h4 /> ) satisfies never }>Hi</Text>;',
				'export const J = () => <Text render={ ( <h4 /> )! }>Hi</Text>;',
				// Both arms of a guard, as for a conditional: following only the right
				// one exempted the fallback and still reported the guarded element.
				'export const K = () => <Text render={ <h4 /> || null }>Hi</Text>;',
				'export const L = () => <Text render={ big && <h2 /> || <h4 /> }>Hi</Text>;',
				// JSX lets the braces be dropped entirely.
				'export const M = () => <Text render=<h4 /> >Hi</Text>;',
				// WPDS ships its own components under an experimental prefix, and
				// `__experimentalText` is the same text component as `Text`.
				"import { __experimentalText } from '@wordpress/components';",
				'export const N = () => <__experimentalText render={ <h4 /> }>Hi</__experimentalText>;',
				// A namespace import puts the component name in the member.
				"import * as UI from '@wordpress/ui';",
				'export const O = () => <UI.Text render={ <h4 /> }>Hi</UI.Text>;',
			].join('\n'),
		),
	);
	assert(!findings.length, `flagged the escape hatch it recommends: ${JSON.stringify(findings.map((f) => f.message))}`);
});

// The exemption is for the components whose job is emitting a tag. Every other
// export of a design-system package that takes a `render` prop takes an ordinary
// render callback — `@wordpress/components` ships `FormFileUpload` — and markup
// inside one of those is markup the author wrote, with an analog to convert to.
await check('a design-system render callback is not a substitution', async () => {
	const findings = rawOnly(
		await findingsFor(
			[
				"import { FormFileUpload, Button } from '@wordpress/components';",
				'export const A = () => <FormFileUpload render={ ( { open } ) => <p onClick={ open }>pick</p> } />;',
				'export const B = () => <Button render={ <p>label</p> } />;',
			].join('\n'),
		),
	);
	assert(
		findings.length === 2,
		`a real render callback was exempted: ${JSON.stringify(findings.map((f) => f.message))}`,
	);
});

// `attr.name` collapses a namespace, so `xlink:render` read as `render` and
// exempted an element no substitution prop was ever given.
await check('a namespaced attribute is not a substitution prop', async () => {
	const findings = rawOnly(
		await findingsFor(
			["import { Text } from '@wordpress/ui';", 'export const A = () => <Text xlink:render={ <h4 /> }>Hi</Text>;'].join(
				'\n',
			),
		),
	);
	one(findings, 'a namespaced prop exempted the element');
});

// `render` is not a name WPDS reserved: react-router, Formik and Downshift all
// spell a render prop exactly that. Gating the exemption on "the tag starts with
// a capital" bought the fix with a silent false negative — an element that
// genuinely should convert, reported nowhere, with nothing to suppress.
await check('a third-party render prop is not a design-system substitution', async () => {
	const findings = rawOnly(
		await findingsFor(
			[
				"import { Route } from 'react-router';",
				'export const A = () => <Route render={ () => <p>page</p> } />;',
				'export const B = () => <Whatever render={ <p>x</p> } />;',
				'export const C = () => <div render={ <h4 /> } />;',
			].join('\n'),
		),
	);
	assert(findings.length === 3, `a non-WPDS carrier exempts nothing — got ${findings.length}`);
});

// The narrow reading on purpose: the prop's own element is an argument naming a
// tag, but everything under it is markup the author wrote and React renders as
// markup. Exempting the subtree would hide a hand-rolled layout by wrapping it
// in a `render`.
await check('markup nested inside a substitution prop still counts', async () => {
	const findings = rawOnly(
		await findingsFor(
			[
				"import { Text } from '@wordpress/ui';",
				// Both elements report without the fix, so this fixture discriminates:
				// the outer <p> is the substitution, the <h4> under it is markup.
				'export const A = () => <Text render={ <p><h4>t</h4></p> }>Hi</Text>;',
				'export const B = () => <h4>a heading nobody handed to anything</h4>;',
			].join('\n'),
		),
	);
	assert(findings.length === 2, `expected the nested <h4> and B's <h4> — got ${findings.length}`);
	assert(
		findings.every((f) => f.message.includes('<h4>')),
		`flagged the substitution element itself: ${JSON.stringify(findings.map((f) => f.message))}`,
	);
});

// The exclusion answers one question — which tag does the component emit — and
// no others. Styling written on that element is drift wherever it sits.
await check('styling on a substitution element is still styling', async () => {
	const findings = await findingsFor(
		[
			"import { Text } from '@wordpress/ui';",
			'export const A = () => <Text render={ <h4 style={ { marginBottom: 16 } } /> }>Hi</Text>;',
		].join('\n'),
	);
	assert(!rawOnly(findings).length, 'the <h4> is still the substitution element');
	assert(
		findings.some((f) => f.rule === 'layout/margin-on-child'),
		`inline margin went unreported: ${JSON.stringify(findings.map((f) => f.message))}`,
	);
});

// `render` is WPDS and Base UI; `as` and `component` are the same idiom
// elsewhere. A design system that spells it differently says so in config, and
// an empty list is how a project asks for the old behaviour back.
await check('the substitution-prop list is config-driven', async () => {
	const source = [
		"import { Text } from '@wordpress/ui';",
		'export const A = () => <Text render={ <h4 /> } elementType={ <h5 /> }>Hi</Text>;',
	].join('\n');
	const custom = rawOnly(await findingsFor(source, { substitutionProps: ['elementType'] }));
	const f = one(custom, 'only the prop the config names is a substitution');
	assert(f.message.includes('<h4>'), `wrong element exempted: ${f.message}`);
	const none = rawOnly(await findingsFor(source, { substitutionProps: [] }));
	assert(none.length === 2, `an empty list exempts nothing — got ${none.length}`);

	// `new Set('render')` is a set of characters — a config that means nothing it
	// says, reporting identically to one that turned the exemption off.
	let threw = '';
	await findingsFor(source, { substitutionProps: 'render' }).catch((err: unknown) => {
		threw = err instanceof Error ? err.message : String(err);
		return [];
	});
	assert(/substitutionProps must be an array/.test(threw), `a bare string was accepted: ${threw || 'no throw'}`);
});

finish();
