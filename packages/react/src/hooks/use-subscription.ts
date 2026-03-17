import type { DataMessage } from "@sukko/sdk";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useSukkoClient } from "./use-client";

export interface UseSubscriptionOptions<T = unknown> {
	/** Channels to subscribe to. */
	channels: string[];
	/** Enable/disable the subscription. Default: true. */
	enabled?: boolean;
	/** Callback fired on each incoming message. */
	onMessage?: (msg: DataMessage<T>) => void;
}

export interface UseSubscriptionResult<T = unknown> {
	/** The most recent message received on any subscribed channel. */
	lastMessage: DataMessage<T> | null;
	/** The data payload of the most recent message. */
	data: T | null;
	/** Whether channels are actively subscribed. */
	isSubscribed: boolean;
}

// Global ref-count map: channel → number of components subscribed
const refCounts = new Map<string, number>();

/**
 * Subscribe to WebSocket channels and receive typed data messages.
 *
 * Manages reference counting: if multiple components subscribe to the same
 * channel, only one WebSocket subscription is created. The channel is
 * unsubscribed when the last component unmounts.
 *
 * ```tsx
 * const { data, lastMessage } = useSubscription<Trade>({
 *   channels: ["tenant.BTC.trade"],
 * });
 * ```
 */
export function useSubscription<T = unknown>(
	options: UseSubscriptionOptions<T>,
): UseSubscriptionResult<T> {
	const { channels, enabled = true, onMessage } = options;
	const client = useSukkoClient();

	// Stable channel key for dependency comparison
	const channelKey = useMemo(() => [...channels].sort().join(","), [channels]);

	// Latest message snapshot (mutable ref for useSyncExternalStore)
	const snapshotRef = useRef<DataMessage<T> | null>(null);
	const versionRef = useRef(0);

	// Stable onMessage ref
	const onMessageRef = useRef(onMessage);
	onMessageRef.current = onMessage;

	// Track subscription state
	const isSubscribed = useRef(false);

	// Subscribe to external store (message updates)
	const subscribe = useCallback(
		(onStoreChange: () => void): (() => void) => {
			const off = client.on("message", (msg: DataMessage) => {
				if (channels.includes(msg.channel)) {
					snapshotRef.current = msg as DataMessage<T>;
					versionRef.current++;
					onMessageRef.current?.(msg as DataMessage<T>);
					onStoreChange();
				}
			});
			return off;
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[client, channelKey],
	);

	const getSnapshot = useCallback((): DataMessage<T> | null => {
		return snapshotRef.current;
	}, []);

	const getServerSnapshot = useCallback((): DataMessage<T> | null => {
		return null;
	}, []);

	const lastMessage = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

	// Manage WebSocket subscriptions with ref counting
	useEffect(() => {
		if (!enabled || channels.length === 0) return;

		// Increment ref counts and find channels that need subscribing
		const toSubscribe: string[] = [];
		for (const ch of channels) {
			const count = refCounts.get(ch) ?? 0;
			refCounts.set(ch, count + 1);
			if (count === 0) toSubscribe.push(ch);
		}

		if (toSubscribe.length > 0) {
			client.subscribe(toSubscribe);
		}
		isSubscribed.current = true;

		return () => {
			// Decrement ref counts and find channels that need unsubscribing
			const toUnsubscribe: string[] = [];
			for (const ch of channels) {
				const count = refCounts.get(ch) ?? 1;
				if (count <= 1) {
					refCounts.delete(ch);
					toUnsubscribe.push(ch);
				} else {
					refCounts.set(ch, count - 1);
				}
			}

			if (toUnsubscribe.length > 0) {
				client.unsubscribe(toUnsubscribe);
			}
			isSubscribed.current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, channelKey, enabled]);

	return {
		lastMessage,
		data: lastMessage?.data ?? null,
		isSubscribed: isSubscribed.current,
	};
}
