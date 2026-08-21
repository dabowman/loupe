#!/usr/bin/env node
/**
 * Regressions.
 *
 * Each of these was a silent failure — the gate reported "clean", or reported a
 * finding against code the project owns, or never finished at all. None of them
 * surfaced as an error, which is why they need a test rather than a code review.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harvestStems } from '../src/markup.mjs';
import { isSource } from '../src/discover.mjs';
import { loadConfig } from '../src/config.mjs';
import { analyze } from '../src/analyze.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'bin', 'ds-hygiene.mjs');

let failed = 0;
// Awaited, so an async body's rejection fails the run instead of surfacing as
// an unhandled rejection after the summary has already printed "all passed".
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

const tmpRepo = (files) => {
	const root = mkdtempSync(join(tmpdir(), 'dsh-regress-'));
	for (const [rel, body] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, body);
	}
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
		'ds-hygiene.config.json': JSON.stringify({
			extends: 'wordpress-components',
			namespaces: { project: ['wp-parsely-'] },
		}),
		'src/App.jsx': 'export const App = () => <div className="wp-parsely-loading" />;',
		'style.css': '.wp-parsely-loading { color: #f00; }',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'ds-hygiene.config.json') });
		const { findings } = await analyze(config, { scope: null });
		const internal = findings.filter((f) => String(f.message).includes('library internal'));
		assert(!internal.length, `reported as a library internal: ${JSON.stringify(internal)}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// `--files /abs/path` matched no repo-relative finding, so the run reported
// clean. `/wpds-audit <path>` hands it absolute paths routinely.
await check('--files accepts an absolute path', () => {
	const root = tmpRepo({
		'ds-hygiene.config.json': JSON.stringify({ extends: 'generic', rules: { 'layout/margin-on-child': 'warn' } }),
		'style.css': '.a { margin-bottom: 16px; }',
	});
	try {
		const run = (arg) =>
			execFileSync('node', [CLI, 'check', '--root', root, '--files', arg, '--format', 'json'], {
				encoding: 'utf8',
			});
		const abs = JSON.parse(run(join(root, 'style.css')));
		const rel = JSON.parse(run('style.css'));
		assert(rel.summary.total > 0, 'fixture should produce a finding');
		assert(abs.summary.total === rel.summary.total, `absolute path found ${abs.summary.total}, relative found ${rel.summary.total}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
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
		assert(JSON.parse(out).systemMessage.includes('config error'), `unexpected output: ${out}`);
	} catch (err) {
		throw new Error(`hook exited non-zero on a config error: ${err.status} ${err.stderr}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// The wordpress-components markup glob was `**/src/**`, which made 59% of a real
// repo invisible — and every class referenced only there reported as dead.
await check('markup outside src/ still counts as a reference', async () => {
	const root = tmpRepo({
		'ds-hygiene.config.json': JSON.stringify({
			extends: 'wordpress-components',
			namespaces: { project: ['acme-'] },
		}),
		'routes/panel/index.tsx': 'export const P = () => <div className="acme-panel" />;',
		'routes/panel/style.css': '.acme-panel { color: #f00; }',
	});
	try {
		const config = await loadConfig({ root, configPath: join(root, 'ds-hygiene.config.json') });
		const { findings } = await analyze(config, { scope: null });
		const dead = findings.filter((f) => f.rule === 'css/dead-class');
		assert(!dead.length, `reported live classes as dead: ${JSON.stringify(dead.map((f) => f.message))}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Claude Code exports CLAUDE_PLUGIN_OPTION_* to hook processes only. `status`
// therefore never saw the blocking switch and reported every inferred config as
// advisory, however it was configured — while the hook happily blocked. A
// diagnostic that cannot observe the setting it diagnoses sends you hunting for
// the bug somewhere else.
await check('status reports the blocking switch it cannot see in the environment', () => {
	const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
	const root = tmpRepo({
		'ds-hygiene.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
		'src/A.jsx': 'export const A = () => <div className="acme-a" />;',
	});
	try {
		mkdirSync(join(home, '.claude'), { recursive: true });
		writeFileSync(
			join(home, '.claude', 'settings.json'),
			JSON.stringify({ pluginConfigs: { 'wpds-quality@somewhere': { options: { blocking: true } } } })
		);
		const env = { ...process.env, HOME: home };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
		delete env.CLAUDE_PLUGIN_ROOT;
		const out = execFileSync('node', [CLI, 'status', '--root', root], { encoding: 'utf8', env });
		assert(/blocking on/.test(out), `status did not read the setting:\n${out}`);
		assert(/Turns are blocked by/.test(out), `status still claims nothing blocks:\n${out}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

// The other half of the same bug: what status promises has to be what the hook
// does, or the diagnostic is just a different kind of wrong.
await check('the hook blocks when the setting says it should', () => {
	const root = tmpRepo({
		'ds-hygiene.config.json': JSON.stringify({ extends: 'wpds', namespaces: { project: ['acme-'] } }),
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
		if (err.message.includes('did not block')) throw err;
		assert(err.status === 2, `expected exit 2, got ${err.status}`);
		assert(/system\/override|typography\/in-css/.test(err.stderr), `no report handed back:\n${err.stderr}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
process.exit(failed ? 1 : 0);
