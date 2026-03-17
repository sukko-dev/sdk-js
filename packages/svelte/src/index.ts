// Context
export { setSukkoClient, getSukkoClient } from "./context";

// Stores
export { createConnectionState } from "./stores/connection";
export type { ConnectionStateResult } from "./stores/connection";
export { createSubscription } from "./stores/subscription";
export type { SubscriptionOptions, SubscriptionResult } from "./stores/subscription";
export { onSukkoEvent } from "./stores/event";

// Re-export core types for convenience
export type {
	ConnectionState,
	DataMessage,
	SukkoClientEvents,
	SukkoClientOptions,
} from "@sukko/sdk";
