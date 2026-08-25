#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 *
 * The last few are the edges of the guard that fixed the walk: they passed
 * before it existed, and the point of writing them down is that they still do.
 * A guard against a gate that never finishes becomes a gate that never runs the
 * moment its idea of "project" is narrower than the engine's own.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
	// A manifest, so the run gets past the project-shape guard and reaches the
	// config error this is about: the `preset` plugin option is set once for
	// every project its owner opens, so it is not itself evidence of a project.
	const root = tmpRepo({ 'package.json': '{}', 'src/App.jsx': 'export const App = () => <div />;' });
	let out: string;
	try {
		out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"x","tool_input":{"file_path":"src/App.jsx"}}',
			env: { ...process.env, CLAUDE_PLUGIN_OPTION_PRESET: 'no-such-preset' },
		});
	} catch (err) {
		const f = execFailure(err);
		cleanup(root);
		throw new Error(`hook exited non-zero on a config error: ${f.status} ${f.stderr}`);
	}
	try {
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(parsed.systemMessage?.includes('config error'), `unexpected output: ${out}`);
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

// Config inference walked the whole tree before the guard that decides the root
// is not a project ran at all. `hookRoot()` falls back to the process cwd when
// CLAUDE_PROJECT_DIR is unset, so a root that is neither a package nor a
// worktree — a home directory, most often — was indexed in full on the way to
// standing aside, on every edit. One such call blew past the 120s Stop timeout
// and had to be killed by hand.
await check('the hook stands aside on a non-project root instead of indexing it', () => {
	const root = tmpRepo({
		'src/App.jsx': 'export const App = () => <div className="acme-a" />;',
		'style.css': '.acme-a { margin-bottom: 16px; }',
	});
	try {
		let out: string;
		try {
			out = execFileSync('node', [CLI, 'hook', '--root', root], {
				encoding: 'utf8',
				input: '{"session_id":"np","tool_input":{"file_path":"style.css"}}',
			});
		} catch (err) {
			const f = execFailure(err);
			throw new Error(`hook exited non-zero on a non-project root: ${f.status} ${f.stderr}`);
		}
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(
			parsed.systemMessage?.includes('not a git worktree'),
			`the hook analyzed a root that is not a project: ${out}`
		);
	} finally {
		cleanup(root);
	}
});

// The edges of that guard, every one of them cheaper to get wrong than to
// notice, because `suppressOutput` means a hook that stands aside says so where
// nobody is reading.
//
// The flags first. `--all` and `--files` name their own scope and never ask git
// anything, so they have always worked outside a worktree — and a guard that
// took those with it would be a worse bug than the one it fixed.
await check('--all still runs where there is no worktree and no manifest', () => {
	const root = tmpRepo({ 'style.css': '.acme-a { margin-bottom: 16px; }' });
	try {
		const out = execFileSync('node', [CLI, 'check', '--all', '--root', root, '--format', 'json'], { encoding: 'utf8' });
		const parsed = JSON.parse(out) as { summary: { total: number } };
		assert(parsed.summary.total > 0, `--all reported nothing outside a worktree:\n${out}`);
	} finally {
		cleanup(root);
	}
});

// And the refusal itself is a contract: exit 2, and wording that tells you the
// two flags that would have worked.
await check('--changed outside a worktree still refuses with exit 2', () => {
	// A manifest, so the project-shape guard passes and the refusal under test
	// is the one the changed-file scope raises. Without it this passed on the
	// guard's copy of the message and stopped covering `resolveScope` at all —
	// which is the whole reason both say it through one constant.
	const root = tmpRepo({ 'package.json': '{}', 'style.css': '.acme-a { margin-bottom: 16px; }' });
	try {
		execFileSync('node', [CLI, 'check', '--changed', '--root', root], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
		throw new Error('check --changed exited 0 outside a worktree');
	} catch (err) {
		const f = execFailure(err);
		if (f.message.includes('exited 0 outside a worktree')) throw err;
		assert(f.status === 2, `expected exit 2, got ${f.status}`);
		assert(
			f.stderr.includes('not a git worktree; use --all or --files'),
			`the refusal changed wording: ${f.stderr}`
		);
	} finally {
		cleanup(root);
	}
});

// A deployed block theme in wp-content/themes/ has a theme.json and a
// templates/ directory, and routinely has neither a package.json nor a .git —
// while `loupe detect` identifies it as wordpress-block-theme at high
// confidence. A guard whose idea of "project" is narrower than the engine's own
// refuses to gate a directory this same binary confidently recognises.
await check('a block theme with no manifest and no worktree is still gated', () => {
	const root = tmpRepo({
		'theme.json': '{"version":3}',
		'templates/index.html': '<div class="ridge-hero"></div>',
		'style.css': '.ridge-hero { margin-bottom: 16px; }',
	});
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"bt","tool_input":{"file_path":"style.css"}}',
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(
			!parsed.systemMessage?.includes('not a git worktree'),
			`the gate stood aside on a theme it detects at high confidence: ${out}`
		);
	} finally {
		cleanup(root);
	}
});

