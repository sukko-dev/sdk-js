// Core client
export { SukkoClient } from "./client";

// Event emitter (for advanced use / custom extensions)
export { TypedEventEmitter } from "./emitter";
export type { EventMap } from "./emitter";

// Transport abstraction
export type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "./transport";

// Protocol types
export type {
	// Connection
	ConnectionState,
	SukkoClientEvents,
	SukkoClientOptions,
	// Client → Server
	AuthRefreshMessage,
	ClientMessage,
	HeartbeatMessage,
	PublishMessage,
	ReconnectMessage,
	SubscribeMessage,
	UnsubscribeMessage,
	// Server → Client
	AuthAckMessage,
	AuthErrorCode,
	AuthErrorMessage,
	DataMessage,
	ErrorMessage,
	PongMessage,
	PublishAckMessage,
	PublishErrorCode,
	PublishErrorMessage,
	ReconnectAckMessage,
	ReconnectErrorCode,
	ReconnectErrorMessage,
	ServerMessage,
	SubscribeErrorMessage,
	SubscriptionAckMessage,
	UnsubscribeErrorMessage,
	UnsubscriptionAckMessage,
} from "./types";

// Delivery-stream types — what `client.messages()` yields (the authoritative, back-pressured
// surface). Distinct from the `./types` protocol types above, which back the `.on("message")` tap;
// the two message models coexist transitionally until the T009b switch to `./messages`.
export type {
	DeliveryItem,
	Message,
	ReplayMessage,
	Gap,
	PossibleGap,
	Overflow,
	HistoryError,
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
} from "./errors";

// Constants
export { CLOSE_CODES, CLIENT_ID_KEY, SUKKO_DEFAULTS } from "./constants";

// Utilities
export { buildChannel, parseChannel } from "./utils";
export type { ParsedChannel } from "./utils";
