import { DeliveryQueue } from "./backpressure";
import {
	CLIENT_ID_KEY,
	CLOSE_CODES,
	type CloseDirection,
	SUKKO_DEFAULTS,
	isForceDisconnect,
	isHeartbeatTimeout,
} from "./constants";
import { TypedEventEmitter } from "./emitter";
import type { DeliveryItem, Message } from "./messages";
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

type ResolvedOptions = Required<Omit<SukkoClientOptions, "transport" | "token" | "getToken">> & {
	token: string;
	getToken: SukkoClientOptions["getToken"];
};

/**
 * Sukko real-time client.
 *
 * Framework-agnostic, transport-agnostic client: subscribe, unsubscribe, publish, heartbeat,
 * reconnection (re-subscribes on reconnect), a back-pressured `messages()` delivery stream, and
 * manual token refresh. NOTE: automatic reconnect currently re-subscribes only — gap replay is a
 * manual `reconnectWithReplay()` call, not yet wired into auto-reconnect (§I Known Gap; the recovery
 * engine + supervisor land in the T026 rewrite).
 *
 * The transport layer (WebSocket, SSE, Web Push, etc.) is injected via the `transport`
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

	// The close code the CLIENT last initiated (e.g. a heartbeat-timeout 4000), so a close event can
	// be attributed local vs remote — 4000 means heartbeat-timeout (local, reconnect) or
	// force_disconnect (remote, terminal) depending on direction (FR-019).
	private localCloseCode: number | null = null;

	// Subscriptions
	private _subscriptions = new Set<string>();

	// Delivery — a client-lifetime bounded queue drained by `messages()`; the event-emitter is the
	// non-back-pressured pre-queue tap (§ plan: forced dual delivery surface).
	private readonly deliveryQueue: DeliveryQueue;
	private queueConsumer = false;
	private transportPaused = false;

	// Replay state
	private clientId: string;
	private lastPos = new Map<string, string>();
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
			reconnectAttempts: options.reconnectAttempts ?? SUKKO_DEFAULTS.reconnectMaxAttempts,
			reconnectDelayBase: options.reconnectDelayBase ?? SUKKO_DEFAULTS.backoffBaseMs,
			reconnectDelayMax: options.reconnectDelayMax ?? SUKKO_DEFAULTS.backoffMaxMs,
			heartbeatInterval: options.heartbeatInterval ?? SUKKO_DEFAULTS.heartbeatIntervalMs,
			heartbeatTimeout: options.heartbeatTimeout ?? SUKKO_DEFAULTS.pongTimeoutMs,
			staleConnectionThreshold:
				options.staleConnectionThreshold ?? SUKKO_DEFAULTS.staleConnectionThresholdMs,
			autoConnect: options.autoConnect ?? true,
			getToken: options.getToken,
		};

		this.deliveryQueue = new DeliveryQueue({
			maxsize: SUKKO_DEFAULTS.bufferSize,
			policy: SUKKO_DEFAULTS.overflowPolicy,
			floor: SUKKO_DEFAULTS.historyLimit + SUKKO_DEFAULTS.maxReplayMessages,
		});

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

	/**
	 * Async iterator over the delivery stream — live and replayed messages, gap signals, and overflow
	 * markers (`DeliveryItem`). This is the **authoritative, back-pressured** surface: on a capable
	 * transport, a slow consumer here pauses receiving; on an incapable transport the queue applies its
	 * overflow policy. **Single-consumer** — do not iterate concurrently. The stream ends when the
	 * client disconnects. The `.on("message", …)` event surface remains as a non-back-pressured tap.
	 */
	async *messages(): AsyncGenerator<DeliveryItem> {
		// Reject a second concurrent iterator BEFORE claiming ownership — otherwise its teardown would
		// clear the first (legitimate) consumer's back-pressure flag, silently disabling pause/resume.
		if (this.queueConsumer) {
			throw new Error("messages() is single-consumer — only one iterator may be active at a time");
		}
		this.queueConsumer = true;
		try {
			for (;;) {
				const result = await this.deliveryQueue.next();
				if (result.done) return;
				// Resume a paused capable transport as soon as the consumer has drained below capacity.
				if (this.transportPaused && !this.deliveryQueue.isFull) {
					this.transport.resume();
					this.transportPaused = false;
				}
				yield result.value;
			}
		} finally {
			this.queueConsumer = false;
			if (this.transportPaused) {
				this.transport.resume();
				this.transportPaused = false;
			}
		}
	}

	/**
	 * Push a delivery item onto the queue and, when an active `messages()` consumer is present on a
	 * capable transport, pause receiving once the buffer is full (real back-pressure). With no active
	 * iterator consumer the queue simply applies its overflow policy — the emitter tap is never stalled.
	 */
	private enqueue(item: DeliveryItem): void {
		this.deliveryQueue.push(item);
		if (
			this.queueConsumer &&
			this.transport.capabilities.canPauseReceive &&
			this.deliveryQueue.isFull &&
			!this.transportPaused
		) {
			this.transport.pause();
			this.transportPaused = true;
		}
	}

	/** Connect to the server via the transport. */
	connect(): void {
		if (this.transport.state === "opening" || this.transport.state === "open") return;

		// Reset the close-direction latch at the epoch boundary so a heartbeat-timeout 4000 set in a
		// prior epoch (but never consumed by handleTransportClose, e.g. after disconnect()) can't
		// mis-attribute a later REMOTE force_disconnect 4000 as local (FR-019 safety).
		this.localCloseCode = null;
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

		// Release any parked messages() consumer — client-lifetime queue ends on disconnect (§XI teardown).
		// NOTE: the queue is not revived by a later connect() in this phase; the full connect/disconnect/
		// close vs reconnect-epoch lifecycle (queue survival across epochs) is defined by the T026
		// supervisor rewrite. Automatic reconnect (handleTransportClose) deliberately does NOT close it.
		this.deliveryQueue.close();
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
		for (const ch of channels) {
			this._subscriptions.delete(ch);
			this.lastPos.delete(ch);
		}

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

	/** Send a reconnect-with-replay request using last-known pos values per channel. */
	reconnectWithReplay(): void {
		if (this.transport.state !== "open") return;
		if (this.lastPos.size === 0) return;

		const lastPos: Record<string, string> = {};
		this.lastPos.forEach((pos, channel) => {
			lastPos[channel] = pos;
		});

		this.send({
			type: "reconnect",
			data: { client_id: this.clientId, last_pos: lastPos },
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

		// Attribute the close: a 4000 the client itself initiated (heartbeat timeout) is `local`;
		// otherwise it is `remote` (an operator force_disconnect).
		const localCode = this.localCloseCode;
		this.localCloseCode = null;
		const direction: CloseDirection = localCode === code ? "local" : "remote";

		// Per-close-code reconnect policy (FR-019).
		if (isHeartbeatTimeout(code, direction)) {
			// Local 4000 — our own heartbeat timeout fired; the connection is dead → reconnect.
			this.handleReconnect();
			return;
		}
		if (
			isForceDisconnect(code, direction) || // remote 4000 operator force-disconnect — terminal
			code === CLOSE_CODES.NORMAL || // 1000 clean shutdown
			code === CLOSE_CODES.POLICY_VIOLATION // 1008 policy violation — not transient
		) {
			// TODO(T026): 1008 and remote-4000 should also surface a TYPED error on the error channel
			// (FR-019 / Scenario 6 AC2). Deferred to the supervisor rewrite that builds that channel —
			// until then the terminal cause is observable via the `close` event's code (emitted above).
			this.setState("disconnected");
			return;
		}
		// 1001 going-away, 1011 internal-error, 1006/abnormal, unknown → transient, reconnect with backoff.
		this.handleReconnect();
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
					if (msg.pos) {
						this.lastPos.set(msg.channel, msg.pos);
					}
					this.emit("message", msg); // pre-queue tap (multicast, non-back-pressured)
					this.enqueue(raw as unknown as Message); // authoritative delivery stream
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
				default:
					// Unknown/future message type — drop and continue for forward-compatibility (FR-025);
					// never kill the read-pump.
					break;
			}
		} catch {
			// Malformed (non-JSON) frame — drop and continue; the read-pump must survive it (FR-025).
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Reconnection
	// ---------------------------------------------------------------------------

	private handleReconnect(): void {
		if (!this.options.reconnect) {
			this.setState("disconnected");
			return;
		}

		// `reconnectAttempts === 0` means unlimited; otherwise, once attempts are exhausted the client
		// gives up and enters the terminal `error` state — no indefinite retry (FR-018/FR-026).
		const unlimited = this.options.reconnectAttempts === 0;
		if (!unlimited && this.reconnectAttempt >= this.options.reconnectAttempts) {
			this.setState("error");
			return;
		}

		this.setState("reconnecting");
		this.reconnectAttempt++;

		// Full Jitter (AWS): delay = random(0, min(cap, base * 2^(attempt-1))). Jitter is the whole
		// point — pure exponential without it causes lock-step reconnect storms.
		const ceiling = Math.min(
			this.options.reconnectDelayMax,
			this.options.reconnectDelayBase * 2 ** (this.reconnectAttempt - 1),
		);
		const delay = Math.random() * ceiling;

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
					this.localCloseCode = CLOSE_CODES.HEARTBEAT_TIMEOUT; // local 4000 → reconnect (FR-019)
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
