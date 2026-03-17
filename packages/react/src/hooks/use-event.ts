import type { SukkoClientEvents } from "@sukko/sdk";
import { useEffect, useRef } from "react";
import { useSukkoClient } from "./use-client";

/**
 * Listen to a specific SukkoClient event.
 * Manages `.on()/.off()` lifecycle tied to the component.
 *
 * ```tsx
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
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		// biome-ignore lint/suspicious/noExplicitAny: wrapper must forward any args
		const wrapper = (...args: any[]) => {
			(handlerRef.current as Function)(...args);
		};

		const off = client.on(event, wrapper as SukkoClientEvents[K]);
		return off;
	}, [client, event]);
}
