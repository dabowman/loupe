#!/usr/bin/env node
/**
 * What a judged run spends: the shared client, the answer cache, and the hook
 * only paying for what it prints.
 *
 * The unit half drives `ask` with a stub `fetch`. The end-to-end half runs the
 * CLI against a local stand-in for TypeSafe (`LOUPE_JUDGE_ENDPOINT`, which only
 * accepts this machine) that counts the requests it was sent — the number the
 * whole of this file is about.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AnswerCache } from '../src/cache.ts';
import { ask, judgeClient, judgeSummary } from '../src/judge.ts';
import type { Query } from '../src/judge.ts';
import { CLI, assert, check, cleanup, finish, scratch, writeAll } from './harness.ts';

const run = promisify(execFile);

const query: Query<string> = {
	element: (item) => ({ source: item }),
	question: () => ({ criteria: { a: 'A', b: 'B' } }),
};

const answer = { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } };

/** A stub that answers everything, counting calls and the most it had in flight at once. */
function counting(delayMs = 0) {
	const seen = { calls: 0, inFlight: 0, peak: 0 };
	const stub = (async () => {
		seen.calls++;
		seen.inFlight++;
		seen.peak = Math.max(seen.peak, seen.inFlight);
		await new Promise((r) => setTimeout(r, delayMs));
		seen.inFlight--;
		return new Response(JSON.stringify({ answers: { e0: answer } }));
	}) as unknown as typeof fetch;
	return { seen, stub };
}

// ── the client ──────────────────────────────────────────────────────────────

await check('asks sharing one client share its request limit, however many run at once', async () => {
	const { seen, stub } = counting(5);
	const client = judgeClient('key', { fetchImpl: stub });
	const items = (tag: string) => Array.from({ length: 10 }, (_, i) => `${tag}${i}`);
	await Promise.all(['a', 'b', 'c', 'd'].map((t) => ask(query, items(t), client)));
	assert(seen.calls === 40, `sent ${seen.calls}, expected 40`);
	assert(seen.peak <= 6, `${seen.peak} requests in flight at once, over the limit of 6`);
	assert(client.stats.asked === 40, `counted ${client.stats.asked} asked`);
});

await check('the same question asked twice at once is sent once', async () => {
	const { seen, stub } = counting(5);
	const client = judgeClient('key', { fetchImpl: stub });
	const [x, y] = await Promise.all([ask(query, ['same'], client), ask(query, ['same'], client)]);
	assert(seen.calls === 1, `sent ${seen.calls}`);
	assert(x[0]?.choice === 'a' && y[0]?.choice === 'a', 'one of the two went unanswered');
	assert(client.stats.shared === 1, `shared ${client.stats.shared}`);
});

await check('an answer paid for in one run is reused by the next, and only for the same question', async () => {
	const dir = scratch('loupe-answers-');
	try {
		const path = join(dir, 'judge-cache.json');
		const first = counting();
		const one = judgeClient('key', { fetchImpl: first.stub, cache: new AnswerCache(path) });
		await ask(query, ['p1', 'p2'], one);
		one.cache?.save();
		assert(first.seen.calls === 2, `first run sent ${first.seen.calls}`);
		assert(existsSync(path), 'nothing was written');

		const second = counting();
		const two = judgeClient('key', { fetchImpl: second.stub, cache: new AnswerCache(path) });
		const answers = await ask(query, ['p1', 'p2', 'p3'], two);
		assert(second.seen.calls === 1, `second run sent ${second.seen.calls}, expected only the new question`);
		assert(
			answers.every((a) => a?.choice === 'a'),
			'a cached answer came back wrong',
		);
		assert(judgeSummary(two) === 'judge: 1 asked, 2 from cache', judgeSummary(two) ?? 'null');
	} finally {
		cleanup(dir);
	}
});

await check('a reply missing an answer is not cached, so it is asked again', async () => {
	const dir = scratch('loupe-answers-');
	try {
		const path = join(dir, 'judge-cache.json');
		let calls = 0;
		const gap = (async () => {
			calls++;
			return new Response(JSON.stringify({ answers: {} }));
		}) as unknown as typeof fetch;
		for (let i = 0; i < 2; i++) {
			const client = judgeClient('key', { fetchImpl: gap, cache: new AnswerCache(path) });
			await ask(query, ['p'], client);
			client.cache?.save();
		}
		assert(calls === 2, `asked ${calls} time(s), expected the gap re-asked`);
	} finally {
		cleanup(dir);
	}
});

await check('a corrupt cache file is a cold cache, not a failure', async () => {
	const dir = scratch('loupe-answers-');
	try {
		writeAll(dir, { 'judge-cache.json': '{"version":1,"entries":' });
		const { seen, stub } = counting();
		const client = judgeClient('key', { fetchImpl: stub, cache: new AnswerCache(join(dir, 'judge-cache.json')) });
		await ask(query, ['p'], client);
		client.cache?.save();
		assert(seen.calls === 1, `sent ${seen.calls}`);
		const saved = JSON.parse(readFileSync(join(dir, 'judge-cache.json'), 'utf8'));
		assert(Object.keys(saved.entries).length === 1, 'the rewritten file does not hold the new answer');
	} finally {
		cleanup(dir);
	}
});

