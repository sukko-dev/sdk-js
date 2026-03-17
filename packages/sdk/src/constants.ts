/** Default configuration values for SukkoClient. */
export const SUKKO_DEFAULTS = {
	RECONNECT_ATTEMPTS: 5,
	RECONNECT_DELAY_BASE: 1000,
	RECONNECT_DELAY_MAX: 30000,
	HEARTBEAT_INTERVAL: 30000,
	HEARTBEAT_TIMEOUT: 5000,
	CONNECTION_TIMEOUT: 10000,
	STALE_CONNECTION_THRESHOLD: 30000,
} as const;

/** WebSocket close codes used by the Sukko protocol. */
export const CLOSE_CODES = {
	/** Normal closure (client or server initiated). */
	NORMAL: 1000,
	/** Server graceful shutdown. */
	GOING_AWAY: 1001,
	/** Protocol error. */
	PROTOCOL_ERROR: 1002,
	/** Policy violation — slow client disconnected by server. */
	POLICY_VIOLATION: 1008,
	/** Server internal error. */
	INTERNAL_ERROR: 1011,
	/** Client-initiated: heartbeat pong timeout. */
	HEARTBEAT_TIMEOUT: 4000,
	/** Client-initiated: authentication failed. */
	AUTH_FAILED: 4001,
	/** Client-initiated: subscription failed. */
	SUBSCRIPTION_FAILED: 4002,
} as const;

/** localStorage key for persistent client ID. */
export const CLIENT_ID_KEY = "sukko_client_id";
