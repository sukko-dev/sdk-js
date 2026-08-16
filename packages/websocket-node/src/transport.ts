import { TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import WebSocket from "ws";
import type { WebSocketNodeTransportOptions, WsConstructor } from "./types";

const DEFAULT_CONNECTION_TIMEOUT = 10000;

/**
 * Node WebSocket transport backed by the `ws` library, with **real receive back-pressure**.
 *
 * Unlike the WHATWG `WebSocket` (`@sukko/websocket`), which auto-drains inbound frames and cannot stop
 * reading, `ws` exposes the underlying socket: `pause()`/`resume()` stop and restart reading, which
 * fills the OS receive buffer and shrinks the TCP window — so a slow consumer throttles the **server**
 * over the wire instead of the client buffering unboundedly. The core `SukkoClient` drives these off
 * its delivery-queue high-water mark (gated on `canPauseReceive: true`).
 *
 * Implements the `Transport` interface from `@sukko/sdk`; reconnection, heartbeat, and subscriptions
 * are managed by `SukkoClient`. Supports reuse: after `close()`, `open()` creates a fresh socket.
 *
 * ```ts
 * import { SukkoClient } from "@sukko/sdk";
 * import { WebSocketNodeTransport } from "@sukko/websocket-node";
 *
 * const client = new SukkoClient({
 *   transport: new WebSocketNodeTransport({ url: "wss://example.com/ws" }),
 *   token: "jwt",
 * });
 * ```
 */
export class WebSocketNodeTransport
	extends TypedEventEmitter<TransportEvents>
	implements Transport
{
	private ws: WebSocket | null = null;
	private token: string;
	/** Public so the client can derive the gateway HTTP origin for REST/push (Transport.url). */
	readonly url: string;
	private readonly connectionTimeout: number;
	private readonly WebSocketCtor: WsConstructor;
	private connectionTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: WebSocketNodeTransportOptions) {
		super();
		this.url = options.url;
		this.token = options.token ?? "";
		this.connectionTimeout = options.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
		this.WebSocketCtor = options.WebSocket ?? WebSocket;
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
		// `ws` can pause the underlying socket → real TCP back-pressure. See the class doc.
		return { canSend: true, canSubscribe: true, canPublish: true, canPauseReceive: true };
	}

	setToken(token: string): void {
		this.token = token;
	}

	setChannels(_channels: string[]): void {
		// No-op — WebSocket subscribes in-band via `subscribe` frames (canSubscribe: true).
	}

	pause(): void {
		// Stop reading → the OS receive buffer fills → the TCP window shrinks → the server is throttled.
		this.ws?.pause();
	}

	resume(): void {
		this.ws?.resume();
	}

	open(): void {
		this.cleanup();

		let url = this.url;
		if (this.token) {
			const separator = url.includes("?") ? "&" : "?";
			url = `${url}${separator}token=${encodeURIComponent(this.token)}`;
		}

		try {
			this.ws = new this.WebSocketCtor(url);
		} catch {
			this.emit("error");
			return;
		}

		this.setupHandlers();

		this.connectionTimer = setTimeout(() => {
			if (this.ws?.readyState === WebSocket.CONNECTING) {
				this.ws.terminate(); // hard close a stalled handshake
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

		this.ws.on("open", () => {
			this.clearConnectionTimer();
			this.emit("open");
		});

		this.ws.on("close", (code: number, reason: Buffer) => {
			this.clearConnectionTimer();
			this.ws = null;
			this.emit("close", code, reason.toString());
		});

		this.ws.on("error", () => {
			this.emit("error");
		});

		this.ws.on("message", (data: WebSocket.RawData) => {
			// The protocol is text JSON — decode the frame to a string.
			this.emit("message", data.toString());
		});
	}

	private cleanup(code?: number, reason?: string): void {
		if (this.ws) {
			this.ws.removeAllListeners();
			if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
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
}
