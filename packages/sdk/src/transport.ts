// ---------------------------------------------------------------------------
// Transport abstraction — contract for WebSocket, SSE, Push transports
// ---------------------------------------------------------------------------

/**
 * Transport connection state.
 * - `"closed"` — not connected
 * - `"opening"` — connection in progress
 * - `"open"` — connected and ready to send/receive
 */
export type TransportState = "closed" | "opening" | "open";

/**
 * Declares what the transport supports.
 * WebSocket: all true. SSE: canSend via HTTP fallback. Push: receive-only.
 */
export interface TransportCapabilities {
	canSend: boolean;
	canSubscribe: boolean;
	canPublish: boolean;
}

/** Event map for transport lifecycle events. */
export type TransportEvents = {
	open: () => void;
	close: (code: number, reason: string) => void;
	message: (data: string) => void;
	error: () => void;
};

/**
 * Transport interface — thin wrapper around a raw connection.
 *
 * Reconnection, heartbeat, and subscription tracking live in `SukkoClient`,
 * NOT in the transport. The transport is responsible only for:
 * - Opening/closing the underlying connection
 * - Sending and receiving raw string data
 * - Emitting lifecycle events (open, close, message, error)
 *
 * Transports MUST support reuse: after `close()`, calling `open()` again
 * should create a fresh underlying connection.
 */
export interface Transport {
	/** Open the connection. */
	open(): void;
	/** Close the connection. */
	close(code?: number, reason?: string): void;
	/** Send a raw string message. */
	send(data: string): void;
	/** Update the token used for the next connection. */
	setToken(token: string): void;
	/** Current connection state. */
	readonly state: TransportState;
	/** Declared capabilities of this transport. */
	readonly capabilities: TransportCapabilities;
	/** Register an event listener. Returns an unsubscribe function. */
	on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
	/** Remove a specific event listener. */
	off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
	/** Remove all listeners, optionally for a specific event. */
	removeAllListeners(event?: keyof TransportEvents): void;
}
