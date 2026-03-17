import { TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import type { WebSocketConstructor, WebSocketTransportOptions } from "./types";

const DEFAULT_CONNECTION_TIMEOUT = 10000;

/**
 * WebSocket transport — thin wrapper around the browser/Node WebSocket API.
 *
 * Implements the `Transport` interface from `@sukko/sdk`. Responsible only for:
 * - Opening/closing the WebSocket connection
 * - URL building with token query parameter
 * - Connection timeout
 * - Emitting lifecycle events (open, close, message, error)
 *
 * Reconnection, heartbeat, and subscriptions are managed by `SukkoClient`.
 *
 * Supports reuse: after `close()`, calling `open()` creates a fresh WebSocket.
 *
 * When used with `SukkoClient`, the client calls `setToken()` before each
 * `open()`, overriding the construction-time token.
 *
 * ```ts
 * import { SukkoClient } from "@sukko/sdk";
 * import { WebSocketTransport } from "@sukko/websocket";
 *
 * const client = new SukkoClient({
 *   transport: new WebSocketTransport({ url: "wss://example.com/ws" }),
 *   token: "jwt",
 * });
 * ```
 */
export class WebSocketTransport
	extends TypedEventEmitter<TransportEvents>
	implements Transport
{
	private ws: WebSocket | null = null;
	private token: string;
	private readonly url: string;
	private readonly connectionTimeout: number;
	private readonly WebSocketCtor: WebSocketConstructor | undefined;
	private connectionTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: WebSocketTransportOptions) {
		super();
		this.url = options.url;
		this.token = options.token ?? "";
		this.connectionTimeout = options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
		this.WebSocketCtor = options.WebSocket;
	}

	// ---------------------------------------------------------------------------
	// Transport interface
	// ---------------------------------------------------------------------------

	get state(): TransportState {
		if (!this.ws) return "closed";
		switch (this.ws.readyState) {
			case WebSocket.CONNECTING:
				return "opening";
			case WebSocket.OPEN:
				return "open";
			default:
				return "closed";
		}
	}

	get capabilities(): TransportCapabilities {
		return { canSend: true, canSubscribe: true, canPublish: true };
	}

	setToken(token: string): void {
		this.token = token;
	}

	open(): void {
		this.cleanup();

		let url = this.url;
		if (this.token) {
			const separator = url.includes("?") ? "&" : "?";
			url = `${url}${separator}token=${encodeURIComponent(this.token)}`;
		}

		const WS = this.WebSocketCtor ?? this.resolveWebSocket();
		if (!WS) {
			// SSR or environment without WebSocket — emit error, stay closed
			this.emit("error");
			return;
		}

		try {
			this.ws = new WS(url);
		} catch {
			this.emit("error");
			return;
		}

		this.setupHandlers();

		this.connectionTimer = setTimeout(() => {
			if (this.ws?.readyState === WebSocket.CONNECTING) {
				this.ws.close(4000, "Connection timeout");
			}
		}, this.connectionTimeout);
	}

	close(code?: number, reason?: string): void {
		this.clearConnectionTimer();
		this.cleanup(code, reason);
	}

	send(data: string): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(data);
		}
	}

	// ---------------------------------------------------------------------------
	// Internal
	// ---------------------------------------------------------------------------

	private setupHandlers(): void {
		if (!this.ws) return;

		this.ws.onopen = () => {
			this.clearConnectionTimer();
			this.emit("open");
		};

		this.ws.onclose = (event) => {
			this.clearConnectionTimer();
			this.ws = null;
			this.emit("close", event.code, event.reason || "");
		};

		this.ws.onerror = () => {
			// Error details are intentionally opaque in browsers.
			// The subsequent close event handles reconnection.
			this.emit("error");
		};

		this.ws.onmessage = (event) => {
			this.emit("message", event.data as string);
		};
	}

	private cleanup(code?: number, reason?: string): void {
		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close(code ?? 1000, reason ?? "");
			}
			this.ws = null;
		}
	}

	private clearConnectionTimer(): void {
		if (this.connectionTimer) {
			clearTimeout(this.connectionTimer);
			this.connectionTimer = null;
		}
	}

	private resolveWebSocket(): WebSocketConstructor | null {
		if (typeof WebSocket !== "undefined") return WebSocket;
		return null;
	}
}
