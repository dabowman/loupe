#!/usr/bin/env node
/**
 * Detection tests.
 *
 * Auto-detection is what makes the plugin usable with no config, so a
 * regression here silently changes behaviour in every project at once.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DETECT_ENTRY_BUDGET, STYLE_FILE_BUDGET, STYLE_MAX_BYTES, detectConfig } from '../src/detect.ts';
import { listPresets } from '../src/config.ts';
import { discover } from '../src/discover.ts';
import { CLI, assert, check, cleanup, fail, finish, scratch, write } from './harness.ts';

/** One detection scenario: a repo to build, and what should come back. */
interface Case {
	name: string;
	files: (root: string) => void;
	expect: {
		preset: string;
		project: string[];
		packageDir?: string;
		tokenSourcesUnder?: string;
	};
}

const CASES: Case[] = [
	{
		name: 'wp editor plugin → wpds (not the weaker parent preset)',
		files: (r: string) => {
			write(r, 'package.json', JSON.stringify({ devDependencies: { '@wordpress/components': '^28.0.0' } }));
			for (let i = 0; i < 4; i++) {
				write(r, `src/B${i}.jsx`, `export const B${i} = () => <div className="acme-panel acme-panel--${i}" />;`);
				write(
					r,
					`css/b${i}.css`,
					`.acme-panel { gap: 8px; }\n.acme-panel--${i} { color: #111; }\n.components-button { color: #222; }`,
				);
			}
		},
		expect: { preset: 'wpds', project: ['acme-'] },
	},
	{
		name: 'block theme → wordpress-block-theme',
		files: (r: string) => {
			write(r, 'theme.json', '{"version":3}');
			write(r, 'templates/index.html', '<div class="wp-block-group ridge-hero has-text-color"></div>');
			write(r, 'parts/header.html', '<div class="ridge-nav ridge-nav__inner"></div>');
			write(
				r,
				'style.css',
				'.ridge-hero{display:flex}\n.ridge-nav{gap:8px}\n.ridge-nav__inner{margin:4px}\n.wp-block-group{color:#000}',
			);
		},
		expect: { preset: 'wordpress-block-theme', project: ['ridge-'] },
	},
	{
		name: 'plain react → generic',
		files: (r: string) => {
			write(r, 'package.json', JSON.stringify({ dependencies: { react: '^18.0.0' } }));
			for (let i = 0; i < 3; i++) {
				write(r, `src/C${i}.jsx`, `export const C${i} = () => <div className="app-box app-box--${i}" />;`);
				write(r, `styles/c${i}.css`, `.app-box{display:flex}\n.app-box--${i}{color:#abc}`);
			}
		},
		expect: { preset: 'generic', project: ['app-'] },
	},
	{
		name: 'CSS-only prefix is not adopted (would self-confirm as dead)',
		files: (r: string) => {
			write(r, 'package.json', '{}');
			write(r, 'src/A.jsx', 'export const A = () => <div className="live-a live-b live-c" />;');
			write(
				r,
				'styles/a.css',
				'.live-a{color:#111}\n.live-b{color:#222}\n.live-c{color:#333}\n.ghost-a{color:#444}\n.ghost-b{color:#555}\n.ghost-c{color:#666}',
			);
		},
		expect: { preset: 'generic', project: ['live-'] },
	},
	{
		name: 'library-only CSS yields no project namespace',
		files: (r: string) => {
			write(r, 'package.json', '{}');
			write(r, 'src/A.jsx', 'export const A = () => <div className="components-button" />;');
			write(
				r,
				'styles/a.css',
				'.components-button{color:#111}\n.wp-block-group{color:#222}\n.has-text-color{color:#333}',
			);
		},
		expect: { preset: 'generic', project: [] },
	},
	{
		// The root manifest carries @wordpress/env and a build script; the plugin
		// that imports the component library is a directory down. Reading only the
		// root detected `generic`, which switches off every rule this exists to run.
		name: 'monorepo → the nested plugin decides the preset',
		files: (r: string) => {
			write(r, 'package.json', JSON.stringify({ devDependencies: { '@wordpress/env': '^9.0.0' } }));
			write(r, 'my-plugin/package.json', JSON.stringify({ dependencies: { '@wordpress/components': '^28.0.0' } }));
			for (let i = 0; i < 4; i++) {
				write(r, `my-plugin/src/B${i}.jsx`, `export const B${i} = () => <div className="acme-panel acme-p${i}" />;`);
				write(r, `my-plugin/css/b${i}.css`, `.acme-panel { gap: 8px; }\n.acme-p${i} { color: #111; }`);
			}
		},
		expect: { preset: 'wpds', project: ['acme-'], packageDir: 'my-plugin', tokenSourcesUnder: 'my-plugin/' },
	},
	{
		// `rbc-` (react-big-calendar) appears in the project's CSS and its markup,
		// which is indistinguishable from a namespace the project owns — until you
		// look at where the class is defined. Every dead-class finding in a real
		// repo came from this, and all of them were false.
		name: 'a prefix an installed dependency defines is not the project’s',
		files: (r: string) => {
			write(r, 'package.json', '{}');
			for (let i = 0; i < 4; i++) {
				write(
					r,
					`src/A${i}.jsx`,
					`export const A${i} = () => <div className="own-box own-b${i} rbc-event rbc-e${i}" />;`,
				);
				write(
					r,
					`styles/a${i}.css`,
					`.own-box{color:#111}\n.own-b${i}{color:#222}\n.rbc-event{color:#333}\n.rbc-e${i}{color:#444}`,
				);
			}
			write(
				r,
				'node_modules/react-big-calendar/lib/css/react-big-calendar.css',
				'.rbc-event{padding:2px}\n.rbc-calendar{display:flex}',
			);
		},
		expect: { preset: 'generic', project: ['own-'] },
	},
];

