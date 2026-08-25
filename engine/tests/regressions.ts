#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestStems } from '../src/markup.ts';
import { isSource } from '../src/discover.ts';
import { loadConfig } from '../src/config.ts';
import { RULES } from '../src/rules.ts';
import { analyze } from '../src/analyze.ts';
import { CLI, assert, check, cleanup, execFailure, finish, one, scratch, writeAll } from './harness.ts';
import type { Finding } from '../src/types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The shipped profiles, at the path the hooks and commands pass. */
const PROFILES = join(HERE, '..', '..', 'profiles');

/**
 * Run the CLI and hand back its exit code and both streams.
 *
 * Both halves of the option lookup are isolated, not just the loud one: the
 * plugin option variables outrank a profile's preset by design, and stripping
 * them is exactly the condition under which `resolvedOptions` falls back to
 * `~/.claude/settings.json` — so an emptied environment alone would hand the
 * developer's own settings file the decision these tests exist to pin down.
 * Every CLI call in this file goes through here for that reason; the one that
 * did not was failing on any machine with `CLAUDE_PLUGIN_OPTION_BLOCKING` set,
 * and passing for the wrong reason on any machine with it set to false.
 *
 * `status` is a zero-exit command and `hook` is not, so the code comes back
 * rather than being thrown: a caller that cares asserts on it. A spawn that
 * never ran does throw — `spawnSync` reports that as `error` with both streams
 * null, and returning `''` for those turned an engine crash into a passing
 * negative assertion.
 */
function runCli(
	argv: readonly string[],
	extra: NodeJS.ProcessEnv = {},
	input?: string,
): { status: number | null; stdout: string; stderr: string } {
	const home = scratch('dsh-home-');
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
		// `process.execPath` rather than `'node'`: the suite must run under the
		// interpreter that started it, not whichever one PATH resolves to.
		const r = spawnSync(process.execPath, [CLI, ...argv], {
			encoding: 'utf8',
			env: { ...env, ...extra },
			...(input === undefined ? {} : { input }),
		});
		if (r.error) throw r.error;
		return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
	} finally {
		cleanup(home);
	}
}

/**
 * A repo with no config: a WPDS import, and a class prefix inference can find.
 *
 * The prefix matters as much as the import — half of what `--profile` has to
 * leave alone is what inference concluded about *this* project.
 */
const inferrableRepo = (): string =>
	tmpRepo({
		'package.json': JSON.stringify({ name: 'externals', devDependencies: { '@wordpress/scripts': '^30.0.0' } }),
		'src/A.jsx': [
			"import { TextControl } from '@wordpress/components';",
			'export const A = () => (',
			'  <div className="acme-a">',
			'    <span className="acme-b" />',
			'    <span className="acme-c" />',
			'    <TextControl className="acme-d" />',
			'  </div>',
			');',
		].join('\n'),
		'styles/a.css': '.acme-a { color: #f00; }\n.acme-b { margin-bottom: 16px; }\n.acme-c { padding: 4px; }\n.acme-d { display: block; }\n',
	});

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

// SARIF and JSON read `RULES[id].title` straight out of the table, while the
// agent format ran it through `renderTitle`. So a GitHub code-scanning alert
// said "replace with a {tokenPrefix} token" where the terminal said
// "--wpds-*". Nothing errored: the template is a valid string, and only a
// human comparing two formats would notice.
//
// The placeholder list is derived from the titles rather than written down
// here, so a rule added with a new {placeholder} is covered without anyone
// remembering to update this test.
await check('no formatter emits an unsubstituted {placeholder}', async () => {
	const placeholders = [
		...new Set(Object.values(RULES).flatMap((r) => [...r.title.matchAll(/\{(\w+)\}/g)].map((m) => m[0]))),
	];
	assert(placeholders.length > 0, 'no rule title carries a placeholder — this test would prove nothing');

	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '.acme-card { border-radius: 4px; margin-bottom: 8px; }',
		'src/A.jsx': 'export const A = () => <div className="acme-card" />;',
	});
	try {
		for (const format of ['agent', 'json', 'sarif']) {
			// The fixture is deliberately blocking, so `check` exits 1 and
			// execFileSync throws. The report is on stdout either way, and it is
			// the blocking path the hook hands back that matters most here.
			let out: string;
			try {
				out = execFileSync('node', [CLI, 'check', '--all', '--root', root, '--format', format], {
					encoding: 'utf8',
				});
			} catch (err) {
				const f = execFailure(err);
				assert(f.status === 1, `check failed for an unexpected reason: ${f.status} ${f.stderr}`);
				out = f.stdout;
			}
			assert(out.includes('acme-card') || out.includes('border-radius'), `${format} produced no findings to check`);
			const leaked = placeholders.filter((ph) => out.includes(ph));
			assert(!leaked.length, `${format} shipped ${leaked.join(', ')} unsubstituted`);
		}
	} finally {
		cleanup(root);
	}
});

