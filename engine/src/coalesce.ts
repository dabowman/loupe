/**
 * Runs folded into one: a burst of saves, edits or watch events becomes a
 * single re-analysis, and a request that lands mid-run is not dropped but
 * queued for one more.
 *
 * Both long-lived servers — `loupe ui` over its watcher and `loupe lsp` over
 * its saves — want exactly this, and each used to carry its own timer, its own
 * `running` flag and its own `queued` flag. One copy, so the two cannot drift
 * in how they fold.
 *
 * `run` is awaited and expected not to throw: what a failed run means — the
 * last good page stays, the editor hears once — is the caller's to say inside
 * it.
 */
export function coalesce(
	run: () => Promise<void>,
	delay: number,
): { schedule: (wait?: number) => void; cancel: () => void } {
	let timer: NodeJS.Timeout | null = null;
	let running = false;
	let queued = false;
	const drain = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			while (queued) {
				queued = false;
				await run();
			}
		} finally {
			running = false;
		}
	};
	return {
		/** Ask for a run after `wait` ms, superseding one already asked for and not yet started. */
		schedule(wait = delay): void {
			queued = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				void drain();
			}, wait);
		},
		/** Drop a run asked for and not yet started. One in flight finishes. */
		cancel(): void {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
