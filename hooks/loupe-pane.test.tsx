/**
 * The Loupe pane, exercised through the engine's test kit: `/loupe-pane` runs
 * the engine (stood in for here) and the pane draws its answer on every
 * surface — the chart as SVG where a surface takes one, as text where it does
 * not, the tally and the rule rows everywhere.
 *
 * Run with `claude plugin test .` from the plugin root.
 */

import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';

import type { LoupeReport } from '../types';

const REPORT: LoupeReport = {
	version: 1,
	tool: 'loupe',
	blocking: true,
	summary: {
		total: 7,
		error: 4,
		warn: 3,
		suppressions: 0,
		parseErrors: 0,
		tokensKnown: 120,
		filesScanned: 12,
		byFile: { 'src/a.scss': 5, 'src/b.css': 2 },
	},
	tiles: [
		{ key: 'findings', value: 7, isLead: true },
		{ key: '✗ blocking', value: 4, isError: true },
		{ key: '• advisory', value: 3 },
		{ key: 'suppressions', value: 0 },
		{ key: 'files scanned', value: 12 },
		{ key: 'files unparsed', value: 0 },
	],
	rules: [
		{ id: 'layout/margin-on-child', title: 'margin — move spacing to the parent', severity: 'error', count: 4, files: 2 },
		{ id: 'tokens/hardcoded-value', title: 'hardcoded value', severity: 'warn', count: 3, files: 1 },
	],
	dirs: [{ label: 'src', count: 7 }],
	files: [
		{ label: 'src/a.scss', count: 5 },
		{ label: 'src/b.css', count: 2 },
	],
	clusters: [],
	svg: {
		rules: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 50"><text>rules</text></svg>',
		dirs: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 28"><text>dirs</text></svg>',
	},
};

/** The command as a person types it: `/loupe-pane` at a fullscreen terminal. */
const LOUPE_PANE = {
	command: 'loupe-pane',
	args: '',
	origin: { kind: 'composer' },
	presentation: { isFullscreen: true, columns: 120 },
} as const;

const PANE = {
	plugin: 'loupe',
	component: 'Pane',
	requestId: 'loupe',
	props: {
		title: 'Loupe',
		isFocused: false,
		bodyColumns: 60,
		placement: 'dock',
		scroll: { offset: 0, bodyRows: 30 },
		view: {},
	},
} as const;

/**
 * The engine beneath the plugin: each hook stands for what a session would
 * answer. `settings` is what the project's Claude Code settings hold; `opened`
 * counts the panes the plugin asked for.
 */
function engine(on: On, run: { calls: string[][]; opened: number }, settings: Record<string, unknown> = {}) {
	on('command.register', () => ({ value: { command: 'loupe-pane' } }));
	on('ui.open', () => {
		run.opened += 1;
		return { value: { isPlaced: true } };
	});
	on('session.start', (_, e) => ({ cwd: e.cwd }));
	on('settings.read', () => ({ value: settings }));
	on('env.get', () => ({ value: undefined }));
	on('ui.status', () => ({ value: undefined }));
	on('ui.toast', () => ({ value: undefined }));
	on('process.run', (_, e) => {
		run.calls.push([...e.argv]);
		return {
			value: {
				exitCode: 1,
				stdout: `${JSON.stringify(REPORT)}\n`,
				stderr: '',
				isStdoutTruncated: false,
				isStderrTruncated: false,
			},
		};
	});
}

test('/loupe-pane runs the engine for the pane model and reports the tally', async ($, on) => {
	const run = { calls: [] as string[][], opened: 0 };
	engine(on, run);
	await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true });

	const answer = await $.command.run(LOUPE_PANE);
	expect(answer.text).toBe('Loupe pane: 7 findings, 4 blocking, 3 advisory.');

	const check = run.calls.find((argv) => argv.includes('check'));
	expect(check?.includes('--format')).toBe(true);
	expect(check?.[check.indexOf('--format') + 1]).toBe('pane');
	// The project's opt-in was not set, so the session's start opened nothing and
	// ran nothing: the command is the one run.
	expect(run.calls.length).toBe(1);
});

test('the pane draws the report on every surface', async ($, on) => {
	engine(on, { calls: [], opened: 0 });
	await $.session.start({ cwd: '/project', surface: 'desktop', isInteractive: true });
	await $.command.run(LOUPE_PANE);

	for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
		const ui = await $.ui.mount({ ...PANE, surface });
		const total = await ui.find({ type: 'Text', text: /7 findings/ });
		expect(total?.text).toBe('7 findings');
		const blocking = await ui.find({ type: 'Text', text: /blocking/ });
		expect(blocking?.text).toBe('✗ 4 blocking');
		// A rule is a button on every surface: pressing it drafts the fix command.
		const rule = await ui.find({ type: 'Button', key: 'rule:layout/margin-on-child' });
		expect(rule === undefined).toBe(false);
		await ui.unmount();
	}
});

test('a surface with no Svg gets the bars as text, one with Svg gets the chart', async ($, on) => {
	engine(on, { calls: [], opened: 0 });
	await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true });
	await $.command.run(LOUPE_PANE);

	const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' });
	const bars = await terminal.find({ type: 'Text', text: /▇/ });
	expect(bars === undefined).toBe(false);
	await terminal.unmount();

	const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' });
	const chart = await desktop.find({ type: 'Svg' });
	expect(chart === undefined).toBe(false);
	await desktop.unmount();
});

test('the pane opens itself only where the project opted the hooks in', async ($, on) => {
	const run = { calls: [] as string[][], opened: 0 };
	engine(on, run, { env: { LOUPE: 'on' } });

	await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true });
	expect(run.opened).toBe(1);
	// And the first run is what it opens on.
	expect(run.calls.length).toBe(1);
});

test('pressing a rule drafts its fix command into the prompt, never sends it', async ($, on) => {
	engine(on, { calls: [], opened: 0 });
	let filled = '';
	on('prompt.read', () => ({ value: { text: '', cursor: 0 } }));
	on('prompt.fill', (_, e) => {
		filled = e.text;
		return { isFilled: true, text: e.text, cursor: e.text.length };
	});
	await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true });
	await $.command.run(LOUPE_PANE);

	const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
	await ui.press({ key: 'rule:layout/margin-on-child' });
	expect(filled).toBe('/loupe-fix layout/margin-on-child');
	await ui.unmount();
});