for (const c of CASES) {
	const root = scratch('dsh-detect-');
	try {
		c.files(root);
		const got = detectConfig(root);
		const under = c.expect.tokenSourcesUnder;
		const okPreset = got.preset === c.expect.preset;
		const okNs = JSON.stringify(got.namespaces.project) === JSON.stringify(c.expect.project);
		const okDir = c.expect.packageDir === undefined || got.packageDir === c.expect.packageDir;
		const sources = got.config.designSystem?.tokenSources ?? [];
		const okTokens = under === undefined || (sources.length > 0 && sources.every((p) => p.startsWith(under)));
		if (okPreset && okNs && okDir && okTokens) {
			console.log(`ok   ${c.name}`);
		} else {
			fail();
			console.log(`FAIL ${c.name}`);
			if (!okPreset) console.log(`  preset: want ${c.expect.preset}, got ${got.preset}`);
			if (!okNs)
				console.log(
					`  namespaces: want ${JSON.stringify(c.expect.project)}, got ${JSON.stringify(got.namespaces.project)}`,
				);
			if (!okDir)
				console.log(`  packageDir: want ${JSON.stringify(c.expect.packageDir)}, got ${JSON.stringify(got.packageDir)}`);
			if (!okTokens)
				console.log(`  tokenSources: want all under ${c.expect.tokenSourcesUnder}, got ${JSON.stringify(sources)}`);
		}
	} finally {
		cleanup(root);
	}
}

// ── the ceiling ─────────────────────────────────────────────────────────────
// Inference walked the tree with no depth cap, no entry budget and no time
// budget. The hook's root falls back to the process cwd when
// CLAUDE_PROJECT_DIR is unset, so that walk was sometimes a home directory —
// still running at 60s, on every edit.

// Pinned because nothing else exercises the shipped value: every test below
// passes its own ceiling, so a typo here, or a default dropped from a
// signature, would sail through the suite and only show up as a hook that
// takes a minute.
await check('the shipped ceiling is the one that was measured', () => {
	assert(DETECT_ENTRY_BUDGET === 50_000, `the ceiling moved to ${DETECT_ENTRY_BUDGET} without a measurement`);
});

