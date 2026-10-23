/**
 * Loupe — pi extension.
 *
 * Ports the Claude Code hooks and commands to pi's extension API:
 *
 *   PostToolUse (Edit|Write)  →  tool_result on edit/write
 *   Stop hook                 →  agent_end
 *   /loupe-init               →  /loupe-init command
 *   /loupe-audit              →  /loupe-audit command
 *   /loupe-fix                →  /loupe-fix command
 *   /loupe-baseline           →  /loupe-baseline command
 *   /loupe-report             →  /loupe-report command
 *
 * Skills (loupe-authoring, loupe-patterns, loupe-remediation) are loaded
 * directly by pi from the skills/ directory — no porting needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");
const ENGINE = join(PACKAGE_ROOT, "engine", "bin", "loupe.mjs");
const PROFILES = join(PACKAGE_ROOT, "profiles");

/** Files the engine can say something about. */
const UI_FILE = /\.(jsx?|tsx?|s?css|less|styl)$/i;

/** Build the engine command prefix with profiles. */
function loupe(...args: string[]): string {
	return `node ${JSON.stringify(ENGINE)} ${args.join(" ")} --profiles ${JSON.stringify(PROFILES)}`;
}

/**
 * Run the engine the way Claude Code's hooks do, so the project opt-in,
 * LOUPE_OFF, advisory demotion and the retry stand-down all apply here too.
 * The payload goes on stdin, which pi.exec cannot write — hence execFile.
 * Exit 2 is blocking, with the agent's report on stderr. Otherwise the agent
 * hears only what the hook addressed to it, `additionalContext` on stdout.
 */
function runHook(
	cwd: string,
	payload: {
		session_id: string;
		tool_input?: { file_path: string };
		tool_response?: { filePath: string; originalFile: string | null };
	},
	files: string[],
	signal?: AbortSignal,
): Promise<{ blocking: boolean; output: string }> {
	const scope = files.length > 0 ? ["--files", files.join(",")] : [];
	return new Promise((done) => {
		const child = execFile(
			"node",
			[ENGINE, "hook", "--root", cwd, ...scope, "--profiles", PROFILES],
			{ cwd, signal, timeout: 60_000 },
			(err, stdout, stderr) => {
				if (err?.code === 2) return done({ blocking: true, output: stderr.trim() });
				let context = "";
				try {
					context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? "";
				} catch {
					/* a crashed or silent hook has nothing for the agent */
				}
				done({ blocking: false, output: context });
			},
		);
		child.stdin?.on("error", () => {}); // a child that failed to start has no reader
		child.stdin?.end(JSON.stringify(payload));
	});
}