// `--profile <id>` says "use this profile regardless of what the project
// imports" and used none of it: the scope gate re-asked the question the flag
// had already answered and dropped both registries, and the profile's own
// preset was read by nothing. The run that named a design system was
// configured for no design system at all — reported, of course, as a clean one.
await check('a named profile brings its preset and its registries', () => {
	const root = inferrableRepo();
	try {
		const { stdout, stderr } = runCli(['status', '--root', root, '--profile', 'wpds', '--profiles', PROFILES]);
		assert(/extending preset wpds/.test(stdout), `the profile's preset did not apply:\n${stdout}`);
		assert(/suppress:\s+wpds-allow/.test(stdout), `the profile's preset did not reach the ruleset:\n${stdout}`);
		assert(!/registry skipped/.test(stderr), `the named profile's registries were dropped:\n${stderr}`);
		assert(!/patterns\/duplicate-composite\s+off/.test(stdout), `the pattern registry never reached its rule:\n${stdout}`);
		assert(!/system\/locked-component\s+off/.test(stdout), `the component registry never reached its rule:\n${stdout}`);
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

// The suppression keyword is preset-scoped — `generic` asks for `ds-allow`,
// `wpds` for `wpds-allow` — so adopting a preset renames it. Every directive
// written in the old keyword used to go quiet on that rename: not honored, not
// reported as malformed, missing from `loupe suppressions`. A reason someone
// wrote down and signed off simply stopped counting, and nothing anywhere said
// so. Read aliases are what keep the rename from costing anything.
await check('a preset rename does not orphan directives written in the old keyword', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': [
			'/* ds-allow tokens/hardcoded-value -- the preset before this one */',
			'.acme-a { color: #826200; }',
			'/* wpds-allow tokens/hardcoded-value -- the keyword this preset asks for */',
			'.acme-b { color: #826201; }',
			'/* ds-disable */',
			'.acme-c { color: #826202; }',
			'/* ds-allow tokens/hardcoded-value */',
			'.acme-d { color: #826203; }',
			'',
		].join('\n'),
	});
	try {
		const config = await loadConfig({ root });
		const r = await analyze(config, { scope: null });
		const lines = (rule: string): number[] => r.findings.filter((f) => f.rule === rule).map((f) => f.line).sort();

		// Both keywords mute. A blanket alias stays blanket: `ds-disable` is
		// carried in the preset's blanket list, and reading `ds-allow` must not
		// hand it the power to mute anything.
		assert(
			JSON.stringify(lines('tokens/hardcoded-value')) === '[6,8]',
			`expected findings only on the blanket and reasonless lines — got ${JSON.stringify(lines('tokens/hardcoded-value'))}`,
		);
		// A directive in the old keyword that is malformed reports as malformed,
		// rather than reverting to prose and reporting nothing.
		assert(
			JSON.stringify(lines('suppression/malformed')) === '[5,7]',
			`expected malformed on the blanket and reasonless lines — got ${JSON.stringify(lines('suppression/malformed'))}`,
		);

		// It counts as a suppression, which is what `loupe suppressions` audits,
		// and it carries the keyword it was written with so the rename is findable.
		assert(r.directives.length === 2, `expected 2 active directives, got ${r.directives.length}`);
		const aliased = r.directives.filter((d) => d.alias !== undefined);
		assert(aliased.length === 1 && aliased[0]?.alias === 'ds-allow', `expected one directive marked ds-allow, got ${JSON.stringify(aliased)}`);
	} finally {
		cleanup(root);
	}
});