await check('the walk stops at its entry ceiling and says that it did', () => {
	const root = scratch('dsh-ceiling-');
	try {
		// Sixty files that match nothing and three that do. A budget counting
		// matches rather than entries would walk all sixty-three for free — and a
		// home directory is exactly this shape, which is what made the walk
		// unbounded in the place the bug was reported from.
		for (let i = 0; i < 60; i++) write(root, `d${i % 6}/f${i}.txt`, 'filler\n');
		for (let i = 0; i < 3; i++) write(root, `d${i}/s${i}.css`, `.pj-a${i}{color:#111}`);
		const sources = { styles: ['**/*.css'], markup: ['**/*.jsx'], references: [], ignore: [] };

		const bounded = discover({ root, sources, limit: 20 });
		assert(bounded.truncated, 'a walk that stopped at its ceiling has to report stopping');
		assert(bounded.styles.length < 3, `a ceiling of 20 entries yielded all ${bounded.styles.length} styles`);

		const whole = discover({ root, sources });
		assert(!whole.truncated, 'an unbounded walk never reports truncation');
		assert(whole.styles.length === 3, `unbounded walk found ${whole.styles.length} of 3 style files`);
	} finally {
		cleanup(root);
	}
});

// `~/.cache`, a pnpm store, a cargo registry, maildirs: hundreds of thousands
// of directories holding almost nothing. Counting only files let the walk
// through all of them, and the reported repro was `cd ~ && loupe detect`.
await check('directories count against the ceiling too', () => {
	const root = scratch('dsh-ceiling-dirs-');
	try {
		for (let i = 0; i < 60; i++) mkdirSync(join(root, `empty${i}`), { recursive: true });
		write(root, 'only.css', '.pj-a{color:#111}');
		const sources = { styles: ['**/*.css'], markup: [], references: [], ignore: [] };

		const bounded = discover({ root, sources, limit: 20 });
		assert(bounded.truncated, 'a tree of 61 entries has to trip a ceiling of 20');
	} finally {
		cleanup(root);
	}
});

// Every `**` glob picomatch compiles leaves `dot: false` on, so nothing under
// `.venv`, `.cache`, `.cargo` or a pnpm store can ever match one. Walking into
// them spent the ceiling on entries that could not have contributed, and a
// project whose own files lost that race came back with no namespaces at all —
// which reads exactly like a project that has none.
await check('a dot-directory neither answers the walk nor spends its budget', () => {
	const root = scratch('dsh-ceiling-dot-');
	try {
		write(root, 'src/App.jsx', 'export const App = () => <div className="own-box own-card own-hero" />;');
		write(root, 'styles/a.css', '.own-box{color:#111}\n.own-card{color:#222}\n.own-hero{color:#333}');
		for (let i = 0; i < 200; i++) write(root, `.venv/lib/m${i}/x.py`, 'x\n');
		const sources = { styles: ['**/*.css'], markup: ['**/*.jsx'], references: [], ignore: [] };

		const whole = discover({ root, sources });
		assert(!whole.truncated, '.venv is pruned, so nothing here is near any ceiling');
		assert(whole.styles.length === 1 && whole.markup.length === 1, `pruning lost real files: ${JSON.stringify(whole)}`);

		// The budget the walk actually spends: four entries at the root plus the
		// two files below it. If `.venv` were still descended into it would be
		// several hundred, and a ceiling of 20 would truncate.
		const bounded = discover({ root, sources, limit: 20 });
		assert(!bounded.truncated, 'a two-file project must not trip a 20-entry ceiling because of a .venv');
	} finally {
		cleanup(root);
	}
});

