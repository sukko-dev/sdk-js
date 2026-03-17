import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SukkoClient } from "../src/client";
import { CLOSE_CODES } from "../src/constants";
import { TypedEventEmitter } from "../src/emitter";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "../src/transport";

// ---------------------------------------------------------------------------
// Mock Transport
// ---------------------------------------------------------------------------

class MockTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	private _token = "";
	sent: string[] = [];

	get state(): TransportState {
		return this._state;
	}

	get capabilities(): TransportCapabilities {
		return { canSend: true, canSubscribe: true, canPublish: true };
	}

	/** Exposes the stored token for test assertions. */
	get token(): string {
		return this._token;
	}

	setToken(token: string): void {
		this._token = token;
	}

	open(): void {
		this._state = "opening";
		// Auto-open via microtask to mirror real transport behavior
		queueMicrotask(() => this.simulateOpen());
	}

	close(_code?: number, _reason?: string): void {
		this._state = "closed";
	}

	send(data: string): void {
		this.sent.push(data);
	}

	// Test helpers

	simulateOpen(): void {
		this._state = "open";
		this.emit("open");
	}

	simulateClose(code: number, reason = ""): void {
		this._state = "closed";
		this.emit("close", code, reason);
	}

	simulateMessage(data: unknown): void {
		this.emit("message", JSON.stringify(data));
	}

	simulateError(): void {
		this.emit("error");
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createClient(
	overrides: Partial<ConstructorParameters<typeof SukkoClient>[0]> = {},
): { client: SukkoClient; transport: MockTransport } {
	const transport = (overrides.transport as MockTransport) ?? new MockTransport();
	const client = new SukkoClient({
		transport,
		autoConnect: false,
		reconnect: false,
		...overrides,
		// Ensure transport is always the MockTransport
		...(overrides.transport ? {} : { transport }),
	});
	return { client, transport };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SukkoClient", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		SukkoClient.resetInstance();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("construction", () => {
		it("creates with default options", () => {
			const { client } = createClient();
			expect(client.state).toBe("disconnected");
			expect(client.subscriptions.size).toBe(0);
		});

		it("auto-connects when autoConnect is true", async () => {
			const transport = new MockTransport();
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: false,
			});

			// Flush microtask (MockTransport auto-opens)
			await vi.advanceTimersByTimeAsync(0);

			expect(client.state).toBe("connected");
			client.disconnect();
		});
	});

	describe("connect / disconnect", () => {
		it("transitions through connecting → connected", async () => {
			const states: string[] = [];
			const { client } = createClient();
			client.on("stateChange", (s) => states.push(s));

			client.connect();
			expect(client.state).toBe("connecting");

			await vi.advanceTimersByTimeAsync(0);
			expect(client.state).toBe("connected");
			expect(states).toContain("connecting");
			expect(states).toContain("connected");

			client.disconnect();
		});

		it("disconnect transitions to disconnected", async () => {
			const { client } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			client.disconnect();
			expect(client.state).toBe("disconnected");
		});

		it("emits close event on disconnect", async () => {
			const { client } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("close", handler);
			client.disconnect();

			expect(handler).toHaveBeenCalledWith(CLOSE_CODES.NORMAL, "Client disconnect");
		});

		it("does not double-connect if already opening", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const { client } = createClient({ transport });
			client.connect();
			client.connect(); // second call should be a no-op

			expect(openSpy).toHaveBeenCalledTimes(1);
			client.disconnect();
		});

		it("does not connect if already open", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const { client } = createClient({ transport });
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			openSpy.mockClear();
			client.connect(); // should be a no-op

			expect(openSpy).not.toHaveBeenCalled();
			client.disconnect();
		});

		it("passes token to transport via setToken before open", () => {
			const transport = new MockTransport();
			const { client } = createClient({ transport, token: "my-jwt" });

			client.connect();
			expect(transport.token).toBe("my-jwt");
		});
	});

	describe("subscriptions", () => {
		it("tracks subscriptions locally", () => {
			const { client } = createClient();
			client.subscribe(["a.b.c", "d.e.f"]);
			expect(client.subscriptions).toContain("a.b.c");
			expect(client.subscriptions).toContain("d.e.f");
		});

		it("sends subscribe message when connected", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			client.subscribe(["tenant.BTC.trade"]);

			const lastMsg = JSON.parse(transport.sent[transport.sent.length - 1]);
			expect(lastMsg.type).toBe("subscribe");
			expect(lastMsg.data.channels).toContain("tenant.BTC.trade");

			client.disconnect();
		});

		it("restores subscriptions on reconnect", async () => {
			const { client, transport } = createClient();

			// Pre-register subscriptions before connecting
			client.subscribe(["tenant.BTC.trade"]);
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// On open, should auto-subscribe
			const subscribeMsg = transport.sent.find((s) => {
				const msg = JSON.parse(s);
				return msg.type === "subscribe";
			});
			expect(subscribeMsg).toBeDefined();

			client.disconnect();
		});

		it("unsubscribe removes from tracked set", () => {
			const { client } = createClient();
			client.subscribe(["a.b.c"]);
			client.unsubscribe(["a.b.c"]);
			expect(client.subscriptions.size).toBe(0);
		});
	});

	describe("message handling", () => {
		it("emits typed events for incoming messages", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("message", handler);

			transport.simulateMessage({
				type: "message",
				seq: 1,
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { price: 50000 },
			});

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].channel).toBe("tenant.BTC.trade");

			client.disconnect();
		});

		it("emits subscriptionAck events", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("subscriptionAck", handler);

			transport.simulateMessage({
				type: "subscription_ack",
				subscribed: ["tenant.BTC.trade"],
				count: 1,
			});

			expect(handler).toHaveBeenCalledOnce();

			client.disconnect();
		});

		it("emits publishAck events", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("publishAck", handler);

			transport.simulateMessage({
				type: "publish_ack",
				channel: "tenant.BTC.trade",
				status: "accepted",
			});

			expect(handler).toHaveBeenCalledOnce();
			client.disconnect();
		});

		it("emits error events for invalid_json", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("error", handler);

			transport.simulateMessage({
				type: "error",
				code: "invalid_json",
				message: "bad json",
			});

			expect(handler).toHaveBeenCalledOnce();
			client.disconnect();
		});

		it("emits authAck events", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("authAck", handler);

			transport.simulateMessage({
				type: "auth_ack",
				data: { exp: 1234567890 },
			});

			expect(handler).toHaveBeenCalledOnce();
			client.disconnect();
		});

		it("silently ignores unparseable messages", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// Send raw invalid JSON string directly
			expect(() => {
				transport.emit("message", "not json{{{");
			}).not.toThrow();

			client.disconnect();
		});
	});

	describe("heartbeat", () => {
		it("sends heartbeat at configured interval", async () => {
			const { client, transport } = createClient({
				heartbeatInterval: 1000,
				heartbeatTimeout: 500,
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0; // clear subscribe messages

			await vi.advanceTimersByTimeAsync(1000);

			const heartbeat = transport.sent.find((s) => JSON.parse(s).type === "heartbeat");
			expect(heartbeat).toBeDefined();

			client.disconnect();
		});

		it("closes transport on heartbeat timeout", async () => {
			const transport = new MockTransport();
			const closeSpy = vi.spyOn(transport, "close");

			const { client } = createClient({
				transport,
				heartbeatInterval: 1000,
				heartbeatTimeout: 500,
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// Advance past heartbeat interval + timeout
			await vi.advanceTimersByTimeAsync(1000); // heartbeat sent
			await vi.advanceTimersByTimeAsync(500); // pong timeout

			expect(closeSpy).toHaveBeenCalledWith(CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");
		});

		it("clears pong timeout on incoming message", async () => {
			const transport = new MockTransport();
			const closeSpy = vi.spyOn(transport, "close");

			const { client } = createClient({
				transport,
				heartbeatInterval: 1000,
				heartbeatTimeout: 500,
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(1000); // heartbeat sent

			// Simulate pong before timeout
			transport.simulateMessage({ type: "pong", ts: Date.now() });

			await vi.advanceTimersByTimeAsync(500); // would have timed out

			// close should not have been called with heartbeat timeout
			expect(closeSpy).not.toHaveBeenCalledWith(
				CLOSE_CODES.HEARTBEAT_TIMEOUT,
				"Heartbeat timeout",
			);

			client.disconnect();
		});
	});

	describe("publish", () => {
		it("sends publish message when connected", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			client.publish("tenant.BTC.trade", { price: 50000 });

			const pub = transport.sent.find((s) => JSON.parse(s).type === "publish");
			expect(pub).toBeDefined();
			const parsed = JSON.parse(pub!);
			expect(parsed.data.channel).toBe("tenant.BTC.trade");
			expect(parsed.data.data).toEqual({ price: 50000 });

			client.disconnect();
		});

		it("does not send when disconnected", () => {
			const { client, transport } = createClient();
			client.publish("tenant.BTC.trade", { price: 50000 });

			expect(transport.sent.length).toBe(0);
		});
	});

	describe("token", () => {
		it("updateToken changes stored token for next connect", () => {
			const transport = new MockTransport();
			const { client } = createClient({ transport, token: "old" });

			client.updateToken("refreshed");
			client.connect();

			expect(transport.token).toBe("refreshed");
			client.disconnect();
		});

		it("refreshToken calls getToken and sends auth message", async () => {
			const { client, transport } = createClient({
				getToken: async () => "fresh-token",
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			await client.refreshToken();

			const authMsg = transport.sent.find((s) => JSON.parse(s).type === "auth");
			expect(authMsg).toBeDefined();
			expect(JSON.parse(authMsg!).data.token).toBe("fresh-token");

			client.disconnect();
		});

		it("refreshToken throws if no getToken configured", async () => {
			const { client } = createClient();
			await expect(client.refreshToken()).rejects.toThrow("no getToken callback");
		});
	});

	describe("singleton", () => {
		it("getInstance creates and returns singleton", () => {
			const transport = new MockTransport();
			const client = SukkoClient.getInstance({
				transport,
				autoConnect: false,
			});
			const same = SukkoClient.getInstance();
			expect(same).toBe(client);
		});

		it("getInstance throws without options on first call", () => {
			expect(() => SukkoClient.getInstance()).toThrow();
		});

		it("resetInstance disconnects and clears", () => {
			const transport = new MockTransport();
			SukkoClient.getInstance({
				transport,
				autoConnect: false,
			});
			SukkoClient.resetInstance();
			expect(() => SukkoClient.getInstance()).toThrow();
		});
	});

	describe("reconnection", () => {
		it("reconnects on abnormal close when reconnect is enabled", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				reconnectAttempts: 3,
				reconnectDelayBase: 100,
				reconnectDelayMax: 1000,
			});

			await vi.advanceTimersByTimeAsync(0);
			expect(client.state).toBe("connected");
			openSpy.mockClear();

			// Simulate abnormal close
			const reconnectingHandler = vi.fn();
			client.on("reconnecting", reconnectingHandler);
			transport.simulateClose(1006, "Abnormal");

			expect(client.state).toBe("reconnecting");
			expect(reconnectingHandler).toHaveBeenCalledWith(1);

			// Advance past reconnect delay
			await vi.advanceTimersByTimeAsync(1200);
			expect(openSpy).toHaveBeenCalled();

			client.disconnect();
		});

		it("does not reconnect on normal close", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
			});

			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			// Normal close
			transport.simulateClose(CLOSE_CODES.NORMAL);

			await vi.advanceTimersByTimeAsync(5000);
			expect(openSpy).not.toHaveBeenCalled();
			expect(client.state).toBe("disconnected");
		});

		it("does not reconnect on going_away close", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
			});

			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			transport.simulateClose(CLOSE_CODES.GOING_AWAY);

			await vi.advanceTimersByTimeAsync(5000);
			expect(openSpy).not.toHaveBeenCalled();
			expect(client.state).toBe("disconnected");
		});

		it("does not reconnect when reconnect is disabled", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");

			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: false,
			});

			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			transport.simulateClose(1006, "Abnormal");

			await vi.advanceTimersByTimeAsync(5000);
			expect(openSpy).not.toHaveBeenCalled();
			expect(client.state).toBe("disconnected");
		});

		it("switches to error state after max reconnect attempts", async () => {
			// Use a transport that doesn't auto-open, so reconnect attempts
			// fail (close fires again immediately) without resetting the counter.
			const transport = new MockTransport();
			// Override open to NOT auto-open — simulates repeated failed connections
			transport.open = function () {
				(this as any)._state = "opening";
				// Immediately fail the connection
				queueMicrotask(() => this.simulateClose(1006, "Connection refused"));
			};

			const client = new SukkoClient({
				transport,
				autoConnect: false,
				reconnect: true,
				reconnectAttempts: 2,
				reconnectDelayBase: 100,
				reconnectDelayMax: 500,
			});

			// Manually set up initial "connected" state, then let reconnection kick in
			transport.open = function () {
				(this as any)._state = "opening";
				queueMicrotask(() => this.simulateOpen());
			};
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			expect(client.state).toBe("connected");

			// Now override open to simulate failure (close immediately)
			transport.open = function () {
				(this as any)._state = "opening";
				queueMicrotask(() => this.simulateClose(1006, "Connection refused"));
			};

			// First failure: triggers reconnection attempt 1
			transport.simulateClose(1006);
			expect(client.state).toBe("reconnecting");

			// Advance past reconnect delay → connect() → immediate close → attempt 2
			await vi.advanceTimersByTimeAsync(1200);
			await vi.advanceTimersByTimeAsync(0);

			// Advance past second reconnect delay → connect() → immediate close → attempt >= max
			await vi.advanceTimersByTimeAsync(1200);
			await vi.advanceTimersByTimeAsync(0);

			expect(client.state).toBe("error");

			client.disconnect();
		});
	});

	describe("replay", () => {
		it("sends reconnect message with stored offsets", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// Simulate a message to populate offsets
			transport.simulateMessage({
				type: "message",
				seq: 42,
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { price: 50000 },
			});

			client.reconnectWithReplay();

			const reconnectMsg = transport.sent.find((s) => JSON.parse(s).type === "reconnect");
			expect(reconnectMsg).toBeDefined();
			const parsed = JSON.parse(reconnectMsg!);
			expect(parsed.data.last_offset["tenant.BTC.trade"]).toBe(42);

			client.disconnect();
		});

		it("does not send reconnect when disconnected", () => {
			const { client, transport } = createClient();
			client.reconnectWithReplay();
			expect(transport.sent.length).toBe(0);
		});
	});
});
