/**
 * Loupe — pi extension.
 *
 * Ports the Claude Code hooks and commands to pi's extension API:
 *
 *   PostToolUse (Edit|Write)  →  tool_result on edit/write
 *   Stop hook                 →  agent_end
 *   /loupe-audit              →  /loupe-audit command
 *   /loupe-fix                →  /loupe-fix command
 *   /loupe-baseline           →  /loupe-baseline command
 *   /loupe-report             →  /loupe-report command
 *
 * Skills (loupe-authoring, loupe-patterns, loupe-remediation) are loaded
 * directly by pi from the skills/ directory — no porting needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const ENGINE = join(PACKAGE_ROOT, "engine", "bin", "loupe.mjs");
const PROFILES = join(PACKAGE_ROOT, "profiles");

/** Build the engine command prefix with profiles. */
function loupe(...args: string[]): string {
	return `node ${JSON.stringify(ENGINE)} ${args.join(" ")} --profiles ${JSON.stringify(PROFILES)}`;
}

/**
 * Run the engine on a set of files and return { blocking, output }.
 * Uses --format agent so the output is suitable for feeding back to the LLM.
 */
async function runCheck(
	pi: ExtensionAPI,
	files: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ blocking: boolean; output: string }> {
	const scope = files.length > 0 ? `--files ${files.join(",")}` : "--changed";
	const result = await pi.exec(
		"node",
		[ENGINE, "check", scope, "--format", "agent", "--profiles", PROFILES],
		{ cwd, signal, timeout: 60_000 },
	);
	return {
		blocking: result.code === 2,
		output: (result.stdout + result.stderr).trim(),
	};
}

/** Extract the file path from an edit or write tool call's input. */
function extractFilePath(event: { toolName: string; input: Record<string, unknown> }): string | null {
	if (event.toolName === "edit" || event.toolName === "write") {
		const path = event.input?.path;
		return typeof path === "string" ? path : null;
	}
	return null;
}

/** Track files touched during the current agent run, keyed by turn. */
interface RunState {
	touchedFiles: Set<string>;
}

