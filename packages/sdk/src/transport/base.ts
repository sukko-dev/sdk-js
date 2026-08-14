// ---------------------------------------------------------------------------
// Transport abstraction — the contract every connection adapter implements.
// Reconnection, heartbeat, recovery, auth, and subscription tracking live in
// `SukkoClient`, NOT here. A transport only opens/closes a connection, sends and
// receives raw strings, emits lifecycle events, and declares its capabilities.
// ---------------------------------------------------------------------------

/**
 * Transport connection state.
 * - `"closed"` — not connected
 * - `"opening"` — connection in progress
 * - `"open"` — connected and ready to send/receive
 */
export type TransportState = "closed" | "opening" | "open";

/**
 * What the transport supports. Drives the client's behaviour explicitly (§XV — no runtime sniffing):
 * - `canSend` — has a client→server channel (WS yes; SSE no — publish/subscribe go via REST/reconnect).
 * - `canSubscribe`/`canPublish` — in-band subscribe/publish over this transport.
 * - `canPauseReceive` — the transport can apply real receive back-pressure via `pause()`/`resume()`.
 *   WHATWG `WebSocket` (browser + Node global) auto-drains → `false`; a `ws`-npm Node transport →
 *   `true`. When `false`, the delivery queue applies its overflow policy instead (FR-003).
 */
export interface TransportCapabilities {
	canSend: boolean;
	canSubscribe: boolean;
	canPublish: boolean;
	canPauseReceive: boolean;
}

/** Event map for transport lifecycle events. */
export type TransportEvents = {
	open: () => void;
	close: (code: number, reason: string) => void;
	message: (data: string) => void;
	error: () => void;
};

/**
 * Transport interface — a thin wrapper around a raw connection. Transports MUST support reuse: after
 * `close()`, calling `open()` again creates a fresh underlying connection.
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
	/**
	 * Set the channel set applied at the next `open()`. The mirror of `setToken()` for transports whose
	 * subscriptions are connect-time (`canSubscribe: false` — SSE bakes them into the request URL). A
	 * no-op on transports that subscribe in-band (`canSubscribe: true` — WebSocket sends `subscribe`
	 * frames), which the client drives instead. The client calls this before (re)opening a receive-only
	 * transport so a reconnect resumes the current desired set.
	 */
	setChannels(channels: string[]): void;
	/**
	 * Pause receiving (real back-pressure). No-op on transports where `canPauseReceive` is `false`.
	 * The client calls this when the delivery queue fills.
	 */
	pause(): void;
	/** Resume receiving after a `pause()`. No-op when `canPauseReceive` is `false`. */
	resume(): void;
	/** Current connection state. */
	readonly state: TransportState;
	/** Declared capabilities of this transport. */
	readonly capabilities: TransportCapabilities;
	/** The connection URL, when the transport has one — lets the client derive the gateway HTTP origin
	 * for REST/push (`httpBaseFromWs`) without a separate `baseUrl` option. Optional: a transport need
	 * not expose it. */
	readonly url?: string;
	/** Register an event listener. Returns an unsubscribe function. */
	on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
	/** Remove a specific event listener. */
	off<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;
	/** Remove all listeners, optionally for a specific event. */
	removeAllListeners(event?: keyof TransportEvents): void;
}
