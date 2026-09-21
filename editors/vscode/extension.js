/**
 * Loupe for VS Code — a launcher, and deliberately nothing else.
 *
 * What a finding means, where its squiggle goes, what its quick fix writes and
 * what hover says all live in `engine/src/lsp.ts`, which is the copy every
 * other editor reaches too. Before adding behaviour here, ask why every other
 * editor should not have it.
 *
 * Design notes: docs/design/lsp.md
 */

const { workspace, window, commands } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

/** @type {import('vscode-languageclient/node').LanguageClient | undefined} */
let client;

/**
 * The files worth syncing. Findings are published repo-wide regardless; this
 * decides only which buffers the server tracks the text of.
 */
const SELECTOR = [
	'css',
	'scss',
	'sass',
	'less',
	'postcss',
	'javascript',
	'javascriptreact',
	'typescript',
	'typescriptreact',
].map((language) => ({ scheme: 'file', language }));

async function start() {
	const folder = workspace.workspaceFolders?.[0];
	if (!folder) return;

	const config = workspace.getConfiguration('loupe');
	if (!config.get('enable', true)) return;
	const command = config.get('path', 'loupe');

	client = new LanguageClient(
		'loupe',
		'Loupe',
		{
			// `--root` rather than the cwd, which a multi-root workspace and a shell
			// opened elsewhere both get wrong.
			run: { command, args: ['lsp', '--root', folder.uri.fsPath], transport: TransportKind.stdio },
			debug: { command, args: ['lsp', '--root', folder.uri.fsPath], transport: TransportKind.stdio },
			options: { cwd: folder.uri.fsPath },
		},
		{
			documentSelector: SELECTOR,
			// A config change means a different verdict on files nobody touched.
			synchronize: { fileEvents: workspace.createFileSystemWatcher('**/loupe.config.json') },
			// Where the server's stderr lands: failed analyses, unreadable baselines.
			outputChannelName: 'Loupe',
		},
	);

	try {
		await client.start();
	} catch (err) {
		client = undefined;
		// Names the likely cause; a stack trace sends people hunting the wrong bug.
		window.showErrorMessage(
			`Loupe: could not start "${command}". Put the plugin's bin/loupe on your PATH, or set "loupe.path" to it. (${
				err && err.message ? err.message : err
			})`,
		);
	}
}

async function stop() {
	const running = client;
	client = undefined;
	if (running) await running.stop();
}

exports.activate = function activate(context) {
	context.subscriptions.push(
		commands.registerCommand('loupe.restart', async () => {
			await stop();
			await start();
		}),
		// A setting that needed a window reload reads as a setting that is broken.
		workspace.onDidChangeConfiguration(async (e) => {
			if (!e.affectsConfiguration('loupe')) return;
			await stop();
			await start();
		}),
	);
	return start();
};

exports.deactivate = stop;