// The first fix for that reached the preset by skipping inference entirely,
// which threw away the other half of what inference is for. A profile says
// which design system this is; only the project can say what its own classes
// are called — so `--profile` switched css/dead-class off on repos where it had
// been running, and `loupe init --profile` wrote that loss into the repo.
await check('a named profile keeps what inference found about the project', () => {
	const root = inferrableRepo();
	try {
		const { stdout } = runCli(['status', '--root', root, '--profile', 'wpds', '--profiles', PROFILES]);
		assert(/namespaces: acme-/.test(stdout), `the inferred namespaces were dropped:\n${stdout}`);
		assert(!/css\/dead-class\s+off/.test(stdout), `a rule that was running was switched off:\n${stdout}`);
	} finally {
		cleanup(root);
	}
});

// Reading another preset's keyword must not put it on the *malformed* gate as
// well. Every line below is prose — one of them is the comment someone writes
// precisely because the migration guide told them about the rename — and each
// one turned a clean repo into exit 1 under `wpds`, where malformed is an
// error. An upgrade that reports new errors on comments nobody changed is a
// worse trade than the bug it fixes.
await check('prose mentioning another preset\'s keyword stays prose', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': [
			'/* ds-allow is the old keyword; write wpds-allow instead. */',
			'/* ds-allowlist below is generated - do not edit */',
			'// ds-allow used to be spelled that way before the rename',
			'.acme-a { color: var(--wpds-color-fg); }',
			'',
		].join('\n'),
		'src/A.jsx': 'export const A = () => <div className="acme-a">x</div>;\n',
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		assert(
			!r.findings.length,
			`prose about the rename reported: ${JSON.stringify(r.findings.map((f) => `${f.rule}:${f.line}`))}`,
		);
	} finally {
		cleanup(root);
	}
});

// Symmetrically, and this is the direction that was arbitrary: `wpds-allow-file`
// is a blanket form under `wpds`, so under `wpds` it reports. Under `generic` it
// is a word in a comment — reading `wpds-allow` there must not drag its blanket
// spelling along with it.
await check("another preset's blanket spelling is prose where it is not blanket", async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'generic', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '/* wpds-allow-file */\n/* wpds-allowlist: generated */\n.acme-a { display: block; }\n',
		'src/A.jsx': 'export const A = () => <div className="acme-a">x</div>;\n',
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		assert(
			!r.findings.length,
			`prose reported under generic: ${JSON.stringify(r.findings.map((f) => `${f.rule}:${f.line}`))}`,
		);
	} finally {
		cleanup(root);
	}
});

// The one thing an alias may report. A line with a directive's shape and no
// reason was muting nothing before the rename either — leaving it silent is how
// the escape hatch rots.
await check('an aliased directive missing its reason still reports', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '/* ds-allow tokens/hardcoded-value */\n.acme-a { color: #826200; }\n',
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		const malformed = r.findings.filter((f) => f.rule === 'suppression/malformed');
		assert(malformed.length === 1 && malformed[0]?.line === 1, `expected one malformed at line 1, got ${JSON.stringify(malformed)}`);
	} finally {
		cleanup(root);
	}
});

