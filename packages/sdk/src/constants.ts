/**
 * Default configuration values for SukkoClient. Keys are camelCase, in **milliseconds** (the Defaults
 * & Units table's canonical unit).
 */
export const SUKKO_DEFAULTS = {
	reconnectMaxAttempts: 5, // 0 = unlimited
	backoffBaseMs: 1000,
	backoffMaxMs: 30000,
	heartbeatIntervalMs: 30000,
	pongTimeoutMs: 5000,
	connectTimeoutMs: 10000,
	staleConnectionThresholdMs: 30000,
	// Delivery-queue defaults (T017/backpressure). bufferSize must be >= historyLimit +
	// maxReplayMessages so a recovery burst fits without tripping back-pressure.
	bufferSize: 256,
	historyLimit: 100,
	maxReplayMessages: 100,
	overflowPolicy: "drop_oldest",
	// Recovery (T023). replayFloorMs = per-channel auto-replay rate limit (server WS_REPLAY_RATE_LIMIT_INTERVAL);
	// recoveryDeadlineMs = 2× server WS_REPLAY_TIMEOUT, an idle timer reset on each recovery frame (FR-006).
	replayFloorMs: 10000,
	recoveryDeadlineMs: 10000,
	// Auth refresh (T031). authRefreshFloorMs = min interval between refresh sends (floors an
	// auth_error→refresh loop); authRefreshLeadMs = fire the proactive refresh this long before
	// auth_ack.exp; authRefreshBackoffMaxMs = cap on the reactive-failure backoff (const, not a caller
	// knob — tokens are ≤15 min so a 5-minute ceiling is comfortably safe).
	authRefreshFloorMs: 30000,
	authRefreshLeadMs: 30000,
	authRefreshBackoffMaxMs: 300000,
	// SSE (T036). sseIdleTimeoutMs = max silence (no bytes, incl. `: keepalive` comments) before the
	// stream is treated as dead and dropped — the sole SSE liveness detector (no heartbeat over SSE).
	sseIdleTimeoutMs: 90000,
} as const;

/** WebSocket close codes used by the Sukko protocol. */
export const CLOSE_CODES = {
	/** Normal closure (client or server initiated). */
	NORMAL: 1000,
	/** Server graceful shutdown. */
	GOING_AWAY: 1001,
	/** Policy violation — slow client disconnected by server. */
	POLICY_VIOLATION: 1008,
	/** Server internal error. */
	INTERNAL_ERROR: 1011,
	/** Local (self-initiated) close: heartbeat pong timeout. Same numeric code as FORCE_DISCONNECT, but a local timeout never reaches `handleTransportClose` — see the NOTE below. */
	HEARTBEAT_TIMEOUT: 4000,
	/** Remote (operator-initiated) close: server force-disconnected this client. Terminal — no auto-reconnect (FR-019). */
	FORCE_DISCONNECT: 4000,
} as const;

/** Whether a close was initiated by this client (`local`) or by the peer (`remote`) — carried on a `ConnectionClosedError`. */
export type CloseDirection = "local" | "remote";

// NOTE: in the client, close direction is disambiguated by ROUTING, not a flag — a client-initiated
// close (disconnect / heartbeat timeout) never reaches `handleTransportClose` (the transport
// suppresses its close echo), so a 4000 seen there is always a remote `force_disconnect` (terminal); a
// local heartbeat-timeout 4000 is handled directly (reconnect). See client.ts `handleHeartbeatTimeout`.

/** localStorage key for persistent client ID. */
export const CLIENT_ID_KEY = "sukko_client_id";
