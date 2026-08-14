// Automatic auth (T031/T032, FR-005): single-flight refresh + api-key→JWT escalation. The SDK owns
// its credential state and makes the dual-purpose `auth` message's mode explicit off that state (§XV),
// never runtime-detected:
//
// - **Refresh** keeps subscriptions; fired PROACTIVELY from `auth_ack.exp` (skip `exp==0` = no-expiry)
//   and REACTIVELY on an unsolicited `auth_error`. Single-flight — concurrent refreshes coalesce onto
//   one in-flight `auth` — floored with exponential backoff on consecutive failures so an
//   `auth_error`→refresh loop cannot form.
// - **Escalation** (→ JWT) waits for any in-flight refresh to FINISH (not succeed — a failed refresh
//   must not abort the escalation), then sends its OWN `auth` frame + awaits its own ack. It NEVER
//   coalesces onto the refresh's frame — doing so would send the refresh's token and never the JWT
//   (a correction over the sukko-py reference, owed back there as bug #2). On success the caller
//   re-subscribes the retained not-granted delta; offline it defers to `updateToken` + the next
//   reconnect.
//
// Lifecycle: the in-flight deferred is resolved by the read-pump's dispatch of `auth_ack`/`auth_error`.
// `close()` — called at every connection-loss site — fails any pending deferred and cancels the
// proactive timer, so a `refresh()` awaiter never hangs across a disconnect (§XI deterministic teardown).

import type { Clock } from "./_clock";
import { SUKKO_DEFAULTS } from "./constants";
import { ConfigurationError, NotConnectedError, UnauthorizedError } from "./errors";

interface Deferred {
	readonly promise: Promise<void>;
	/** Idempotent — the first settle wins; later resolve/reject calls are no-ops. */
	resolve: () => void;
	reject: (err: Error) => void;
}

function deferred(): Deferred {
	let settled = false;
	let resolve!: () => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = (): void => {
			if (!settled) {
				settled = true;
				res();
			}
		};
		reject = (err: Error): void => {
			if (!settled) {
				settled = true;
				rej(err);
			}
		};
	});
	// A coalesced caller may not have awaited the promise yet when `close()`/`onAuthError` rejects it;
	// swallow the unhandled rejection here. Real awaiters still observe it through `promise`.
	promise.catch(() => {});
	return { promise, resolve, reject };
}

export interface AuthManagerOptions {
	/** The initial credential (JWT or api-key). */
	token?: string;
	/** Async callback returning a fresh token; enables proactive refresh. */
	getToken?: () => Promise<string>;
	/** Send an `auth` frame carrying `token`. */
	send: (token: string) => void;
	/** Injectable clock for the floor/backoff sleep and the proactive timer. */
	clock: Clock;
	/** Min interval between refresh sends (floors the auth_error→refresh loop). */
	floorMs?: number;
	/** Fire the proactive refresh this long before `auth_ack.exp`. */
	leadMs?: number;
}

/** Owns credential state + the automatic auth machinery. Driven by the client's read-pump
 * (`onAuthAck`/`onAuthError`) and its own proactive timer. Client-lifetime; `close()` per epoch. */
export class AuthManager {
	private token: string | undefined;
	private readonly getToken: (() => Promise<string>) | undefined;
	private readonly send: (token: string) => void;
	private readonly clock: Clock;
	private readonly floorMs: number;
	private readonly leadMs: number;
	private pending: Deferred | null = null;
	private lastRefreshAt = Number.NEGATIVE_INFINITY; // allow the first refresh immediately
	private failures = 0;
	private timer: AbortController | null = null;

	constructor(options: AuthManagerOptions) {
		this.token = options.token;
		this.getToken = options.getToken;
		this.send = options.send;
		this.clock = options.clock;
		this.floorMs = options.floorMs ?? SUKKO_DEFAULTS.authRefreshFloorMs;
		this.leadMs = options.leadMs ?? SUKKO_DEFAULTS.authRefreshLeadMs;
	}

	/** The current credential (used for the next connect's `setToken`). */
	get currentToken(): string | undefined {
		return this.token;
	}

	/** Set the credential for the next connect WITHOUT sending `auth` (offline / escalation-deferred). */
	updateToken(token: string): void {
		this.token = token;
	}

	/** Whether a fresh credential can be fetched (`getToken` configured) — the precondition for SSE
	 * reactive-auth: a static token would just be re-rejected, so a 401 is only recoverable with getToken. */
	get canFetchFreshToken(): boolean {
		return this.getToken !== undefined;
	}

	/**
	 * Fetch a fresh credential via `getToken` and adopt it for the next connect. Used by the SSE reactive
	 * refresh (a 401 handshake): unlike `refresh()`, it sends no `auth` frame and awaits no ack — SSE has
	 * neither — so it never hangs. Requires `getToken` (guard with `canFetchFreshToken`).
	 */
	async fetchFreshToken(): Promise<void> {
		if (this.getToken === undefined) {
			throw new ConfigurationError("cannot fetch a fresh token: no getToken configured");
		}
		this.updateToken(await this.getToken());
	}

	// --- refresh / escalation -----------------------------------------------------------------

	private effectiveFloor(): number {
		if (this.failures === 0) return this.floorMs;
		return Math.min(SUKKO_DEFAULTS.authRefreshBackoffMaxMs, this.floorMs * 2 ** this.failures);
	}

	private async resolveToken(): Promise<string> {
		if (this.getToken) return this.getToken();
		if (this.token !== undefined) return this.token;
		throw new ConfigurationError("cannot refresh: no token or getToken configured");
	}

