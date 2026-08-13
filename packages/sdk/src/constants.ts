/**
 * Default configuration values for SukkoClient. Keys are camelCase, in **milliseconds** (the Defaults
 * & Units table's canonical unit). Auth (`authRefresh*`) and SSE (`sseIdleTimeoutMs`) knobs are added
 * when those phases land.
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
	/** Local (self-initiated) close: heartbeat pong timeout. Same code as FORCE_DISCONNECT — disambiguated by direction. */
	HEARTBEAT_TIMEOUT: 4000,
	/** Remote (operator-initiated) close: server force-disconnected this client. Terminal — no auto-reconnect (FR-019). */
	FORCE_DISCONNECT: 4000,
} as const;

/** Whether a close was initiated by this client (`local`) or by the server (`remote`) — 4000 needs this to disambiguate. */
export type CloseDirection = "local" | "remote";

/** True when the close is an operator-initiated `force_disconnect` (remote 4000) — terminal, no reconnect. */
export function isForceDisconnect(code: number, direction: CloseDirection): boolean {
	return code === CLOSE_CODES.FORCE_DISCONNECT && direction === "remote";
}

/** True when the close is a local heartbeat-timeout (self-initiated 4000) — reconnect with backoff. */
export function isHeartbeatTimeout(code: number, direction: CloseDirection): boolean {
	return code === CLOSE_CODES.HEARTBEAT_TIMEOUT && direction === "local";
}

/** localStorage key for persistent client ID. */
export const CLIENT_ID_KEY = "sukko_client_id";
