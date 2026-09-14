import type { SukkoClientEvents } from "@sukko/sdk";
import { onMounted, onUnmounted } from "vue";
import { useSukkoClient } from "../context";

/**
 * Listen to a specific SukkoClient event.
 * Manages `.on()/.off()` lifecycle tied to the component.
 *
 * ```vue
 * useSukkoEvent("subscriptionAck", (msg) => {
 *   console.log("Subscribed to:", msg.subscribed);
 * });
 * ```
 */
export function useSukkoEvent<K extends keyof SukkoClientEvents>(
	event: K,
	handler: SukkoClientEvents[K],
): void {
	const client = useSukkoClient();
	let off: (() => void) | undefined;

	onMounted(() => {
		off = client.on(event, handler);
	});

	onUnmounted(() => {
		off?.();
	});
}
