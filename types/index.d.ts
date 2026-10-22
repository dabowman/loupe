/**
 * The Loupe mod's state contract: what `hooks/register.tsx` keeps in `$.state`.
 *
 * `LoupeReport` is the engine's `--format pane` document (`PanePayload` in
 * `engine/src/report-pane.ts`), written down a second time because a contract
 * is one self-contained file with no import: a change to one is a change to
 * both. `version` is additive-only, so a reader ignores keys it does not know.
 */

export type LoupeSeverity = 'error' | 'warn' | 'off';

export type LoupeTile = { key: string; value: number; isError?: true; isLead?: true };

export type LoupeRule = { id: string; title: string; severity: LoupeSeverity; count: number; files: number };

export type LoupeBar = { label: string; count: number; isTail?: true };

export type LoupeCluster = { rule: string; group: string; files: string[] };

export type LoupeReport = {
	version: 1;
	tool: 'loupe';
	blocking: boolean;
	summary: {
		total: number;
		error: number;
		warn: number;
		suppressions: number;
		parseErrors: number;
		tokensKnown: number;
		filesScanned: number;
		byFile: Record<string, number>;
		baselined?: number;
		fixed?: number;
	};
	tiles: LoupeTile[];
	rules: LoupeRule[];
	dirs: LoupeBar[];
	files: LoupeBar[];
	clusters: LoupeCluster[];
	svg: { rules: string; rulesBySeverity: { error: string; warn: string }; dirs: string };
};

/** Where the last run stands: a report, a run in flight, or the engine's refusal. */
export type LoupeRun = {
	report: LoupeReport | null;
	/** The engine could not run (exit 2): its stderr, for the pane to show. */
	error: string | null;
	isRunning: boolean;
};

/** Which rules the pane lists: every severity, or one. */
export type LoupeFilter = 'all' | 'error' | 'warn';

declare module 'claude-code' {
	interface PluginState {
		loupe: {
			run: LoupeRun;
			filter: LoupeFilter;
			/** The HTML report the pane last wrote, absolute; null until it has. */
			htmlPath: string | null;
		};
	}
}
