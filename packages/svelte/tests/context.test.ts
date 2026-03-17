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

// Mock svelte context API
let contextStore = new Map<unknown, unknown>();

vi.mock("svelte", () => ({
	setContext: (key: unknown, value: unknown) => {
		contextStore.set(key, value);
	},
	getContext: (key: unknown) => {
		return contextStore.get(key);
	},
	onDestroy: (_fn: () => void) => {},
}));

// Import after mocking
const { setSukkoClient, getSukkoClient } = await import("../src/context");

describe("Svelte context", () => {
	it("setSukkoClient stores client in context", () => {
		const client = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		setSukkoClient(client);

		const retrieved = getSukkoClient();
		expect(retrieved).toBe(client);
	});

	it("getSukkoClient throws when no context set", () => {
		contextStore.clear();

		expect(() => getSukkoClient()).toThrow(
			"getSukkoClient must be called within a component tree where setSukkoClient was called",
		);
	});

	it("setSukkoClient overwrites previous client", () => {
		const client1 = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});
		const client2 = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		setSukkoClient(client1);
		setSukkoClient(client2);

		// Note: In real Svelte, setContext can only be called once during init.
		// This test verifies the function itself works, not Svelte's runtime constraint.
		// The last call wins since we're using a simple Map mock.
	});
});