export default function (pi: ExtensionAPI) {
	/** Files touched during the current agent run. */
	const touched = new Set<string>();
	/**
	 * What each edit or write's file held before it ran, by call id; null for a
	 * file the call creates. Claude Code hands its hook this as `originalFile`,
	 * so PostToolUse blocks only on what the edit introduced; pi has no such
	 * field, so the file is read here before the tool runs.
	 */
	const before = new Map<string, string | null>();

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", () => touched.clear());
	pi.on("agent_start", () => touched.clear());

	// ── PostToolUse equivalent: check the file just written ────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const filePath = event.input?.path;
		if (typeof filePath !== "string" || !filePath || !UI_FILE.test(filePath)) return;
		try {
			before.set(event.toolCallId, await readFile(resolve(ctx.cwd, filePath), "utf8"));
		} catch {
			before.set(event.toolCallId, null);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const originalFile = before.get(event.toolCallId);
		before.delete(event.toolCallId);
		if (event.isError) return;

		const filePath = event.input?.path;
		if (typeof filePath !== "string" || !filePath) return;
		// The tool's path is relative to the session's cwd; the engine reads a
		// relative --files entry against the project root, which can be above it.
		const abs = resolve(ctx.cwd, filePath);

		// Track for the Stop-hook equivalent at agent_end.
		touched.add(abs);

		if (!UI_FILE.test(filePath)) return;

		const { blocking, output } = await runHook(
			ctx.cwd,
			{
				session_id: ctx.sessionManager.getSessionId(),
				tool_input: { file_path: abs },
				...(originalFile === undefined ? {} : { tool_response: { filePath: abs, originalFile } }),
			},
			[],
			ctx.signal,
		);

		if (!output) return;

		// Hand the findings back to the LLM as additional tool result content:
		// what blocks, or what the edit introduced that does not, with the blocking
		// findings it walked past and the end-of-run check will hold.
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: blocking
						? `\n\n⚠️ Loupe — design-system conformance findings on ${filePath}:\n\n${output}`
						: `\n\nLoupe — ${output}`,
				},
			],
		};
	});

	// ── Stop hook equivalent: check all changed files at agent_end ─────────

	pi.on("agent_end", async (_event, ctx) => {
		const files = [...touched].filter((f) => UI_FILE.test(f));
		if (files.length === 0) return;

		const { blocking, output } = await runHook(
			ctx.cwd,
			{ session_id: ctx.sessionManager.getSessionId() },
			files,
			ctx.signal,
		);

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

	pi.registerCommand("loupe-init", {
		description:
			"Configure loupe for this project — settle the design system, namespaces and external prefixes with the user, then write loupe.config.json",
		handler: async (args, ctx) => {
			const named = args?.trim() || "";

			const prompt = `Write this project's \`loupe.config.json\`, confirming with the user what detection could not settle. Once the file exists the engine never re-infers, so a wrong guess written here stays wrong.

1. Detect:

\`\`\`bash
${loupe("detect", "--format json")}
\`\`\`

If a \`loupe.config.json\` already exists, say so and ask before replacing it (\`--force\`).

2. Settle the design system.${named ? ` The user named \`${named}\` — use it.` : ""} At \`high\` presetConfidence, name it and move on. At \`low\` or \`none\`, stop — do not accept \`generic\`, which turns most rules off. Resolve it from \`presetEvidence\` (source imports, \`@types/wordpress__*\`, \`build/*.asset.php\` dependencies, \`.wp-env.json\`, \`composer.json\`) and the code itself. \`${loupe("presets")}\` lists the choices; \`${loupe("status", "--preset <name>")}\` shows what each turns on. Propose one with its evidence and let the user confirm.

3. Confirm \`namespaces.project\` (with coverage, confidence and any \`namespaceNotes\`), then each \`possibleExternal\` entry: CSS-module or hashed names and \`node_modules\` prefixes are nearly always third-party; a prefix nothing references is vendored or dead — read how it is enqueued. Vendored goes in \`external\`; dead stays out.

4. Write with \`${loupe("init", "--preset <name>")}\` (or \`init --force\` only if the user agreed there is no design system), then edit \`loupe.config.json\` for the confirmed \`namespaces.project\` and \`namespaces.external\`.

5. Run \`${loupe("status")}\` and report which rules the choice turned on and which stayed off, with the reason each gives. Then size the backlog with \`${loupe("check", "--all", "--format json")}\`; if it is large, offer \`/loupe-baseline\`, otherwise \`/loupe-audit\`. Tell the user to commit \`loupe.config.json\`. Do not start fixing.`;

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("loupe-audit", {
		description:
			"Run a design-system conformance audit over the repo (or just changed files) and summarize what needs fixing",
		handler: async (args, ctx) => {
			const flags = args?.trim() || "--all";

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
${loupe("fix", "--changed")}
\`\`\`

\`fix\` reads no baseline, so \`--changed\` keeps it off the accepted backlog; to work a named rule's backlog, pass \`--rule <id>\` in its place, and for a named path \`--files <path>\` in its place — a directory stands for the source files under it, and every value in them is in reach, baselined or not. Add \`--dry-run\` first if the repo has uncommitted work.

## 2. Get the current state

\`\`\`bash
${loupe("check", "--all", "--format json")}
\`\`\`

${flags ? `The arguments were: ${flags}. If they name a rule id, pass it as \`--rule <id>\` — to this check and to the \`fix\` in step 1 — and add \`--no-baseline\` to this check (and to the verifying one in step 4): naming a rule is working that rule's backlog on purpose, and a baseline would hide exactly the findings you were asked to clear. \`fix\` reads no baseline, so it needs no flag. A path goes in as \`--files <path>\`; both repeat. Naming only a path keeps the baseline: that is the new drift, not the accepted backlog. Don't filter the JSON yourself.` : "A bare /loupe-fix keeps the baseline: it works the new drift, not the accepted backlog. Work upward through the layers: unparsed files, then malformed suppressions, then the classes already dead, then component overrides, then layout, then values, then a last sweep for what that work left dead."} Re-run between stages rather than working from a stale list.

## 3. Fix inline

Count the files holding findings for the stage you are on and fix them. Re-run the check between stages.

## Rules

- Never silence a finding by deleting styling that was doing something.
- Suppress only with a real reason naming the constraint that makes the finding wrong here.
- Never suppress \`stylesheet/unparsed\`.
- If the backlog is large, propose \`/loupe-baseline\` instead.

## 4. Verify

Re-run the check once, repo-wide, with the same \`--rule\` and \`--no-baseline\` as step 2. Report what changed, and when a rule was named and its backlog is now empty, suggest re-recording the baseline with \`/loupe-baseline\`.`;

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerCommand("loupe-baseline", {
		description:
			"Record current design-system findings as an accepted backlog so only new drift is reported",
		handler: async (args, ctx) => {
			const prompt = `Record the existing findings as a baseline, turning the backlog into a ratchet.

Show the scale first. \`--dry-run\` writes nothing:

\`\`\`bash
${loupe("baseline", "--dry-run")}
\`\`\`

It prints what would be recorded, by rule, and — when a baseline already exists — how each rule's entries differ from it: \`+N new\` is backlog accepted for the first time, \`-N fixed\` is work done since the last recording. (Do not use \`check\` for this: it applies the existing baseline, so on a repo that already has one it reports nothing to confirm.)

Report that breakdown and confirm before writing — a baseline is a decision to defer real work. If the dry run says nothing would change, say so and stop.

On confirmation:

\`\`\`bash
${loupe("baseline")}
\`\`\`

Then tell the user to commit \`.loupe/baseline.json\`, and note that entries key on rule + file + normalized code rather than line number, so reformatting will not resurrect the whole file.

Suggest burning the backlog down one rule at a time with \`/loupe-fix <rule-id>\`, which works that rule's baselined findings deliberately — naming a rule makes its check run with \`--no-baseline\` — while a bare \`/loupe-fix\` keeps respecting the baseline and fixes new drift only. Delete the baseline once it is empty. \`${loupe("check", "--no-baseline", "--rule <rule-id>")}\` shows how much of one rule the baseline is holding; \`fix\` reads no baseline at all.`;

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
