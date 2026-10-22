/**
 * The Loupe pane — the conformance report, drawn beside the transcript.
 *
 * The classic hooks in this folder are the gate: they hand the model a budgeted
 * text report and block the turn on what an edit introduced. This module is for
 * the person. It runs the same engine after each edit the model makes to a UI
 * file, and draws what `--format pane` answers in a pane Claude Code places
 * beside the conversation: the tally, the rules in frequency order, where the
 * drift sits, and the composites rebuilt across files. It also keeps a line in
 * the status bar, says once when the blocking count reaches zero, and raises a
 * notification when a turn ends with blocking findings still standing.
 *
 * It draws differently per surface because the surfaces draw differently: the
 * desktop and the editor get the engine's SVG charts, the terminal gets the
 * same rows as block-glyph bars sized to the pane. Every number comes from the
 * engine's pane document (`engine/src/report-pane.ts`), so the pane, the HTML
 * page and the JSON cannot describe different reports.
 *
 * Off until the project opts in, like the hooks (`"env": { "LOUPE": "on" }`),
 * and off under the plugin's `pane` option; `/loupe-pane` opens it anywhere,
 * on request. It draws nothing in cloud sessions, `claude -p` or the SDK, where
 * the hooks still run and the text report is the whole story.
 *
 * Design notes: docs/design/report.md#the-pane
 */

import { atom, read, update } from 'claude-code';
import type { EngineInterface, PluginOptions, Register, RenderSurface, Timer } from 'claude-code';

import type { LoupeFilter, LoupeReport, LoupeRule, LoupeRun } from '../types';

const PANE = 'loupe';
const COMMAND = 'loupe-pane';

const run = atom({ plugin: 'loupe', key: 'run' } as const, { report: null, error: null, isRunning: false });
const filter = atom({ plugin: 'loupe', key: 'filter' } as const, 'all');
const htmlPath = atom({ plugin: 'loupe', key: 'htmlPath' } as const, null);

/** Files the engine can say something about; anything else is not worth a run. */
const UI_FILE = /\.(jsx?|tsx?|s?css|less|styl)$/i;
/** A turn edits several files in a row; one run after the burst, not one per edit. */
const DEBOUNCE_MS = 700;
const ENGINE_TIMEOUT_MS = 120_000;
/** Rows the pane lists before it says how many more there are. */
const RULE_ROWS = 10;
const DIR_ROWS = 8;
const FILE_ROWS = 5;

/** The hook's own reading of an on switch (`isOn` in engine/src/hook.ts). */
const isOn = (v: unknown): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(String(v));

const GLYPH: Record<string, string> = { error: '✗', warn: '•' };
const WORD: Record<string, string> = { error: 'blocking', warn: 'advisory' };

/** Clip a label to `max` cells, keeping its end — the specific part of a path or a rule id. */
const clip = (s: string, max: number): string => (s.length <= max ? s : `…${s.slice(s.length - max + 1)}`);

/** A block-glyph bar of `count` against `max`, at least one cell wide for anything non-zero. */
const bar = (count: number, max: number, width: number): string =>
	'▇'.repeat(count > 0 && max > 0 ? Math.max(1, Math.round((count / max) * width)) : 0);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusLine(report: LoupeReport): string {
	const s = report.summary;
	if (s.total === 0) return 'loupe ✓ clean';
	if (s.error > 0) return `loupe ✗ ${s.error} blocking · ${s.warn} advisory`;
	return `loupe • ${s.warn} advisory`;
}

/**
 * Session state. Module-level rather than closed over inside `register`: the
 * validator admits `$` only into functions declared at the top of the file, and
 * a reload starts these over, which is what a reload should do.
 */
let root = '';
let cwd = '';
/** Whether edits re-run the engine: the project's opt-in, or the person's `/loupe-pane`. */
let enabled = false;
/** UI files the model edited this turn. */
let touched = 0;
let timer: Timer | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let lastBlocking: number | null = null;

/**
 * The same switches the hook reads: the plugin's options, `LOUPE_OFF`, and
 * `LOUPE` from the environment or the project's Claude Code settings `env`.
 */
async function optedIn($: EngineInterface, options: PluginOptions): Promise<boolean> {
	if (options.pane === false || options.off === true) return false;
	const settings = (await $.settings.read()) as { env?: Record<string, unknown> } | undefined;
	const env = settings?.env ?? {};
	if (isOn(await $.env.get('LOUPE_OFF')) || isOn(env.LOUPE_OFF)) return false;
	return isOn((await $.env.get('LOUPE')) ?? env.LOUPE);
}

