import { CLIENT_ID_KEY, CLOSE_CODES, SUKKO_DEFAULTS } from "./constants";
import { TypedEventEmitter } from "./emitter";
import type { Transport } from "./transport";
import type {
	AuthAckMessage,
	AuthErrorMessage,
	ClientMessage,
	ConnectionState,
	DataMessage,
	ErrorMessage,
	PongMessage,
	PublishAckMessage,
	PublishErrorMessage,
	ReconnectAckMessage,
	ReconnectErrorMessage,
	SubscribeErrorMessage,
	SubscriptionAckMessage,
	SukkoClientEvents,
	SukkoClientOptions,
	UnsubscribeErrorMessage,
	UnsubscriptionAckMessage,
} from "./types";

type ResolvedOptions = Required<
	Omit<SukkoClientOptions, "transport" | "token" | "getToken">
> & {
	token: string;
	getToken: SukkoClientOptions["getToken"];
};

/**
 * Sukko real-time client.
 *
 * Framework-agnostic, transport-agnostic client implementing the full Sukko
 * protocol: subscribe, unsubscribe, publish, heartbeat, reconnection with
 * replay, and mid-connection auth refresh.
 *
 * The transport layer (WebSocket, SSE, etc.) is injected via the `transport`
 * option, keeping this client decoupled from any specific transport.
 *
 * ```ts
 * import { SukkoClient } from "@sukko/sdk";
 * import { WebSocketTransport } from "@sukko/websocket";
 *
 * const client = new SukkoClient({
 *   transport: new WebSocketTransport({ url: "wss://example.com/ws" }),
 *   token: "jwt",
 * });
 * client.on("message", (msg) => console.log(msg.channel, msg.data));
 * client.subscribe(["tenant.BTC.trade"]);
 * ```
 */
export class SukkoClient extends TypedEventEmitter<SukkoClientEvents> {
	// Singleton
	private static instance: SukkoClient | null = null;

	// Connection
	private transport: Transport;
	private options: ResolvedOptions;
	private _state: ConnectionState = "disconnected";

	// Transport listener cleanup
	private transportCleanup: (() => void) | null = null;

	// Reconnection
	private reconnectAttempt = 0;

	// Subscriptions
	private _subscriptions = new Set<string>();

	// Replay state
	private clientId: string;
	private lastOffsets = new Map<string, number>();
	private lastActivityTimestamp: number = Date.now();

	// Timers
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private pongTimeout: ReturnType<typeof setTimeout> | null = null;

	// Network listeners
	private boundHandleOnline: (() => void) | null = null;
	private boundHandleVisibilityChange: (() => void) | null = null;

	constructor(options: SukkoClientOptions) {
		super();

		this.transport = options.transport;
		this.options = {
			token: options.token ?? "",
			reconnect: options.reconnect ?? true,
			reconnectAttempts: options.reconnectAttempts ?? SUKKO_DEFAULTS.RECONNECT_ATTEMPTS,
			reconnectDelayBase: options.reconnectDelayBase ?? SUKKO_DEFAULTS.RECONNECT_DELAY_BASE,
			reconnectDelayMax: options.reconnectDelayMax ?? SUKKO_DEFAULTS.RECONNECT_DELAY_MAX,
			heartbeatInterval: options.heartbeatInterval ?? SUKKO_DEFAULTS.HEARTBEAT_INTERVAL,
			heartbeatTimeout: options.heartbeatTimeout ?? SUKKO_DEFAULTS.HEARTBEAT_TIMEOUT,
			staleConnectionThreshold:
				options.staleConnectionThreshold ?? SUKKO_DEFAULTS.STALE_CONNECTION_THRESHOLD,
			autoConnect: options.autoConnect ?? true,
			getToken: options.getToken,
		};

		this.clientId = this.loadOrCreateClientId();
		this.setupTransportListeners();
		this.setupNetworkListeners();

		if (this.options.autoConnect) {
			this.connect();
		}
	}

	// ---------------------------------------------------------------------------
	// Singleton convenience
	// ---------------------------------------------------------------------------

	/** Get or create a singleton instance. */
	static getInstance(options?: SukkoClientOptions): SukkoClient {
		if (!SukkoClient.instance) {
			if (!options) {
				throw new Error("SukkoClient.getInstance() requires options for first initialization");
			}
			SukkoClient.instance = new SukkoClient({ ...options, autoConnect: false });
		}
		return SukkoClient.instance;
	}

