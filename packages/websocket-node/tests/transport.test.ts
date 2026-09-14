import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketNodeTransport } from "../src/index";
import type { WsConstructor } from "../src/index";

// Fake `ws` socket: an EventEmitter exposing the members the transport uses, plus fire helpers.
// readyState follows the standard numeric values (0 CONNECTING, 1 OPEN, 3 CLOSED).
class FakeWs extends EventEmitter {
	static last: FakeWs | null = null;
	readyState = 0;
	send = vi.fn();
	close = vi.fn();
	terminate = vi.fn();
	pause = vi.fn();
	resume = vi.fn();

	constructor(readonly url: string) {
		super();
		FakeWs.last = this;
	}

	fireOpen(): void {
		this.readyState = 1;
		this.emit("open");
	}
	fireMessage(text: string): void {
		this.emit("message", Buffer.from(text));
	}
	fireClose(code: number, reason: string): void {
		this.readyState = 3;
		this.emit("close", code, Buffer.from(reason));
	}
	fireError(): void {
		this.emit("error", new Error("boom"));
	}
}

const Ctor = FakeWs as unknown as WsConstructor;

function grab(): FakeWs {
	if (!FakeWs.last) throw new Error("no socket constructed");
	return FakeWs.last;
}

function makeTransport(connectionTimeout?: number): WebSocketNodeTransport {
	return new WebSocketNodeTransport({ url: "wss://x/ws", WebSocket: Ctor, connectionTimeout });
}

beforeEach(() => {
	FakeWs.last = null;
});

describe("WebSocketNodeTransport", () => {
	it("declares real receive back-pressure capability", () => {
		expect(makeTransport().capabilities).toEqual({
			canSend: true,
			canSubscribe: true,
			canPublish: true,
			canPauseReceive: true,
		});
	});

	it("pause()/resume() drive the underlying socket (the real back-pressure levers)", () => {
		const t = makeTransport();
		t.open();
		const ws = grab();
		t.pause();
		t.resume();
		expect(ws.pause).toHaveBeenCalledOnce();
		expect(ws.resume).toHaveBeenCalledOnce();
	});

	it("wires open/message/close/error through to Transport events", () => {
		const t = makeTransport();
		const events: string[] = [];
		t.on("open", () => events.push("open"));
		t.on("message", (d) => events.push(`message:${d}`));
		t.on("close", (code, reason) => events.push(`close:${code}:${reason}`));
		t.on("error", () => events.push("error"));
		t.open();
		const ws = grab();
		ws.fireOpen();
		ws.fireMessage('{"type":"message"}');
		ws.fireError();
		ws.fireClose(1006, "gone");
		expect(events).toEqual(["open", 'message:{"type":"message"}', "error", "close:1006:gone"]);
	});

	it("maps connection state and sends only when open", () => {
		const t = makeTransport();
		expect(t.state).toBe("closed");
		t.open();
		const ws = grab();
		expect(t.state).toBe("opening"); // readyState CONNECTING
		t.send("too-early");
		expect(ws.send).not.toHaveBeenCalled();
		ws.fireOpen();
		expect(t.state).toBe("open");
		t.send("hello");
		expect(ws.send).toHaveBeenCalledWith("hello");
	});

	it("reuses after close: tears down the old socket and opens a fresh one", () => {
		const t = makeTransport();
		t.open();
		const first = grab();
		first.readyState = 1;
		t.close(1000, "bye");
		expect(first.close).toHaveBeenCalledWith(1000, "bye");

		// The old socket is unwired — a stale frame must not reach the transport.
		const onMessage = vi.fn();
		t.on("message", onMessage);
		first.fireMessage("stale");
		expect(onMessage).not.toHaveBeenCalled();

		t.open();
		expect(grab()).not.toBe(first);
	});

	it("terminates a stalled handshake after the connection timeout", () => {
		vi.useFakeTimers();
		try {
			const t = makeTransport(5000);
			t.open();
			const ws = grab(); // stays CONNECTING (never fires open)
			vi.advanceTimersByTime(5000);
			expect(ws.terminate).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});
});
