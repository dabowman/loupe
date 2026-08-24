#!/usr/bin/env node
/**
 * Detection tests.
 *
 * Auto-detection is what makes the plugin usable with no config, so a
 * regression here silently changes behaviour in every project at once.
 */

import { detectConfig } from '../src/detect.ts';
import { cleanup, fail, failures, finish, scratch, write } from './harness.ts';

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
				write(r, `css/b${i}.css`, `.acme-panel { gap: 8px; }\n.acme-panel--${i} { color: #111; }\n.components-button { color: #222; }`);
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
			write(r, 'style.css', '.ridge-hero{display:flex}\n.ridge-nav{gap:8px}\n.ridge-nav__inner{margin:4px}\n.wp-block-group{color:#000}');
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
			write(r, 'styles/a.css', '.live-a{color:#111}\n.live-b{color:#222}\n.live-c{color:#333}\n.ghost-a{color:#444}\n.ghost-b{color:#555}\n.ghost-c{color:#666}');
		},
		expect: { preset: 'generic', project: ['live-'] },
	},
	{
		name: 'library-only CSS yields no project namespace',
		files: (r: string) => {
			write(r, 'package.json', '{}');
			write(r, 'src/A.jsx', 'export const A = () => <div className="components-button" />;');
			write(r, 'styles/a.css', '.components-button{color:#111}\n.wp-block-group{color:#222}\n.has-text-color{color:#333}');
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
				write(r, `src/A${i}.jsx`, `export const A${i} = () => <div className="own-box own-b${i} rbc-event rbc-e${i}" />;`);
				write(r, `styles/a${i}.css`, `.own-box{color:#111}\n.own-b${i}{color:#222}\n.rbc-event{color:#333}\n.rbc-e${i}{color:#444}`);
			}
			write(r, 'node_modules/react-big-calendar/lib/css/react-big-calendar.css', '.rbc-event{padding:2px}\n.rbc-calendar{display:flex}');
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
			if (!okNs) console.log(`  namespaces: want ${JSON.stringify(c.expect.project)}, got ${JSON.stringify(got.namespaces.project)}`);
			if (!okDir) console.log(`  packageDir: want ${JSON.stringify(c.expect.packageDir)}, got ${JSON.stringify(got.packageDir)}`);
			if (!okTokens) console.log(`  tokenSources: want all under ${c.expect.tokenSourcesUnder}, got ${JSON.stringify(sources)}`);
		}
	} finally {
		cleanup(root);
	}
}
finish(`\n${CASES.length - failures()} passed, ${failures()} failed`);