// ── the CLI, against a stand-in endpoint ────────────────────────────────────

const requests: string[] = [];
const server = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => {
		body += c;
	});
	req.on('end', () => {
		requests.push(body);
		// Under every floor, so nothing is written into a finding: what is
		// measured is what was asked, not what came of it.
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({ answers: { e0: { choice: 'x', confidence: 0.1, probabilities: { x: 1 } } } }));
	});
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const PROFILES = join(import.meta.dirname, '..', '..', 'profiles');
/** Five raw `<p>`s: each one a `system/raw-element` finding with a Text variant to ask about. */
const MARKUP = Array.from(
	{ length: 5 },
	(_, i) => `export const P${i} = () => <p className="p${i}">Line ${i}</p>;`,
).join('\n');
const PKG = JSON.stringify({ dependencies: { '@wordpress/components': '*', '@wordpress/ui': '*' } });

function project(config?: object, markup = MARKUP): { root: string; data: string } {
	const root = scratch('loupe-judged-');
	writeAll(root, {
		'package.json': PKG,
		'src/P.jsx': markup,
		'.claude/settings.local.json': JSON.stringify({ env: { LOUPE: 'on' } }),
		...(config ? { 'loupe.config.json': JSON.stringify(config) } : {}),
	});
	return { root, data: join(root, '.plugin-data') };
}

const env = (data: string, extra: Record<string, string> = {}) => ({
	...process.env,
	TYPESAFE_API_KEY: 'test-key',
	LOUPE_JUDGE_ENDPOINT: endpoint,
	CLAUDE_PLUGIN_DATA: data,
	LOUPE_NO_CACHE: '',
	...extra,
});

/** Runs the CLI and returns how many requests reached the endpoint, with its output. */
async function judged(
	args: string[],
	e: NodeJS.ProcessEnv,
	input?: string,
): Promise<{ n: number; stdout: string; stderr: string }> {
	const before = requests.length;
	const child = run('node', [CLI, ...args], { env: e, encoding: 'utf8' });
	if (input !== undefined) {
		child.child.stdin?.write(input);
		child.child.stdin?.end();
	}
	const out = await child.catch((err: { stdout: string; stderr: string; code: number }) => {
		// Blocking findings — exit 1 from check, 2 from the hook — mean the run worked.
		if (err.code !== (args[0] === 'hook' ? 2 : 1)) throw new Error(`exit ${err.code}: ${err.stderr}`);
		return err;
	});
	return { n: requests.length - before, stdout: out.stdout, stderr: out.stderr };
}

const hookPayload = (root: string, session = 's1') =>
	JSON.stringify({
		session_id: session,
		hook_event_name: 'PostToolUse',
		tool_name: 'Write',
		tool_input: { file_path: join(root, 'src/P.jsx') },
	});

await check('check --judge asks once, then answers the same run from the cache', async () => {
	const { root, data } = project({ extends: 'wpds' });
	try {
		const args = ['check', '--root', root, '--all', '--judge', '--profiles', PROFILES];
		const first = await judged(args, env(data));
		assert(first.n === 5, `the first run sent ${first.n} request(s), expected one per <p>`);
		assert(/judge: 5 asked/.test(first.stderr), `no spend line: ${first.stderr}`);
		const again = await judged(args, env(data));
		assert(again.n === 0, `the repeat sent ${again.n} request(s)`);
		assert(/0 asked, 5 from cache/.test(again.stderr), `spend line: ${again.stderr}`);
		const fresh = await judged([...args, '--no-cache'], env(data));
		assert(fresh.n === 5, `--no-cache sent ${fresh.n}`);
		const envOff = await judged(args, env(data, { LOUPE_NO_CACHE: '1' }));
		assert(envOff.n === 5, `LOUPE_NO_CACHE=1 sent ${envOff.n}`);
	} finally {
		cleanup(root);
	}
});

// Five tags, five different lines: the report has room for two of them.
const DISTINCT = ['p', 'h1', 'h2', 'h3', 'h4']
	.map((tag, i) => `export const E${i} = () => <${tag} className="e${i}">Line ${i}</${tag}>;`)
	.join('\n');

// A PostToolUse that blocks nothing hands the agent the findings its cap has
// room for, so it asks about those; a Stop that blocks nothing prints a tally.
await check('an advisory hook run asks only about what it hands the agent, and Stop nothing', async () => {
	// No config: inferred, so every finding is advisory.
	const { root, data } = project(undefined, DISTINCT);
	try {
		execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
		const hookEnv = env(data, { CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_OPTION_MAX_FINDINGS: '2' });
		const post = await judged(['hook', '--judge', '--profiles', PROFILES], hookEnv, hookPayload(root));
		assert(post.n === 2, `the PostToolUse sent ${post.n} request(s), expected the 2 it has room to hand over`);
		// Uncached, so a Stop that asked could not hide behind the answers above.
		const stop = await judged(
			['hook', '--judge', '--profiles', PROFILES, '--no-cache'],
			hookEnv,
			JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false }),
		);
		assert(/advisory/.test(stop.stdout), `the Stop did not tally the findings: ${stop.stdout}`);
		assert(stop.n === 0, `the advisory Stop sent ${stop.n} request(s)`);
	} finally {
		cleanup(root);
	}
});

