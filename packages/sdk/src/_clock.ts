// Injectable clock / sleep / RNG seam (NFR-006) — the TS analog of sukko-py's `_clock.py`.
// Determinism is the SDK's race-detector substitute: every timing path (backoff+jitter, refresh
// floor+lead, replay floor, recovery/history deadline, heartbeat/pong, SSE idle) routes through a
// `Clock`, so timing tests advance a `FakeClock` in virtual time and NEVER sleep for real.

/** Abstraction over wall-clock time, delay, and randomness. Injected into the client for testing. */
export interface Clock {
	/** Current time in epoch milliseconds. */
	now(): number;
	/** Resolve after `ms` virtual/real milliseconds; reject with an `AbortError` if `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
	/** A float in [0, 1) — used for jitter. Deterministic on `FakeClock`, `Math.random` on the real one. */
	rng(): number;
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

/** The production clock: real time, `setTimeout` delays, `Math.random` jitter. */
export class SystemClock implements Clock {
	now(): number {
		return Date.now();
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(abortError());
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	rng(): number {
		return Math.random();
	}
}

interface Sleeper {
	dueAt: number;
	resolve: () => void;
	reject: (reason: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

// Deterministic seedable PRNG (mulberry32) so jitter is reproducible under test.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return (): number => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Virtual-time clock for tests. `advance(ms)` fires due sleepers in order; nothing sleeps for real. */
export class FakeClock implements Clock {
	private current: number;
	private advancing = false;
	private readonly sleepers: Sleeper[] = [];
	private readonly random: () => number;

	constructor(options?: { start?: number; seed?: number }) {
		this.current = options?.start ?? 0;
		this.random = mulberry32(options?.seed ?? 1);
	}

	now(): number {
		return this.current;
	}

	rng(): number {
		return this.random();
	}

	/** Number of sleepers still waiting — useful for asserting deterministic teardown in tests. */
	get pending(): number {
		return this.sleepers.length;
	}

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise<void>((resolve, reject) => {
			// Clamp to match `setTimeout` semantics: a non-positive delay fires as soon as possible at
			// the current virtual time and never rewinds `now()` (SystemClock/`setTimeout` clamp too).
			const sleeper: Sleeper = { dueAt: this.current + Math.max(0, ms), resolve, reject, signal };
			if (signal) {
				sleeper.onAbort = (): void => {
					this.remove(sleeper);
					reject(abortError());
				};
				signal.addEventListener("abort", sleeper.onAbort, { once: true });
			}
			this.sleepers.push(sleeper);
		});
	}

	/**
	 * Advance virtual time by `ms`, firing every sleeper whose deadline is reached — in due order, so
	 * a sleep scheduled while resolving an earlier one sees the correct `now()`. Awaits a microtask
	 * between wakeups so chained `await`s settle deterministically.
	 *
	 * NOT re-entrant (throws if called while a prior `advance` is in flight) — a single test drives the
	 * clock. Assumes a sleep is scheduled **directly** in a wakeup's continuation (single microtask
	 * hop); a sleep deferred behind an extra `Promise.resolve()` would be picked up on the next
	 * `advance`, not this one.
	 */
	async advance(ms: number): Promise<void> {
		if (this.advancing) throw new Error("FakeClock.advance() is not re-entrant");
		this.advancing = true;
		try {
			const target = this.current + ms;
			// Let any already-queued continuations run before we start advancing.
			await Promise.resolve();
			for (;;) {
				const next = this.earliestDueBy(target);
				if (next === undefined) break;
				this.current = next.dueAt;
				this.remove(next);
				next.signal?.removeEventListener("abort", next.onAbort as () => void);
				next.resolve();
				await Promise.resolve();
			}
			this.current = target;
		} finally {
			this.advancing = false;
		}
	}

	private earliestDueBy(target: number): Sleeper | undefined {
		let earliest: Sleeper | undefined;
		for (const s of this.sleepers) {
			if (s.dueAt <= target && (earliest === undefined || s.dueAt < earliest.dueAt)) earliest = s;
		}
		return earliest;
	}

	private remove(sleeper: Sleeper): void {
		const i = this.sleepers.indexOf(sleeper);
		if (i !== -1) this.sleepers.splice(i, 1);
	}
}
