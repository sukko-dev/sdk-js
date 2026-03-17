// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface SubscribeMessage {
	type: "subscribe";
	data: { channels: string[] };
}

export interface UnsubscribeMessage {
	type: "unsubscribe";
	data: { channels: string[] };
}

export interface PublishMessage {
	type: "publish";
	data: { channel: string; data: unknown };
}

export interface ReconnectMessage {
	type: "reconnect";
	data: { client_id: string; last_offset: Record<string, number> };
}

export interface HeartbeatMessage {
	type: "heartbeat";
	data?: Record<string, never>;
}

export interface AuthRefreshMessage {
	type: "auth";
	data: { token: string };
}

export type ClientMessage =
	| SubscribeMessage
	| UnsubscribeMessage
	| PublishMessage
	| ReconnectMessage
	| HeartbeatMessage
	| AuthRefreshMessage;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface DataMessage<T = unknown> {
	type: "message";
	seq: number;
	ts: number;
	channel: string;
	data: T;
}

export interface SubscriptionAckMessage {
	type: "subscription_ack";
	subscribed: string[];
	count: number;
}

export interface UnsubscriptionAckMessage {
	type: "unsubscription_ack";
	unsubscribed: string[];
	count: number;
	forced?: true;
}

export interface PublishAckMessage {
	type: "publish_ack";
	channel: string;
	status: "accepted";
}

export type PublishErrorCode =
	| "not_available"
	| "invalid_request"
	| "invalid_channel"
	| "message_too_large"
	| "rate_limited"
	| "publish_failed"
	| "forbidden"
	| "topic_not_provisioned"
	| "service_unavailable"
	| "no_routing_rules"
	| "no_matching_route";

export interface PublishErrorMessage {
	type: "publish_error";
	code: PublishErrorCode;
	message: string;
}

export interface ReconnectAckMessage {
	type: "reconnect_ack";
	status: "completed";
	messages_replayed: number;
	message: string;
}

export type ReconnectErrorCode = "invalid_request" | "not_available" | "replay_failed";

export interface ReconnectErrorMessage {
	type: "reconnect_error";
	code: ReconnectErrorCode;
	message: string;
}

export interface PongMessage {
	type: "pong";
	ts: number;
}

export interface ErrorMessage {
	type: "error";
	code: "invalid_json";
	message: string;
}

export interface SubscribeErrorMessage {
	type: "subscribe_error";
	code: "invalid_request";
	message: string;
}

export interface UnsubscribeErrorMessage {
	type: "unsubscribe_error";
	code: "invalid_request";
	message: string;
}

export interface AuthAckMessage {
	type: "auth_ack";
	data: { exp: number };
}

export type AuthErrorCode =
	| "invalid_token"
	| "token_expired"
	| "tenant_mismatch"
	| "rate_limited"
	| "not_available";

export interface AuthErrorMessage {
	type: "auth_error";
	data: { code: AuthErrorCode; message: string };
}

export type ServerMessage<T = unknown> =
	| DataMessage<T>
	| SubscriptionAckMessage
	| UnsubscriptionAckMessage
	| PublishAckMessage
	| PublishErrorMessage
	| ReconnectAckMessage
	| ReconnectErrorMessage
	| PongMessage
	| ErrorMessage
	| SubscribeErrorMessage
	| UnsubscribeErrorMessage
	| AuthAckMessage
	| AuthErrorMessage;

// ---------------------------------------------------------------------------
// Client event map (for TypedEventEmitter)
// ---------------------------------------------------------------------------

export type SukkoClientEvents = {
	message: (msg: DataMessage) => void;
	stateChange: (state: ConnectionState) => void;
	subscriptionAck: (msg: SubscriptionAckMessage) => void;
	unsubscriptionAck: (msg: UnsubscriptionAckMessage) => void;
	publishAck: (msg: PublishAckMessage) => void;
	publishError: (msg: PublishErrorMessage) => void;
	reconnectAck: (msg: ReconnectAckMessage) => void;
	reconnectError: (msg: ReconnectErrorMessage) => void;
	pong: (msg: PongMessage) => void;
	error: (msg: ErrorMessage) => void;
	subscribeError: (msg: SubscribeErrorMessage) => void;
	unsubscribeError: (msg: UnsubscribeErrorMessage) => void;
	authAck: (msg: AuthAckMessage) => void;
	authError: (msg: AuthErrorMessage) => void;
	close: (code: number, reason: string) => void;
	reconnecting: (attempt: number) => void;
};

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

import type { Transport } from "./transport";

export interface SukkoClientOptions {
	/** Transport adapter (e.g., `new WebSocketTransport({ url })` from `@sukko/websocket`). */
	transport: Transport;
	/** JWT token for authentication. Passed to transport via `setToken()`. */
	token?: string;
	/** Enable automatic reconnection. Default: true. */
	reconnect?: boolean;
	/** Max reconnect attempts before switching to indefinite retry. Default: 5. */
	reconnectAttempts?: number;
	/** Base delay in ms for exponential backoff. Default: 1000. */
	reconnectDelayBase?: number;
	/** Max delay in ms for reconnection. Default: 30000. */
	reconnectDelayMax?: number;
	/** Interval in ms between heartbeat pings. Default: 30000. */
	heartbeatInterval?: number;
	/** Timeout in ms to wait for pong after heartbeat. Default: 5000. */
	heartbeatTimeout?: number;
	/** Duration in ms after which a connection with no activity is considered stale. Default: 30000. */
	staleConnectionThreshold?: number;
	/** Connect automatically on construction. Default: true. */
	autoConnect?: boolean;
	/** Async callback to fetch a fresh token. Called during auth refresh. */
	getToken?: () => Promise<string>;
}
