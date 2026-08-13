// Core client
export { SukkoClient } from "./client";

// Event emitter (for advanced use / custom extensions)
export { TypedEventEmitter } from "./emitter";
export type { EventMap } from "./emitter";

// Transport abstraction + the built-in SSE transport (receive-only; the WebSocket adapter is
// `@sukko/websocket`).
export type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
	SseTransportOptions,
} from "./transport";
export { SseTransport } from "./transport";
export type { FetchLike } from "./http";

// Client configuration + event surface
export type { ConnectionState, SukkoClientEvents, SukkoClientOptions } from "./options";

// Protocol + delivery-stream types — the single AsyncAPI-derived contract model (`./messages`). The
// `message` tap and the `messages()` delivery stream share one `Message` type. (The full public-API
// surface cleanup — adding/removing exports per the disposition table — lands in the T041 pass.)
export type {
	// Client → Server
	AuthMessage,
	ClientMessage,
	HeartbeatMessage,
	PublishMessage,
	ReconnectMessage,
	SubscribeMessage,
	UnsubscribeMessage,
	// Server → Client
	AuthAck,
	AuthErrorCode,
	AuthError,
	ErrorMessage,
	JsonObject,
	Message,
	Pong,
	PublishAck,
	PublishErrorCode,
	PublishError,
	ReconnectAck,
	ReconnectErrorCode,
	ReconnectError,
	ServerMessage,
	SubscribeError,
	SubscriptionAck,
	UnsubscribeError,
	UnsubscriptionAck,
	// Delivery stream (`messages()`)
	DeliveryItem,
	Gap,
	HistoryError,
	Overflow,
	PossibleGap,
	ReplayMessage,
} from "./messages";

// Push subscription management — the `client.push` namespace type surface.
export { PushClient } from "./push";
export type { PushPlatform, PushSubscribeOptions } from "./push";

// Errors — the SukkoError base (catch-all) plus every error a public method throws or an event carries.
// `restPublish`/`push` add the REST error map (edition, over-size, forbidden, conflict, validation).
export {
	ConfigurationError,
	ConflictError,
	EditionRequiredError,
	ForbiddenError,
	NotConnectedError,
	PayloadTooLargeError,
	ProtocolError,
	RateLimitedError,
	RecoveryInterruptedError,
	ServiceUnavailableError,
	SukkoError,
	TransportError,
	UnauthorizedError,
	ValidationError,
} from "./errors";

// Delivery-queue overflow policy — referenced by the `overflowPolicy` client option.
export type { OverflowPolicy } from "./backpressure";

// Constants
export { CLOSE_CODES, CLIENT_ID_KEY, SUKKO_DEFAULTS } from "./constants";

// Utilities
export { buildChannel, parseChannel } from "./utils";
export type { ParsedChannel } from "./utils";