// A guess drawn from part of a tree looks exactly like a guess drawn from a
// whole project — same namespaces, same coverage percentage computed over what
// was read. Confidence is the only thing that separates them, so a truncated
// walk can never come back high.
await check('a truncated inference is never high confidence', () => {
	const root = scratch('dsh-ceiling-detect-');
	try {
		// The namespace evidence sits in the root and the filler below it, so the
		// bounded run below reads enough to accept `own-` and still stops early —
		// which is the case the demotion is about. A run that found nothing would
		// be answering `none`, a different claim.
		write(root, 'package.json', '{}');
		write(root, 'App.jsx', 'export const App = () => <div className="own-box own-card own-hero" />;');
		write(root, 'a.css', '.own-box{color:#111}\n.own-card{color:#222}\n.own-hero{color:#333}');
		for (let i = 0; i < 40; i++) write(root, `filler/f${i}.txt`, 'filler\n');

		const whole = detectConfig(root);
		assert(!whole.truncated, 'a project this size is nowhere near the shipped ceiling');
		assert(whole.namespaceConfidence === 'high', `unbounded run should be high, got ${whole.namespaceConfidence}`);

		const bounded = detectConfig(root, { limit: 6 });
		assert(bounded.truncated, 'inference that stopped at the ceiling has to say so');
		assert(
			bounded.namespaces.project.includes('own-'),
			`the root's own files are read before the tree below them: ${JSON.stringify(bounded.namespaces)}`,
		);
		assert(
			bounded.namespaceConfidence === 'low',
			`a guess from part of a tree cannot be high confidence — got ${bounded.namespaceConfidence}`,
		);
		// The preset is read off manifests and top-level markers, not the walk,
		// so it is exactly as good as it ever was.
		assert(bounded.preset === 'generic', `the preset is still answered, got ${bounded.preset}`);
	} finally {
		cleanup(root);
	}
});

// Truncation demotes `high`; it does not overwrite `none`. "We stopped early
// and found nothing" and "we looked and there is nothing" are different claims,
// and collapsing them printed `(none found)  [low confidence]`.
await check('a truncated walk that found nothing still answers none', () => {
	const root = scratch('dsh-ceiling-none-');
	try {
		write(root, 'package.json', '{}');
		for (let i = 0; i < 40; i++) write(root, `filler/f${i}.txt`, 'filler\n');

		const bounded = detectConfig(root, { limit: 3 });
		assert(bounded.truncated, 'a 40-file tree has to trip a ceiling of 3');
		assert(
			bounded.namespaceConfidence === 'none',
			`nothing was found, so the confidence is none — got ${bounded.namespaceConfidence}`,
		);
	} finally {
		cleanup(root);
	}
});

// ── the read budgets ────────────────────────────────────────────────────────
// The walk ceiling bounds entries visited, not bytes read: markup was capped at
// 2000 files and stylesheets at nothing, so a tree of large generated CSS was
// read in full before inference answered. A budget that trips is a guess from
// less than was found, and has to read as one.

/** A project inference can name with high confidence: `own-` in CSS and markup. */
const ownProject = (root: string): void => {
	write(root, 'package.json', '{}');
	write(root, 'App.jsx', 'export const App = () => <div className="own-box own-card own-hero" />;');
	write(root, 'a.css', '.own-box{color:#111}\n.own-card{color:#222}\n.own-hero{color:#333}');
};

