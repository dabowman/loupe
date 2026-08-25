#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestStems } from '../src/markup.ts';
import { isSource } from '../src/discover.ts';
import { loadConfig } from '../src/config.ts';
import { analyze } from '../src/analyze.ts';
import { assert, check, cleanup, execFailure, finish, scratch, writeAll } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'loupe.mjs');

// `check` exits 1 whenever a finding survives the baseline, and `execFileSync`
// raises that as a throw — before any assertion about the output can run. Every
// test that asserts on a hidden-count is a test about whether findings survived,
// so all of them need the output, not the exit code.
const checkAll = (root: string, extra: string[] = []): string => {
	try {
		return execFileSync('node', [CLI, 'check', '--all', '--root', root, ...extra], {
			encoding: 'utf8',
			env: env(),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	} catch (err) {
		return execFailure(err).stdout;
	}
};

const tmpRepo = (files: Record<string, string>): string => {
	const root = scratch('dsh-regress-');
	writeAll(root, files);
	return root;
};

/**
 * The ambient environment, minus every switch that changes what the gate does.
 *
 * A developer's shell is not a clean room. `LOUPE_OFF` silences the hook and is
 * exactly the variable someone working on the off switch has exported; the
 * `CLAUDE_PLUGIN_OPTION_*` family overrides rules, and `preset` among them wins
 * over the fixture's own `loupe.config.json`, so `CLAUDE_PLUGIN_OPTION_PRESET`
 * makes the wpds rules vanish and the blocking test fail with "it did not
 * block". `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_ROOT` move state and profiles.
 * `HOME` is the quietest of them: `resolvedOptions` reads `~/.claude/settings*
 * .json`, so a developer with this plugin installed and configured has options
 * leaking in through a file nothing in the test mentions.
 *
 * All of them fail in the same direction — a red suite that points at the code
 * instead of at the shell — so the helper closes every door, and a test that
 * wants one open passes it in `extra`.
 */
const EMPTY_HOME = scratch('dsh-home-');

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
	const e: NodeJS.ProcessEnv = { ...process.env, HOME: EMPTY_HOME, ...extra };
	if (!('LOUPE_OFF' in extra)) delete e['LOUPE_OFF'];
	if (!('CLAUDE_PLUGIN_DATA' in extra)) delete e['CLAUDE_PLUGIN_DATA'];
	if (!('CLAUDE_PLUGIN_ROOT' in extra)) delete e['CLAUDE_PLUGIN_ROOT'];
	for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') && !(k in extra)) delete e[k];
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
		// `env({HOME: home})`, not a hand-rolled scrub: this test needs one door
		// open — the settings file it just wrote — and the helper closes the rest.
		const out = execFileSync('node', [CLI, 'status', '--root', root], { encoding: 'utf8', env: env({ HOME: home }) });
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
	// A fresh session id per run. The gate budgets retries per session and stands
	// down once the budget is spent, so reusing one id makes the fourth blocking
	// run exit 0 for a reason that has nothing to do with the switch under test.
	let session = 0;
	const run = (extra: NodeJS.ProcessEnv, content?: string): string =>
		execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: JSON.stringify({
				session_id: `off-${++session}`,
				tool_input: { file_path: 'styles/a.css', ...(content === undefined ? {} : { content }) },
			}),
			env: env({ CLAUDE_PLUGIN_OPTION_BLOCKING: 'true', ...extra }),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	try {
		// Establish that the fixture blocks. Without this the test cannot tell
		// "silenced" from "nothing to say": the gate returns before the root check
		// and the analysis, so `out === ''` also holds for an empty directory, for
		// a root that does not exist, and for a fixture whose findings a rule
		// change quietly stopped producing.
		const blocked = (() => {
			try {
				run({});
				return null;
			} catch (err) {
				return execFailure(err);
			}
		})();
		assert(blocked?.status === 2, `fixture does not block, so silence proves nothing: ${blocked?.status}`);

		assert(run({ LOUPE_OFF: '1' }) === '', 'LOUPE_OFF=1 did not silence the hook');

		// The values that look like an off switch but are not. A gate that goes
		// quiet on `LOUPE_OFF=0` is worse than one that ignores it: three docs and
		// `--help` promise this exact behaviour, and the failure is silent.
		for (const value of ['0', 'false', 'off', 'no', '']) {
			let status: number | null = null;
			try {
				run({ LOUPE_OFF: value });
			} catch (err) {
				status = execFailure(err).status;
			}
			assert(status === 2, `LOUPE_OFF=${JSON.stringify(value)} silenced the hook; it must not`);
		}

		// Silenced or not, the hook drains the payload. Claude Code writes a Write
		// tool's whole file body to this pipe; exiting without reading it leaves
		// that write on a pipe with no reader, and the parent takes an EPIPE on
		// every large edit of the session. A small payload fits the pipe buffer and
		// proves nothing, so this one is deliberately past it.
		assert(run({ LOUPE_OFF: '1' }, 'x'.repeat(512 * 1024)) === '', 'a large payload was not drained under LOUPE_OFF');

		// `status` has to reach the same conclusion the gate does. Unifying the
		// predicate is not the same as unifying what is concluded from it: with the
		// hook silenced, `status` went on printing `Turns are blocked by: ...` and
		// marking every error rule BLOCKS, seven lines under its own `hook: OFF`.
		const silenced = execFileSync('node', [CLI, 'status', '--root', root], {
			encoding: 'utf8',
			env: env({ LOUPE_OFF: '1', CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' }),
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		assert(/hook:\s+OFF/.test(silenced), `status did not report the switch:\n${silenced}`);
		assert(!/Turns are blocked by/.test(silenced), `status says the gate blocks while it is silenced:\n${silenced}`);
		assert(!/BLOCKS/.test(silenced), `status marks rules BLOCKS while the gate is silenced:\n${silenced}`);
	} finally {
		cleanup(root);
	}
});

// A baseline that is present and unreadable is not an absent one. Conflict
// markers in a committed file are the ordinary way to get here, and treating
// them as "no baseline" puts the whole accepted backlog back with the gate
// blocking on all of it — the symptom pinning the baseline to the project was
// meant to end, arriving through the file's contents instead of its location.
await check('an unreadable baseline is named, not silently ignored', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	const baseline = join(root, '.loupe-baseline.json');
	try {
		execFileSync('node', [CLI, 'baseline', '--root', root], { encoding: 'utf8', env: env() });
		const clean = checkAll(root);
		assert(/[1-9]\d* baselined finding\(s\) hidden/.test(clean), `fixture was not baselined:\n${clean}`);

		// Two ways to be unreadable. The second is the quiet one: it parses, so the
		// `catch` that guards the first never sees it, and an `entries` default of
		// `[]` reported it as a healthy empty baseline while the backlog went live.
		const corruptions = {
			'conflict markers': '<<<<<<< ours\n{"version":1,"entries":["a"]}\n=======\n{"version":1,"entries":["b"]}\n>>>>>>> theirs\n',
			'valid JSON without entries': '{"version":1,"createdAt":"","count":3,"findings":3}\n',
		};
		for (const [name, body] of Object.entries(corruptions)) {
			writeFileSync(baseline, body);
			const f = execFailure(
				(() => {
					try {
						execFileSync('node', [CLI, 'check', '--all', '--root', root], {
							encoding: 'utf8',
							env: env(),
							stdio: ['pipe', 'pipe', 'pipe'],
						});
						return null;
					} catch (err) {
						return err;
					}
				})()
			);
			assert(/is unreadable/.test(f.stderr), `${name}: check did not name the baseline:\n${f.stderr}`);

			const status = execFileSync('node', [CLI, 'status', '--root', root], {
				encoding: 'utf8',
				env: env(),
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			assert(/unreadable/.test(status), `${name}: status vouched for a broken baseline:\n${status}`);

			// The hook says it too. It is the surface where this bites — the agent
			// gets its own accepted backlog handed back as blocking findings — and
			// staying quiet there spends the retry budget with no reason given.
			let hookErr = '';
			try {
				execFileSync('node', [CLI, 'hook', '--root', root], {
					encoding: 'utf8',
					input: '{"session_id":"unread","tool_input":{"file_path":"styles/a.css"}}',
					env: env({ CLAUDE_PLUGIN_OPTION_BLOCKING: 'true' }),
					stdio: ['pipe', 'pipe', 'pipe'],
				});
			} catch (err) {
				hookErr = execFailure(err).stderr;
			}
			assert(/is unreadable/.test(hookErr), `${name}: the hook blocked without naming the baseline:\n${hookErr}`);
		}
	} finally {
		cleanup(root);
	}
});

// `--baseline` is documented in `--help` and in both READMEs. The writer and the
// readers resolve it separately, so a flag the writer honours and the readers
// drop records a backlog into a file nothing will ever read — silently, and
// reported as success.
await check('--baseline names the same file for the writer and the readers', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] }, baseline: 'cfg/b.json' }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	try {
		// An explicit path, including one naming a directory that does not exist.
		const named = execFileSync('node', [CLI, 'baseline', '--root', root, '--baseline', 'sub/dir/b.json'], {
			encoding: 'utf8',
			env: env(),
		});
		assert(/sub\/dir\/b\.json/.test(named), `--baseline was not honoured on write:\n${named}`);
		const readBack = checkAll(root, ['--baseline', 'sub/dir/b.json']);
		assert(/[1-9]\d* baselined finding\(s\) hidden/.test(readBack), `readers ignored --baseline:\n${readBack}`);

		// `--baseline=` is an empty string, not a path. Writer and readers have to
		// agree it means "nobody named one" — `??` on either side sends them to
		// different files, which is how the flag reported success into a file the
		// gate never opened.
		const empty = execFileSync('node', [CLI, 'baseline', '--root', root, '--baseline='], { encoding: 'utf8', env: env() });
		assert(/cfg\/b\.json/.test(empty), `--baseline= did not fall back to the configured path:\n${empty}`);
		const emptyRead = checkAll(root, ['--baseline=']);
		assert(/[1-9]\d* baselined finding\(s\) hidden/.test(emptyRead), `--baseline= read a different file than it wrote:\n${emptyRead}`);
	} finally {
		cleanup(root);
	}
});

// A 0.1.x baseline was a deliberate `loupe baseline`; an upgrade must not throw
// it away. It is also not the same case as the project's own default file being
// used because a configured path is not there yet — one wants "re-record this",
// the other wants "your config points elsewhere", and one message for both was
// wrong for both.
await check('an older baseline location is honored and named for what it is', () => {
	const root = tmpRepo({
		'loupe.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx':
			"import { __experimentalText as Text } from '@wordpress/components';\nexport const A = () => <Text className=\"acme-t\">x</Text>;",
		'styles/a.css': '.acme-t { color: #f00; }',
	});
	try {
		execFileSync('node', [CLI, 'baseline', '--root', root], { encoding: 'utf8', env: env() });
		const recorded = readFileSync(join(root, '.loupe-baseline.json'), 'utf8');

		// 0.1.x kept it in the state directory.
		mkdirSync(join(root, '.loupe'), { recursive: true });
		writeFileSync(join(root, '.loupe', 'baseline.json'), recorded);
		rmSync(join(root, '.loupe-baseline.json'));
		const legacy = checkAll(root);
		assert(/[1-9]\d* baselined finding\(s\) hidden/.test(legacy), `a 0.1.x baseline was dropped:\n${legacy}`);
		const legacyStatus = execFileSync('node', [CLI, 'status', '--root', root], { encoding: 'utf8', env: env() });
		assert(/0\.1\.x location/.test(legacyStatus), `status did not mark the old location:\n${legacyStatus}`);

		// The other fallback: the config names a file that is not there yet, and
		// the project's own default file answers. It is in the project already, so
		// telling the user to move it there is advice they cannot follow.
		rmSync(join(root, '.loupe'), { recursive: true, force: true });
		writeFileSync(join(root, '.loupe-baseline.json'), recorded);
		writeFileSync(
			join(root, 'loupe.config.json'),
			JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] }, baseline: 'cfg/b.json' })
		);
		const byName = checkAll(root);
		assert(/[1-9]\d* baselined finding\(s\) hidden/.test(byName), `the committed default-name file was dropped:\n${byName}`);
		const byNameStatus = execFileSync('node', [CLI, 'status', '--root', root], { encoding: 'utf8', env: env() });
		assert(/the default name/.test(byNameStatus), `status mislabelled the default-name fallback:\n${byNameStatus}`);
		assert(!/0\.1\.x location/.test(byNameStatus), `a file in the project was called an old location:\n${byNameStatus}`);
	} finally {
		cleanup(root);
	}
});

finish();
