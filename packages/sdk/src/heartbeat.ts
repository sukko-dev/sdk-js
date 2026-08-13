// Heartbeat / liveness monitor (T028, FR-024). `SukkoClient` constructs one HeartbeatMonitor per
// connection epoch, drives it with the client's injected `Clock`, feeds `noteActivity()` from the
// message handler, and tears it down via the epoch `AbortController`.
//
// Runs ONLY on a send-capable (WS) transport: it sends
// the app-level `heartbeat` message every `intervalMs`, then waits `pongTimeoutMs` for ANY inbound
// frame (a `pong` or any other message) to confirm liveness. If none arrives, it fires `onTimeout`
// (the client performs a local HEARTBEAT_TIMEOUT 4000 close → reconnect). It NEVER starts on a
// receive-only transport (SSE), whose sole liveness detector is the SSE idle timeout (FR-010). All
// timing runs through the injected clock, so the loop is deterministically testable.

import type { Clock } from "./_clock";

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

export interface HeartbeatMonitorOptions {
	clock: Clock;
	intervalMs: number;
	pongTimeoutMs: number;
	/** The transport's `canSend` capability — only a send-capable (WS) transport heartbeats. */
	canSend: boolean;
	/** Send the app-level `heartbeat` message. */
	send: () => void;
	/** Called once when no inbound frame arrives within `pongTimeoutMs` of a heartbeat. */
	onTimeout: () => void;
}

export class HeartbeatMonitor {
	private readonly clock: Clock;
	private readonly intervalMs: number;
	private readonly pongTimeoutMs: number;
	private readonly canSend: boolean;
	private readonly send: () => void;
	private readonly onTimeout: () => void;
	private lastActivityAt = Number.NEGATIVE_INFINITY;

	constructor(options: HeartbeatMonitorOptions) {
		this.clock = options.clock;
		this.intervalMs = options.intervalMs;
		this.pongTimeoutMs = options.pongTimeoutMs;
		this.canSend = options.canSend;
		this.send = options.send;
		this.onTimeout = options.onTimeout;
	}

	/** Record that an inbound frame arrived — resets the liveness window. Called for ANY server frame. */
	noteActivity(): void {
		this.lastActivityAt = this.clock.now();
	}

	/**
	 * Run the heartbeat loop until `signal` aborts (an epoch teardown) or a timeout fires. Resolves
	 * cleanly on abort. A no-op on a receive-only transport (`canSend === false`) — it never sends.
	 */
	async run(signal: AbortSignal): Promise<void> {
		if (!this.canSend) return;
		try {
			for (;;) {
				await this.clock.sleep(this.intervalMs, signal);
				this.send();
				const sentAt = this.clock.now();
				await this.clock.sleep(this.pongTimeoutMs, signal);
				if (this.lastActivityAt < sentAt) {
					// No inbound frame since the heartbeat went out — the connection is dead.
					this.onTimeout();
					return;
				}
			}
		} catch (err) {
			if (isAbortError(err)) return; // clean epoch teardown
			throw err;
		}
	}
}
