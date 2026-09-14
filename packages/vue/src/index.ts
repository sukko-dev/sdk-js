// Provider & context
export { SukkoProvider, createSukkoPlugin, useSukkoClient } from "./context";
export type { SukkoProviderProps, SukkoPluginOptions } from "./context";

// Composables
export { useConnectionState } from "./composables/use-connection";
export type { ConnectionStateResult } from "./composables/use-connection";
export { useSubscription } from "./composables/use-subscription";
export type {
	TypedMessage,
	UseSubscriptionOptions,
	UseSubscriptionResult,
} from "./composables/use-subscription";
export { useSukkoEvent } from "./composables/use-event";

// Re-export core types for convenience
export type {
	ConnectionState,
	Message,
	SukkoClientEvents,
	SukkoClientOptions,
} from "@sukko/sdk";
