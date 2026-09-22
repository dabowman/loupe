/**
 * The HTML report: the artifact half of the view.
 *
 * Every other formatter here spends its design budget on brevity, because its
 * reader is an agent. This one's reader is a person deciding what to fix, so:
 *
 * 1. The page renders client-side from the exact `--format json` payload,
 *    embedded verbatim, so it cannot disagree with the JSON.
 * 2. It shows the two things a line-per-finding list structurally cannot: a
 *    directory rollup, and the composite rules as the N-way relations they are.
 *
 * No timestamp is rendered — re-running the same check would produce a file that
 * differs from itself. The file's mtime records when it was taken. That is a
 * property of *this* host and not of the view: `loupe ui` serves the same
 * rendering and does say when it last ran, because nobody diffs a window.
 *
 * What is drawn, and how, is `report-view.ts`, which `loupe ui` renders too.
 *
 * Design notes: docs/design/report.md#the-html-report
 */

import { body } from './report-view.ts';
import { reportPayload } from './report.ts';
import type { AnalyzeResult, BaselinedResult, Config } from './types.ts';

/**
 * Embed the payload in a `<script type="application/json">` block.
 *
 * The block's content is raw text: the only thing that can end it early is the
 * literal `</script`, and the only thing that can open a comment is `<!--`.
 * Escaping every `<` closes both, and is safe wholesale because in JSON a `<`
 * can only occur inside a string, where it means the same character.
 */
const embed = (json: string): string => json.replace(/</g, '\\u003c');

export function formatHtml(result: AnalyzeResult | BaselinedResult, config: Config): string {
	const payload = embed(JSON.stringify(reportPayload(result, config)));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loupe report</title>
</head>
<body>
${body({ payload, clean: result.findings.length === 0, parseErrors: result.diagnostics.parseErrors.length })}
</body>
</html>
`;
}
