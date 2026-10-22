/**
 * The pane model: what the Claude Code pane draws beside the transcript.
 *
 * The HTML report is read in a browser; this is read by `hooks/register.tsx`,
 * a Claude Code mod drawing in a region a few dozen cells wide, on surfaces
 * that differ in what they can draw — the desktop and the editor take an SVG,
 * the terminal takes text. So the model is pre-shaped: the tallies the page
 * computes client-side are computed here once, and the charts are emitted as
 * SVG strings the remote surfaces draw as they are, so the terminal rendering
 * and the desktop rendering start from the same numbers in the same order.
 *
 * It is derived from the `--format json` payload and nothing else — the same
 * rule the HTML report keeps, for the same reason: two readers of one run must
 * never see two different reports. The ordering rules mirror the page's client
 * (`report-html.ts`): rules in frequency order with rank breaking ties,
 * directories capped with the tail folded into one row rather than dropped.
 *
 * Design notes: docs/design/report.md#the-pane
 */

import { reportPayload, tally } from './report.ts';
import type { AnalyzeResult, BaselinedResult, Config, ReportPayload, RuleId, Severity } from './types.ts';

/** One stat tile; `isError` paints the value in the error color, `isLead` enlarges it. */
export interface PaneTile {
	key: string;
	value: number;
	isError?: true;
	isLead?: true;
}

export interface PaneRule {
	id: string;
	title: string;
	severity: Severity;
	count: number;
	/** Distinct files the rule's findings sit in. */
	files: number;
}

export interface PaneBar {
	label: string;
	count: number;
	/** The folded tail row past the directory cap: a count of what is not shown, not a directory. */
	isTail?: true;
}

export interface PaneCluster {
	rule: string;
	group: string;
	files: string[];
}

/**
 * The pane's whole input, in one JSON document. `version` is additive-only,
 * like `ReportPayload`'s: fields may be added; nothing emitted changes meaning
 * without a bump. The mod's `types/index.d.ts` declares the same shape for the
 * plugin's state contract — the one place a change here has to be mirrored.
 */
export interface PanePayload {
	version: 1;
	tool: 'loupe';
	blocking: boolean;
	summary: ReportPayload['summary'];
	tiles: PaneTile[];
	/** Frequency order, rank breaking ties: the chart's order, not the agent format's. */
	rules: PaneRule[];
	/** Top directories by finding count, the tail past `DIR_CAP` folded into one row. */
	dirs: PaneBar[];
	/** The densest files, as `summary.byFile` orders them. */
	files: PaneBar[];
	clusters: PaneCluster[];
	svg: {
		rules: string;
		/** The rule chart narrowed to one severity, for a reader with a severity picker. */
		rulesBySeverity: { error: string; warn: string };
		dirs: string;
	};
}

/** How many directories the rollup names before it starts counting the rest. Matches `report-html.ts`. */
export const DIR_CAP = 12;
/** How many files the densest-files list names. */
const FILE_CAP = 8;

const dirOf = (file: string): string => {
	const i = file.lastIndexOf('/');
	return i === -1 ? '.' : file.slice(0, i);
};

/**
 * The tiles, as `renderKpis` in the page draws them: the lead number, the
 * split, a baseline tile only when it hid something, and the unparsed count
 * beside the scanned count — zero unparsed means nothing until you know how
 * many were read.
 */
function tiles(p: ReportPayload): PaneTile[] {
	const s = p.summary;
	const out: PaneTile[] = [
		{ key: 'findings', value: s.total, isLead: true },
		{ key: '✗ blocking', value: s.error, ...(s.error > 0 ? { isError: true } : {}) },
		{ key: '• advisory', value: s.warn },
	];
	if (s.baselined) out.push({ key: 'baselined', value: s.baselined });
	out.push({ key: 'suppressions', value: s.suppressions });
	out.push({ key: 'files scanned', value: s.filesScanned });
	out.push({ key: 'files unparsed', value: s.parseErrors, ...(s.parseErrors > 0 ? { isError: true } : {}) });
	return out;
}

function rules(p: ReportPayload): PaneRule[] {
	const byId = new Map(p.rules.map((r) => [r.id, r]));
	const files = new Map<RuleId, Set<string>>();
	for (const f of p.findings) {
		if (!files.has(f.rule)) files.set(f.rule, new Set());
		files.get(f.rule)?.add(f.file);
	}
	// Frequency order, rank breaking ties — the page's order (`renderRules`), and
	// deliberately not the agent format's rank order: rank is "fix this first",
	// length is "there is the most of this".
	return tally(p.findings.map((f) => f.rule))
		.sort((a, b) => b[1] - a[1] || (byId.get(b[0])?.rank ?? 0) - (byId.get(a[0])?.rank ?? 0))
		.map(([id, count]) => {
			const r = byId.get(id);
			return {
				id,
				title: r?.title ?? '',
				severity: r?.severity ?? 'warn',
				count,
				files: files.get(id)?.size ?? 0,
			};
		});
}

/** Past the cap the tail is folded into one row, not truncated silently. */
function dirs(p: ReportPayload): PaneBar[] {
	const counts = tally(p.findings.map((f) => dirOf(f.file)));
	const shown: PaneBar[] = counts.slice(0, DIR_CAP).map(([label, count]) => ({ label, count }));
	const tail = counts.slice(DIR_CAP);
	if (tail.length) {
		shown.push({
			label: `${tail.length} more director${tail.length === 1 ? 'y' : 'ies'}`,
			count: tail.reduce((t, c) => t + c[1], 0),
			isTail: true,
		});
	}
	return shown;
}

