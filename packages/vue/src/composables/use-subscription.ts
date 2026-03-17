import type { DataMessage } from "@sukko/sdk";
import {
	type ComputedRef,
	type MaybeRefOrGetter,
	type Ref,
	type ShallowRef,
	computed,
	onUnmounted,
	ref,
	shallowRef,
	toValue,
	watch,
} from "vue";
import { useSukkoClient } from "../context";

export interface UseSubscriptionOptions<T = unknown> {
	/** Channels to subscribe to. Can be a ref or getter for reactivity. */
	channels: MaybeRefOrGetter<string[]>;
	/** Enable/disable the subscription. Can be a ref or getter. Default: true. */
	enabled?: MaybeRefOrGetter<boolean>;
	/** Callback fired on each incoming message. */
	onMessage?: (msg: DataMessage<T>) => void;
}

export interface UseSubscriptionResult<T = unknown> {
	/** The most recent message received on any subscribed channel. */
	lastMessage: ShallowRef<DataMessage<T> | null>;
	/** The data payload of the most recent message. */
	data: ComputedRef<T | null>;
	/** Whether channels are actively subscribed. */
	isSubscribed: Ref<boolean>;
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
 * ```vue
 * const { data, lastMessage } = useSubscription<Trade>({
 *   channels: ["tenant.BTC.trade"],
 * });
 * ```
 */
export function useSubscription<T = unknown>(
	options: UseSubscriptionOptions<T>,
): UseSubscriptionResult<T> {
	const client = useSukkoClient();
	const lastMessage = shallowRef<DataMessage<T> | null>(null);
	const isSubscribed = ref(false);
	let offMessage: (() => void) | undefined;

	function setup(channels: string[], enabled: boolean): void {
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
		offMessage = client.on("message", (msg: DataMessage) => {
			if (channels.includes(msg.channel)) {
				lastMessage.value = msg as DataMessage<T>;
				options.onMessage?.(msg as DataMessage<T>);
			}
		});

		isSubscribed.value = true;
	}

	function cleanup(channels: string[]): void {
		offMessage?.();
		offMessage = undefined;

		if (channels.length === 0) return;

		// Decrement ref counts and unsubscribe channels that reach 0
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
		isSubscribed.value = false;
	}

	// Watch for channel/enabled changes with immediate execution
	watch(
		() => ({
			channels: [...toValue(options.channels)].sort().join(","),
			enabled: toValue(options.enabled ?? true),
		}),
		(newVal, oldVal) => {
			// Cleanup previous subscription
			if (oldVal) {
				const oldChannels = oldVal.channels ? oldVal.channels.split(",").filter(Boolean) : [];
				cleanup(oldChannels);
			}
			// Setup new subscription
			const newChannels = newVal.channels ? newVal.channels.split(",").filter(Boolean) : [];
			setup(newChannels, newVal.enabled);
		},
		{ immediate: true },
	);

	// Final cleanup on unmount
	onUnmounted(() => {
		const channels = toValue(options.channels);
		cleanup(channels);
	});

	return {
		lastMessage,
		data: computed(() => lastMessage.value?.data ?? null),
		isSubscribed,
	};
}
