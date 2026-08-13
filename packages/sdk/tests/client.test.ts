import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemClock } from "../src/_clock";
import { SukkoClient } from "../src/client";
import { CLOSE_CODES } from "../src/constants";
import { TypedEventEmitter } from "../src/emitter";
import {
	ConfigurationError,
	NotConnectedError,
	RecoveryInterruptedError,
	TransportError,
	UnauthorizedError,
} from "../src/errors";
import type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "../src/transport";

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
		return { canSend: true, canSubscribe: true, canPublish: true, canPauseReceive: false };
	}

	/** Exposes the stored token for test assertions. */
	get token(): string {
		return this._token;
	}

	setToken(token: string): void {
		this._token = token;
	}

	pause(): void {}

	resume(): void {}

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

function createClient(overrides: Partial<ConstructorParameters<typeof SukkoClient>[0]> = {}): {
	client: SukkoClient;
	transport: MockTransport;
} {
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

/** A client with automatic reconnect + deterministic Full-Jitter backoff (rng must be mocked to 0.5). */
function createReconnectableClient(): { client: SukkoClient; transport: MockTransport } {
	const transport = new MockTransport();
	const client = new SukkoClient({
		transport,
		autoConnect: true,
		reconnect: true,
		backoffBaseMs: 1000,
		backoffMaxMs: 1000,
	});
	return { client, transport };
}

/** Drive one automatic reconnect (reconnect:true) and return the resulting `reconnect` frame's `data`. */
async function reconnectFrame(
	transport: MockTransport,
): Promise<Record<string, unknown> | undefined> {
	transport.sent.length = 0;
	transport.simulateClose(1006, "reconnect"); // → reconnecting
	await vi.advanceTimersByTimeAsync(1000); // past the 500ms backoff (rng 0.5) → the second open
	const frame = transport.sent.find((s) => JSON.parse(s).type === "reconnect");
	return frame ? (JSON.parse(frame).data as Record<string, unknown>) : undefined;
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
		vi.restoreAllMocks();
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
				heartbeatIntervalMs: 1000,
				pongTimeoutMs: 500,
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
				heartbeatIntervalMs: 1000,
				pongTimeoutMs: 500,
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
				heartbeatIntervalMs: 1000,
				pongTimeoutMs: 500,
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			await vi.advanceTimersByTimeAsync(1000); // heartbeat sent

			// Simulate pong before timeout
			transport.simulateMessage({ type: "pong", ts: Date.now() });

			await vi.advanceTimersByTimeAsync(500); // would have timed out

			// close should not have been called with heartbeat timeout
			expect(closeSpy).not.toHaveBeenCalledWith(CLOSE_CODES.HEARTBEAT_TIMEOUT, "Heartbeat timeout");

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

		it("refreshToken calls getToken and sends auth, resolving on auth_ack (single-flight)", async () => {
			const { client, transport } = createClient({
				getToken: async () => "fresh-token",
			});

			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// refreshToken now AWAITS the ack — start it, assert the frame, then resolve it via auth_ack.
			const refreshing = client.refreshToken();
			await vi.advanceTimersByTimeAsync(0);
			const authMsg = transport.sent.find((s) => JSON.parse(s).type === "auth");
			expect(authMsg).toBeDefined();
			expect(JSON.parse(authMsg!).data.token).toBe("fresh-token");

			transport.simulateMessage({ type: "auth_ack", data: { exp: 0 } }); // 0 = no-expiry (no proactive timer)
			await expect(refreshing).resolves.toBeUndefined();

			client.disconnect();
		});

		it("refreshToken rejects with NotConnectedError while disconnected", async () => {
			const { client } = createClient({ getToken: async () => "t" });
			await expect(client.refreshToken()).rejects.toThrow(NotConnectedError);
		});

		it("refreshToken rejects when the server sends auth_error", async () => {
			const { client, transport } = createClient({ getToken: async () => "bad-token" });
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const refreshing = client.refreshToken();
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({
				type: "auth_error",
				data: { code: "invalid_token", message: "nope" },
			});
			await expect(refreshing).rejects.toThrow(UnauthorizedError);

			client.disconnect();
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
				reconnectMaxAttempts: 3,
				backoffBaseMs: 100,
				backoffMaxMs: 1000,
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

		it("reconnects on going_away (1001) — transient per FR-019", async () => {
			const transport = new MockTransport();
			const client = new SukkoClient({ transport, autoConnect: true, reconnect: true });
			await vi.advanceTimersByTimeAsync(0);

			transport.simulateClose(CLOSE_CODES.GOING_AWAY);
			expect(client.state).toBe("reconnecting");
			client.disconnect();
		});

		it("reconnects on internal_error (1011) but is terminal on policy_violation (1008)", async () => {
			const t1 = new MockTransport();
			const c1 = new SukkoClient({ transport: t1, autoConnect: true, reconnect: true });
			await vi.advanceTimersByTimeAsync(0);
			t1.simulateClose(CLOSE_CODES.INTERNAL_ERROR);
			expect(c1.state).toBe("reconnecting"); // 1011 transient
			c1.disconnect();

			const t2 = new MockTransport();
			const c2 = new SukkoClient({ transport: t2, autoConnect: true, reconnect: true });
			await vi.advanceTimersByTimeAsync(0);
			t2.simulateClose(CLOSE_CODES.POLICY_VIOLATION);
			expect(c2.state).toBe("disconnected"); // 1008 terminal
		});

		it("is terminal on a REMOTE 4000 (operator force_disconnect), no reconnect", async () => {
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");
			const client = new SukkoClient({ transport, autoConnect: true, reconnect: true });
			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			transport.simulateClose(CLOSE_CODES.FORCE_DISCONNECT, "force disconnect"); // no local code → remote
			await vi.advanceTimersByTimeAsync(5000);
			expect(openSpy).not.toHaveBeenCalled();
			expect(client.state).toBe("disconnected");
		});

		it("reconnects on a heartbeat timeout and actually re-opens after backoff (no server close echo)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic Full-Jitter delay (restored in afterEach)
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				heartbeatIntervalMs: 100,
				pongTimeoutMs: 50,
				backoffBaseMs: 1000,
				backoffMaxMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			// Heartbeat goes out at 100; its pong window (50) elapses at t=150 with no inbound frame → the
			// monitor fires onTimeout → the client tears the epoch down and reconnects WITHOUT any transport
			// close echo (client-initiated close() is suppressed by the transport). No simulateClose needed.
			// Backoff delay = 0.5 * min(1000, 1000) = 500, so connect() is scheduled for t=650.
			await vi.advanceTimersByTimeAsync(300); // t=300 < 650 → still backing off
			expect(client.state).toBe("reconnecting");

			// Past the backoff — the scheduled connect() must actually RE-OPEN the socket (proving the
			// close-before-reconnect ordering), not no-op against a not-yet-closed transport.
			await vi.advanceTimersByTimeAsync(400); // t=700 > 650
			expect(openSpy).toHaveBeenCalled();
			expect(client.state).toBe("connected");
			client.disconnect();
		});

		it("routes reconnect backoff + jitter through the injected clock (NFR-006)", async () => {
			const clock = new SystemClock();
			const sleepSpy = vi.spyOn(clock, "sleep");
			const rngSpy = vi.spyOn(clock, "rng").mockReturnValue(0.5);
			const transport = new MockTransport();
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				clock,
				backoffBaseMs: 1000,
				backoffMaxMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(0);

			transport.simulateClose(1006, "Abnormal");
			expect(client.state).toBe("reconnecting");
			expect(rngSpy).toHaveBeenCalled(); // jitter via the injected clock's RNG
			// backoff sleep via the injected clock: delay = 0.5 * min(1000, 1000) = 500
			expect(sleepSpy).toHaveBeenCalledWith(500, expect.anything());
			client.disconnect();
		});

		it("disconnect() cancels a pending reconnect backoff", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const transport = new MockTransport();
			const openSpy = vi.spyOn(transport, "open");
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				backoffBaseMs: 1000,
				backoffMaxMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(0);
			openSpy.mockClear();

			transport.simulateClose(1006, "Abnormal"); // → reconnecting, backoff (500) pending
			expect(client.state).toBe("reconnecting");
			client.disconnect(); // aborts shutdown → cancels the pending reconnect
			await vi.advanceTimersByTimeAsync(2000); // well past the 500 backoff
			expect(openSpy).not.toHaveBeenCalled(); // the reconnect never fired
			expect(client.state).toBe("disconnected");
		});

		it("re-enables reconnect after a disconnect→connect cycle (shutdown controller reuse)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const transport = new MockTransport();
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				backoffBaseMs: 1000,
				backoffMaxMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(0);
			client.disconnect(); // aborts shutdown
			client.connect(); // must re-open a fresh (non-aborted) shutdown scope
			await vi.advanceTimersByTimeAsync(0);
			expect(client.state).toBe("connected");

			const openSpy = vi.spyOn(transport, "open");
			transport.simulateClose(1006, "Abnormal");
			expect(client.state).toBe("reconnecting"); // reconnect still works — shutdown wasn't stuck aborted
			await vi.advanceTimersByTimeAsync(600); // past backoff 500
			expect(openSpy).toHaveBeenCalled();
			expect(client.state).toBe("connected");
			client.disconnect();
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
				reconnectMaxAttempts: 2,
				backoffBaseMs: 100,
				backoffMaxMs: 500,
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

	describe("reconnect-replay", () => {
		// buildReconnect()'s pos-map content (only-channels-with-pos, empty-probe, forget-exclusion) is
		// unit-tested in recovery.test.ts; these assert the CLIENT resends that frame automatically on
		// reconnect and that unsubscribe (→ recovery.forget) is reflected in it.
		beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0.5));

		it("resends the reconnect-replay frame with stored pos automatically on reconnect", async () => {
			const { client, transport } = createReconnectableClient();
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { price: 50000 },
				pos: "3-42",
			});

			const data = await reconnectFrame(transport);
			expect(data?.last_pos).toEqual({ "tenant.BTC.trade": "3-42" });

			client.disconnect();
		});

		it("excludes an unsubscribed channel's pos from the reconnect-replay (unsubscribe → forget)", async () => {
			const { client, transport } = createReconnectableClient();
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: {},
				pos: "2-50",
			});
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.ETH.trade",
				data: {},
				pos: "3-99",
			});
			client.unsubscribe(["tenant.BTC.trade"]);

			const data = await reconnectFrame(transport);
			expect(data?.last_pos).toEqual({ "tenant.ETH.trade": "3-99" });

			client.disconnect();
		});
	});

	describe("recovery routing", () => {
		it("sends no reconnect frame on the first open, but probes on the reconnect (ordering)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5); // deterministic Full-Jitter delay
			const transport = new MockTransport();
			const client = new SukkoClient({
				transport,
				autoConnect: true,
				reconnect: true,
				backoffBaseMs: 1000,
				backoffMaxMs: 1000,
			});
			await vi.advanceTimersByTimeAsync(0);

			// First open: buildReconnect() is null before markConnected() → no reconnect frame.
			expect(transport.sent.find((s) => JSON.parse(s).type === "reconnect")).toBeUndefined();

			transport.simulateClose(1006, "Abnormal"); // → reconnecting, backoff 500 pending
			await vi.advanceTimersByTimeAsync(600); // past the backoff → the socket reopens
			expect(client.state).toBe("connected");

			// Second open: a Direct-probe (empty last_pos, no pos yet) IS sent.
			const reconnect = transport.sent.find((s) => JSON.parse(s).type === "reconnect");
			expect(reconnect).toBeDefined();
			expect(JSON.parse(reconnect!).data.last_pos).toEqual({});

			client.disconnect();
		});

		it("routes a live gap to an immediate replay and surfaces the gap on messages()", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0;

			const iterator = client.messages();
			const pending = iterator.next();
			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			});

			// The floor is open on the first gap → replay is sent synchronously.
			const replay = transport.sent.find((s) => JSON.parse(s).type === "replay");
			expect(replay).toBeDefined();
			expect(JSON.parse(replay!).data).toEqual({ channel: "tenant.BTC.trade", from_pos: "2-100" });

			// The gap is also surfaced to the delivery stream.
			const { value } = await pending;
			expect(value).toMatchObject({ type: "gap", channel: "tenant.BTC.trade", last_pos: "2-100" });

			client.disconnect();
		});

		it("drops a malformed gap (missing last_pos or channel) — no replay, kept off messages()", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0;

			const iterator = client.messages();
			const pending = iterator.next();

			// A gap missing its required `last_pos`, and one missing its required `channel` — both must be
			// dropped: no `replay` sent, and neither surfaced to the delivery stream (FR-025/§II).
			transport.simulateMessage({ type: "gap", channel: "tenant.BTC.trade", ts: Date.now() });
			transport.simulateMessage({ type: "gap", last_pos: "2-100", ts: Date.now() });
			expect(transport.sent.find((s) => JSON.parse(s).type === "replay")).toBeUndefined();

			// The next thing to reach messages() is a well-formed live message, proving neither bad gap was
			// enqueued ahead of it.
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: { ok: true },
			});
			const { value } = await pending;
			expect(value).toMatchObject({ type: "message", data: { ok: true } });

			client.disconnect();
		});

		it("tracks pos from replayed messages and enqueues them on the delivery stream", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const iterator = client.messages();
			const pending = iterator.next();
			transport.simulateMessage({
				type: "replay_message",
				channel: "tenant.BTC.trade",
				ts: Date.now(),
				data: { price: 1 },
				pos: "5-7",
			});
			const { value } = await pending;
			expect(value).toMatchObject({ type: "replay_message", channel: "tenant.BTC.trade" });

			client.disconnect();
		});

		it("anchors the reconnect-replay from a replayed message's pos", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const { client, transport } = createReconnectableClient();
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({
				type: "replay_message",
				channel: "tenant.BTC.trade",
				ts: Date.now(),
				data: { price: 1 },
				pos: "5-7",
			});

			const data = await reconnectFrame(transport);
			expect(data?.last_pos).toEqual({ "tenant.BTC.trade": "5-7" });

			client.disconnect();
		});

		it("degrades to a PossibleGap per channel on reconnect_error: not_available", async () => {
			const { client, transport } = createClient();
			client.subscribe(["tenant.BTC.trade", "tenant.ETH.trade"]);
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const iterator = client.messages();
			const first = iterator.next();
			transport.simulateMessage({
				type: "reconnect_error",
				code: "not_available",
				message: "direct backend",
			});
			const { value: v1 } = await first;
			const { value: v2 } = await iterator.next();
			expect(v1).toMatchObject({ type: "possible_gap" });
			expect(v2).toMatchObject({ type: "possible_gap" });
			const channels = [v1, v2].map((v) => (v as { channel: string }).channel).sort();
			expect(channels).toEqual(["tenant.BTC.trade", "tenant.ETH.trade"]);

			client.disconnect();
		});

		it("stops sending reconnect frames once degraded to Direct (no more probing)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const { client, transport } = createReconnectableClient();
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({
				type: "reconnect_error",
				code: "not_available",
				message: "direct",
			});

			// Direct persists across reconnect → buildReconnect() returns null → no reconnect frame.
			const data = await reconnectFrame(transport);
			expect(data).toBeUndefined();

			client.disconnect();
		});

		it("emits reconnectError for a non-not_available reconnect_error code", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("reconnectError", handler);
			transport.simulateMessage({
				type: "reconnect_error",
				code: "replay_failed",
				message: "boom",
			});

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].code).toBe("replay_failed");

			client.disconnect();
		});

		it("emits recoveryInterrupted when the connection drops mid-replay", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			}); // → replaying

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			transport.simulateClose(1006, "Abnormal"); // drop mid-replay

			expect(handler).toHaveBeenCalledOnce();
			const err = handler.mock.calls[0][0];
			expect(err).toBeInstanceOf(RecoveryInterruptedError);
			expect(err.channel).toBe("tenant.BTC.trade");
		});

		it("routes a channel-scoped replay error frame to recoveryInterrupted", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			});

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			transport.simulateMessage({
				type: "error",
				code: "replay_failed",
				channel: "tenant.BTC.trade",
				message: "replay failed",
			});

			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].channel).toBe("tenant.BTC.trade");

			client.disconnect();
		});

		it("routes error:not_available and error:invalid_request during replay to recoveryInterrupted", async () => {
			// Both codes are in the contract's receiveReplayError enum, so a channel-scoped `error` frame
			// carrying either during a live replay is a replay failure — NOT the generic `error` event, and
			// NOT a Direct degrade (that is keyed on the `reconnect_error` message type).
			for (const code of ["not_available", "invalid_request"] as const) {
				const { client, transport } = createClient();
				client.connect();
				await vi.advanceTimersByTimeAsync(0);
				transport.simulateMessage({
					type: "gap",
					channel: "tenant.BTC.trade",
					last_pos: "2-100",
					ts: Date.now(),
				}); // → replaying

				const recovery = vi.fn();
				const error = vi.fn();
				client.on("recoveryInterrupted", recovery);
				client.on("error", error);
				transport.simulateMessage({
					type: "error",
					code,
					channel: "tenant.BTC.trade",
					message: `replay ${code}`,
				});

				expect(recovery).toHaveBeenCalledOnce();
				expect(recovery.mock.calls[0][0].channel).toBe("tenant.BTC.trade");
				expect(error).not.toHaveBeenCalled(); // single signal, not a stray error + a later deadline
				client.disconnect();
			}
		});

		it("resets the detection deadline on each replay_message (per-frame idle timer, fix #3)", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			}); // → replaying, deadline armed at +10s

			// Stream replay frames every 6s: each resets the 10s idle deadline, so it never fires even though
			// the elapsed time (18s) is well past the ORIGINAL absolute deadline.
			await vi.advanceTimersByTimeAsync(6000);
			transport.simulateMessage({
				type: "replay_message",
				channel: "tenant.BTC.trade",
				ts: Date.now(),
				data: {},
			});
			await vi.advanceTimersByTimeAsync(6000);
			transport.simulateMessage({
				type: "replay_message",
				channel: "tenant.BTC.trade",
				ts: Date.now(),
				data: {},
			});
			await vi.advanceTimersByTimeAsync(6000);
			expect(handler).not.toHaveBeenCalled();

			// Frames stop → the deadline finally elapses a full window later.
			await vi.advanceTimersByTimeAsync(10000);
			expect(handler).toHaveBeenCalledOnce();

			client.disconnect();
		});

		it("fires a floor-delayed replay through the recovery timer", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// First gap → immediate replay, then complete → the channel goes idle with the floor closed.
			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			});
			transport.simulateMessage({
				type: "replay_complete",
				channel: "tenant.BTC.trade",
				messages_replayed: 1,
			});
			transport.sent.length = 0;

			// Second gap within the floor window → held (not sent immediately).
			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-150",
				ts: Date.now(),
			});
			expect(transport.sent.find((s) => JSON.parse(s).type === "replay")).toBeUndefined();

			// Advance past the replay floor (10s) → the timer fires the held replay.
			await vi.advanceTimersByTimeAsync(10000);
			const replay = transport.sent.find((s) => JSON.parse(s).type === "replay");
			expect(replay).toBeDefined();
			expect(JSON.parse(replay!).data.from_pos).toBe("2-150");

			client.disconnect();
		});

		it("raises recoveryInterrupted when replay_complete never arrives before the deadline", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			transport.simulateMessage({
				type: "gap",
				channel: "tenant.BTC.trade",
				last_pos: "2-100",
				ts: Date.now(),
			}); // → replaying, detection deadline armed at +10s

			await vi.advanceTimersByTimeAsync(10001); // no replay_complete → deadline fires
			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].channel).toBe("tenant.BTC.trade");

			client.disconnect();
		});
	});

	describe("history", () => {
		it("sends a history frame with the given limit", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0;

			client.history("tenant.BTC.trade", 25);

			const frame = transport.sent.find((s) => JSON.parse(s).type === "history");
			expect(frame).toBeDefined();
			expect(JSON.parse(frame!).data).toEqual({ channel: "tenant.BTC.trade", limit: 25 });

			client.disconnect();
		});

		it("defaults the limit to historyLimit when omitted", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0;

			client.history("tenant.BTC.trade");

			const frame = transport.sent.find((s) => JSON.parse(s).type === "history");
			expect(JSON.parse(frame!).data.limit).toBe(100); // SUKKO_DEFAULTS.historyLimit

			client.disconnect();
		});

		it("throws ConfigurationError when limit exceeds historyLimit", async () => {
			const { client } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			expect(() => client.history("tenant.BTC.trade", 101)).toThrow(ConfigurationError);

			client.disconnect();
		});

		it("throws ConfigurationError for a non-positive or non-integer limit", async () => {
			const { client } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// The contract declares limit an integer >= 1 — validate the lower bound client-side too (§II).
			expect(() => client.history("tenant.BTC.trade", 0)).toThrow(ConfigurationError);
			expect(() => client.history("tenant.BTC.trade", -5)).toThrow(ConfigurationError);
			expect(() => client.history("tenant.BTC.trade", 2.5)).toThrow(ConfigurationError);

			client.disconnect();
		});

		it("throws NotConnectedError when not connected", () => {
			const { client } = createClient();
			expect(() => client.history("tenant.BTC.trade")).toThrow(NotConnectedError);
		});

		it("throws TransportError on a transport that cannot send (WS-only)", async () => {
			class NoSendTransport extends MockTransport {
				override get capabilities(): TransportCapabilities {
					return { canSend: false, canSubscribe: true, canPublish: false, canPauseReceive: false };
				}
			}
			const transport = new NoSendTransport();
			const client = new SukkoClient({ transport, autoConnect: false, reconnect: false });
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			expect(() => client.history("tenant.BTC.trade")).toThrow(TransportError);

			client.disconnect();
		});

		it("does NOT anchor recovery pos from history frames (no backward anchor)", async () => {
			vi.spyOn(Math, "random").mockReturnValue(0.5);
			const { client, transport } = createReconnectableClient();
			await vi.advanceTimersByTimeAsync(0);

			// A live message advances the anchor to 5-100.
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: {},
				pos: "5-100",
			});
			// An OLDER history backfill frame arrives with pos 5-50 — it must NOT move the anchor back.
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: {},
				pos: "5-50",
				history: true,
			});

			const data = await reconnectFrame(transport);
			expect(data?.last_pos).toEqual({ "tenant.BTC.trade": "5-100" });

			client.disconnect();
		});

		it("resets the detection deadline on each history frame, and history_complete clears it", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			client.history("tenant.BTC.trade", 10); // arms the detection deadline at +10s

			// History frames every 6s keep resetting the 10s idle deadline past the original deadline.
			await vi.advanceTimersByTimeAsync(6000);
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: {},
				history: true,
			});
			await vi.advanceTimersByTimeAsync(6000);
			transport.simulateMessage({
				type: "message",
				ts: Date.now(),
				channel: "tenant.BTC.trade",
				data: {},
				history: true,
			});
			await vi.advanceTimersByTimeAsync(6000);
			expect(handler).not.toHaveBeenCalled();

			// history_complete clears the deadline — no interrupt ever fires.
			transport.simulateMessage({
				type: "history_complete",
				channel: "tenant.BTC.trade",
				count: 2,
				source: "kafka",
			});
			await vi.advanceTimersByTimeAsync(20000);
			expect(handler).not.toHaveBeenCalled();

			client.disconnect();
		});

		it("raises recoveryInterrupted when history never completes past the deadline", async () => {
			const { client } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const handler = vi.fn();
			client.on("recoveryInterrupted", handler);
			client.history("tenant.BTC.trade", 10); // deadline armed at +10s, no frames follow

			await vi.advanceTimersByTimeAsync(10001);
			expect(handler).toHaveBeenCalledOnce();
			expect(handler.mock.calls[0][0].channel).toBe("tenant.BTC.trade");

			client.disconnect();
		});

		it("keeps the deadline armed on history_in_progress (duplicate rejected, original still running)", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const historyError = vi.fn();
			const recovery = vi.fn();
			client.on("historyError", historyError);
			client.on("recoveryInterrupted", recovery);
			client.history("tenant.BTC.trade", 10); // original request → deadline armed at +10s

			// A duplicate request is rejected while the original backfill is still in flight. Its deadline
			// must NOT be cleared — otherwise the original's stall watchdog is silently lost.
			transport.simulateMessage({
				type: "history_error",
				code: "history_in_progress",
				channel: "tenant.BTC.trade",
				message: "history already running",
			});
			expect(historyError).toHaveBeenCalledOnce();

			// The original watchdog survives: a subsequent stall still raises RecoveryInterrupted.
			await vi.advanceTimersByTimeAsync(10001);
			expect(recovery).toHaveBeenCalledOnce();
			expect(recovery.mock.calls[0][0].channel).toBe("tenant.BTC.trade");

			client.disconnect();
		});

		it("emits historyError and clears the deadline (single signal, no later interrupt)", async () => {
			const { client, transport } = createClient();
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			const historyError = vi.fn();
			const recovery = vi.fn();
			client.on("historyError", historyError);
			client.on("recoveryInterrupted", recovery);
			client.history("tenant.BTC.trade", 10); // arms the deadline

			transport.simulateMessage({
				type: "history_error",
				code: "history_disabled",
				channel: "tenant.BTC.trade",
				message: "history is not enabled",
			});
			expect(historyError).toHaveBeenCalledOnce();
			expect(historyError.mock.calls[0][0].code).toBe("history_disabled");

			// The armed deadline was cleared — no spurious RecoveryInterrupted 10s later.
			await vi.advanceTimersByTimeAsync(20000);
			expect(recovery).not.toHaveBeenCalled();

			client.disconnect();
		});
	});

	describe("auth integration", () => {
		it("marks subscription_ack grants and re-subscribes the not-granted delta on escalate", async () => {
			const { client, transport } = createClient();
			client.subscribe(["tenant.BTC.trade", "tenant.ETH.trade"]);
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// The api-key is granted only BTC; ETH is filtered (retained in the not-granted delta).
			transport.simulateMessage({
				type: "subscription_ack",
				subscribed: ["tenant.BTC.trade"],
				count: 1,
			});
			transport.sent.length = 0;

			const escalating = client.escalate("jwt-token");
			await vi.advanceTimersByTimeAsync(0);
			const authMsg = transport.sent.find((s) => JSON.parse(s).type === "auth");
			expect(JSON.parse(authMsg!).data.token).toBe("jwt-token"); // escalation sent its own frame

			transport.simulateMessage({ type: "auth_ack", data: { exp: 0 } });
			await escalating;

			// On success the not-granted delta (ETH) is re-subscribed.
			const sub = transport.sent.find((s) => JSON.parse(s).type === "subscribe");
			expect(JSON.parse(sub!).data.channels).toEqual(["tenant.ETH.trade"]);

			client.disconnect();
		});

		it("keeps a forcibly-unsubscribed channel in the escalation delta (forced unsubscription_ack)", async () => {
			const { client, transport } = createClient();
			client.subscribe(["tenant.BTC.trade", "tenant.ETH.trade"]);
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			// Both channels granted…
			transport.simulateMessage({
				type: "subscription_ack",
				subscribed: ["tenant.BTC.trade", "tenant.ETH.trade"],
				count: 2,
			});
			// …then ETH is forcibly unsubscribed (permission change) — its grant drops but it stays desired.
			transport.simulateMessage({
				type: "unsubscription_ack",
				unsubscribed: ["tenant.ETH.trade"],
				forced: true,
			});
			transport.sent.length = 0;

			const escalating = client.escalate("jwt-token");
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({ type: "auth_ack", data: { exp: 0 } });
			await escalating;

			// The forcibly-dropped channel is re-subscribed via the not-granted delta.
			const sub = transport.sent.find((s) => JSON.parse(s).type === "subscribe");
			expect(JSON.parse(sub!).data.channels).toEqual(["tenant.ETH.trade"]);

			client.disconnect();
		});

		it("a non-forced unsubscription_ack leaves grants intact (no spurious re-subscribe on escalate)", async () => {
			const { client, transport } = createClient();
			client.subscribe(["tenant.BTC.trade"]);
			client.connect();
			await vi.advanceTimersByTimeAsync(0);

			transport.simulateMessage({
				type: "subscription_ack",
				subscribed: ["tenant.BTC.trade"],
				count: 1,
			});
			// A non-forced unsubscription_ack must NOT drop the grant (only `forced: true` does).
			transport.simulateMessage({
				type: "unsubscription_ack",
				unsubscribed: ["tenant.BTC.trade"],
				count: 1,
			});
			transport.sent.length = 0;

			const escalating = client.escalate("jwt-token");
			await vi.advanceTimersByTimeAsync(0);
			transport.simulateMessage({ type: "auth_ack", data: { exp: 0 } });
			await escalating;

			// BTC is still granted → not in the delta → no re-subscribe.
			expect(transport.sent.find((s) => JSON.parse(s).type === "subscribe")).toBeUndefined();

			client.disconnect();
		});

		it("stores the JWT and sends nothing when escalate is called while disconnected", async () => {
			const { client, transport } = createClient();
			await client.escalate("jwt-token"); // not connected → deferred
			expect(transport.sent.find((s) => JSON.parse(s).type === "auth")).toBeUndefined();

			// The stored JWT is presented on the next connect.
			client.connect();
			expect(transport.token).toBe("jwt-token");
			client.disconnect();
		});

		it("reactively refreshes on an unsolicited auth_error", async () => {
			const { client, transport } = createClient({ getToken: async () => "refreshed" });
			client.connect();
			await vi.advanceTimersByTimeAsync(0);
			transport.sent.length = 0;

			// No refresh in flight → the auth_error is unsolicited → a reactive refresh fires.
			transport.simulateMessage({
				type: "auth_error",
				data: { code: "token_expired", message: "expired" },
			});
			await vi.advanceTimersByTimeAsync(0);

			const authMsg = transport.sent.find((s) => JSON.parse(s).type === "auth");
			expect(authMsg).toBeDefined();
			expect(JSON.parse(authMsg!).data.token).toBe("refreshed");

			client.disconnect();
		});
	});
});