	/** Reject `d` and clear it if still the in-flight deferred (idempotent with the read-pump hooks). */
	private settle(d: Deferred, err: unknown): void {
		d.reject(err instanceof Error ? err : new UnauthorizedError(String(err)));
		if (this.pending === d) this.pending = null;
	}

	/**
	 * Refresh the token. Coalesces onto any in-flight `auth`; otherwise claims the in-flight slot
	 * BEFORE the floor sleep (so `close()` during that sleep fails this refresh instead of hanging),
	 * honors the floor+backoff, fetches a fresh token, sends `auth`, and awaits the ack. Rejects with a
	 * typed error if the refresh is rejected.
	 */
	async refresh(): Promise<void> {
		if (this.pending) return this.pending.promise;
		const d = deferred();
		this.pending = d;
		try {
			// Race the floor sleep against the deferred so `close()`/`onAuthError` rejecting it BREAKS the
			// sleep — otherwise a refresh parked here would hang until the (unabortable) sleep elapsed.
			const wait = this.lastRefreshAt + this.effectiveFloor() - this.clock.now();
			if (wait > 0) await Promise.race([this.clock.sleep(wait), d.promise]);
			const token = await this.resolveToken();
			// Only send if this is STILL the active refresh: `close()`/`onAuthError` may have superseded
			// `d` (rejecting it) while we awaited the token. Sending then would leak a stale `auth` frame —
			// possibly into a reconnected epoch, since the transport gates send on open-state, not epoch
			// identity. When superseded, `d` is already settled, so `await d.promise` throws/returns correctly.
			if (this.pending === d) {
				this.token = token;
				this.lastRefreshAt = this.clock.now();
				this.send(token);
			}
			await d.promise;
		} catch (err) {
			this.settle(d, err);
			throw err;
		}
	}

	/** Reactive refresh (unsolicited `auth_error`) — swallows the error so it can't crash the read-pump. */
	async reactiveRefresh(): Promise<void> {
		try {
			await this.refresh();
		} catch {
			// The proactive timer / next auth_error retries; nothing to surface here.
		}
	}

	/**
	 * Escalate to a JWT. Waits for any in-flight refresh to FINISH, then sends its OWN `auth` frame and
	 * awaits its own ack — never coalescing onto the refresh's frame. Returns `true` when sent + acked
	 * (the caller then re-subscribes the not-granted delta), `false` when deferred while disconnected.
	 */
	async escalate(jwt: string, connected: boolean): Promise<boolean> {
		if (!connected) {
			this.token = jwt; // defer: the next reconnect presents the JWT
			return false;
		}
		// Wait for any in-flight refresh to FINISH. A refresh auth-failure is fine — we send our own
		// frame regardless. But a connection drop (NotConnectedError from close()) means we can't send
		// now: store the JWT and defer to the next reconnect, exactly like the offline path — never fall
		// through to create a deferred that nothing will settle.
		while (this.pending) {
			try {
				await this.pending.promise;
			} catch (err) {
				if (err instanceof NotConnectedError) {
					this.token = jwt;
					return false;
				}
			}
		}
		// Set the credential AFTER the wait so a refresh completing during it cannot clobber the JWT.
		this.token = jwt;
		const d = deferred();
		this.pending = d;
		try {
			// Record the send so a subsequent auto-refresh honors the server's auth rate-limit floor —
			// escalation is a real `auth` send and must not punch a hole in the 1-per-`floorMs` budget.
			this.lastRefreshAt = this.clock.now();
			this.send(jwt);
			await d.promise;
		} catch (err) {
			this.settle(d, err);
			if (err instanceof NotConnectedError) return false; // dropped mid-escalation → deferred (JWT stored)
			throw err;
		}
		return true;
	}

	// --- read-pump hooks ----------------------------------------------------------------------

	/** `auth_ack`: resolve any in-flight refresh, reset backoff, (re)arm the proactive timer from `exp`. */
	onAuthAck(exp: number): void {
		this.failures = 0;
		const p = this.pending;
		this.pending = null;
		p?.resolve();
		this.scheduleProactive(exp);
	}

	/**
	 * `auth_error`. Returns `true` when UNSOLICITED (no refresh in flight) so the caller triggers a
	 * reactive refresh; `false` when it resolves our own in-flight refresh (which must NOT loop).
	 */
	onAuthError(code: string, message: string): boolean {
		this.failures++;
		const p = this.pending;
		if (p) {
			this.pending = null;
			p.reject(new UnauthorizedError(`${code}: ${message}`));
			return false;
		}
		return true;
	}

	// --- proactive timer ----------------------------------------------------------------------

	/** Arm a one-shot refresh `leadMs` before `exp` (absolute Unix seconds). `exp==0` / no `getToken` →
	 * nothing to schedule. The timer runs on its own signal; `close()` cancels it on connection loss. */
	private scheduleProactive(exp: number): void {
		this.cancelTimer();
		if (exp === 0 || this.getToken === undefined) return;
		const ctrl = new AbortController();
		this.timer = ctrl;
		const delay = Math.max(0, exp * 1000 - this.leadMs - this.clock.now());
		void this.clock.sleep(delay, ctrl.signal).then(
			() => {
				this.timer = null;
				void this.reactiveRefresh();
			},
			() => {}, // aborted — rescheduled by a newer ack, or cancelled by close()
		);
	}

	private cancelTimer(): void {
		this.timer?.abort();
		this.timer = null;
	}

	/** Fail any pending refresh and cancel the proactive timer. Called at every connection-loss site. */
	close(): void {
		this.cancelTimer();
		const p = this.pending;
		if (p) {
			this.pending = null;
			p.reject(new NotConnectedError("auth refresh interrupted by close"));
		}
	}
}
