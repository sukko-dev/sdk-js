import type { SukkoClientEvents } from "@sukko/sdk";
import { onDestroy } from "svelte";
import { getSukkoClient } from "../context";

/**
 * Listen to a specific SukkoClient event with automatic cleanup.
 * Must be called during component initialization.
 *
 * ```svelte
 * <script>
 *   onSukkoEvent("subscriptionAck", (msg) => {
 *     console.log("Subscribed to:", msg.subscribed);
 *   });
 * </script>
 * ```
 */
export function onSukkoEvent<K extends keyof SukkoClientEvents>(
	event: K,
	handler: SukkoClientEvents[K],
): void {
	const client = getSukkoClient();
	const off = client.on(event, handler);
	onDestroy(off);
}
