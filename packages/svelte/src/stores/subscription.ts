import type { DataMessage } from "@sukko/sdk";
import { readable } from "svelte/store";
import type { Readable } from "svelte/store";
import { getSukkoClient } from "../context";

export interface SubscriptionOptions<T = unknown> {
	/** Channels to subscribe to. */
	channels: string[];
	/** Enable/disable the subscription. Default: true. */
	enabled?: boolean;
	/** Callback fired on each incoming message. */
	onMessage?: (msg: DataMessage<T>) => void;
}

export interface SubscriptionResult<T = unknown> {
	/** The most recent message received on any subscribed channel. */
	lastMessage: DataMessage<T> | null;
	/** The data payload of the most recent message. */
	data: T | null;
	/** Whether channels are actively subscribed. */
	isSubscribed: boolean;
}

// Global ref-count map: channel → number of stores subscribed
const refCounts = new Map<string, number>();

/**
 * Create a readable store that subscribes to WebSocket channels.
 *
 * Manages reference counting: if multiple stores subscribe to the same
 * channel, only one WebSocket subscription is created. The channel is
 * unsubscribed when the last store's subscribers are removed.
 *
 * ```svelte
 * <script>
 *   const trades = createSubscription<Trade>({ channels: ["tenant.BTC.trade"] });
 *   $: ({ data, lastMessage } = $trades);
 * </script>
 * ```
 */
export function createSubscription<T = unknown>(
	options: SubscriptionOptions<T>,
): Readable<SubscriptionResult<T>> {
	const client = getSukkoClient();
	const { channels, enabled = true, onMessage } = options;

	const initial: SubscriptionResult<T> = {
		lastMessage: null,
		data: null,
		isSubscribed: false,
	};

	return readable(initial, (set) => {
		if (!enabled || channels.length === 0) return;

		// Increment ref counts and subscribe channels with count 0
		const toSubscribe: string[] = [];
		for (const ch of channels) {
			const count = refCounts.get(ch) ?? 0;
			refCounts.set(ch, count + 1);
			if (count === 0) toSubscribe.push(ch);
		}

		if (toSubscribe.length > 0) {
			client.subscribe(toSubscribe);
		}

		// Listen for messages on subscribed channels
		const off = client.on("message", (msg: DataMessage) => {
			if (channels.includes(msg.channel)) {
				const typed = msg as DataMessage<T>;
				set({
					lastMessage: typed,
					data: typed.data,
					isSubscribed: true,
				});
				onMessage?.(typed);
			}
		});

		set({ lastMessage: null, data: null, isSubscribed: true });

		// Cleanup: remove listener, decrement ref counts, unsubscribe
		return () => {
			off();
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
		};
	});
}
