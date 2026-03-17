import { SukkoClient, TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { mount } from "@vue/test-utils";
import { defineComponent, h, nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { SukkoProvider } from "../src/context";
import { useConnectionState } from "../src/composables/use-connection";

class MockTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
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
	send(): void {}
}

function createClient(): SukkoClient {
	return new SukkoClient({
		transport: new MockTransport(),
		autoConnect: false,
		reconnect: false,
	});
}

const TestConsumer = defineComponent({
	setup() {
		const { state, isConnected, isReconnecting } = useConnectionState();
		return () =>
			h("div", [
				h("span", { "data-testid": "state" }, state.value),
				h("span", { "data-testid": "connected" }, String(isConnected.value)),
				h("span", { "data-testid": "reconnecting" }, String(isReconnecting.value)),
			]);
	},
});

describe("useConnectionState", () => {
	it("returns initial disconnected state", () => {
		const client = createClient();

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestConsumer) },
		});

		expect(wrapper.find('[data-testid="state"]').text()).toBe("disconnected");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("false");
		expect(wrapper.find('[data-testid="reconnecting"]').text()).toBe("false");
	});

	it("updates when state changes to connected", async () => {
		const client = createClient();

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestConsumer) },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("stateChange", "connected");
		await nextTick();

		expect(wrapper.find('[data-testid="state"]').text()).toBe("connected");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("true");
		expect(wrapper.find('[data-testid="reconnecting"]').text()).toBe("false");
	});

	it("updates isReconnecting when reconnecting", async () => {
		const client = createClient();

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestConsumer) },
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("stateChange", "reconnecting");
		await nextTick();

		expect(wrapper.find('[data-testid="state"]').text()).toBe("reconnecting");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("false");
		expect(wrapper.find('[data-testid="reconnecting"]').text()).toBe("true");
	});

	it("tracks multiple state transitions", async () => {
		const client = createClient();

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: { default: () => h(TestConsumer) },
		});

		expect(wrapper.find('[data-testid="state"]').text()).toBe("disconnected");

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("stateChange", "connecting");
		await nextTick();
		expect(wrapper.find('[data-testid="state"]').text()).toBe("connecting");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("false");

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("stateChange", "connected");
		await nextTick();
		expect(wrapper.find('[data-testid="state"]').text()).toBe("connected");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("true");

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(client as any).emit("stateChange", "disconnected");
		await nextTick();
		expect(wrapper.find('[data-testid="state"]').text()).toBe("disconnected");
		expect(wrapper.find('[data-testid="connected"]').text()).toBe("false");
	});
});
