/** WebSocket constructor type for dependency injection. */
export type WebSocketConstructor = new (
	url: string | URL,
	protocols?: string | string[],
) => WebSocket;

/** Options for creating a WebSocketTransport. */
export interface WebSocketTransportOptions {
	/** WebSocket server URL (e.g., "wss://example.com/ws"). */
	url: string;
	/**
	 * Initial JWT token. Appended as `?token=` query parameter.
	 *
	 * When used with `SukkoClient`, the client calls `setToken()` before
	 * each `open()`, overriding this initial value.
	 */
	token?: string;
	/** Initial API key. Appended as `?api_key=` (used only when no JWT is set; browsers cannot set
	 * WebSocket headers, so the API key travels as a query param — the gateway accepts both forms). */
	apiKey?: string;
	/** Timeout in ms for initial connection. Default: 10000. */
	connectionTimeout?: number;
	/** Injectable WebSocket constructor for testing or SSR environments. */
	WebSocket?: WebSocketConstructor;
}