const engine = (...args: string[]): string[] => [
	'node',
	`${root}/engine/bin/loupe.mjs`,
	...args,
	'--profiles',
	`${root}/profiles`,
];

/** Status line and the one toast: said when the blocking count reaches zero, not on every run. */
function announce($: EngineInterface, state: LoupeRun): void {
	const report = state.report;
	if (!report) {
		$.ui.status(state.error ? 'loupe: could not run' : undefined);
		return;
	}
	$.ui.status(statusLine(report));
	if (lastBlocking !== null && lastBlocking > 0 && report.summary.error === 0) {
		$.ui.toast(report.summary.total === 0 ? 'loupe: clean' : 'loupe: no blocking findings left');
	}
	lastBlocking = report.summary.error;
}

/**
 * One engine run at a time. A call while one is in flight asks for one more
 * after it, so a burst of edits ends on a report that saw the last of them.
 */
function refresh($: EngineInterface): Promise<void> {
	if (inFlight) {
		again = true;
		return inFlight;
	}
	inFlight = (async () => {
		do {
			again = false;
			await update($, run, (r) => ({ ...r, isRunning: true }));
			let next: Partial<LoupeRun>;
			try {
				const r = await $.process.run(engine('check', '--all', '--format', 'pane'), {
					cwd,
					timeoutMs: ENGINE_TIMEOUT_MS,
				});
				// 0 clean, 1 blocking — both are the report working. 2 is the engine
				// unable to run, and then stderr is the message.
				next =
					r.exitCode <= 1 && r.stdout.trim()
						? { report: JSON.parse(r.stdout) as LoupeReport, error: null }
						: { error: r.stderr.trim() || `loupe exited ${r.exitCode}` };
			} catch (err) {
				next = { error: err instanceof Error ? err.message : String(err) };
			}
			// A failed run keeps the last report on screen, with the failure beside it.
			const state = await update($, run, (r) => ({ ...r, ...next, isRunning: false }));
			announce($, state);
		} while (again);
	})()
		.catch(() => {
			// The module was unloaded under the run, or the engine refused a call:
			// there is nothing left to draw it on, and a run that outlives its
			// module must not surface as an unhandled rejection.
		})
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/** Puts a command in the prompt box for the person to send — never sends it. */
async function draft($: EngineInterface, text: string): Promise<void> {
	const box = await $.prompt.read();
	await $.prompt.fill({ text, mode: box.text.trim() ? 'append' : 'replace' });
}

/** The HTML report, written under the project where a path click opens it, its path on the clipboard. */
async function writeHtml($: EngineInterface, surface: RenderSurface): Promise<void> {
	const r = await $.process.run(engine('check', '--all', '--format', 'html'), { cwd, timeoutMs: ENGINE_TIMEOUT_MS });
	if (r.exitCode > 1 || !r.stdout) {
		$.ui.toast(`loupe: could not render the report${r.stderr ? ` — ${r.stderr.trim().split('\n')[0]}` : ''}`);
		return;
	}
	const path = `${cwd}/.loupe/report.html`;
	await $.fs.write(path, r.stdout);
	await update($, htmlPath, () => path);
	const copied = await $.ui.copy({ text: path, surface });
	$.ui.toast(copied.isCopied ? 'loupe: report written, path copied' : 'loupe: report written to .loupe/report.html');
}

export const register: Register = (on, options) => {
	on('session.start', async ($, e, next) => {
		root = $.plugin.root;
		cwd = e.cwd;
		await $.command.register({
			name: COMMAND,
			description: 'Open the Loupe pane: the conformance report, drawn beside the transcript',
		});
		enabled = await optedIn($, options);
		if (enabled && e.isInteractive) {
			// Unasked, the surface places it only where it would be a sidebar; the
			// engine holds it undrawn otherwise, so this costs nothing in a narrow
			// terminal. The first run is what the pane opens on.
			void $.ui.open({ id: PANE, title: 'Loupe' });
			void refresh($);
		}
		return next(e);
	});

	// Asked for by name, the pane runs anywhere — the project's opt-in governs
	// only whether it opens itself. From here on, edits refresh it.
	on('command.run', { command: COMMAND }, async ($) => {
		enabled = true;
		await $.ui.open({ id: PANE, title: 'Loupe', focus: true });
		await refresh($);
		const state = await read($, run);
		const s = state.report?.summary;
		return {
			text: s
				? `Loupe pane: ${plural(s.total, 'finding')}, ${s.error} blocking, ${s.warn} advisory.`
				: `Loupe pane: the engine could not run${state.error ? ` — ${state.error.split('\n')[0]}` : ''}.`,
		};
	});

	// A RegExp rather than a list: `MultiEdit` is not a tool this build names,
	// and a matcher may name only tools it knows.
	on('tool.call', { tool: /^(Edit|Write|MultiEdit)$/ }, async ($, e, next) => {
		const ran = await next(e);
		if (!enabled || 'deny' in ran || ran.isError) return ran;
		const path = (e as { file_path?: unknown }).file_path;
		if (typeof path !== 'string' || !UI_FILE.test(path)) return ran;
		touched += 1;
		timer?.cancel();
		timer = $.clock.after(DEBOUNCE_MS, () => {
			timer = null;
			void refresh($);
		});
		return ran;
	}).catch(($, e, next) => next(e));

	// The turn is over: whatever the gate let through is what stands. One last
	// run, not awaited — the turn is not held for it — and a notification if
	// blocking findings remain, which is the case the person would want to hear
	// about without watching.
	on('turn.complete', async ($, e, next) => {
		const edited = touched;
		touched = 0;
		if (enabled && edited > 0) {
			timer?.cancel();
			timer = null;
			void refresh($)
				.then(async () => {
					const s = (await read($, run)).report?.summary;
					if (s && s.error > 0) {
						await $.ui.notify(`${plural(s.error, 'blocking finding')} remain after this turn`, { title: 'Loupe' });
					}
				})
				.catch(() => {
					/* unloaded under the run: nothing to tell, and nowhere to tell it */
				});
		}
		return next(e);
	});

	on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
		const state = await read($, run);
		const which = await read($, filter);
		const written = await read($, htmlPath);
		const cols = Math.max(24, e.props.bodyColumns);
		const report = state.report;
		const shownRules = report ? report.rules.filter((r) => which === 'all' || r.severity === which) : [];
		const refreshLabel = state.isRunning ? 'Running…' : 'Refresh';
		const fix = (rule: LoupeRule) => () => void draft($, `/loupe-fix ${rule.id}`);

		// Every surface draws these; the chart and the picker are what differ.
		const { Box, Text, Button } = $.ui.resolve(e);

		// A `Select` where the surface draws fields; the phone draws none yet, so
		// there the list shows every rule.
		let picker = null;
		if (e.surface !== 'mobile') {
			const { Select } = $.ui.resolve(e);
			picker = (
				<Select
					key="filter"
					label="show"
					value={which}
					options={[
						{ value: 'all', label: 'all' },
						{ value: 'error', label: '✗ blocking' },
						{ value: 'warn', label: '• advisory' },
					]}
					onSelect={(v) => void update($, filter, () => v as LoupeFilter)}
				/>
			);
		}

		const header = report ? (
			<Box flexDirection="column">
				<Box gap={2} flexWrap="wrap">
					<Text weight="bold">{report.summary.total} findings</Text>
					<Text color={report.summary.error > 0 ? 'error' : undefined}>
						✗ {report.summary.error} blocking
					</Text>
					<Text>• {report.summary.warn} advisory</Text>
					<Text dimColor>{plural(report.summary.filesScanned, 'file')} scanned</Text>
					{report.summary.baselined ? <Text dimColor>{report.summary.baselined} baselined</Text> : null}
				</Box>
				{report.summary.parseErrors > 0 ? (
					<Text color="error">
						{plural(report.summary.parseErrors, 'file')} could not be parsed — every number here is a floor, not a
						total.
					</Text>
				) : null}
			</Box>
		) : (
			<Text dimColor>
				{state.isRunning ? 'Running the check…' : state.error ? 'The engine could not run.' : 'No report yet.'}
			</Text>
		);

		const controls = (
			<Box gap={1} flexWrap="wrap">
				<Button key="refresh" hotkey="r" label={refreshLabel} onPress={() => void refresh($)} />
				<Button
					key="html"
					hotkey="h"
					label="HTML report"
					onPress={(press) => void writeHtml($, press.surface)}
				/>
				{picker}
			</Box>
		);

		const footer = (
			<Box flexDirection="column">
				{state.error ? <Text color="error">{clip(state.error.split('\n')[0] ?? '', cols)}</Text> : null}
				{written ? <Text dimColor>report: {clip(written, cols - 8)}</Text> : null}
			</Box>
		);

		if (!report) {
			return (
				<Box flexDirection="column" gap={1}>
					{header}
					{controls}
					{footer}
				</Box>
			);
		}

		const files =
			report.files.length > 0 ? (
				<Box flexDirection="column">
					<Text dimColor>Densest files</Text>
					{report.files.slice(0, FILE_ROWS).map((f) => (
						<Text key={`file:${f.label}`} wrap="truncate-start">
							{String(f.count).padStart(4)} {f.label}
						</Text>
					))}
				</Box>
			) : null;

		const clusters =
			report.clusters.length > 0 ? (
				<Box flexDirection="column">
					<Text dimColor>Composites rebuilt across files</Text>
					{report.clusters.slice(0, 4).map((c) => (
						<Text key={`cluster:${c.rule}:${c.group}`} wrap="truncate-end">
							{plural(c.files.length, 'file')} · {c.rule} · {c.group}
						</Text>
					))}
				</Box>
			) : null;

		// Pressing a rule drafts its fix command into the prompt. The glyph and the
		// word travel with the color, on every surface.
		const ruleRows = shownRules.slice(0, RULE_ROWS);
		const moreRules = shownRules.length - ruleRows.length;

		if (e.surface === 'terminal') {
			const labelW = Math.min(34, Math.max(12, Math.floor(cols * 0.42)));
			const valueW = 4;
			const barW = Math.max(4, cols - labelW - valueW - 3);
			const maxRule = ruleRows[0]?.count ?? 0;
			const dirRows = report.dirs.slice(0, DIR_ROWS);
			const maxDir = dirRows.reduce((m, d) => Math.max(m, d.count), 0);
			return (
				<Box flexDirection="column" gap={1}>
					{header}
					{controls}
					<Box flexDirection="column">
						<Text dimColor>By rule — press one to draft its fix</Text>
						{ruleRows.length === 0 ? <Text dimColor>Nothing in this slice.</Text> : null}
						{ruleRows.map((r) => (
							<Button key={`rule:${r.id}`} plain onPress={fix(r)}>
								<Text color={r.severity === 'error' ? 'error' : 'warning'}>{GLYPH[r.severity] ?? '•'}</Text>{' '}
								{clip(r.id, labelW - 2).padEnd(labelW - 2)}{' '}
								<Text color={r.severity === 'error' ? 'error' : 'warning'}>{bar(r.count, maxRule, barW)}</Text>{' '}
								<Text dimColor>{String(r.count).padStart(valueW - 1)}</Text>
							</Button>
						))}
						{moreRules > 0 ? <Text dimColor>{plural(moreRules, 'more rule')}</Text> : null}
					</Box>
					<Box flexDirection="column">
						<Text dimColor>Where it is</Text>
						{dirRows.map((d) => (
							<Text key={`dir:${d.label}`} dimColor={d.isTail === true}>
								{clip(d.label, labelW).padEnd(labelW)} {bar(d.count, maxDir, barW)} {String(d.count).padStart(valueW - 1)}
							</Text>
						))}
					</Box>
					{files}
					{clusters}
					{footer}
				</Box>
			);
		}

		// Desktop, editor, phone: the engine's SVG charts, which carry their own
		// palette and a <title> per bar; the interactive frame shows it on hover.
		const { Svg } = $.ui.resolve(e);
		return (
			<Box flexDirection="column" gap={1}>
				{header}
				{controls}
				<Box flexDirection="column">
					<Text dimColor>By rule</Text>
					<Svg source={report.svg.rules} alt={`Findings by rule: ${report.rules.map((r) => `${r.id} ${r.count}`).join(', ')}`} isInteractive />
					{ruleRows.length > 0 ? (
						<Box gap={1} flexWrap="wrap">
							<Text dimColor>draft a fix:</Text>
							{ruleRows.map((r) => (
								<Button key={`rule:${r.id}`} plain dimColor onPress={fix(r)}>
									{GLYPH[r.severity] ?? '•'} {r.id}
								</Button>
							))}
						</Box>
					) : null}
				</Box>
				<Box flexDirection="column">
					<Text dimColor>Where it is</Text>
					<Svg source={report.svg.dirs} alt={`Findings by directory: ${report.dirs.map((d) => `${d.label} ${d.count}`).join(', ')}`} />
				</Box>
				{files}
				{clusters}
				{footer}
			</Box>
		);
	});
};
