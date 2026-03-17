import { SukkoClient } from "@sukko/sdk";
import { TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SukkoProvider } from "../src/context";
import { useSukkoClient } from "../src/hooks/use-client";

afterEach(cleanup);

// Mock Transport for SukkoClient
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

function TestConsumer() {
	const client = useSukkoClient();
	return <div data-testid="state">{client.state}</div>;
}

describe("SukkoProvider", () => {
	it("renders children", () => {
		const client = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		render(
			<SukkoProvider client={client}>
				<div data-testid="child">hello</div>
			</SukkoProvider>,
		);

		expect(screen.getByTestId("child")).toBeDefined();
	});

	it("provides client to child components", () => {
		const client = new SukkoClient({
			transport: new MockTransport(),
			autoConnect: false,
		});

		render(
			<SukkoProvider client={client}>
				<TestConsumer />
			</SukkoProvider>,
		);

		expect(screen.getByTestId("state").textContent).toBe("disconnected");
	});

	it("creates client from options", () => {
		render(
			<SukkoProvider
				options={{
					transport: new MockTransport(),
					autoConnect: false,
				}}
			>
				<TestConsumer />
			</SukkoProvider>,
		);

		expect(screen.getByTestId("state").textContent).toBe("disconnected");
	});

	it("useSukkoClient throws outside provider", () => {
		// Suppress console.error for expected error
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		expect(() => render(<TestConsumer />)).toThrow(
			"useSukkoClient must be used within a <SukkoProvider>",
		);

		spy.mockRestore();
	});
});