await check('a stylesheet over the size cap is skipped, and the confidence says so', () => {
	const root = scratch('dsh-budget-bytes-');
	try {
		ownProject(root);
		const whole = detectConfig(root);
		assert(whole.namespaceConfidence === 'high', `baseline should be high, got ${whole.namespaceConfidence}`);
		assert(whole.namespaceNotes.length === 0, `nothing was skipped: ${JSON.stringify(whole.namespaceNotes)}`);

		// One generated blob over the cap, full of a prefix the markup also names —
		// read, it would outvote the project's own CSS.
		const rule = '.gen-x{color:#000}\n';
		write(root, 'styles/tokens.css', rule.repeat(Math.ceil((STYLE_MAX_BYTES + 1) / rule.length)));
		write(root, 'Gen.jsx', 'export const G = () => <div className="gen-x" />;');
		const capped = detectConfig(root);
		assert(
			!capped.namespaces.project.includes('gen-'),
			`an oversized stylesheet named a namespace: ${JSON.stringify(capped.namespaces)}`,
		);
		assert(
			capped.namespaceConfidence === 'low',
			`a skipped stylesheet cannot leave a high-confidence answer — got ${capped.namespaceConfidence}`,
		);
		assert(
			capped.namespaceNotes.some((n) => /skipped 1 stylesheet\(s\) over \d+kB/.test(n)),
			`the skip has to be said: ${JSON.stringify(capped.namespaceNotes)}`,
		);
		assert(!capped.truncated, 'a skipped file is not a truncated walk; init must not refuse over it');
	} finally {
		cleanup(root);
	}
});

await check('stylesheets past the count cap are not read, and the confidence says so', () => {
	const root = scratch('dsh-budget-count-');
	try {
		ownProject(root);
		// Deeper than the project's own stylesheet, so the walk finds it first.
		for (let i = 0; i < STYLE_FILE_BUDGET; i++) write(root, `gen/g${i}.css`, `.own-g${i}{color:#000}`);
		const got = detectConfig(root);
		assert(got.namespaces.project.includes('own-'), `the root's stylesheet is read first: ${JSON.stringify(got)}`);
		assert(got.namespaceConfidence === 'low', `a capped read cannot be high — got ${got.namespaceConfidence}`);
		assert(
			got.namespaceNotes.some((n) => n.includes(`first ${STYLE_FILE_BUDGET} of ${STYLE_FILE_BUDGET + 1}`)),
			`the cap has to be said: ${JSON.stringify(got.namespaceNotes)}`,
		);
	} finally {
		cleanup(root);
	}
});

await check('the count cap reads shallowest first, not alphabetically first', () => {
	const root = scratch('dsh-budget-depth-');
	try {
		write(root, 'package.json', '{}');
		write(root, 'src/A.jsx', 'export const A = () => <div className="acme-a acme-b acme-c acme-d" />;');
		write(root, 'styles/main.css', '.acme-a{color:#1}\n.acme-b{color:#2}\n.acme-c{color:#3}\n.acme-d{color:#4}');
		// `assets/` sorts before `styles/` by bytes, so a byte-ordered budget spends
		// itself on these and never reaches the project's own sheet.
		for (let i = 0; i < STYLE_FILE_BUDGET + 10; i++) write(root, `assets/gen/g${i}.css`, `.gen-g${i}{color:#000}`);
		const got = detectConfig(root);
		assert(
			got.namespaces.project.includes('acme-'),
			`the shallow stylesheet has to be read within the budget: ${JSON.stringify(got.namespaces)} ${JSON.stringify(got.namespaceNotes)}`,
		);
	} finally {
		cleanup(root);
	}
});

// ── possible external prefixes ──────────────────────────────────────────────
// `namespaces.external` only ever came from presets, so a vendored bundle no
// preset knows read as project code: `.ChatFooter-module_container` drew a
// hardcoded-value finding, and `loupe fix` staged a substitution into a remote
// widget's CSS-module internals.

/** `own-` in CSS and markup, plus three kinds of somebody else's CSS. */
const vendoredProject = (root: string): void => {
	ownProject(root);
	write(
		root,
		'chat-mount.scss',
		'.ChatFooter-module_container{background:#fff}\n.ChatFooter-module_input{color:#111}\n.ChatFooter-module_send{color:#222}\n' +
			'.Header_nav__3xYz9{color:#333}\n',
	);
	write(root, 'ghost.css', '.ghost-a{color:#444}\n.ghost-b{color:#555}\n.ghost-c{color:#666}');
	for (let i = 0; i < 3; i++) write(root, `cal${i}.css`, `.rbc-event{color:#777}\n.rbc-e${i}{color:#888}`);
	write(root, 'Cal.jsx', 'export const Cal = () => <div className="rbc-event" />;');
	write(root, 'node_modules/react-big-calendar/lib/css/react-big-calendar.css', '.rbc-event{padding:2px}');
};

