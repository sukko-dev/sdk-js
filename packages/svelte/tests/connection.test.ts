import { SukkoClient, TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { describe, expect, it, vi } from "vitest";

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

// Mock svelte context to provide client
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

const { createConnectionState } = await import("../src/stores/connection");

describe("createConnectionState", () => {
	it("returns initial state", () => {
		mockClient = createClient();

		const store = createConnectionState();
		let value: { state: string; isConnected: boolean; isReconnecting: boolean } | undefined;

		const unsub = store.subscribe((v) => {
			value = v;
		});

		expect(value?.state).toBe("disconnected");
		expect(value?.isConnected).toBe(false);
		expect(value?.isReconnecting).toBe(false);
		unsub();
	});

	it("updates on stateChange event", () => {
		mockClient = createClient();

		const store = createConnectionState();
		let value: { state: string; isConnected: boolean; isReconnecting: boolean } | undefined;

		const unsub = store.subscribe((v) => {
			value = v;
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("stateChange", "connected");

		expect(value?.state).toBe("connected");
		expect(value?.isConnected).toBe(true);
		expect(value?.isReconnecting).toBe(false);
		unsub();
	});

	it("tracks reconnecting state", () => {
		mockClient = createClient();

		const store = createConnectionState();
		let value: { state: string; isConnected: boolean; isReconnecting: boolean } | undefined;

		const unsub = store.subscribe((v) => {
			value = v;
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("stateChange", "reconnecting");

		expect(value?.state).toBe("reconnecting");
		expect(value?.isConnected).toBe(false);
		expect(value?.isReconnecting).toBe(true);
		unsub();
	});

	it("tracks multiple transitions", () => {
		mockClient = createClient();

		const store = createConnectionState();
		const values: string[] = [];

		const unsub = store.subscribe((v) => {
			values.push(v.state);
		});

		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("stateChange", "connecting");
		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("stateChange", "connected");
		// biome-ignore lint/suspicious/noExplicitAny: test access to private emitter
		(mockClient as any).emit("stateChange", "disconnected");

		expect(values).toEqual(["disconnected", "connecting", "connected", "disconnected"]);
		unsub();
	});
});
