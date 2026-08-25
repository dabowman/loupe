#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestStems } from '../src/markup.ts';
import { isSource } from '../src/discover.ts';
import { loadConfig } from '../src/config.ts';
import { analyze } from '../src/analyze.ts';
import { assert, check, cleanup, execFailure, finish, scratch, writeAll } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'loupe.mjs');

const tmpRepo = (files: Record<string, string>): string => {
	const root = scratch('dsh-regress-');
	writeAll(root, files);
	return root;
};

/**
 * The ambient environment, minus the switches that change what the gate does.
 *
 * `LOUPE_OFF` silences the hook, and it is exactly the variable a developer
 * working on the off switch has exported in the shell they run the suite from —
 * at which point the tests that assert the hook *blocks* fail with "it did not
 * block" and point at the wrong thing entirely.
 */
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
	const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
	if (!('LOUPE_OFF' in extra)) delete e['LOUPE_OFF'];
	return e;
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
			env: env({ CLAUDE_PLUGIN_OPTION_PRESET: 'no-such-preset' }),
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
			env: env({ CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' }),
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
		const shell = env();
		delete shell['CLAUDE_PLUGIN_DATA'];
		const recorded = execFileSync('node', [CLI, 'baseline', '--root', root], { encoding: 'utf8', env: shell });
		assert(/baselined [1-9]/.test(recorded), `nothing baselined:\n${recorded}`);

		// A hook that ignores the baseline blocks, and blocking is exit 2 — which
		// `execFileSync` raises as a throw before any assertion here can run. Catch
		// it and say what it means, or the regression reports itself as `Command
		// failed: node ...` and the message written for it is never reached.
		let out: string;
		try {
			out = execFileSync('node', [CLI, 'hook', '--root', root], {
				encoding: 'utf8',
				input: '{"session_id":"base","tool_input":{"file_path":"styles/a.css"}}',
				env: env({ CLAUDE_PLUGIN_DATA: pluginData, CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' }),
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			const f = execFailure(err);
			throw new Error(`hook did not honor the baseline \u2014 exit ${f.status}:\n${f.stderr}`);
		}
		assert(!/blocking/i.test(out), `hook did not honor the baseline:\n${out}`);
	} finally {
		cleanup(root);
		cleanup(pluginData);
	}
});

// `baseline` reported the entry count and called it findings, so it disagreed
// with the number `check` printed a moment later — 194 against 253, both
// labelled findings, with nothing on hand to say whether 59 had been dropped.
// The dedup itself is deliberate; only the label was wrong.
await check('baseline reports the findings recorded and the entries they collapsed into', () => {
	// Three selectors carrying the same declaration: same rule, same file, same
	// code, so three findings key to a single entry.
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <><Text className=\"acme-one\">one</Text><Text className=\"acme-two\">two</Text><Text className=\"acme-three\">three</Text></>;",
		'styles/a.css': '.acme-one { color: #f00; }\n.acme-two { color: #f00; }\n.acme-three { color: #f00; }',
	});
	// Nothing collapses here, so both counts are the same one and only one is named.
	const distinct = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-one\">one</Text>;",
		'styles/a.css': '.acme-one { color: #f00; font-size: 13px; }',
	});
	try {
		const recorded = execFileSync('node', [CLI, 'baseline', '--root', root], { encoding: 'utf8' });
		// `entry` singular: the count that gets hedged on the left was hardcoded
		// plural on the right, and `3 finding(s) as 1 entries` shipped.
		const both = /baselined (\d+) finding\(s\) as (\d+) (entry|entries) /.exec(recorded);
		assert(both, `baseline did not report both counts:\n${recorded}`);
		const [, findings, entries, noun] = both;
		assert(noun === (entries === '1' ? 'entry' : 'entries'), `wrong plural for ${entries}: ${recorded}`);
		const written = JSON.parse(readFileSync(join(root, '.loupe-baseline.json'), 'utf8')) as { entries: string[] };
		assert(Number(entries) === written.entries.length, `entry count is not what was written: ${entries} vs ${written.entries.length}`);
		assert(Number(findings) > Number(entries), `fixture did not collapse anything: ${recorded}`);

		// The number `check` hides next is the findings one, not the entries one.
		const out = execFileSync('node', [CLI, 'check', '--all', '--root', root], { encoding: 'utf8' });
		const hidden = /(\d+) baselined finding\(s\) hidden/.exec(out);
		assert(hidden, `check reported no baselined findings:\n${out}`);
		assert(hidden[1] === findings, `check hid ${hidden[1]} where baseline claimed ${findings}`);

		const single = execFileSync('node', [CLI, 'baseline', '--root', distinct], { encoding: 'utf8' });
		assert(/baselined [1-9]\d* finding\(s\) \u2192 /.test(single), `expected a single count:\n${single}`);
	} finally {
		cleanup(root);
		cleanup(distinct);
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
			env: env({ LOUPE_OFF: '1', CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' }),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		assert(out === '', `expected no output, got: ${out}`);
	} finally {
		cleanup(root);
	}
});

finish();
