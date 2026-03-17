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

// Constants
export { CLOSE_CODES, CLIENT_ID_KEY, SUKKO_DEFAULTS } from "./constants";

// Utilities
export { buildChannel, getChannelCategory, parseChannel } from "./utils";
export type { ParsedChannel } from "./utils";