// `git rev-parse` exits 128 on a dubious-ownership mount — the normal state
// inside a container — and on a machine with no git binary it does not run at
// all. Neither is evidence that a repo is not a repo, so the guard reads `.git`
// off the filesystem before it asks git anything.
await check('a repo git refuses to answer about is still gated', () => {
	const root = tmpRepo({
		'.git': 'gitdir: /nowhere/that/exists\n',
		'src/App.jsx': 'export const App = () => <div className="acme-a" />;',
		'style.css': '.acme-a { margin-bottom: 16px; }',
	});
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"dg","tool_input":{"file_path":"style.css"}}',
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(
			!parsed.systemMessage?.includes('not a git worktree'),
			`git declining to answer was read as "no project": ${out}`
		);
	} finally {
		cleanup(root);
	}
});

// A classic WordPress theme or plugin is PHP, CSS and nothing else: no npm, no
// `theme.json`, and routinely not in git. It is also most of what this plugin
// is pointed at, so a guard whose only manifest is `package.json` turned the
// gate off for the audience — silently, because `suppressOutput` hides the
// message that says so.
await check('a composer-only project with no worktree is still gated', () => {
	const root = tmpRepo({
		'composer.json': '{"name":"acme/plugin"}',
		'tpl.php': '<?php ?><div class="acme-a"></div>',
		'style.css': '.acme-a { margin-bottom: 16px; }',
	});
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"cj","tool_input":{"file_path":"style.css"}}',
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(!parsed.systemMessage?.includes('not a git worktree'), `the gate stood aside on a PHP project: ${out}`);
	} finally {
		cleanup(root);
	}
});

// The `.git` fallback exists for the case where git will not answer — a
// dubious-ownership mount, the normal state inside a container. Probed only at
// the root it covered the top of a repo and nothing else, so the subdirectory
// `isWorktree` was added to catch was exactly the case left with no answer.
await check('a repo subdirectory git refuses to answer about is still gated', () => {
	const root = tmpRepo({
		'.git': 'gitdir: /nowhere/that/exists\n',
		'packages/ui/App.jsx': 'export const App = () => <div className="acme-a" />;',
		'packages/ui/style.css': '.acme-a { margin-bottom: 16px; }',
	});
	// A `git` that exits non-zero without answering, ahead of any real one.
	const bin = join(root, '.stub-bin');
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 128\n', { mode: 0o755 });
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', join(root, 'packages', 'ui')], {
			encoding: 'utf8',
			input: '{"session_id":"sd","tool_input":{"file_path":"style.css"}}',
			env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(
			!parsed.systemMessage?.includes('not a git worktree'),
			`git declining to answer about a subdirectory was read as "no project": ${out}`
		);
	} finally {
		cleanup(root);
	}
});

// The `preset` plugin option is set once, for every project its owner ever
// opens. Treating it as somebody stating that *this* directory is a project
// switched the guard off everywhere for anyone who had pinned one — and with a
// valid preset the run is not even advisory, so it walked an unchosen root and
// then blocked the turn.
await check('a pinned plugin preset does not vouch for a non-project root', () => {
	const root = tmpRepo({ 'style.css': '.acme-a { margin-bottom: 16px; }' });
	try {
		const out = execFileSync('node', [CLI, 'hook', '--root', root], {
			encoding: 'utf8',
			input: '{"session_id":"pp","tool_input":{"file_path":"style.css"}}',
			env: { ...process.env, CLAUDE_PLUGIN_OPTION_PRESET: 'wpds', CLAUDE_PLUGIN_OPTION_BLOCKING: '1' },
		});
		const parsed = JSON.parse(out) as { systemMessage?: string };
		assert(
			parsed.systemMessage?.includes('not a git worktree'),
			`a user-wide preset let the gate index a non-project root: ${out}`
		);
	} catch (err) {
		const f = execFailure(err);
		throw new Error(`the hook blocked a turn on a non-project root: ${f.status} ${f.stderr}`);
	} finally {
		cleanup(root);
	}
});

// `--changed` is a scope only on the commands that resolve one. `detect
// --changed` ignores the flag, so a guard firing on the flag alone invents a
// refusal that run would never have got.
await check('--changed on a command that ignores it does not refuse', () => {
	const root = tmpRepo({ 'style.css': '.acme-a { margin-bottom: 16px; }' });
	try {
		const out = execFileSync('node', [CLI, 'detect', '--changed', '--root', root], { encoding: 'utf8' });
		assert(/preset:/.test(out), `detect --changed stopped answering:\n${out}`);
	} finally {
		cleanup(root);
	}
});

finish();
