#!/usr/bin/env node
/**
 * Compiles the engine into a single self-contained executable.
 *
 * A third artifact, for the places that have no Node and should not be made to
 * grow one. Bun does the compiling because it is the only toolchain that reads
 * the engine's TypeScript as-is and cross-compiles to every target from one
 * machine; nothing about the produced binary depends on Bun elsewhere.
 *
 * Output is deliberately not `dist/`, which is committed: these are 60-110 MB
 * each and belong on a release.
 *
 * NO CREDENTIAL IS EVER COMPILED IN, and nothing here may change that. The
 * engine reads `process.env.TYPESAFE_API_KEY` at runtime and neither compiler
 * substitutes it. `--define:process.env.TYPESAFE_API_KEY=...`, or anything that
 * inlines the ambient environment, would bake whatever the build machine
 * exported into a published artifact. Do not add one.
 *
 * Design notes: docs/design/cli.md#the-binary
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
 * Linux appears twice on purpose: the default build links against glibc and
 * exits "not found" on Alpine, a failure that reads like a missing file rather
 * than a missing libc.
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
	// repositories it is checking. That would be the scanned repo executing code
	// with the job's environment, so it is off. (The .env autoload stays on: it is
	// how the binary finds a `--judge` key.)
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