	/** Disconnect and destroy the singleton instance. */
	static resetInstance(): void {
		if (SukkoClient.instance) {
			SukkoClient.instance.disconnect();
			SukkoClient.instance.removeNetworkListeners();
			SukkoClient.instance.removeAllListeners();
			SukkoClient.instance = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Public API — Connection
	// ---------------------------------------------------------------------------

	/** Current connection state. */
	get state(): ConnectionState {
		return this._state;
	}

	/** Active channel subscriptions. */
	get subscriptions(): ReadonlySet<string> {
		return this._subscriptions;
	}

	/** Connect to the server via the transport. */
	connect(): void {
		if (this.transport.state === "opening" || this.transport.state === "open") return;

		this.setState("connecting");
		this.clearTimers();
		this.transport.setToken(this.options.token);
		this.transport.open();
	}

	/** Disconnect intentionally (no automatic reconnection). */
	disconnect(): void {
		this.clearTimers();

		// Remove transport close listener before closing to prevent
		// duplicate state/event emission from the close handler.
		this.removeTransportListeners();
		this.transport.close(CLOSE_CODES.NORMAL, "Client disconnect");
		this.setupTransportListeners();

		this.setState("disconnected");
		this.emit("close", CLOSE_CODES.NORMAL, "Client disconnect");
	}

	// ---------------------------------------------------------------------------
	// Public API — Subscriptions
	// ---------------------------------------------------------------------------

	/** Subscribe to one or more channels. */
	subscribe(channels: string[]): void {
		for (const ch of channels) this._subscriptions.add(ch);

		if (this.transport.state === "open") {
			this.send({ type: "subscribe", data: { channels } });
		}
	}

	/** Unsubscribe from one or more channels. */
	unsubscribe(channels: string[]): void {
		for (const ch of channels) this._subscriptions.delete(ch);

		if (this.transport.state === "open") {
			this.send({ type: "unsubscribe", data: { channels } });
		}
	}

	// ---------------------------------------------------------------------------
	// Public API — Publishing
	// ---------------------------------------------------------------------------

	/** Publish a message to a channel. */
	publish(channel: string, data: unknown): void {
		if (this.transport.state === "open") {
			this.send({ type: "publish", data: { channel, data } });
		}
	}

	// ---------------------------------------------------------------------------
	// Public API — Token
	// ---------------------------------------------------------------------------

	/** Update the stored token (used for future connections). */
	updateToken(token: string): void {
		this.options.token = token;
	}

	/**
	 * Refresh the token mid-connection.
	 * Calls the `getToken` callback, updates the stored token,
	 * and sends an `auth` message to the server.
	 */
	async refreshToken(): Promise<void> {
		if (!this.options.getToken) {
			throw new Error("Cannot refresh token: no getToken callback configured");
		}

		const token = await this.options.getToken();
		this.options.token = token;

		if (this.transport.state === "open") {
			this.send({ type: "auth", data: { token } });
		}
	}

	// ---------------------------------------------------------------------------
	// Public API — Replay
	// ---------------------------------------------------------------------------

	/** Send a reconnect-with-replay request using stored offsets. */
	reconnectWithReplay(): void {
		if (this.transport.state !== "open") return;

		const lastOffset: Record<string, number> = {};
		this.lastOffsets.forEach((offset, topic) => {
			lastOffset[topic] = offset;
		});

		this.send({
			type: "reconnect",
			data: { client_id: this.clientId, last_offset: lastOffset },
		});
	}

	/** Reset the reconnect attempt counter. */
	resetReconnectAttempts(): void {
		this.reconnectAttempt = 0;
	}

	// ---------------------------------------------------------------------------
	// Internal — Transport listeners
	// ---------------------------------------------------------------------------

	private setupTransportListeners(): void {
		const offOpen = this.transport.on("open", () => this.handleTransportOpen());
		const offClose = this.transport.on("close", (code, reason) =>
			this.handleTransportClose(code, reason),
		);
		const offMessage = this.transport.on("message", (data) => this.handleMessage(data));
		const offError = this.transport.on("error", () => this.handleTransportError());

		this.transportCleanup = () => {
			offOpen();
			offClose();
			offMessage();
			offError();
		};
	}

	private removeTransportListeners(): void {
		if (this.transportCleanup) {
			this.transportCleanup();
			this.transportCleanup = null;
		}
	}

	private handleTransportOpen(): void {
		this.setState("connected");
		this.reconnectAttempt = 0;
		this.lastActivityTimestamp = Date.now();
		this.startHeartbeat();

		// Restore subscriptions
		if (this._subscriptions.size > 0) {
			this.send({
				type: "subscribe",
				data: { channels: Array.from(this._subscriptions) },
			});
		}
	}

	private handleTransportClose(code: number, reason: string): void {
		this.stopHeartbeat();
		this.emit("close", code, reason);

		switch (code) {
			case CLOSE_CODES.NORMAL:
			case CLOSE_CODES.GOING_AWAY:
				this.setState("disconnected");
				return;
			default:
				if (this.options.reconnect) {
					this.handleReconnect();
				} else {
					this.setState("disconnected");
				}
		}
	}

	private handleTransportError(): void {
		// Error details are intentionally opaque in browsers.
		// The subsequent close event will trigger reconnection.
	}

	// ---------------------------------------------------------------------------
	// Internal — Message handling
	// ---------------------------------------------------------------------------

	private send(message: ClientMessage): void {
		if (this.transport.state === "open") {
			this.transport.send(JSON.stringify(message));
		}
	}

	private setState(state: ConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this.emit("stateChange", state);
		}
	}

	private forceReconnect(): void {
		this.clearTimers();
		this.resetReconnectAttempts();
		this.transport.close();
		this.connect();
	}

	private handleMessage(data: string): void {
		this.lastActivityTimestamp = Date.now();

		// Any message from server clears pong timeout
		if (this.pongTimeout) {
			clearTimeout(this.pongTimeout);
			this.pongTimeout = null;
		}

		try {
			const raw = JSON.parse(data) as { type: string };

			switch (raw.type) {
				case "message": {
					const msg = raw as unknown as DataMessage;
					this.lastOffsets.set(msg.channel, msg.seq);
					this.emit("message", msg);
					break;
				}
				case "subscription_ack":
					this.emit("subscriptionAck", raw as unknown as SubscriptionAckMessage);
					break;
				case "unsubscription_ack":
					this.emit("unsubscriptionAck", raw as unknown as UnsubscriptionAckMessage);
					break;
				case "publish_ack":
					this.emit("publishAck", raw as unknown as PublishAckMessage);
					break;
				case "publish_error":
					this.emit("publishError", raw as unknown as PublishErrorMessage);
					break;
				case "reconnect_ack":
					this.emit("reconnectAck", raw as unknown as ReconnectAckMessage);
					break;
				case "reconnect_error":
					this.emit("reconnectError", raw as unknown as ReconnectErrorMessage);
					break;
				case "pong":
					this.emit("pong", raw as unknown as PongMessage);
					break;
				case "error":
					this.emit("error", raw as unknown as ErrorMessage);
					break;
				case "subscribe_error":
					this.emit("subscribeError", raw as unknown as SubscribeErrorMessage);
					break;
				case "unsubscribe_error":
					this.emit("unsubscribeError", raw as unknown as UnsubscribeErrorMessage);
					break;
				case "auth_ack":
					this.emit("authAck", raw as unknown as AuthAckMessage);
					break;
				case "auth_error":
					this.emit("authError", raw as unknown as AuthErrorMessage);
					break;
			}
		} catch {
			// Silently ignore unparseable messages
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Reconnection
	// ---------------------------------------------------------------------------

	private handleReconnect(): void {
		if (!this.options.reconnect) return;

		if (this.reconnectAttempt >= this.options.reconnectAttempts) {
			// Phase 2: indefinite retry at max delay
			this.setState("error");
			this.emit("reconnecting", this.reconnectAttempt);

			const delay = this.options.reconnectDelayMax + Math.random() * 1000;
			this.reconnectTimer = setTimeout(() => this.connect(), delay);
			return;
		}

		// Phase 1: exponential backoff with jitter
		this.setState("reconnecting");
		this.reconnectAttempt++;

		const delay = Math.min(
			this.options.reconnectDelayBase * 2 ** (this.reconnectAttempt - 1) + Math.random() * 1000,
			this.options.reconnectDelayMax,
		);

		this.emit("reconnecting", this.reconnectAttempt);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	// ---------------------------------------------------------------------------
	// Internal — Heartbeat
	// ---------------------------------------------------------------------------

	private startHeartbeat(): void {
		this.stopHeartbeat();

		this.heartbeatTimer = setInterval(() => {
			if (this.transport.state === "open") {
				this.send({ type: "heartbeat", data: {} as Record<string, never> });

				this.pongTimeout = setTimeout(() => {
					this.transport.close(CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
				}, this.options.heartbeatTimeout);
			}
		}, this.options.heartbeatInterval);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.pongTimeout) {
			clearTimeout(this.pongTimeout);
			this.pongTimeout = null;
		}
	}

	private clearTimers(): void {
		this.stopHeartbeat();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Network event handlers (SSR-safe)
	// ---------------------------------------------------------------------------

	private setupNetworkListeners(): void {
		if (typeof window === "undefined") return;

		this.boundHandleOnline = () => {
			if (this._state === "error" || this._state === "disconnected") {
				this.forceReconnect();
			}
		};

		this.boundHandleVisibilityChange = () => {
			if (typeof document === "undefined") return;

			if (document.visibilityState === "visible") {
				const timeSinceActivity = Date.now() - this.lastActivityTimestamp;

				if (timeSinceActivity > this.options.staleConnectionThreshold) {
					this.forceReconnect();
				} else if (this._state !== "connected") {
					this.forceReconnect();
				}
			}
		};

		window.addEventListener("online", this.boundHandleOnline);
		document.addEventListener("visibilitychange", this.boundHandleVisibilityChange);
	}

	private removeNetworkListeners(): void {
		if (typeof window === "undefined") return;

		if (this.boundHandleOnline) {
			window.removeEventListener("online", this.boundHandleOnline);
		}
		if (this.boundHandleVisibilityChange && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this.boundHandleVisibilityChange);
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Utilities
	// ---------------------------------------------------------------------------

	private loadOrCreateClientId(): string {
		if (typeof window === "undefined" || typeof localStorage === "undefined") {
			return this.generateId();
		}

		try {
			const stored = localStorage.getItem(CLIENT_ID_KEY);
			if (stored) return stored;

			const id = this.generateId();
			localStorage.setItem(CLIENT_ID_KEY, id);
			return id;
		} catch {
			// localStorage may throw in private browsing or when full
			return this.generateId();
		}
	}

	private generateId(): string {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
			return crypto.randomUUID();
		}
		// Fallback for environments without crypto.randomUUID
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
}
