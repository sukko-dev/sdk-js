import { SukkoClient, TypedEventEmitter } from "@sukko/sdk";
import type { DataMessage, Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import { SukkoProvider } from "../src/context";
import { useSubscription } from "../src/composables/use-subscription";

class MockTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	sent: string[] = [];
	get state(): TransportState {
		return this._state;
	}
	get capabilities(): TransportCapabilities {
		return { canSend: true, canSubscribe: true, canPublish: true };
	}
	setToken(_token: string): void {}
	open(): void {
		this._state = "opening";
	}
	close(): void {
		this._state = "closed";
	}
	send(data: string): void {
		this.sent.push(data);
	}
}

interface TestData {
	price: number;
}

function createClient(): SukkoClient {
	return new SukkoClient({
		transport: new MockTransport(),
		autoConnect: false,
		reconnect: false,
	});
}

function createTestSubscriber(props: {
	channels: string[];
	enabled?: boolean;
	onMessage?: (msg: DataMessage<TestData>) => void;
}) {
	return defineComponent({
		setup() {
			const { lastMessage, data, isSubscribed } = useSubscription<TestData>({
				channels: props.channels,
				enabled: props.enabled,
				onMessage: props.onMessage,
			});
			return () =>
				h("div", [
					h("span", { "data-testid": "data" }, data.value ? JSON.stringify(data.value) : "null"),
					h("span", { "data-testid": "channel" }, lastMessage.value?.channel ?? "none"),
					h("span", { "data-testid": "subscribed" }, String(isSubscribed.value)),
				]);
		},
	});
}

describe("useSubscription", () => {
	it("returns null data initially", () => {
		const client = createClient();
		const TestSub = createTestSubscriber({ channels: ["tenant.BTC.trade"] });

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		expect(wrapper.find('[data-testid="data"]').text()).toBe("null");
		expect(wrapper.find('[data-testid="channel"]').text()).toBe("none");
	});

	it("receives messages on subscribed channels", async () => {
		const client = createClient();
		const TestSub = createTestSubscriber({ channels: ["tenant.BTC.trade"] });

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		};

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("message", msg);
		await nextTick();

		expect(wrapper.find('[data-testid="data"]').text()).toBe('{"price":50000}');
		expect(wrapper.find('[data-testid="channel"]').text()).toBe("tenant.BTC.trade");
	});

	it("ignores messages on unsubscribed channels", async () => {
		const client = createClient();
		const TestSub = createTestSubscriber({ channels: ["tenant.BTC.trade"] });

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.ETH.trade",
			data: { price: 3000 },
		};

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("message", msg);
		await nextTick();

		expect(wrapper.find('[data-testid="data"]').text()).toBe("null");
		expect(wrapper.find('[data-testid="channel"]').text()).toBe("none");
	});

	it("calls onMessage callback", async () => {
		const client = createClient();
		const onMessage = vi.fn();
		const TestSub = createTestSubscriber({
			channels: ["tenant.BTC.trade"],
			onMessage,
		});

		mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		};

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("message", msg);

		expect(onMessage).toHaveBeenCalledOnce();
		expect(onMessage.mock.calls[0][0].data.price).toBe(50000);
	});

	it("does not subscribe when enabled is false", () => {
		const client = createClient();
		const subscribeSpy = vi.spyOn(client, "subscribe");
		const TestSub = createTestSubscriber({
			channels: ["tenant.BTC.trade"],
			enabled: false,
		});

		mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
	});

	it("does not subscribe when channels array is empty", () => {
		const client = createClient();
		const subscribeSpy = vi.spyOn(client, "subscribe");
		const TestSub = createTestSubscriber({ channels: [] });

		mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
	});

	it("updates data on subsequent messages", async () => {
		const client = createClient();
		const TestSub = createTestSubscriber({ channels: ["tenant.BTC.trade"] });

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestSub) },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("message", {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		} satisfies DataMessage<TestData>);
		await nextTick();

		expect(wrapper.find('[data-testid="data"]').text()).toBe('{"price":50000}');

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("message", {
			type: "message",
			seq: 2,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 51000 },
		} satisfies DataMessage<TestData>);
		await nextTick();

		expect(wrapper.find('[data-testid="data"]').text()).toBe('{"price":51000}');
	});
});
