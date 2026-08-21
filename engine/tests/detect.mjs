#!/usr/bin/env node
/**
 * Detection tests.
 *
 * Auto-detection is what makes the plugin usable with no config, so a
 * regression here silently changes behaviour in every project at once.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectConfig } from '../src/detect.mjs';

const write = (root, rel, body) => {
	const p = join(root, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, body);
};

const CASES = [
	{
		name: 'wp editor plugin → wpds (not the weaker parent preset)',
		files: (r) => {
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
		files: (r) => {
			write(r, 'theme.json', '{"version":3}');
			write(r, 'templates/index.html', '<div class="wp-block-group ridge-hero has-text-color"></div>');
			write(r, 'parts/header.html', '<div class="ridge-nav ridge-nav__inner"></div>');
			write(r, 'style.css', '.ridge-hero{display:flex}\n.ridge-nav{gap:8px}\n.ridge-nav__inner{margin:4px}\n.wp-block-group{color:#000}');
		},
		expect: { preset: 'wordpress-block-theme', project: ['ridge-'] },
	},
	{
		name: 'plain react → generic',
		files: (r) => {
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
		files: (r) => {
			write(r, 'package.json', '{}');
			write(r, 'src/A.jsx', 'export const A = () => <div className="live-a live-b live-c" />;');
			write(r, 'styles/a.css', '.live-a{color:#111}\n.live-b{color:#222}\n.live-c{color:#333}\n.ghost-a{color:#444}\n.ghost-b{color:#555}\n.ghost-c{color:#666}');
		},
		expect: { preset: 'generic', project: ['live-'] },
	},
	{
		name: 'library-only CSS yields no project namespace',
		files: (r) => {
			write(r, 'package.json', '{}');
			write(r, 'src/A.jsx', 'export const A = () => <div className="components-button" />;');
			write(r, 'styles/a.css', '.components-button{color:#111}\n.wp-block-group{color:#222}\n.has-text-color{color:#333}');
		},
		expect: { preset: 'generic', project: [] },
	},
];

let failed = 0;
for (const c of CASES) {
	const root = mkdtempSync(join(tmpdir(), 'dsh-detect-'));
	try {
		c.files(root);
		const got = detectConfig(root);
		const okPreset = got.preset === c.expect.preset;
		const okNs = JSON.stringify(got.namespaces.project) === JSON.stringify(c.expect.project);
		if (okPreset && okNs) {
			console.log(`ok   ${c.name}`);
		} else {
			failed++;
			console.log(`FAIL ${c.name}`);
			if (!okPreset) console.log(`  preset: want ${c.expect.preset}, got ${got.preset}`);
			if (!okNs) console.log(`  namespaces: want ${JSON.stringify(c.expect.project)}, got ${JSON.stringify(got.namespaces.project)}`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
console.log(`\n${CASES.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
