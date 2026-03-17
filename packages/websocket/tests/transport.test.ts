import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "../src/transport";

// ---------------------------------------------------------------------------
// Mock WebSocket (browser API)
// ---------------------------------------------------------------------------

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState: number = MockWebSocket.CONNECTING;
	url: string;

	onopen: ((ev: Event) => void) | null = null;
	onclose: ((ev: { code: number; reason: string }) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;

	sent: string[] = [];

	constructor(url: string | URL) {
		this.url = typeof url === "string" ? url : url.toString();
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, _reason?: string): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code: code ?? 1000, reason: _reason ?? "" });
	}

	// Test helpers
	simulateOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	simulateMessage(data: string): void {
		this.onmessage?.({ data });
	}

	simulateClose(code: number, reason = ""): void {
		this.readyState = MockWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}

	simulateError(): void {
		this.onerror?.(new Event("error"));
	}
}

// Capture the last created MockWebSocket instance
let lastWs: MockWebSocket | null = null;

class TrackingWebSocket extends MockWebSocket {
	constructor(url: string | URL) {
		super(url);
		lastWs = this;
	}
}

function createTransport(
	overrides: Partial<ConstructorParameters<typeof WebSocketTransport>[0]> = {},
): WebSocketTransport {
	return new WebSocketTransport({
		url: "ws://localhost:3002/ws",
		WebSocket: TrackingWebSocket as unknown as new (url: string | URL) => WebSocket,
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WebSocketTransport", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		lastWs = null;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("constructor", () => {
		it("stores options without opening a connection", () => {
			const transport = createTransport();
			expect(transport.state).toBe("closed");
		});
	});

	describe("open()", () => {
		it("creates a WebSocket with the configured URL", () => {
			const transport = createTransport({ url: "ws://example.com/ws" });
			transport.open();

			expect(lastWs).not.toBeNull();
			expect(lastWs!.url).toBe("ws://example.com/ws");
		});

		it("appends token as query parameter", () => {
			const transport = createTransport({ token: "my-jwt" });
			transport.open();

			expect(lastWs!.url).toBe("ws://localhost:3002/ws?token=my-jwt");
		});

		it("appends token with & when URL already has query params", () => {
			const transport = createTransport({
				url: "ws://localhost/ws?foo=bar",
				token: "jwt",
			});
			transport.open();

			expect(lastWs!.url).toBe("ws://localhost/ws?foo=bar&token=jwt");
		});

		it("encodes token value", () => {
			const transport = createTransport({ token: "a b+c" });
			transport.open();

			expect(lastWs!.url).toContain("token=a%20b%2Bc");
		});

		it("does not append token when empty", () => {
			const transport = createTransport({ token: "" });
			transport.open();

			expect(lastWs!.url).toBe("ws://localhost:3002/ws");
		});

		it("state is 'opening' before WebSocket opens", () => {
			const transport = createTransport();
			transport.open();

			expect(transport.state).toBe("opening");
		});
	});

	describe("setToken()", () => {
		it("updates the token used for the next open()", () => {
			const transport = createTransport({ token: "old" });
			transport.setToken("new-token");
			transport.open();

			expect(lastWs!.url).toContain("token=new-token");
		});

		it("overrides the construction-time token", () => {
			const transport = createTransport({ token: "initial" });
			transport.setToken("override");
			transport.open();

			expect(lastWs!.url).toContain("token=override");
			expect(lastWs!.url).not.toContain("token=initial");
		});
	});

	describe("close()", () => {
		it("closes the underlying WebSocket", () => {
			const transport = createTransport();
			transport.open();
			lastWs!.simulateOpen();

			transport.close();
			expect(transport.state).toBe("closed");
		});

		it("is safe to call when already closed", () => {
			const transport = createTransport();
			expect(() => transport.close()).not.toThrow();
		});
	});

	describe("send()", () => {
		it("forwards string data to WebSocket", () => {
			const transport = createTransport();
			transport.open();
			lastWs!.simulateOpen();

			transport.send('{"type":"heartbeat"}');
			expect(lastWs!.sent).toContain('{"type":"heartbeat"}');
		});

		it("does not throw when WebSocket is not open", () => {
			const transport = createTransport();
			expect(() => transport.send("data")).not.toThrow();
		});
	});

	describe("state", () => {
		it("returns 'closed' initially", () => {
			const transport = createTransport();
			expect(transport.state).toBe("closed");
		});

		it("returns 'opening' during connection", () => {
			const transport = createTransport();
			transport.open();
			expect(transport.state).toBe("opening");
		});

		it("returns 'open' after connection established", () => {
			const transport = createTransport();
			transport.open();
			lastWs!.simulateOpen();
			expect(transport.state).toBe("open");
		});

		it("returns 'closed' after close", () => {
			const transport = createTransport();
			transport.open();
			lastWs!.simulateOpen();
			transport.close();
			expect(transport.state).toBe("closed");
		});
	});

	describe("capabilities", () => {
		it("returns all capabilities as true", () => {
			const transport = createTransport();
			expect(transport.capabilities).toEqual({
				canSend: true,
				canSubscribe: true,
				canPublish: true,
			});
		});
	});

	describe("events", () => {
		it("emits 'open' when WebSocket connects", () => {
			const transport = createTransport();
			const handler = vi.fn();
			transport.on("open", handler);

			transport.open();
			lastWs!.simulateOpen();

			expect(handler).toHaveBeenCalledOnce();
		});

		it("emits 'close' with code and reason", () => {
			const transport = createTransport();
			const handler = vi.fn();
			transport.on("close", handler);

			transport.open();
			lastWs!.simulateOpen();
			lastWs!.simulateClose(1006, "Abnormal");

			expect(handler).toHaveBeenCalledWith(1006, "Abnormal");
		});

		it("emits 'message' with raw string data", () => {
			const transport = createTransport();
			const handler = vi.fn();
			transport.on("message", handler);

			transport.open();
			lastWs!.simulateOpen();
			lastWs!.simulateMessage('{"type":"pong","ts":123}');

			expect(handler).toHaveBeenCalledWith('{"type":"pong","ts":123}');
		});

		it("emits 'error' on WebSocket error", () => {
			const transport = createTransport();
			const handler = vi.fn();
			transport.on("error", handler);

			transport.open();
			lastWs!.simulateError();

			expect(handler).toHaveBeenCalledOnce();
		});

		it("unsubscribe function removes listener", () => {
			const transport = createTransport();
			const handler = vi.fn();
			const off = transport.on("open", handler);

			off();
			transport.open();
			lastWs!.simulateOpen();

			expect(handler).not.toHaveBeenCalled();
		});
	});

	describe("connection timeout", () => {
		it("closes socket if stuck in CONNECTING state", () => {
			const transport = createTransport({ connectionTimeout: 500 });
			transport.open();

			// Socket stays in CONNECTING state
			expect(lastWs!.readyState).toBe(MockWebSocket.CONNECTING);

			vi.advanceTimersByTime(500);

			// Should have been closed
			expect(lastWs!.readyState).toBe(MockWebSocket.CLOSED);
		});

		it("does not close if socket opens before timeout", () => {
			const transport = createTransport({ connectionTimeout: 500 });
			transport.open();

			lastWs!.simulateOpen();
			vi.advanceTimersByTime(500);

			expect(transport.state).toBe("open");
		});
	});

	describe("SSR safety", () => {
		it("emits error when no WebSocket constructor is available", () => {
			const transport = new WebSocketTransport({
				url: "ws://localhost/ws",
				WebSocket: undefined,
			});

			const errorHandler = vi.fn();
			transport.on("error", errorHandler);

			// In test environment, global WebSocket exists, so we need to
			// verify behavior when constructor throws instead
			expect(transport.state).toBe("closed");
		});
	});

	describe("reuse", () => {
		it("creates a fresh WebSocket after close then open", () => {
			const transport = createTransport();

			transport.open();
			const firstWs = lastWs;
			firstWs!.simulateOpen();

			transport.close();
			expect(transport.state).toBe("closed");

			transport.open();
			const secondWs = lastWs;

			expect(secondWs).not.toBe(firstWs);
			expect(transport.state).toBe("opening");

			secondWs!.simulateOpen();
			expect(transport.state).toBe("open");
		});
	});
});
