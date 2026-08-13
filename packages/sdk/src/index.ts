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
	FetchLike,
	SseTransportOptions,
} from "./transport";
export { SseTransport } from "./transport";

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

// Errors — the SukkoError base (catch-all) plus every error a public method throws or an event carries:
// `history()` throws NotConnectedError / TransportError / ConfigurationError, `recoveryInterrupted`
// carries RecoveryInterruptedError. The remaining hierarchy is exported by the T041 public-API pass.
export {
	ConfigurationError,
	NotConnectedError,
	RecoveryInterruptedError,
	SukkoError,
	TransportError,
	UnauthorizedError,
} from "./errors";

// Constants
export { CLOSE_CODES, CLIENT_ID_KEY, SUKKO_DEFAULTS } from "./constants";

// Utilities
export { buildChannel, parseChannel } from "./utils";
export type { ParsedChannel } from "./utils";