await check('detection proposes external prefixes, and writes none of them', () => {
	const root = scratch('dsh-external-');
	try {
		vendoredProject(root);
		const got = detectConfig(root);
		const reasonOf = (prefix: string): string | undefined =>
			got.possibleExternal.find((c) => c.prefix === prefix)?.reason;
		const listed = JSON.stringify(got.possibleExternal);
		assert(/CSS-module/.test(reasonOf('ChatFooter-module_') ?? ''), `the CSS-module bundle is not listed: ${listed}`);
		assert(
			got.possibleExternal.find((c) => c.prefix === 'ChatFooter-module_')?.classes === 3,
			`three distinct module classes: ${listed}`,
		);
		assert(/hashed/.test(reasonOf('Header_') ?? ''), `the hashed class is not listed: ${listed}`);
		assert(/node_modules/.test(reasonOf('rbc-') ?? ''), `the vendored dependency is not listed: ${listed}`);
		assert(/no markup/.test(reasonOf('ghost-') ?? ''), `the unreferenced prefix is not listed: ${listed}`);
		assert(reasonOf('own-') === undefined, `the project's own namespace is not external: ${listed}`);
		assert(JSON.stringify(got.namespaces.project) === '["own-"]', `namespaces: ${JSON.stringify(got.namespaces)}`);
		assert(got.config.namespaces?.external === undefined, `a guess was written: ${JSON.stringify(got.config)}`);
	} finally {
		cleanup(root);
	}
});

/** The CLI, isolated from the developer's own plugin settings. */
const cli = (argv: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
	const home = scratch('dsh-home-');
	try {
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
		for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
		const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env });
		if (r.error) throw r.error;
		return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
	} finally {
		cleanup(home);
	}
};

await check('detect reports the possible external list in text and in JSON', () => {
	const root = scratch('dsh-external-cli-');
	try {
		vendoredProject(root);
		const text = cli(['detect', '--root', root, '--no-color']).stdout;
		assert(/possible external:\s+ChatFooter-module_/.test(text), `not in the text report:\n${text}`);
		assert(/confirm with `namespaces.external`/.test(text), `no hint to confirm:\n${text}`);
		const json = JSON.parse(cli(['detect', '--root', root, '--format', 'json']).stdout) as {
			possibleExternal?: { prefix: string }[];
		};
		assert(
			json.possibleExternal?.some((c) => c.prefix === 'ChatFooter-module_'),
			`not in the JSON: ${JSON.stringify(json.possibleExternal)}`,
		);
	} finally {
		cleanup(root);
	}
});

// ── init on a guess ─────────────────────────────────────────────────────────
// `init` wrote whatever detection returned, the `generic` fallback included —
// and once the file exists inference never runs again, so a WordPress plugin
// built on `@wordpress/scripts`' externals was pinned to a ruleset with most
// rules off, silently, for good.

/** The externals shape: WordPress everywhere except `dependencies`. */
const externalsPlugin = (root: string): void => {
	write(
		root,
		'package.json',
		JSON.stringify({ devDependencies: { '@wordpress/scripts': '*', '@types/wordpress__components': '*' } }),
	);
	write(
		root,
		'src/A.jsx',
		'import { Button } from \'@wordpress/components\';\nexport const A = () => <Button className="own-box own-card own-hero" />;',
	);
	write(root, 'src/a.css', '.own-box{color:#111}\n.own-card{color:#222}\n.own-hero{color:#333}');
	write(root, 'build/index.asset.php', "<?php return array('dependencies' => array('wp-components', 'wp-element'));");
	write(root, '.wp-env.json', '{}');
	write(root, 'composer.json', JSON.stringify({ type: 'wordpress-plugin' }));
};

