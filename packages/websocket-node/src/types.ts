import type WebSocket from "ws";

/** `ws` WebSocket constructor type — injectable for testing. */
export type WsConstructor = new (
	url: string | URL,
	options?: { headers?: Record<string, string> },
) => WebSocket;

/** Options for creating a {@link WebSocketNodeTransport}. */
export interface WebSocketNodeTransportOptions {
	/** WebSocket server URL (e.g. "wss://example.com/ws"). */
	url: string;
	/**
	 * Initial JWT, appended as `?token=`. When used with `SukkoClient`, the client calls `setToken()`
	 * before each `open()`, overriding this initial value.
	 */
	token?: string;
	/** Initial API key. Sent as the `X-API-Key` header (used only when no JWT is set). */
	apiKey?: string;
	/** Timeout in ms for the initial connection. Default: 10000. */
	connectionTimeout?: number;
	/** Injectable `ws` constructor (for tests). Defaults to the `ws` package's `WebSocket`. */
	WebSocket?: WsConstructor;
}
