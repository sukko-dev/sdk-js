import type { ConnectionState } from "@sukko/sdk";
import { useCallback, useSyncExternalStore } from "react";
import { useSukkoClient } from "./use-client";

interface ConnectionStateResult {
	state: ConnectionState;
	isConnected: boolean;
	isReconnecting: boolean;
}

/**
 * Subscribe to connection state changes.
 * Returns the current state and derived booleans.
 */
export function useConnectionState(): ConnectionStateResult {
	const client = useSukkoClient();

	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			return client.on("stateChange", onStoreChange);
		},
		[client],
	);

	const getSnapshot = useCallback((): ConnectionState => {
		return client.state;
	}, [client]);

	const getServerSnapshot = useCallback((): ConnectionState => {
		return "disconnected";
	}, []);

	const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

	return {
		state,
		isConnected: state === "connected",
		isReconnecting: state === "reconnecting",
	};
}
