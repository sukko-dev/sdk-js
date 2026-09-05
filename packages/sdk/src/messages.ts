// Wire message models — AsyncAPI v1.4.0 (`contract/client-ws.asyncapi.v1.4.0.yaml`). Wire `type`
// strings, field names, and error codes match the contract EXACTLY (§I). Enforced by the
// contract-coverage test (`contract/coverage.test.ts`, FR-016/SC-004).
//
// Modeling principle (FR-022 / NFR-008): the SDK models the fields it CONSUMES. Opaque position
// cursors (`pos`, `last_pos`, `from_pos`) are kept — the SDK stores and echoes them, never parses
// them. The `seq` family (`seq`, `from_seq`, `to_seq`) is intentionally NOT modelled: the server
// `gap` advisory is the sole gap authority, so `seq` is unconsumed and excluded (asserted absent by
// the public-surface test). `mid` (stable message identity, sukko-dev/sukko#241) IS modelled even
// though the SDK never consumes it itself — it exists solely for caller-side dedup/idempotency,
// mirroring Ably's first-class `Message.id` (§XII prior art:
// https://ably.com/docs/api/realtime-sdk/messages, https://ably.com/blog/introducing-idempotent-publishing)
// and Centrifugo's idempotent-identifier guidance (https://centrifugal.dev/docs/faq).
// `force_disconnect` is NOT a message type — it is WS close code 4000 (see `constants.ts`).

/** An opaque JSON payload owned by the publishing service. */
export type JsonObject = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Server → client (18 message types)
// ─────────────────────────────────────────────────────────────────────────────

/** A broadcast message. `history: true` marks a historical replay; `pos` is the Kafka replay cursor. */
export interface Message {
	type: "message";
	ts: number; // Unix ms
	channel: string;
	data: JsonObject;
	history?: boolean;
	pos?: string;
	/**
	 * Stable message identity — IDENTICAL on every copy of the same message (live broadcast, gap-replay
	 * `replay_message`, history), unlike the per-connection `seq` (unmodelled) and the `pos` replay
	 * cursor. Use it to deduplicate reconnect-replay overlap (same `mid` = same message) and for
	 * idempotent processing. Opaque, at most 64 characters — never parse it, and never send it as a
	 * replay cursor (`last_pos`/`from_pos` accept `pos` values only). Omitted by servers predating the
	 * field.
	 */
	readonly mid?: string;
}

export interface SubscriptionAck {
	type: "subscription_ack";
	subscribed: string[];
	count: number;
}

export interface UnsubscriptionAck {
	type: "unsubscription_ack";
	unsubscribed: string[];
	count?: number;
	forced?: boolean;
}