// `suppression.aliases` is user-supplied text interpolated into a regex. The
// escaping and the blanket guard are the whole safety story for it, and both
// fail silently — as a keyword that matches too much, or one that mutes when it
// should report.
await check('declared aliases are escaped, and a blanket term is never one', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({
			extends: 'wpds',
			namespaces: { project: ['acme-'] },
			suppression: { aliases: ['ds.allow', 'a|b', '(x', 'ds-disable'] },
		}),
		'styles/a.css': [
			'/* ds.allow tokens/hardcoded-value -- a dot is a dot */',
			'.acme-a { color: #826200; }',
			'/* dsxallow tokens/hardcoded-value -- the dot must not match x */',
			'.acme-b { color: #826201; }',
			'/* (x tokens/hardcoded-value -- an unbalanced group is literal text */',
			'.acme-c { color: #826202; }',
			'/* ds-disable tokens/hardcoded-value -- blanket terms stay blanket */',
			'.acme-d { color: #826203; }',
			'',
		].join('\n'),
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		const lines = (rule: string): number[] =>
			r.findings.filter((f) => f.rule === rule).map((f) => f.line).sort((a, b) => a - b);
		assert(
			JSON.stringify(lines('tokens/hardcoded-value')) === '[4,8]',
			`expected the escaped aliases to mute and only those — got ${JSON.stringify(lines('tokens/hardcoded-value'))}`,
		);
		// `ds-disable` is a blanket term of the active preset, so naming it as an
		// alias buys nothing: it reports, exactly as it did before.
		assert(lines('suppression/malformed').includes(7), `a blanket term declared as an alias must still report — got ${JSON.stringify(lines('suppression/malformed'))}`);
	} finally {
		cleanup(root);
	}
});

// The mirror of the two prose tests above, and the half they miss: each of them
// runs its prose only under the preset where the term is an *alias*, so the word
// boundary they are named for is exercised only on the gate that already had
// one. `ds-allowlist` under `generic` — the fallback for a project with no
// config at all — went through a bare `startsWith` and reported an error.
await check('a longer word starting with the active keyword stays prose', async () => {
	const cases: [string, string][] = [
		['generic', 'ds'],
		['wpds', 'wpds'],
	];
	for (const [preset, kw] of cases) {
		const root = tmpRepo({
			'loupe.config.json': JSON.stringify({ extends: preset, namespaces: { project: ['acme-'] } }),
			'styles/a.css': [
				`/* ${kw}-allowlist below is generated - do not edit */`,
				`/* ${kw}-allowed values are listed above */`,
				`/* ${kw}-disabled is a state, not a directive */`,
				`#${kw}-allow-panel { display: block; }`,
				'.acme-a { display: block; }',
				'',
			].join('\n'),
			'src/A.jsx': 'export const A = () => <div className="acme-a">x</div>;\n',
		});
		try {
			const r = await analyze(await loadConfig({ root }), { scope: null });
			assert(
				!r.findings.length,
				`${preset}: prose reported ${JSON.stringify(r.findings.map((f) => `${f.rule}:${f.line}`))}`,
			);
		} finally {
			cleanup(root);
		}
	}
});

// The other half of the shape gate. Narrowing what an alias may report is only
// safe while it still reports everything that is recognizably a *broken*
// directive — a reason with no rule ids, a bare keyword. Letting those fall
// through both branches is the silence the module header forbids: no mute, no
// finding, and nothing in `loupe suppressions` either.
await check('a broken directive written in an alias still reports', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': [
			'/* ds-allow -- Stack exposes no padding prop */',
			'.acme-a { display: block; }',
			'/* ds-allow */',
			'.acme-b { display: block; }',
			'',
		].join('\n'),
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		const at = r.findings.filter((f) => f.rule === 'suppression/malformed').map((f) => f.line).sort((a, b) => a - b);
		assert(JSON.stringify(at) === '[1,3]', `expected malformed at lines 1 and 3, got ${JSON.stringify(at)}`);
	} finally {
		cleanup(root);
	}
});

await check('a named profile does not discard the project_prefixes option', () => {
	const root = inferrableRepo();
	try {
		const { stdout } = runCli(['status', '--root', root, '--profile', 'wpds', '--profiles', PROFILES], {
			CLAUDE_PLUGIN_OPTION_PROJECT_PREFIXES: 'wf-',
		});
		assert(/namespaces: wf-/.test(stdout), `the plugin option was ignored under --profile:\n${stdout}`);
	} finally {
		cleanup(root);
	}
});

