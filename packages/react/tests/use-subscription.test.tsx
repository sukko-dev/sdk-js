import { SukkoClient } from "@sukko/sdk";
import type { DataMessage } from "@sukko/sdk";
import { TypedEventEmitter } from "@sukko/sdk";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "@sukko/sdk";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SukkoProvider } from "../src/context";
import { useSubscription } from "../src/hooks/use-subscription";

afterEach(cleanup);

// Mock Transport
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

function createClient(): SukkoClient {
	return new SukkoClient({
		transport: new MockTransport(),
		autoConnect: false,
		reconnect: false,
	});
}

interface TestData {
	price: number;
}

function TestSubscriber({
	channels,
	enabled,
	onMessage,
}: {
	channels: string[];
	enabled?: boolean;
	onMessage?: (msg: DataMessage<TestData>) => void;
}) {
	const { lastMessage, data, isSubscribed } = useSubscription<TestData>({
		channels,
		enabled,
		onMessage,
	});

	return (
		<div>
			<span data-testid="data">{data ? JSON.stringify(data) : "null"}</span>
			<span data-testid="channel">{lastMessage?.channel ?? "none"}</span>
			<span data-testid="subscribed">{String(isSubscribed)}</span>
		</div>
	);
}

describe("useSubscription", () => {
	it("returns null data initially", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} />
			</SukkoProvider>,
		);

		expect(screen.getByTestId("data").textContent).toBe("null");
		expect(screen.getByTestId("channel").textContent).toBe("none");
	});

	it("receives messages on subscribed channels", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} />
			</SukkoProvider>,
		);

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		};

		act(() => {
			(client as any).emit("message", msg);
		});

		expect(screen.getByTestId("data").textContent).toBe('{"price":50000}');
		expect(screen.getByTestId("channel").textContent).toBe("tenant.BTC.trade");
	});

	it("ignores messages on unsubscribed channels", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} />
			</SukkoProvider>,
		);

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.ETH.trade",
			data: { price: 3000 },
		};

		act(() => {
			(client as any).emit("message", msg);
		});

		expect(screen.getByTestId("data").textContent).toBe("null");
		expect(screen.getByTestId("channel").textContent).toBe("none");
	});

	it("calls onMessage callback", () => {
		const client = createClient();
		const onMessage = vi.fn();

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} onMessage={onMessage} />
			</SukkoProvider>,
		);

		const msg: DataMessage<TestData> = {
			type: "message",
			seq: 1,
			ts: Date.now(),
			channel: "tenant.BTC.trade",
			data: { price: 50000 },
		};

		act(() => {
			(client as any).emit("message", msg);
		});

		expect(onMessage).toHaveBeenCalledOnce();
		expect(onMessage.mock.calls[0][0].data.price).toBe(50000);
	});

	it("does not subscribe when enabled is false", () => {
		const client = createClient();
		const subscribeSpy = vi.spyOn(client, "subscribe");

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} enabled={false} />
			</SukkoProvider>,
		);

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
	});

	it("does not subscribe when channels array is empty", () => {
		const client = createClient();
		const subscribeSpy = vi.spyOn(client, "subscribe");

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={[]} />
			</SukkoProvider>,
		);

		expect(subscribeSpy).not.toHaveBeenCalled();
		subscribeSpy.mockRestore();
	});

	it("updates data on subsequent messages", () => {
		const client = createClient();

		render(
			<SukkoProvider client={client}>
				<TestSubscriber channels={["tenant.BTC.trade"]} />
			</SukkoProvider>,
		);

		act(() => {
			(client as any).emit("message", {
				type: "message",
				seq: 1,
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { price: 50000 },
			} satisfies DataMessage<TestData>);
		});

		expect(screen.getByTestId("data").textContent).toBe('{"price":50000}');

		act(() => {
			(client as any).emit("message", {
				type: "message",
				seq: 2,
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { price: 51000 },
			} satisfies DataMessage<TestData>);
		});

		expect(screen.getByTestId("data").textContent).toBe('{"price":51000}');
	});
});