export interface PublishAck {
	type: "publish_ack";
	channel: string;
	status: "accepted";
	/**
	 * Stable message identity the gateway assigned to the published message — the same `mid`
	 * subscribers receive on the delivered envelope (see `Message.mid`). Omitted when the publish fans
	 * out to multiple topics (each produced message gets its own `mid`) and by servers predating the
	 * field.
	 */
	readonly mid?: string;
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

export interface PublishError {
	type: "publish_error";
	code: PublishErrorCode;
	message: string;
}

export interface ReconnectAck {
	type: "reconnect_ack";
	status: "completed";
	messages_replayed: number;
	message: string;
}

export type ReconnectErrorCode = "invalid_request" | "not_available" | "replay_failed";

export interface ReconnectError {
	type: "reconnect_error";
	code: ReconnectErrorCode;
	message: string;
}

export interface Pong {
	type: "pong";
	ts: number; // Unix ms
}

export type ErrorCode =
	| "invalid_json"
	| "invalid_request"
	| "not_subscribed"
	| "replay_in_progress"
	| "replay_rate_limited"
	| "offset_out_of_range"
	| "replay_failed"
	| "not_available";

export interface ErrorMessage {
	type: "error";
	code: ErrorCode;
	channel?: string;
	message: string;
}

export interface SubscribeError {
	type: "subscribe_error";
	code: "invalid_request";
	message: string;
}

export interface UnsubscribeError {
	type: "unsubscribe_error";
	code: "invalid_request";
	message: string;
}

/** `data.exp` is New token expiration in Unix **SECONDS** (0 = no expiry) — the only seconds-unit wire field. */
export interface AuthAck {
	type: "auth_ack";
	data: { exp: number };
}

export type AuthErrorCode =
	| "invalid_token"
	| "token_expired"
	| "tenant_mismatch"
	| "rate_limited"
	| "not_available";

export interface AuthError {
	type: "auth_error";
	data: { code: AuthErrorCode; message: string };
}

export interface HistoryComplete {
	type: "history_complete";
	channel: string;
	count: number;
	source: "cache" | "kafka" | "mixed";
	truncated?: boolean; // absent = false
}

export type HistoryErrorCode =
	| "history_disabled"
	| "not_available"
	| "history_not_subscribed"
	| "history_time_range_not_supported"
	| "history_invalid_limit"
	| "history_in_progress"
	| "history_storage_unavailable"
	| "history_invalid_channel"
	| "history_invalid_request";

export interface HistoryError {
	type: "history_error";
	code: HistoryErrorCode;
	channel: string;
	message: string;
}

/** Gap advisory. `last_pos` is the replay anchor (opaque). `seq`-family fields are excluded (FR-022). */
export interface Gap {
	type: "gap";
	channel: string;
	last_pos: string;
	ts: number; // Unix ms
}

/** A single message replayed during live gap recovery. */
export interface ReplayMessage {
	type: "replay_message";
	channel: string;
	ts: number; // Unix ms
	data: JsonObject;
	pos?: string;
	/**
	 * Stable message identity — the same value this message carried (or would have carried) on its
	 * live and history deliveries; use it to drop replayed duplicates already received (see
	 * `Message.mid`). Omitted by servers predating the field.
	 */
	readonly mid?: string;
}

export interface ReplayComplete {
	type: "replay_complete";
	channel: string;
	messages_replayed: number;
	truncated?: boolean; // absent = false
}

/** Discriminated union of every server→client message (18). */
export type ServerMessage =
	| Message
	| SubscriptionAck
	| UnsubscriptionAck
	| PublishAck
	| PublishError
	| ReconnectAck
	| ReconnectError
	| Pong
	| ErrorMessage
	| SubscribeError
	| UnsubscribeError
	| AuthAck
	| AuthError
	| HistoryComplete
	| HistoryError
	| Gap
	| ReplayMessage
	| ReplayComplete;

// ─────────────────────────────────────────────────────────────────────────────
// Client → server (8 message types)
// ─────────────────────────────────────────────────────────────────────────────

// Only the multi-channel subscribe mode is modelled — subscribe-with-history is out of scope (v1
// exposes history via the `history` message / `history()` method only).
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
	data: { channel: string; data: JsonObject };
}

export interface ReconnectMessage {
	type: "reconnect";
	data: { client_id: string; last_pos: Record<string, string> };
}

export interface HeartbeatMessage {
	type: "heartbeat";
}

/** Auth refresh or api-key→JWT escalation. Wire `type` is `auth` (NOT `auth_refresh`) — §I. */
export interface AuthMessage {
	type: "auth";
	data: { token: string };
}

export interface HistoryMessage {
	type: "history";
	data: { channel: string; limit: number };
}

export interface ReplayRequestMessage {
	type: "replay";
	data: { channel: string; from_pos: string };
}

/** Discriminated union of every client→server message (8). */
export type ClientMessage =
	| SubscribeMessage
	| UnsubscribeMessage
	| PublishMessage
	| ReconnectMessage
	| HeartbeatMessage
	| AuthMessage
	| HistoryMessage
	| ReplayRequestMessage;

// ─────────────────────────────────────────────────────────────────────────────
// SDK-internal delivery items (NOT wire messages — synthesized locally)
// ─────────────────────────────────────────────────────────────────────────────

/** Per-channel data-loss signal on the Direct backend (no `pos` recovery). Distinct from the wire `gap`. */
export interface PossibleGap {
	type: "possible_gap";
	channel: string;
}

/** Back-pressure overflow marker (incapable transport): `dropped` is the coalesced dropped count. */
export interface Overflow {
	type: "overflow";
	dropped: number;
}

/** What `messages()` yields: live + replayed messages, gap signals, and the overflow marker. */
export type DeliveryItem = Message | ReplayMessage | Gap | PossibleGap | Overflow;

// ─────────────────────────────────────────────────────────────────────────────
// Wire-type registries — the contract-coverage test asserts these against the vendored YAML.
// ─────────────────────────────────────────────────────────────────────────────

/** The 18 server→client wire `type` strings. */
export const SERVER_MESSAGE_TYPES = [
	"message",
	"subscription_ack",
	"unsubscription_ack",
	"publish_ack",
	"publish_error",
	"reconnect_ack",
	"reconnect_error",
	"pong",
	"error",
	"subscribe_error",
	"unsubscribe_error",
	"auth_ack",
	"auth_error",
	"history_complete",
	"history_error",
	"gap",
	"replay_message",
	"replay_complete",
] as const;

/** The 8 client→server wire `type` strings. */
export const CLIENT_MESSAGE_TYPES = [
	"subscribe",
	"unsubscribe",
	"publish",
	"reconnect",
	"heartbeat",
	"auth",
	"history",
	"replay",
] as const;