// A reason is mandatory, and the comment terminator is not one. `-- */` used to
// satisfy the reason group with the closer itself, so the loosest possible
// directive muted and `loupe suppressions` printed `*/` as the sign-off.
await check('the comment terminator is not a reason', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '/* wpds-allow tokens/hardcoded-value -- */\n.acme-a { color: #826200; }\n',
		'src/A.jsx': 'export const A = () => <div className="acme-a">x</div>;\n',
	});
	try {
		const r = await analyze(await loadConfig({ root }), { scope: null });
		assert(!r.directives.length, `an empty reason must not mute: ${JSON.stringify(r.directives)}`);
		assert(
			r.findings.some((f) => f.rule === 'suppression/malformed' && f.line === 1),
			`expected suppression/malformed at line 1, got ${JSON.stringify(r.findings.map((f) => `${f.rule}:${f.line}`))}`,
		);
	} finally {
		cleanup(root);
	}
});

// `init` writes a file that outlives the run, and it recomputes detection when
// the run did not do it. A --profile that skipped detection therefore wrote a
// config with the wrong namespaces into someone's repo — the one failure here
// that survives the process that caused it.
await check('init under a profile writes the profile preset and the real prefixes', () => {
	const root = inferrableRepo();
	try {
		const { stdout } = runCli(['init', '--root', root, '--profile', 'wpds', '--profiles', PROFILES], {
			CLAUDE_PLUGIN_OPTION_PROJECT_PREFIXES: 'wf-',
		});
		assert(/Wrote /.test(stdout), `init wrote nothing:\n${stdout}`);
		const written: unknown = JSON.parse(readFileSync(join(root, 'loupe.config.json'), 'utf8'));
		const cfg = written as { extends?: string; namespaces?: { project?: string[] } };
		assert(cfg.extends === 'wpds', `init recorded the wrong preset: ${JSON.stringify(written)}`);
		assert(cfg.namespaces?.project?.join(',') === 'wf-', `init recorded the wrong namespaces: ${JSON.stringify(written)}`);
	} finally {
		cleanup(root);
	}
});

// A profile's preset is the least explicit statement about a project, and every
// other one has to survive contact with it — including the two that reach the
// run without a file to point at.
await check('everything more explicit than a profile outranks its preset', () => {
	const root = inferrableRepo();
	const explicit = join(root, 'explicit.json');
	writeFileSync(explicit, JSON.stringify({ extends: 'generic' }));
	const configured = tmpRepo({ 'loupe.config.json': JSON.stringify({ extends: 'generic' }) });
	const named = ['--profile', 'wpds', '--profiles', PROFILES];
	try {
		const cases: [string, { stdout: string }][] = [
			['--config', runCli(['status', '--root', root, '--config', explicit, ...named])],
			['--preset', runCli(['status', '--root', root, '--preset', 'generic', ...named])],
			['the preset plugin option', runCli(['status', '--root', root, ...named], { CLAUDE_PLUGIN_OPTION_PRESET: 'generic' })],
			["the project's own config", runCli(['status', '--root', configured, ...named])],
		];
		for (const [what, { stdout }] of cases)
			assert(/suppress:\s+ds-allow/.test(stdout), `the profile preset overrode ${what}:\n${stdout}`);
	} finally {
		cleanup(root);
		cleanup(configured);
	}
});

// The gate may not block a turn on a guess, and a profile does not turn the
// guess into a statement: it names the design system, not this project. Reached
// for the preset by skipping inference and the config stopped being marked
// inferred — so an advisory hook run started blocking turns instead.
await check('a named profile does not make an inferred config block turns', () => {
	const root = inferrableRepo();
	try {
		// Through `runCli` like the rest: `CLAUDE_PLUGIN_OPTION_BLOCKING` is the
		// one variable that decides this outcome on its own, so a test reading it
		// out of the developer's environment is testing their settings, not the
		// code — true either way it happens to be set.
		const { status, stdout } = runCli(
			['hook', '--root', root, '--profile', 'wpds', '--profiles', PROFILES],
			{},
			'{"session_id":"prof","tool_input":{"file_path":"styles/a.css"}}',
		);
		assert(status === 0, `the hook blocked a turn on an inferred config (exit ${status}):\n${stdout}`);
		assert(/advisory/.test(stdout), `the hook did not report advisory:\n${stdout}`);
	} finally {
		cleanup(root);
	}
});