await check('init refuses a guessed design system, and says what it saw instead', () => {
	const root = scratch('dsh-init-guess-');
	try {
		externalsPlugin(root);
		const { status, stdout } = cli(['init', '--root', root, '--no-color']);
		assert(status === 2, `init on a guess exited ${status}:\n${stdout}`);
		assert(!existsSync(join(root, 'loupe.config.json')), 'init wrote the guess anyway');
		// Read from the presets directory, so a new preset shows up unasked.
		for (const name of listPresets()) assert(stdout.includes(name), `available presets omit ${name}:\n${stdout}`);
		for (const evidence of [
			/source imports: @wordpress\/components \[a wpds marker\]/,
			/@types\/wordpress__components/,
			/build\/index\.asset\.php dependencies: wp-components, wp-element/,
			/\.wp-env\.json/,
			/composer\.json \(type wordpress-plugin\)/,
		])
			assert(evidence.test(stdout), `missing evidence ${evidence}:\n${stdout}`);
		assert(/loupe init --preset <name>/.test(stdout), `no re-run command:\n${stdout}`);
	} finally {
		cleanup(root);
	}
});

await check('init --preset names the design system and writes it; --force writes the guess', () => {
	const root = scratch('dsh-init-named-');
	try {
		externalsPlugin(root);
		const named = cli(['init', '--root', root, '--preset', 'wpds']);
		assert(named.status === 0, `init --preset exited ${named.status}:\n${named.stdout}${named.stderr}`);
		const cfg = JSON.parse(readFileSync(join(root, 'loupe.config.json'), 'utf8')) as {
			extends?: string;
			namespaces?: { project?: string[] };
		};
		assert(cfg.extends === 'wpds', `init --preset wrote the guess instead: ${JSON.stringify(cfg)}`);
		assert(cfg.namespaces?.project?.join(',') === 'own-', `the namespaces were lost: ${JSON.stringify(cfg)}`);

		const forced = cli(['init', '--root', root, '--force']);
		assert(forced.status === 0, `init --force exited ${forced.status}`);
		const guessed = JSON.parse(readFileSync(join(root, 'loupe.config.json'), 'utf8')) as { extends?: string };
		assert(guessed.extends === 'generic', `--force writes what detection found: ${JSON.stringify(guessed)}`);
	} finally {
		cleanup(root);
	}
});

await check('a recognised design system is written without being asked twice', () => {
	const root = scratch('dsh-init-sure-');
	try {
		externalsPlugin(root);
		write(root, 'package.json', JSON.stringify({ dependencies: { '@wordpress/components': '*' } }));
		const { status } = cli(['init', '--root', root]);
		assert(status === 0, `init on a high-confidence match exited ${status}`);
		assert(existsSync(join(root, 'loupe.config.json')), 'nothing was written');
	} finally {
		cleanup(root);
	}
});

// The other half: with no config, that same guess ran on every check, and the
// only place it said so was `status`.
await check('check on a guessed generic config points at init, in the agent format only', () => {
	const root = scratch('dsh-init-hint-');
	try {
		externalsPlugin(root);
		const agent = cli(['check', '--all', '--root', root, '--no-color']).stdout;
		assert(/no design system recognised .* Run `loupe init`/.test(agent), `no init hint:\n${agent}`);
		// JSON is parsed: a trailing line would break every consumer.
		const json = cli(['check', '--all', '--root', root, '--format', 'json']).stdout;
		JSON.parse(json);
		assert(!json.includes('loupe init'), 'the hint leaked into the JSON report');

		write(root, 'loupe.config.json', JSON.stringify({ extends: 'generic' }));
		const written = cli(['check', '--all', '--root', root, '--no-color']).stdout;
		assert(!written.includes('loupe init'), `a written config is a decision, not a guess:\n${written}`);
	} finally {
		cleanup(root);
	}
});

finish();
