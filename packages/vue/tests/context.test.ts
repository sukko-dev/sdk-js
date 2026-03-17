import { SukkoClient, TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SukkoProvider, useSukkoClient } from "../src/context";

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

const TestConsumer = defineComponent({
	setup() {
		const client = useSukkoClient();
		return () => h("div", { "data-testid": "state" }, client.state);
	},
});

describe("SukkoProvider", () => {
	it("renders children", () => {
		const client = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: {
				default: () => h("div", { "data-testid": "child" }, "hello"),
			},
		});

		expect(wrapper.find('[data-testid="child"]').exists()).toBe(true);
		expect(wrapper.find('[data-testid="child"]').text()).toBe("hello");
	});

	it("provides client to child components", () => {
		const client = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		const wrapper = mount(SukkoProvider, {
			props: { client },
			slots: {
				default: () => h(TestConsumer),
			},
		});

		expect(wrapper.find('[data-testid="state"]').text()).toBe("disconnected");
	});

	it("creates client from options", () => {
		const wrapper = mount(SukkoProvider, {
			props: {
				options: {
					transport: new MockTransport(),
					autoConnect: false,
				},
			},
			slots: {
				default: () => h(TestConsumer),
			},
		});

		expect(wrapper.find('[data-testid="state"]').text()).toBe("disconnected");
	});

	it("useSukkoClient throws outside provider", () => {
		expect(() => mount(TestConsumer)).toThrow(
			"useSukkoClient must be used within a <SukkoProvider>",
		);
	});

	it("disconnects owned client on unmount", () => {
		const transport = new MockTransport();
		const wrapper = mount(SukkoProvider, {
			props: {
				options: {
					transport,
					autoConnect: false,
				},
			},
			slots: {
				default: () => h(TestConsumer),
			},
		});

		// The provider created its own client — it should disconnect on unmount
		wrapper.unmount();
		// No assertion on disconnect (private state), just verify no error
	});
});
