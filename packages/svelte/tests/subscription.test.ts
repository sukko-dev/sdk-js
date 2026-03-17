import { SukkoClient, TypedEventEmitter } from "@sukko/sdk";
import type { DataMessage, Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { describe, expect, it, vi } from "vitest";

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

let mockClient: SukkoClient;

vi.mock("svelte", () => ({
	setContext: () => {},
	getContext: () => mockClient,
	onDestroy: (_fn: () => void) => {},
}));

vi.mock("svelte/store", async () => {
	const actual = await vi.importActual<typeof import("svelte/store")>("svelte/store");
	return actual;
});

const { createSubscription } = await import("../src/stores/subscription");

describe("createSubscription", () => {
	it("returns null data initially", () => {
		mockClient = createClient();

		const store = createSubscription<TestData>({ channels: ["tenant.BTC.trade"] });
		let value: { data: TestData | null; isSubscribed: boolean } | undefined;

		const unsub = store.subscribe((v) => {
			value = v;
		});

		// After subscription starts, isSubscribed is true but data is null
		expect(value?.data).toBe(null);
		expect(value?.isSubscribed).toBe(true);
		unsub();
	});

	it("receives messages on subscribed channels", () => {
		mockClient = createClient();

		const store = createSubscription<TestData>({ channels: ["tenant.BTC.trade"] });
		let value: { data: TestData | null; lastMessage: DataMessage<TestData> | null } | undefined;

		const unsub = store.subscribe((v) => {
			value = v;
		});

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		};

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("message", msg);

		expect(value?.data?.price).toBe(50000);
		expect(value?.lastMessage?.channel).toBe("tenant.BTC.trade");
		unsub();
	});

	it("ignores messages on unsubscribed channels", () => {
		mockClient = createClient();

		const store = createSubscription<TestData>({ channels: ["tenant.BTC.trade"] });
		let updateCount = 0;

		const unsub = store.subscribe(() => {
			updateCount++;
		});

		const initialCount = updateCount;

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("message", {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.ETH.trade",
			data: { price: 3000 },
		} satisfies DataMessage<TestData>);

		expect(updateCount).toBe(initialCount); // no update for wrong channel
		unsub();
	});

	it("calls onMessage callback", () => {
		mockClient = createClient();
		const onMessage = vi.fn();

		const store = createSubscription<TestData>({
			channels: ["tenant.BTC.trade"],
			onMessage,
		});

		const unsub = store.subscribe(() => {});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("message", {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		} satisfies DataMessage<TestData>);

		expect(onMessage).toHaveBeenCalledOnce();
		expect(onMessage.mock.calls[0][0].data.price).toBe(50000);
		unsub();
	});

	it("does not subscribe when enabled is false", () => {
		mockClient = createClient();
		const subscribeSpy = vi.spyOn(mockClient, "subscribe");

		const store = createSubscription<TestData>({
			channels: ["tenant.BTC.trade"],
			enabled: false,
		});

		const unsub = store.subscribe(() => {});

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
		unsub();
	});

	it("does not subscribe when channels array is empty", () => {
		mockClient = createClient();
		const subscribeSpy = vi.spyOn(mockClient, "subscribe");

		const store = createSubscription<TestData>({ channels: [] });

		const unsub = store.subscribe(() => {});

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
		unsub();
	});

	it("calls client.subscribe with channels", () => {
		mockClient = createClient();
		const subscribeSpy = vi.spyOn(mockClient, "subscribe");

		const store = createSubscription<TestData>({
			channels: ["tenant.BTC.trade", "tenant.ETH.trade"],
		});

		const unsub = store.subscribe(() => {});

		expect(subscribeSpy).toHaveBeenCalledWith(["tenant.BTC.trade", "tenant.ETH.trade"]);
		subscribeSpy.mockRestore();
		unsub();
	});

	it("calls client.unsubscribe on store stop", () => {
		mockClient = createClient();
		const unsubscribeSpy = vi.spyOn(mockClient, "unsubscribe");

		const store = createSubscription<TestData>({
			channels: ["tenant.BTC.trade"],
		});

		const unsub = store.subscribe(() => {});
		unsub(); // Stop the store

		expect(unsubscribeSpy).toHaveBeenCalledWith(["tenant.BTC.trade"]);
		unsubscribeSpy.mockRestore();
	});
});