// `keyword` and `blanket` reach the parser from authored JSON through `merge`,
// which copies a non-object value verbatim. An empty keyword makes the parser's
// prefix tests universally true — every line of every file reported as a
// malformed suppression — and a `blanket` written as a bare string spreads into
// one prefix per character.
await check('an unusable suppression keyword falls back rather than flooding', async () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({
			extends: 'generic',
			namespaces: { project: ['acme-'] },
			suppression: { keyword: '', blanket: 'ds-disable' },
		}),
		'styles/a.css': '.acme-a { display: block; }\n.acme-b { display: block; }\n',
		'src/A.jsx': 'export const A = () => <div className="acme-a acme-b">x</div>;\n',
	});
	try {
		const config = await loadConfig({ root });
		assert(config.suppression.keyword === 'ds-allow', `expected the default keyword, got ${JSON.stringify(config.suppression.keyword)}`);
		const r = await analyze(config, { scope: null });
		assert(
			!r.findings.some((f) => f.rule === 'suppression/malformed'),
			`ordinary lines reported as malformed: ${JSON.stringify(r.findings.map((f) => `${f.rule}:${f.line}`))}`,
		);
	} finally {
		cleanup(root);
	}
});

// A profile naming a preset this install does not carry is a broken profile,
// not a broken project: its registries are still worth merging, so the run goes
// on — but silently going on would leave the ruleset a mystery.
await check('a profile naming an uninstalled preset says so and carries on', () => {
	const profiles = scratch('dsh-prof-');
	const root = inferrableRepo();
	try {
		writeAll(profiles, { 'acme/profile.json': JSON.stringify({ id: 'acme', name: 'Acme', preset: 'nope', packages: ['@acme/ui'] }) });
		const { stdout, stderr } = runCli(['status', '--root', root, '--profile', 'acme', '--profiles', profiles]);
		assert(/names preset nope, which is not installed/.test(stderr), `the broken profile said nothing:\n${stderr}`);
		assert(/config:\s+inferred/.test(stdout), `the run should fall back to inference:\n${stdout}`);
		assert(/namespaces: acme-/.test(stdout), `inference should still have run:\n${stdout}`);
	} finally {
		cleanup(profiles);
		cleanup(root);
	}
});

// The skip named the wrong input. It said the project does not import those
// packages; what is actually tested is what the *config* declares, and on an
// inferred config those are not the same thing — so the message sent you
// hunting for imports that were sitting right there in the file.
await check('a skipped registry names the config that rejected it', () => {
	const root = tmpRepo({
		'package.json': JSON.stringify({ name: 'plain' }),
		'registry.json': JSON.stringify({ packages: ['@acme/ui'], patterns: [] }),
		'src/a.tsx': 'export const A = () => <div />;\n',
	});
	try {
		const { stderr } = runCli(['status', '--root', root, '--patterns', join(root, 'registry.json')]);
		assert(/registry skipped/.test(stderr), `the skip must still be reported:\n${stderr}`);
		assert(/this config declares no design-system packages/.test(stderr), `the skip still blames the imports:\n${stderr}`);
	} finally {
		cleanup(root);
	}
});

await check('loupe suppressions names the rename behind an aliased directive', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'styles/a.css': '/* ds-allow tokens/hardcoded-value -- signed off */\n.acme-a { color: #826200; }\n',
	});
	try {
		const out = execFileSync('node', [CLI, 'suppressions', '--root', root], { encoding: 'utf8' });
		assert(/tokens\/hardcoded-value/.test(out), `directive missing from the inventory:\n${out}`);
		assert(/ds-allow \u2192 wpds-allow/.test(out), `the inventory does not name the rename:\n${out}`);
	} finally {
		cleanup(root);
	}
});

