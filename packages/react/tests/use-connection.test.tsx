import { SukkoClient } from "@sukko/sdk";
import { TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SukkoProvider } from "../src/context";
import { useConnectionState } from "../src/hooks/use-connection";

afterEach(cleanup);

// Mock Transport
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
	const { state, isConnected, isReconnecting } = useConnectionState();
	return (
		<div>
			<span data-testid="state">{state}</span>
			<span data-testid="connected">{String(isConnected)}</span>
			<span data-testid="reconnecting">{String(isReconnecting)}</span>
		</div>
	);
}

function createClient(): SukkoClient {
	return new SukkoClient({
		transport: new MockTransport(),
		autoConnect: false,
		reconnect: false,
	});
}

describe("useConnectionState", () => {
	it("returns initial disconnected state", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestConsumer />
			</SukkoProvider>,
		);

		expect(screen.getByTestId("state").textContent).toBe("disconnected");
		expect(screen.getByTestId("connected").textContent).toBe("false");
		expect(screen.getByTestId("reconnecting").textContent).toBe("false");
	});

	it("updates when state changes to connected", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestConsumer />
			</SukkoProvider>,
		);

		act(() => {
			(client as any)._state = "connected";
			(client as any).emit("stateChange", "connected");
		});

		expect(screen.getByTestId("state").textContent).toBe("connected");
		expect(screen.getByTestId("connected").textContent).toBe("true");
		expect(screen.getByTestId("reconnecting").textContent).toBe("false");
	});

	it("updates isReconnecting when reconnecting", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestConsumer />
			</SukkoProvider>,
		);

		act(() => {
			(client as any)._state = "reconnecting";
			(client as any).emit("stateChange", "reconnecting");
		});

		expect(screen.getByTestId("state").textContent).toBe("reconnecting");
		expect(screen.getByTestId("connected").textContent).toBe("false");
		expect(screen.getByTestId("reconnecting").textContent).toBe("true");
	});

	it("tracks multiple state transitions", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestConsumer />
			</SukkoProvider>,
		);

		expect(screen.getByTestId("state").textContent).toBe("disconnected");

		act(() => {
			(client as any)._state = "connecting";
			(client as any).emit("stateChange", "connecting");
		});
		expect(screen.getByTestId("state").textContent).toBe("connecting");
		expect(screen.getByTestId("connected").textContent).toBe("false");

		act(() => {
			(client as any)._state = "connected";
			(client as any).emit("stateChange", "connected");
		});
		expect(screen.getByTestId("state").textContent).toBe("connected");
		expect(screen.getByTestId("connected").textContent).toBe("true");

		act(() => {
			(client as any)._state = "disconnected";
			(client as any).emit("stateChange", "disconnected");
		});
		expect(screen.getByTestId("state").textContent).toBe("disconnected");
		expect(screen.getByTestId("connected").textContent).toBe("false");
	});
});