function clusters(p: ReportPayload): PaneCluster[] {
	const m = new Map<string, PaneCluster>();
	for (const f of p.findings) {
		if (!f.group) continue;
		const k = `${f.rule}\u0000${f.group}`;
		const c = m.get(k) ?? { rule: f.rule, group: f.group, files: [] };
		if (!c.files.includes(f.file)) c.files.push(f.file);
		m.set(k, c);
	}
	return [...m.values()].sort((a, b) => b.files.length - a.files.length);
}

// ── SVG ─────────────────────────────────────────────────────────────────────

const esc = (s: string): string =>
	s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** One row per bar, in CSS pixels, at a width the surface scales to its slot. */
const ROW = 22;
const WIDTH = 640;
const LABEL_W = 236;
const VALUE_W = 40;
const PAD = 6;

/** Clip a label to what the label column holds, keeping the end — the specific part of a path or rule id. */
function clip(label: string, max: number): string {
	return label.length <= max ? label : `…${label.slice(label.length - max + 1)}`;
}

/**
 * The palette the page uses, as an SVG stylesheet. The desktop draws the SVG
 * as an image, so the page's custom properties never reach it; a
 * `prefers-color-scheme` query inside the SVG does, since an SVG image
 * evaluates media queries of its own. Severity is the reserved status colors,
 * and every bar also carries its glyph in text — never the color alone.
 */
const SVG_CSS = `
text { font: 12px system-ui, -apple-system, "Segoe UI", sans-serif; fill: #52514e; }
.v { fill: #52514e; font-variant-numeric: tabular-nums; }
.t { fill: #898781; }
.track { fill: rgba(11,11,11,0.06); }
.error { fill: #d03b3b; } .warn { fill: #fab219; } .seq { fill: #2a78d6; }
.empty { fill: #898781; }
@media (prefers-color-scheme: dark) {
  text, .v { fill: #c3c2b7; } .t { fill: #898781; }
  .track { fill: rgba(255,255,255,0.08); } .seq { fill: #3987e5; }
}`;

/**
 * A horizontal bar chart. `paint` names the class a bar's fill takes; the
 * `<title>` on each row is what an interactive surface shows on hover.
 */
function barChart(
	rows: readonly { label: string; count: number; paint: string; title: string; glyph?: string }[],
	empty: string,
): string {
	const height = rows.length ? rows.length * ROW + PAD * 2 : ROW + PAD * 2;
	const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img"><style>${SVG_CSS}</style>`;
	if (!rows.length) {
		return `${open}<text class="empty" x="${PAD}" y="${PAD + 15}">${esc(empty)}</text></svg>`;
	}
	const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
	const trackW = WIDTH - LABEL_W - VALUE_W - PAD * 2;
	const body = rows
		.map((r, i) => {
			const y = PAD + i * ROW;
			const w = max > 0 ? Math.max(3, (r.count / max) * trackW) : 0;
			const label = `${r.glyph ? `${r.glyph} ` : ''}${clip(r.label, 34)}`;
			return (
				`<g><title>${esc(r.title)}</title>` +
				`<text x="${PAD}" y="${y + 15}">${esc(label)}</text>` +
				`<rect class="track" x="${LABEL_W}" y="${y + 6}" width="${trackW}" height="10" rx="0" />` +
				`<rect class="${r.paint}" x="${LABEL_W}" y="${y + 6}" width="${w.toFixed(1)}" height="10" rx="2" />` +
				`<text class="v" x="${WIDTH - PAD}" y="${y + 15}" text-anchor="end">${r.count}</text></g>`
			);
		})
		.join('');
	return `${open}${body}</svg>`;
}

// `off` never reaches a finding; the record is total because `Severity` is.
const GLYPH: Record<Severity, string> = { error: '✗', warn: '•', off: '' };

export function paneFromPayload(p: ReportPayload): PanePayload {
	const ruleRows = rules(p);
	const dirRows = dirs(p);
	const ruleChart = (rows: readonly PaneRule[], empty: string): string =>
		barChart(
			rows.map((r) => ({
				label: r.id,
				count: r.count,
				paint: r.severity,
				glyph: GLYPH[r.severity],
				title: `${r.count} × ${r.id}${r.title ? ` — ${r.title}` : ''}`,
			})),
			empty,
		);
	return {
		version: 1,
		tool: 'loupe',
		blocking: p.blocking,
		summary: p.summary,
		tiles: tiles(p),
		rules: ruleRows,
		dirs: dirRows,
		files: Object.entries(p.summary.byFile)
			.slice(0, FILE_CAP)
			.map(([label, count]) => ({ label, count })),
		clusters: clusters(p),
		svg: {
			rules: ruleChart(ruleRows, 'No findings.'),
			rulesBySeverity: {
				error: ruleChart(
					ruleRows.filter((r) => r.severity === 'error'),
					'No blocking findings.',
				),
				warn: ruleChart(
					ruleRows.filter((r) => r.severity === 'warn'),
					'No advisory findings.',
				),
			},
			dirs: barChart(
				dirRows.map((d) => ({
					label: d.label,
					count: d.count,
					paint: d.isTail ? 't' : 'seq',
					title: `${d.count} finding${d.count === 1 ? '' : 's'} in ${d.label}`,
				})),
				'No findings.',
			),
		},
	};
}

export function panePayload(result: AnalyzeResult | BaselinedResult, config: Config): PanePayload {
	return paneFromPayload(reportPayload(result, config));
}

export function formatPane(result: AnalyzeResult | BaselinedResult, config: Config): string {
	return `${JSON.stringify(panePayload(result, config))}\n`;
}