// A `--profile` that matches nothing selected nothing, applied no preset and
// said nothing — so a one-character typo checked strictly *less* than the same
// command with no flag at all, and reported clean either way. The sibling case
// one test up already warned; this one, the likelier mistake, did not.
await check('a --profile that matches nothing says so', () => {
	const root = inferrableRepo();
	try {
		const typo = runCli(['status', '--root', root, '--profile', 'wpsd', '--profiles', PROFILES]);
		assert(/no profile "wpsd"/.test(typo.stderr), `a mistyped profile said nothing:\n${typo.stderr}`);
		assert(/available: wpds/.test(typo.stderr), `the warning should name what is on offer:\n${typo.stderr}`);
		// The other way to reach the same state: the id is real, the directory it
		// lives in was never passed.
		const noDir = runCli(['status', '--root', root, '--profile', 'wpds']);
		assert(/--profiles was not given/.test(noDir.stderr), `a profile with nowhere to look said nothing:\n${noDir.stderr}`);
	} finally {
		cleanup(root);
	}
});

// `presetExists` gated a spec that `resolveExtends` would have resolved: one
// strips the `loupe/presets/` prefix and the other did not. A profile written
// the way the docs spell an extends target was told its preset is not installed.
await check('a profile may name its preset the way extends spells it', () => {
	const profiles = scratch('dsh-pref-');
	const root = inferrableRepo();
	try {
		writeAll(profiles, {
			'acme/profile.json': JSON.stringify({ id: 'acme', name: 'Acme', preset: 'loupe/presets/wpds', packages: ['@acme/ui'] }),
		});
		const { stdout, stderr } = runCli(['status', '--root', root, '--profile', 'acme', '--profiles', profiles]);
		assert(!/not installed/.test(stderr), `a resolvable preset was rejected:\n${stderr}`);
		assert(/suppress:\s+wpds-allow/.test(stdout), `the preset did not reach the ruleset:\n${stdout}`);
	} finally {
		cleanup(profiles);
		cleanup(root);
	}
});

// `init` recomputes detection when the run did not do it, and that second pass
// went through none of what outranks it — so on a repo that already had a
// config, `init --force` wrote the inferred namespaces over the ones the plugin
// option had configured. The wrong artifact, and it outlives the run.
await check('init --force over an existing config still honours the prefixes option', () => {
	const root = inferrableRepo();
	writeFileSync(join(root, 'loupe.config.json'), JSON.stringify({ extends: 'generic' }));
	try {
		const { stdout } = runCli(['init', '--root', root, '--force'], {
			CLAUDE_PLUGIN_OPTION_PROJECT_PREFIXES: 'wf-',
		});
		assert(/Wrote /.test(stdout), `init wrote nothing:\n${stdout}`);
		const cfg = JSON.parse(readFileSync(join(root, 'loupe.config.json'), 'utf8')) as {
			namespaces?: { project?: string[] };
		};
		assert(cfg.namespaces?.project?.join(',') === 'wf-', `init recorded the wrong namespaces: ${JSON.stringify(cfg)}`);
	} finally {
		cleanup(root);
	}
});

// The shim adds `--profiles <shipped>` unless the caller named a registry
// source itself, and `--profile` was on that opt-out list. It names one *among*
// the profiles that flag supplies rather than supplying any, so `loupe --profile
// wpds` reached the engine with no profiles directory, found nothing to force,
// and ran a weaker check than the same command without the flag.
await check('the shim still supplies its profiles directory under --profile', () => {
	const shim = join(HERE, '..', '..', 'bin', 'loupe');
	const root = inferrableRepo();
	try {
		const r = spawnSync('sh', [shim, 'status', '--root', root, '--profile', 'wpds'], {
			encoding: 'utf8',
			env: { ...process.env, HOME: root },
		});
		if (r.error) throw r.error;
		const stdout = r.stdout ?? '';
		assert(/profile:\s+wpds/.test(stdout), `the shim did not reach the shipped profile:\n${stdout}`);
		assert(/suppress:\s+wpds-allow/.test(stdout), `the profile's preset never applied:\n${stdout}`);
	} finally {
		cleanup(root);
	}
});

finish();
