#!/usr/bin/env node
/**
 * Compiles the engine into a single self-contained executable.
 *
 * This is a third artifact, not a replacement for either of the two that
 * exist. `src/` is the real code; `dist/loupe.mjs` is the committed bundle that
 * makes a marketplace install work without a toolchain. Both still need Node on
 * the machine. A binary is for the places that have no Node and should not be
 * made to grow one — somebody else's CI, a pre-commit hook in a repo that is
 * not JavaScript, a designer who wants the checker and not a dev environment.
 *
 * Bun does the compiling because it is the only toolchain that reads the
 * engine's TypeScript as-is and cross-compiles to every target from one
 * machine. It is a build-time tool: nothing about the produced binary depends
 * on Bun being installed anywhere else, and the engine keeps no runtime
 * dependency on it.
 *
 * Output is deliberately not `dist/`. `dist/` is committed, and these are 60-100
 * MB each — they belong on a release, never in the history.
 *
 * No credential is ever compiled in, and nothing here may change that. The
 * engine reads `process.env.TYPESAFE_API_KEY` at runtime and `--judge` is the
 * user's own key or nothing — verified three ways against a canary value: a key
 * in a `.env` at the checkout, a key exported into the build environment, and a
 * `.env` sitting in this build's working directory all leave the artifact clean,
 * and a binary run with no key refuses and says where to put one.
 *
 * That holds because the value is read through `process.env` at runtime and
 * neither compiler substitutes it. `--define` is what would break it: passing
 * `--define:process.env.TYPESAFE_API_KEY=...`, or anything that inlines the
 * ambient environment, bakes whatever the build machine happened to export into
 * an artifact meant to be published. Do not add one.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');
const OUT_DIR = join(ENGINE, 'binaries');

/**
 * Short name -> Bun target. The short name is what `--target` takes.
 *
 * Linux appears twice on purpose. The default build links against glibc and
 * exits "not found" on Alpine, which is what a lot of CI actually runs — the
 * failure reads like a missing file rather than a missing libc, so it is worth
 * shipping the musl build beside it rather than letting people find out.
 */
const TARGETS = {
	'linux-x64': 'bun-linux-x64',
	'linux-x64-musl': 'bun-linux-x64-musl',
	'linux-arm64': 'bun-linux-arm64',
	'linux-arm64-musl': 'bun-linux-arm64-musl',
	'darwin-x64': 'bun-darwin-x64',
	'darwin-arm64': 'bun-darwin-arm64',
	'windows-x64': 'bun-windows-x64',
};

const HOST = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

const args = process.argv.slice(2);
const all = args.includes('--all');
const asked = args.find((a) => a.startsWith('--target='))?.slice('--target='.length);

if (asked && !TARGETS[asked]) {
	process.stderr.write(`unknown target: ${asked}\n  known: ${Object.keys(TARGETS).join(', ')}\n`);
	process.exit(2);
}
if (!all && !asked && !TARGETS[HOST]) {
	process.stderr.write(`no target for this host (${HOST}); name one with --target=\n`);
	process.exit(2);
}

const chosen = all ? Object.keys(TARGETS) : [asked ?? HOST];

try {
	execFileSync('bun', ['--version'], { stdio: 'ignore' });
} catch {
	process.stderr.write(
		'build:binary needs Bun, which is a build-time tool only — the binary it produces has no runtime dependency on it.\n' +
			'  Install:  curl -fsSL https://bun.sh/install | bash\n' +
			'  In CI:    uses: oven-sh/setup-bun@v2\n',
	);
	process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const name of chosen) {
	const outfile = join(OUT_DIR, `loupe-${name}${name.startsWith('windows') ? '.exe' : ''}`);
	// A compiled Bun executable reads the working directory's bunfig.toml at
	// startup and runs its `preload` scripts, and this binary is run inside
	// repositories it is checking — somebody else's CI. That would be the
	// scanned repo executing code with the job's environment, so it is off.
	// (The .env autoload stays on: it is how the binary finds a `--judge` key,
	// since Bun has no `process.loadEnvFile`.)
	execFileSync(
		'bun',
		[
			'build',
			'--compile',
			'--no-compile-autoload-bunfig',
			`--target=${TARGETS[name]}`,
			join(ENGINE, 'src', 'cli.ts'),
			'--outfile',
			outfile,
		],
		{ stdio: ['ignore', 'ignore', 'inherit'], cwd: ENGINE },
	);
	process.stdout.write(`${`loupe-${name}`.padEnd(22)} ${(statSync(outfile).size / 1048576).toFixed(0).padStart(4)} MB\n`);
}