await check('a blocking hook run asks only about the findings it prints', async () => {
	const { root, data } = project(
		{
			extends: 'wpds',
			rules: { 'system/raw-element': 'error' },
			hook: { maxFindings: 2 },
		},
		DISTINCT,
	);
	try {
		const hookEnv = env(data, { CLAUDE_PROJECT_DIR: root });
		const first = await judged(['hook', '--judge', '--profiles', PROFILES], hookEnv, hookPayload(root));
		assert(first.n === 2, `the hook sent ${first.n} request(s), expected the 2 it has room to print`);
		assert(
			/\(attempt 1 of \d+; judge: 2 asked\)/.test(first.stderr),
			`the block does not say what it spent: ${first.stderr}`,
		);
		// The same turn's next write, and the Stop after it: nothing new to pay for.
		const again = await judged(['hook', '--judge', '--profiles', PROFILES], hookEnv, hookPayload(root));
		assert(again.n === 0, `the second hook run sent ${again.n}`);
	} finally {
		cleanup(root);
	}
});

// The PostToolUse report prints what the edit introduced, not every finding the
// file has, blocking or advisory: the judgements go there, or the one finding
// the agent is shown reaches it unjudged while the standing ones were paid for.
async function asksAboutWhatTheEditIntroduced(severity: 'error' | 'warn'): Promise<void> {
	const { root, data } = project(
		{
			extends: 'wpds',
			rules: { 'system/raw-element': severity },
			hook: { maxFindings: 1 },
		},
		DISTINCT,
	);
	try {
		const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
		git('init', '-q');
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
		git('add', '-A');
		git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'before');
		const file = join(root, 'src/P.jsx');
		writeFileSync(file, `${DISTINCT}\nexport const E5 = () => <h5 className="e5">Line 5</h5>;`);
		const payload = JSON.stringify({
			session_id: 's1',
			hook_event_name: 'PostToolUse',
			tool_name: 'Write',
			tool_input: { file_path: file },
			tool_response: { filePath: file, originalFile: DISTINCT },
		});
		const before = requests.length;
		await judged(['hook', '--judge', '--profiles', PROFILES], env(data, { CLAUDE_PROJECT_DIR: root }), payload);
		const sent = requests.slice(before);
		assert(sent.length === 1, `the hook sent ${sent.length} request(s), expected the one it prints`);
		const asked = (JSON.parse(sent[0] ?? '{}') as { state?: { elements?: { source?: string }[] } }).state?.elements?.[0]
			?.source;
		// The element asked about opens its `source`; what follows it is context.
		const opening = (asked ?? '').split('\n')[0] ?? '';
		assert(/<h5/.test(opening), `it asked about a standing finding: ${opening}`);
	} finally {
		cleanup(root);
	}
}
await check('a PostToolUse asks about the finding the edit introduced, not the ones it walked past', () =>
	asksAboutWhatTheEditIntroduced('error'),
);
await check('an advisory PostToolUse asks about the finding the edit introduced, not the ones it walked past', () =>
	asksAboutWhatTheEditIntroduced('warn'),
);

// Five `<p>` print as one `×5` line, which stands for all five: judging only
// some would split the line and print the rest unjudged beside it.
await check('a printed ×N line is judged whole', async () => {
	const { root, data } = project({
		extends: 'wpds',
		rules: { 'system/raw-element': 'error' },
		hook: { maxFindings: 1 },
	});
	try {
		const hookEnv = env(data, { CLAUDE_PROJECT_DIR: root });
		const first = await judged(['hook', '--judge', '--profiles', PROFILES], hookEnv, hookPayload(root));
		assert(first.n === 5, `the hook sent ${first.n} request(s), expected one per <p> on the line it prints`);
	} finally {
		cleanup(root);
	}
});

await check('a hook that has stood down asks nothing', async () => {
	const { root, data } = project({
		extends: 'wpds',
		rules: { 'system/raw-element': 'error' },
		hook: { maxAttempts: 1 },
	});
	try {
		const hookEnv = env(data, { CLAUDE_PROJECT_DIR: root });
		await judged(['hook', '--judge', '--profiles', PROFILES, '--no-cache'], hookEnv, hookPayload(root));
		const stoodDown = await judged(
			['hook', '--judge', '--profiles', PROFILES, '--no-cache'],
			hookEnv,
			hookPayload(root),
		);
		assert(stoodDown.n === 0, `the stood-down hook sent ${stoodDown.n} request(s)`);
	} finally {
		cleanup(root);
	}
});

server.close();
finish();
