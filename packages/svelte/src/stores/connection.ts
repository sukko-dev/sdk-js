import type { ConnectionState } from "@sukko/sdk";
import { readable } from "svelte/store";
import type { Readable } from "svelte/store";
import { getSukkoClient } from "../context";

export interface ConnectionStateResult {
	state: ConnectionState;
	isConnected: boolean;
	isReconnecting: boolean;
}

/**
 * Create a readable store that tracks the SukkoClient connection state.
 * Must be called during component initialization (requires context).
 *
 * ```svelte
 * <script>
 *   const connection = createConnectionState();
 *   $: ({ state, isConnected } = $connection);
 * </script>
 * ```
 */
export function createConnectionState(): Readable<ConnectionStateResult> {
	const client = getSukkoClient();
	const initial: ConnectionStateResult = {
		state: client.state,
		isConnected: client.state === "connected",
		isReconnecting: client.state === "reconnecting",
	};

	return readable(initial, (set) => {
		const off = client.on("stateChange", (state: ConnectionState) => {
			set({
				state,
				isConnected: state === "connected",
				isReconnecting: state === "reconnecting",
			});
		});
		return off;
	});
}
