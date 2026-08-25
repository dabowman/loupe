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

finish();