export default function (pi: ExtensionAPI) {
	let runState: RunState = { touchedFiles: new Set() };

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", () => {
		runState = { touchedFiles: new Set() };
	});

	pi.on("agent_start", () => {
		runState = { touchedFiles: new Set() };
	});

	// ── PostToolUse equivalent: check the file just written ────────────────

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (event.isError) return;

		const filePath = extractFilePath(event);
		if (!filePath) return;

		// Track for the Stop-hook equivalent at agent_end.
		runState.touchedFiles.add(filePath);

		// Skip non-UI files the engine cannot say anything about.
		if (!/\.(jsx?|tsx?|s?css|less|styl)$/i.test(filePath)) return;

		const { blocking, output } = await runCheck(pi, [filePath], ctx.cwd, ctx.signal);

		if (!output) return;

		if (blocking) {
			// Hand the findings back to the LLM as additional tool result content.
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `\n\n⚠️ Loupe — design-system conformance findings on ${filePath}:\n\n${output}`,
					},
				],
			};
		}
	});

	// ── Stop hook equivalent: check all changed files at agent_end ─────────

	pi.on("agent_end", async (_event, ctx) => {
		const files = [...runState.touchedFiles].filter((f) =>
			/\.(jsx?|tsx?|s?css|less|styl)$/i.test(f),
		);
		if (files.length === 0) return;

		const { blocking, output } = await runCheck(pi, files, ctx.cwd, ctx.signal);

		if (output && blocking) {
			// Inject a message so the LLM sees the findings on its next turn.
			pi.sendMessage(
				{
					customType: "loupe-gate",
					content: `⚠️ Loupe — design-system conformance findings across changed files:\n\n${output}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}
	});

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("loupe-audit", {
		description:
			"Run a design-system conformance audit over the repo (or just changed files) and summarize what needs fixing",
		handler: async (args, ctx) => {
			const flags = args?.trim() || "--all";
			const skillPath = join(PACKAGE_ROOT, "skills", "loupe-remediation", "SKILL.md");

			const prompt = `Run the conformance engine and report what it finds, against whatever design system this project is on.

\`\`\`bash
${loupe("check", flags)}
\`\`\`

Adjust for the arguments: ${flags}

- \`--changed\` — scope the report to files changed vs. HEAD
- a path — pass as \`--files <path>\`
- \`--suppressions\` — run the \`suppressions\` subcommand instead

Then summarize for the user:

1. Lead with the shape of the problem — which rules dominate, and whether findings cluster or spread.
2. Separate blocking from advisory.
3. Call out \`stylesheet/unparsed\` first if present — those files were not checked at all.
4. Do not start fixing. Offer \`/loupe-fix\` as the next step.

Name the design system — run \`${loupe("status")}\` first.`;

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("loupe-fix", {
		description:
			"Fix design-system conformance findings, working upward through the rule layers",
		handler: async (args, ctx) => {
			const flags = args?.trim() || "";
			const skillPath = join(PACKAGE_ROOT, "skills", "loupe-remediation", "SKILL.md");

			const prompt = `Fix design-system conformance findings.

**Load the \`loupe-remediation\` skill first** — read ${skillPath}

It carries the per-rule remedy and the checks that stop a fix from silently changing rendering. It starts by reading \`${loupe("status")}\` for which design system is in play.

## 1. Apply what needs no judgement

\`\`\`bash
${loupe("fix")}
\`\`\`

Add \`--dry-run\` first if the repo has uncommitted work.

## 2. Get the current state

\`\`\`bash
${loupe("check", "--all", "--format json")}
\`\`\`

${flags ? `Narrow to: ${flags}` : "Work upward through the layers: unparsed files, then malformed suppressions, then component overrides, then layout, then values, then dead classes."} Re-run between stages rather than working from a stale list.

## 3. Fix inline

Count the files holding findings for the stage you are on and fix them. Re-run the check between stages.

## Rules

- Never silence a finding by deleting styling that was doing something.
- Suppress only with a real reason naming the constraint that makes the finding wrong here.
- Never suppress \`stylesheet/unparsed\`.
- If the backlog is large, propose \`/loupe-baseline\` instead.

## 4. Verify

Re-run the check once, repo-wide. Report what changed.`;

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("loupe-baseline", {
		description:
			"Record current design-system findings as an accepted backlog so only new drift is reported",
		handler: async (args, ctx) => {
			const prompt = `Record the existing findings as a baseline, turning the backlog into a ratchet.

Show the scale first:

\`\`\`bash
${loupe("check", "--all", "--format json")}
\`\`\`

Report the count by rule and confirm before writing — a baseline is a decision to defer real work.

On confirmation:

\`\`\`bash
${loupe("baseline")}
\`\`\`

Then tell the user to commit \`.loupe-baseline.json\`, and note that entries key on rule + file + normalized code rather than line number, so reformatting will not resurrect the whole file.

Suggest burning the backlog down one rule at a time with \`/loupe-fix <rule-id>\`, and deleting the baseline once it is empty.`;

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("loupe-report", {
		description:
			"Render the design-system conformance report as an HTML page",
		handler: async (args, ctx) => {
			const flags = args?.trim() || "--all";

			const prompt = `Render the conformance report as a page.

\`\`\`bash
${loupe("check", flags, "--format html")} > /tmp/loupe-report.html
\`\`\`

Exit 1 means blocking findings exist — that is the report working, not a failure. Only exit 2 means the engine could not run.

Give the user the file path (\`/tmp/loupe-report.html\`) and tell them to open it.

Then give the shape of the problem in two or three lines — which rules dominate, whether findings cluster or spread, and whether anything is blocking. Lead with \`stylesheet/unparsed\` if present. Offer \`/loupe-fix\` as the next step.`;

			pi.sendUserMessage(prompt);
		},
	});
}
