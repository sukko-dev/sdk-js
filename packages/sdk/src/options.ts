// Client-facing configuration + event surface. Message payload types live in `./messages` (the single
// AsyncAPI-derived contract model); this module owns only the connection state, the client option
// knobs, and the typed event map.

import type { Clock } from "./_clock";
import type { OverflowPolicy } from "./backpressure";
import type { RecoveryInterruptedError } from "./errors";
import type { FetchLike } from "./http";
import type {
	AuthAck,
	AuthError,
	ErrorMessage,
	HistoryError,
	Message,
	Pong,
	PublishAck,
	PublishError,
	ReconnectAck,
	ReconnectError,
	SubscribeError,
	SubscriptionAck,
	UnsubscribeError,
	UnsubscriptionAck,
} from "./messages";
import type { Transport } from "./transport";

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error";

// ---------------------------------------------------------------------------
// Client event map (for TypedEventEmitter)
// ---------------------------------------------------------------------------

export type SukkoClientEvents = {
	message: (msg: Message) => void;
	stateChange: (state: ConnectionState) => void;
	subscriptionAck: (msg: SubscriptionAck) => void;
	unsubscriptionAck: (msg: UnsubscriptionAck) => void;
	publishAck: (msg: PublishAck) => void;
	publishError: (msg: PublishError) => void;
	reconnectAck: (msg: ReconnectAck) => void;
	reconnectError: (msg: ReconnectError) => void;
	pong: (msg: Pong) => void;
	error: (msg: ErrorMessage) => void;
	subscribeError: (msg: SubscribeError) => void;
	unsubscribeError: (msg: UnsubscribeError) => void;
	authAck: (msg: AuthAck) => void;
	authError: (msg: AuthError) => void;
	close: (code: number, reason: string) => void;
	reconnecting: (attempt: number) => void;
	/** A recovery (reconnect-replay / live replay) was truncated — advisory, not terminal (§III). */
	recoveryInterrupted: (err: RecoveryInterruptedError) => void;
	/** A `history()` request was rejected by the server (disabled, unavailable, or invalid). */
	historyError: (msg: HistoryError) => void;
};

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

export interface SukkoClientOptions {
	/** Transport adapter (e.g., `new WebSocketTransport({ url })` from `@sukko/websocket`). */
	transport: Transport;
	/** JWT token for authentication. Passed to transport via `setToken()`. */
	token?: string;
	/** Enable automatic reconnection. Default: true. */
	reconnect?: boolean;
	/** Max reconnect attempts before the client gives up (`0` = unlimited). Default: 5. */
	reconnectMaxAttempts?: number;
	/** Base delay in ms for the Full-Jitter reconnect backoff. Default: 1000. */
	backoffBaseMs?: number;
	/** Cap in ms for the reconnect backoff. Default: 30000. */
	backoffMaxMs?: number;
	/** Interval in ms between heartbeats. Default: 30000. */
	heartbeatIntervalMs?: number;
	/** Time in ms to wait for any inbound frame after a heartbeat before declaring the link dead. Default: 5000. */
	pongTimeoutMs?: number;
	/** Duration in ms after which a connection with no activity is considered stale. Default: 30000. */
	staleConnectionThresholdMs?: number;
	/** Handshake deadline in ms: if the transport does not reach `connected` within this window, the
	 * client aborts the attempt and reconnects with backoff. Default: 10000. */
	connectTimeoutMs?: number;
	/** Connect automatically on construction. Default: true. */
	autoConnect?: boolean;
	/** Async callback to fetch a fresh token. Called during auth refresh. */
	getToken?: () => Promise<string>;
	/** Delivery-queue capacity. Must be ≥ `historyLimit + maxReplayMessages` so a recovery burst fits.
	 * Default: 256. */
	bufferSize?: number;
	/** What the delivery queue drops when it overflows on a transport that can't back-pressure. Default:
	 * `drop_oldest`. */
	overflowPolicy?: OverflowPolicy;
	/** Max messages a `history()` call may request (also the recovery-burst floor). Default: 100. */
	historyLimit?: number;
	/** Gateway HTTP origin for REST publish + push (e.g. `https://gw.example.com`). Defaults to the
	 * origin derived from the transport's `url` (`wss://…/ws` → `https://…`) when the transport exposes
	 * one; required otherwise before `restPublish`/`push` can be used. */
	baseUrl?: string;
	/** Injectable `fetch` for the REST/push client (tests). Default: the global `fetch`. */
	fetch?: FetchLike;
	/** Injectable clock/sleep/RNG seam (NFR-006) for deterministic timing tests. Default: SystemClock. */
	clock?: Clock;
}
