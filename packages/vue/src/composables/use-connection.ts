import type { ConnectionState } from "@sukko/sdk";
import { type ComputedRef, type Ref, computed, onMounted, onUnmounted, readonly, ref } from "vue";
import { useSukkoClient } from "../context";

export interface ConnectionStateResult {
	state: Readonly<Ref<ConnectionState>>;
	isConnected: ComputedRef<boolean>;
	isReconnecting: ComputedRef<boolean>;
}

/**
 * Subscribe to connection state changes.
 * Returns reactive refs for the current state and derived booleans.
 */
export function useConnectionState(): ConnectionStateResult {
	const client = useSukkoClient();
	const state = ref<ConnectionState>(client.state);
	let off: (() => void) | undefined;

	onMounted(() => {
		off = client.on("stateChange", (s: ConnectionState) => {
			state.value = s;
		});
	});

	onUnmounted(() => {
		off?.();
	});

	return {
		state: readonly(state),
		isConnected: computed(() => state.value === "connected"),
		isReconnecting: computed(() => state.value === "reconnecting"),
	};
}
