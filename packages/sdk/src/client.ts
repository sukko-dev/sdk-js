import { type Clock, SystemClock } from "./_clock";
import { DeliveryQueue } from "./backpressure";
import { CLIENT_ID_KEY, CLOSE_CODES, SUKKO_DEFAULTS } from "./constants";
import { TypedEventEmitter } from "./emitter";
import { REPLAY_ERROR_CODES, RecoveryInterruptedError } from "./errors";
import { HeartbeatMonitor } from "./heartbeat";
import type {
	DeliveryItem,
	Gap,
	Message,
	ReplayComplete,
	ReplayMessage,
	ReplayRequestMessage,
	ErrorMessage as WireErrorMessage,
} from "./messages";
import { type RecoveryAction, RecoveryEngine } from "./recovery";
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
	Omit<SukkoClientOptions, "transport" | "token" | "getToken" | "clock">
> & {
	token: string;
	getToken: SukkoClientOptions["getToken"];
};

/**
 * Sukko real-time client.
 *
 * Framework-agnostic, transport-agnostic client: subscribe, unsubscribe, publish, heartbeat,
 * reconnection, gap recovery, a back-pressured `messages()` delivery stream, and manual token refresh.
 * On reconnect the client resumes from the last-seen opaque `pos` (reconnect-replay) or, on the Direct
 * backend, degrades to resubscribe + a synthetic `PossibleGap`; live gaps drive an automatic per-channel
 * replay. Recovery is owned by the RecoveryEngine and driven by a per-epoch clock-based timer.
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

	// Subscriptions
	private _subscriptions = new Set<string>();

	// Delivery — a client-lifetime bounded queue drained by `messages()`; the event-emitter is the
	// non-back-pressured pre-queue tap (§ plan: forced dual delivery surface).
	private readonly deliveryQueue: DeliveryQueue;
	private queueConsumer = false;
	private transportPaused = false;

	// Recovery — the RecoveryEngine is the single owner of `client_id` and per-channel opaque `pos`,
	// plus the reconnect-replay / live-replay / Direct-degrade FSM. The client routes wire frames into
	// it and executes the canonical actions it returns (§XV single source of truth).
	private readonly recovery: RecoveryEngine;
	private lastActivityTimestamp: number = Date.now();

	// Condvar for the per-epoch recovery timer: aborting `recoveryWake` wakes the timer to recompute
	// its next deadline after the engine's state changes (a gap arrives, a replay completes). Swapped
	// for a fresh controller on each wake so a later wake can abort again.
	private recoveryWake = new AbortController();

	// Timing seam (NFR-006) — injectable via options; defaults to SystemClock (its setTimeout/Date.now
	// stay vi-fake-timer compatible). ALL timing (heartbeat, reconnect backoff+jitter) routes through it.
	private readonly clock: Clock;

	// Per-connection epoch: an AbortController scoping the heartbeat loop; aborted on close/reconnect
	// (the TaskGroup analog).
	private epoch: AbortController | null = null;
	private heartbeat: HeartbeatMonitor | null = null;

	// Client-lifetime signal for the reconnect-backoff sleep; aborted by disconnect() to cancel a
	// pending reconnect, re-created on a fresh connect() after a disconnect.
	private shutdown = new AbortController();

	// Network listeners
	private boundHandleOnline: (() => void) | null = null;
	private boundHandleVisibilityChange: (() => void) | null = null;

	constructor(options: SukkoClientOptions) {
		super();

		this.transport = options.transport;
		this.clock = options.clock ?? new SystemClock();
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

		const clientId = this.loadOrCreateClientId();
		this.recovery = new RecoveryEngine({ clientId, clock: this.clock });
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

		this.setState("connecting");
		// Cancel any pending reconnect backoff and open a fresh cancellation scope for this connection —
		// any "start a connection" path (connect / forceReconnect / a reconnect firing) supersedes an
		// in-flight backoff, so no orphaned sleeper survives (§XI deterministic teardown).
		this.shutdown.abort();
		this.shutdown = new AbortController();
		this.teardownEpoch(); // abort any stale epoch before opening a fresh one
		this.epoch = new AbortController();
		this.transport.setToken(this.options.token);
		this.transport.open();
	}

	/** Disconnect intentionally (no automatic reconnection). */
	disconnect(): void {
		this.shutdown.abort(); // cancel any pending reconnect backoff
		this.onConnectionLost();
		this.teardownEpoch();

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
			this.recovery.forget(ch);
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

	/**
	 * Manually re-issue the reconnect-replay on the current connection: resume from stored `pos` (Kafka),
	 * or — once the client has connected at least once with no `pos` — probe with an empty `last_pos` to
	 * elicit a Direct-backend `not_available` (FR-007). A no-op while disconnected or on a fresh session
	 * with nothing to resume. Superseded by the automatic reconnect-replay in `handleTransportOpen`;
	 * removed from the public surface by T033.
	 */
	reconnectWithReplay(): void {
		if (this.transport.state !== "open") return;
		const reconnect = this.recovery.buildReconnect();
		if (reconnect) this.applyRecoveryActions([reconnect]);
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
		this.startRecoveryTimer();

		// Reconnect-with-replay (resume from stored pos on Kafka) or the Direct-probe — but only from the
		// SECOND connection onward. `buildReconnect()` reads `connectedOnce` BEFORE `markConnected()`
		// arms it, so the genuine first open sends no `reconnect` frame (a probe against a server with no
		// session would falsely elicit `not_available` and wrongly degrade a Kafka client to Direct).
		const reconnect = this.recovery.buildReconnect();
		this.recovery.markConnected();
		if (reconnect) this.applyRecoveryActions([reconnect]);

		// Restore subscriptions (live flow resumes independently of the pos-replay above).
		if (this._subscriptions.size > 0) {
			this.send({
				type: "subscribe",
				data: { channels: Array.from(this._subscriptions) },
			});
		}
	}

	/**
	 * Handles a SERVER or network-initiated close. Client-initiated closes (disconnect, forceReconnect,
	 * heartbeat timeout) do NOT reach here — the transport suppresses their close echo — so a 4000 seen
	 * here is always an operator `force_disconnect` (remote), never a local heartbeat timeout.
	 */
	private handleTransportClose(code: number, reason: string): void {
		this.onConnectionLost();
		this.teardownEpoch();
		this.emit("close", code, reason);

		// Per-close-code reconnect policy (FR-019).
		if (
			code === CLOSE_CODES.NORMAL || // 1000 clean shutdown
			code === CLOSE_CODES.POLICY_VIOLATION || // 1008 policy violation — not transient
			code === CLOSE_CODES.FORCE_DISCONNECT // 4000 operator force-disconnect — terminal
		) {
			// TODO(T026): 1008 and force_disconnect should also surface a TYPED error on the error channel
			// (FR-019 / Scenario 6 AC2). Deferred to the supervisor rewrite that builds that channel —
			// until then the terminal cause is observable via the `close` event's code (emitted above).
			this.setState("disconnected");
			return;
		}
		// 1001 going-away, 1011 internal-error, 1006/abnormal, unknown → transient, reconnect with backoff.
		void this.handleReconnect();
	}

	private handleTransportError(): void {
		// Error details are intentionally opaque in browsers.
		// The subsequent close event will trigger reconnection.
	}

	// ---------------------------------------------------------------------------
	// Internal — Message handling
	// ---------------------------------------------------------------------------

	private send(message: ClientMessage | ReplayRequestMessage): void {
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
		this.resetReconnectAttempts();
		this.onConnectionLost(); // the transport closes with no echo here — flush recovery state directly
		this.transport.close();
		this.connect(); // teardownEpoch + fresh epoch handled inside connect()
	}

	private handleMessage(data: string): void {
		this.lastActivityTimestamp = Date.now();

		// Any inbound frame confirms liveness for the heartbeat monitor.
		this.heartbeat?.noteActivity();

		try {
			const raw = JSON.parse(data) as { type: string };

			switch (raw.type) {
				case "message": {
					const msg = raw as unknown as DataMessage;
					this.recovery.notePos(msg.channel, msg.pos); // anchor for the next reconnect-replay
					this.emit("message", msg); // pre-queue tap (multicast, non-back-pressured)
					this.enqueue(raw as unknown as Message); // authoritative delivery stream
					break;
				}
				case "gap": {
					// A live gap. Surface the loss signal to the consumer FIRST, then let the engine decide
					// whether/when to replay (immediate, floor-wait, or ignored once Direct).
					const gap = raw as unknown as Gap;
					// `channel` and `last_pos` are both contract-required and both drive an outbound `replay`
					// frame — a gap missing either would anchor a replay from `undefined` and emit a malformed
					// frame (the missing key silently dropped by JSON.stringify). Drop-and-continue (FR-025/§II).
					if (typeof gap.channel !== "string" || typeof gap.last_pos !== "string") break;
					this.enqueue(gap);
					this.applyRecoveryActions(this.recovery.handleGap(gap.channel, gap.last_pos));
					this.wakeRecovery();
					break;
				}
				case "replay_message": {
					const rm = raw as unknown as ReplayMessage;
					this.recovery.notePos(rm.channel, rm.pos);
					this.recovery.handleReplayMessage(rm.channel); // reset the per-frame idle deadline (fix #3)
					this.enqueue(rm);
					this.wakeRecovery();
					break;
				}
				case "replay_complete": {
					const rc = raw as unknown as ReplayComplete;
					this.applyRecoveryActions(this.recovery.handleReplayComplete(rc.channel));
					this.wakeRecovery();
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
				case "reconnect_error": {
					// `not_available` is the Direct-backend capability signal, not a retryable error: degrade
					// to resubscribe and surface one synthetic PossibleGap per channel. Any other code is a
					// genuine reconnect failure → the typed event.
					const err = raw as unknown as ReconnectErrorMessage;
					if (err.code === "not_available") {
						this.applyRecoveryActions(
							this.recovery.handleNotAvailable(Array.from(this._subscriptions)),
						);
						this.wakeRecovery();
					} else {
						this.emit("reconnectError", err);
					}
					break;
				}
				case "pong":
					this.emit("pong", raw as unknown as PongMessage);
					break;
				case "error": {
					// A channel-scoped replay/recovery error code means an in-flight replay failed: reset that
					// channel's FSM and raise a single RecoveryInterrupted (never a stray error now plus a
					// deadline-fired one later). Everything else is a plain protocol error → the typed event.
					const err = raw as unknown as WireErrorMessage;
					if (err.channel !== undefined && REPLAY_ERROR_CODES.includes(err.code)) {
						this.applyRecoveryActions(this.recovery.handleRecoveryFailure(err.channel, err.code));
						this.wakeRecovery();
					} else {
						this.emit("error", raw as unknown as ErrorMessage);
					}
					break;
				}
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

	private async handleReconnect(): Promise<void> {
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
		const delay = this.clock.rng() * ceiling;

		this.emit("reconnecting", this.reconnectAttempt);
		try {
			await this.clock.sleep(delay, this.shutdown.signal);
		} catch {
			return; // the backoff sleep was aborted (disconnect / a superseding connect) — stop here
		}
		// Outside the try so a synchronous connect()/transport.open() throw surfaces, not swallowed (§III).
		this.connect();
	}

	// ---------------------------------------------------------------------------
	// Internal — Recovery
	// ---------------------------------------------------------------------------

	/** Execute the canonical actions the RecoveryEngine returns: send frames, enqueue signals, emit errors. */
	private applyRecoveryActions(actions: RecoveryAction[]): void {
		for (const action of actions) {
			switch (action.action) {
				case "send_replay":
					this.send({
						type: "replay",
						data: { channel: action.channel, from_pos: action.from_pos },
					});
					break;
				case "send_reconnect":
					this.send({
						type: "reconnect",
						data: { client_id: action.client_id, last_pos: action.last_pos },
					});
					break;
				case "emit_possible_gap":
					this.enqueue({ type: "possible_gap", channel: action.channel });
					break;
				case "raise_recovery_interrupted":
					this.emit(
						"recoveryInterrupted",
						new RecoveryInterruptedError(action.reason, action.channel),
					);
					break;
			}
		}
	}

	/**
	 * A connection dropped. Any channel mid-recovery is a truncated recovery → RecoveryInterrupted
	 * (advisory; the next reconnect-replay may still recover it). `pos` and `client_id` persist for that
	 * reconnect-replay. Called from every connection-loss path (close, heartbeat timeout, forced
	 * reconnect, intentional disconnect).
	 */
	private onConnectionLost(): void {
		this.applyRecoveryActions(this.recovery.handleDisconnect());
	}

	/** Wake the recovery timer so it recomputes its next deadline after the engine's state changed. */
	private wakeRecovery(): void {
		this.recoveryWake.abort();
		this.recoveryWake = new AbortController();
	}

	/** Start the per-epoch recovery timer (fires due floor-waits + deadlines until the epoch aborts). */
	private startRecoveryTimer(): void {
		if (!this.epoch) return;
		// Guarded like the heartbeat loop: a transport-agnostic send throw during action dispatch must
		// not become an unhandled rejection. Surfaces to the SDK logger once wired (parallel to _redact).
		void this.runRecoveryTimer(this.epoch.signal).catch(() => {});
	}

	/**
	 * Drive the engine's clock-based timers: fire floor-waits whose floor has elapsed (→ `send_replay`)
	 * and raise RecoveryInterrupted past a detection deadline. Parks on the injected clock until the next
	 * deadline, or on the `recoveryWake` condvar when nothing is pending / new work arrives — so it costs
	 * nothing on an idle connection. Exits cleanly when the epoch aborts (§XI deterministic teardown).
	 */
	private async runRecoveryTimer(epochSignal: AbortSignal): Promise<void> {
		for (;;) {
			if (epochSignal.aborted) return;
			// Capture the wake signal BEFORE reading the deadline: a wake fired after this read aborts the
			// captured signal, and `anySignal` propagates an already-aborted source, so the wait below
			// returns at once and recomputes — no lost wakeup (single-threaded: no wake can land between the
			// capture and the park, so no explicit re-check is needed here).
			const wakeSignal = this.recoveryWake.signal;
			const deadline = this.recovery.nextDeadline();
			const now = this.clock.now();
			if (deadline !== null && deadline <= now) {
				this.applyRecoveryActions(this.recovery.due());
				continue;
			}

			const { signal, cleanup } = anySignal([epochSignal, wakeSignal]);
			try {
				if (deadline === null) {
					await waitForAbort(signal); // nothing pending → park until woken or the epoch ends
				} else {
					await this.clock.sleep(deadline - now, signal).catch(() => {}); // wake/epoch aborts the sleep
				}
			} finally {
				cleanup();
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — Heartbeat
	// ---------------------------------------------------------------------------

	/** Start the per-epoch heartbeat monitor (canSend-gated, runs on the injected clock until the epoch aborts). */
	private startHeartbeat(): void {
		if (!this.epoch) return;
		this.heartbeat = new HeartbeatMonitor({
			clock: this.clock,
			intervalMs: this.options.heartbeatInterval,
			pongTimeoutMs: this.options.heartbeatTimeout,
			canSend: this.transport.capabilities.canSend,
			send: () => this.send({ type: "heartbeat", data: {} as Record<string, never> }),
			onTimeout: () => this.handleHeartbeatTimeout(),
		});
		// The heartbeat loop error surfaces to the SDK logger once wired (parallel to _redact); a clean
		// abort is caught inside run(). Guarded so a transport-agnostic send/close throw isn't unhandled.
		void this.heartbeat.run(this.epoch.signal).catch(() => {});
	}

	/**
	 * A local heartbeat timeout — the connection is dead. Client-initiated `close()` does NOT echo back
	 * through `handleTransportClose` (the transport nulls its close handler before closing), so we drive
	 * teardown + the reconnect path directly here (FR-019: local 4000 → reconnect).
	 */
	private handleHeartbeatTimeout(): void {
		this.onConnectionLost();
		this.teardownEpoch();
		this.transport.close(CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
		this.emit("close", CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
		void this.handleReconnect();
	}

	/** Tear down the current connection epoch — aborts the heartbeat loop (the TaskGroup analog). */
	private teardownEpoch(): void {
		this.epoch?.abort();
		this.epoch = null;
		this.heartbeat = null;
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

/**
 * Combine several `AbortSignal`s into one that aborts as soon as any source does. Returns a `cleanup`
 * that MUST be called (in a `finally`) to detach the source listeners — the recovery timer builds one
 * of these per wait, so leaving listeners attached would accumulate them on the long-lived epoch
 * signal (§XI deterministic teardown). Not `AbortSignal.any()` — that isn't in the ES2020 lib types.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort();
	for (const source of signals) {
		if (source.aborted) {
			controller.abort();
			break;
		}
		source.addEventListener("abort", onAbort, { once: true });
	}
	const cleanup = (): void => {
		for (const source of signals) source.removeEventListener("abort", onAbort);
	};
	return { signal: controller.signal, cleanup };
}

/** Resolve once `signal` aborts (immediately if already aborted). No timer — used to park indefinitely. */
function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
