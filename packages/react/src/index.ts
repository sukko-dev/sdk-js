// Provider
export { SukkoContext, SukkoProvider } from "./context";
export type { SukkoProviderProps } from "./context";

// Hooks
export { useSukkoClient } from "./hooks/use-client";
export { useConnectionState } from "./hooks/use-connection";
export { useSubscription } from "./hooks/use-subscription";
export { useSukkoEvent } from "./hooks/use-event";

// Re-export hook types
export type { UseSubscriptionOptions, UseSubscriptionResult } from "./hooks/use-subscription";

// Re-export core types for convenience
export type {
	ConnectionState,
	DataMessage,
	SukkoClientEvents,
	SukkoClientOptions,
} from "@sukko/sdk";
