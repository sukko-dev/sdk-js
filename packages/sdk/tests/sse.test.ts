import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/_clock";
import { type FetchLike, SseTransport } from "../src/transport/sse";

// Flush the microtask queue — the mock fetch + ReadableStream reads settle over microtasks (the
// clock is advanced explicitly for the idle/connect timers).
async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** A controllable SSE body: push text chunks, then close or error the stream. */
function makeStream(): {
	stream: ReadableStream<Uint8Array>;
	push: (s: string) => void;
	end: () => void;
} {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const enc = new TextEncoder();
	return {
		stream,
		push: (s) => controller.enqueue(enc.encode(s)),
		end: () => controller.close(),
	};
}

function okFetch(
	stream: ReadableStream<Uint8Array>,
	capture?: (url: string, init?: RequestInit) => void,
): FetchLike {
	return async (input, init) => {
		capture?.(input, init);
		return new Response(stream, { status: 200 });
	};
}

function makeTransport(
	fetchImpl: FetchLike,
	overrides: { channels?: string[]; token?: string; idleTimeoutMs?: number } = {},
): { transport: SseTransport; clock: FakeClock } {
	const clock = new FakeClock();
	const transport = new SseTransport({
		url: "https://gw.example.com",
		channels: overrides.channels ?? ["acme.trade"],
		token: overrides.token,
		clock,
		fetch: fetchImpl,
		idleTimeoutMs: overrides.idleTimeoutMs ?? 90000,
	});
	return { transport, clock };
}

describe("SseTransport — construction", () => {
	it("requires at least one channel", () => {
		expect(() => new SseTransport({ url: "x", channels: [] })).toThrow(/at least one channel/);
	});

	it("is receive-only (capabilities) and send() is a no-op", () => {
		const { transport } = makeTransport(okFetch(makeStream().stream));
		expect(transport.capabilities).toEqual({
			canSend: false,
			canSubscribe: false,
			canPublish: false,
			canPauseReceive: false,
		});
		expect(() => transport.send("anything")).not.toThrow();
	});
});

describe("SseTransport — connect", () => {
	it("opens GET {url}/sse?channels=… with the auth + accept headers and emits open", async () => {
		let url = "";
		let init: RequestInit | undefined;
		const { stream } = makeStream();
		const { transport } = makeTransport(
			okFetch(stream, (u, i) => {
				url = u;
				init = i;
			}),
			{ token: "jwt", channels: ["acme.x", "acme.y"] },
		);
		const opened = vi.fn();
		transport.on("open", opened);

		transport.open();
		await flush();

		expect(transport.state).toBe("open");
		expect(opened).toHaveBeenCalledOnce();
		expect(url).toBe("https://gw.example.com/sse?channels=acme.x%2Cacme.y"); // comma-joined + encoded
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer jwt");
		expect(headers.Accept).toBe("text/event-stream");
	});

	it("does not double-append /sse and strips a trailing slash from the base url", async () => {
		const urls: string[] = [];
		const clock = new FakeClock();
		const fetchImpl: FetchLike = async (u) => {
			urls.push(u);
			return new Response(makeStream().stream, { status: 200 });
		};
		const withSlash = new SseTransport({
			url: "https://gw.example.com/",
			channels: ["a.x"],
			clock,
			fetch: fetchImpl,
		});
		withSlash.open();
		await flush();
		const withSse = new SseTransport({
			url: "https://gw.example.com/sse",
			channels: ["a.x"],
			clock,
			fetch: fetchImpl,
		});
		withSse.open();
		await flush();

		expect(urls[0]).toBe("https://gw.example.com/sse?channels=a.x");
		expect(urls[1]).toBe("https://gw.example.com/sse?channels=a.x");
		withSlash.close();
		withSse.close();
	});

	it("re-sends the updated token after setToken on reopen", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const clock = new FakeClock();
		const fetchImpl: FetchLike = async (_u, init) => {
			inits.push(init);
			return new Response(makeStream().stream, { status: 200 });
		};
		const transport = new SseTransport({
			url: "https://gw.example.com",
			channels: ["a.x"],
			token: "old",
			clock,
			fetch: fetchImpl,
		});
		transport.open();
		await flush();
		transport.setToken("new"); // auth refresh over SSE = reconnect with a fresh token
		transport.close();
		transport.open();
		await flush();

		expect((inits[0]?.headers as Record<string, string>).Authorization).toBe("Bearer old");
		expect((inits[1]?.headers as Record<string, string>).Authorization).toBe("Bearer new");
		transport.close();
	});

	it("rejects (network error) → transient close", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new TypeError("network down");
		};
		const { transport } = makeTransport(fetchImpl);
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("connect failed"));
		expect(transport.state).toBe("closed");
	});

	it("treats 429 (tenant connection limit) as transient, not terminal", async () => {
		const fetchImpl: FetchLike = async () => new Response("slow down", { status: 429 });
		const { transport } = makeTransport(fetchImpl);
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("429")); // reconnect, not give up
	});

	it("emits a terminal close (1008) on a Pro-gate 403, without opening", async () => {
		const fetchImpl: FetchLike = async () => new Response("forbidden", { status: 403 });
		const { transport } = makeTransport(fetchImpl);
		const opened = vi.fn();
		const closed = vi.fn();
		transport.on("open", opened);
		transport.on("close", closed);

		transport.open();
		await flush();

		expect(opened).not.toHaveBeenCalled();
		expect(closed).toHaveBeenCalledWith(1008, expect.stringContaining("403")); // terminal
	});

	it("emits a transient close (1006) on a 5xx", async () => {
		const fetchImpl: FetchLike = async () => new Response("boom", { status: 503 });
		const { transport } = makeTransport(fetchImpl);
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("503"));
	});
});

describe("SseTransport — parser", () => {
	it("emits a message per dispatched data frame", async () => {
		const { stream, push } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const messages: string[] = [];
		transport.on("message", (d) => messages.push(d));
		transport.open();
		await flush();

		push('data: {"a":1}\n\n');
		await flush();
		push('event: message\ndata: {"b":2}\n\n');
		await flush();

		expect(messages).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("buffers a frame split across chunks and handles CRLF", async () => {
		const { stream, push } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const messages: string[] = [];
		transport.on("message", (d) => messages.push(d));
		transport.open();
		await flush();

		push("data: hel"); // partial
		await flush();
		push("lo\r\n\r\n"); // completes the frame, CRLF endings
		await flush();

		expect(messages).toEqual(["hello"]);
	});

	it("joins multi-line data with newlines and ignores non-message events", async () => {
		const { stream, push } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const messages: string[] = [];
		transport.on("message", (d) => messages.push(d));
		transport.open();
		await flush();

		push("data: line1\ndata: line2\n\n");
		await flush();
		push("event: ping\ndata: ignored\n\n"); // non-message event → not emitted
		await flush();

		expect(messages).toEqual(["line1\nline2"]);
	});

	it("does not emit for empty-data frames, blank lines, or comments", async () => {
		const { stream, push } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const messages: string[] = [];
		transport.on("message", (d) => messages.push(d));
		transport.open();
		await flush();

		push("data:\n\n"); // empty data value
		push("\n"); // stray blank line
		push(": keepalive\n\n"); // comment then dispatch
		await flush();
		expect(messages).toEqual([]);

		// …and a real frame after still parses cleanly.
		push("data: real\n\n");
		await flush();
		expect(messages).toEqual(["real"]);

		transport.close();
	});

	it("discards a half-buffered frame from the previous connection on reopen", async () => {
		const first = makeStream();
		const second = makeStream();
		let call = 0;
		const fetchImpl: FetchLike = async () =>
			new Response(call++ === 0 ? first.stream : second.stream, { status: 200 });
		const { transport } = makeTransport(fetchImpl);
		const messages: string[] = [];
		transport.on("message", (d) => messages.push(d));

		transport.open();
		await flush();
		first.push("data: partial-never-terminated"); // no blank line → stays buffered
		await flush();
		transport.close();
		await flush();

		transport.open(); // reopen → parser state must reset
		await flush();
		second.push("data: fresh\n\n");
		await flush();

		expect(messages).toEqual(["fresh"]); // NOT "partial-never-terminatedfresh"
		transport.close();
	});

	it("drops with a terminal close on an oversized unterminated frame", async () => {
		const { stream, push } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();

		push(`data: ${"x".repeat(1_100_000)}`); // > MAX_FRAME_CHARS, no newline
		await flush();
		expect(closed).toHaveBeenCalledWith(1008, expect.stringContaining("too large"));
	});

	it("tracks id: and resends it as Last-Event-ID on reopen", async () => {
		const captured: Array<RequestInit | undefined> = [];
		const first = makeStream();
		const second = makeStream();
		let call = 0;
		const fetchImpl: FetchLike = async (_input, init) => {
			captured.push(init);
			return new Response(call++ === 0 ? first.stream : second.stream, { status: 200 });
		};
		const { transport } = makeTransport(fetchImpl);
		transport.open();
		await flush();
		first.push("id: 42\ndata: x\n\n");
		await flush();
		transport.close();
		await flush();

		transport.open(); // reopen → resume
		await flush();
		const headers = captured[1]?.headers as Record<string, string>;
		expect(headers["Last-Event-ID"]).toBe("42");
	});
});

describe("SseTransport — liveness + teardown", () => {
	it("drops on the idle timeout, and any chunk (incl. a keepalive) resets the window", async () => {
		const { stream, push } = makeStream();
		const { transport, clock } = makeTransport(okFetch(stream), { idleTimeoutMs: 90000 });
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();

		// Advance partway, THEN a keepalive restarts the 90s window — proving the reset is real (total
		// elapsed at the next check is 45000 + 89999 = 134999 > 90000, yet not closed).
		await clock.advance(45000);
		push(": keepalive\n");
		await flush();
		await clock.advance(89999);
		expect(closed).not.toHaveBeenCalled();
		// …then silence past the (restarted) window drops the stream.
		await clock.advance(1);
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("idle"));
	});

	it("an immediate reopen after an idle drop is not killed by the old generation's late teardown", async () => {
		const first = makeStream();
		const second = makeStream();
		let call = 0;
		const fetchImpl: FetchLike = async () =>
			new Response(call++ === 0 ? first.stream : second.stream, { status: 200 });
		const { transport, clock } = makeTransport(fetchImpl, { idleTimeoutMs: 90000 });
		const closed = vi.fn();
		transport.on("close", () => {
			closed();
			if (call === 1) transport.open(); // reconnect synchronously from the close handler
		});

		transport.open();
		await flush();
		await clock.advance(90000); // idle drop of connection A → close → synchronous reopen (B)
		await flush();
		second.push("data: on-B\n\n"); // B must still be alive
		await flush();

		expect(transport.state).toBe("open"); // B survived A's late teardown
		expect(closed).toHaveBeenCalledTimes(1); // exactly one close (A's), no spurious second
		transport.close();
	});

	it("emits a transient close when the stream ends (remote)", async () => {
		const { stream, end } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		end();
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("ended"));
	});

	it("does NOT emit close when the client closes it", async () => {
		const { stream } = makeStream();
		const { transport } = makeTransport(okFetch(stream));
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		transport.close();
		await flush();
		expect(transport.state).toBe("closed");
		expect(closed).not.toHaveBeenCalled(); // client-initiated close is not echoed
	});

	it("drops on the connect timeout when the handshake stalls", async () => {
		const fetchImpl: FetchLike = () => new Promise<Response>(() => {}); // never resolves
		const clock = new FakeClock();
		const transport = new SseTransport({
			url: "https://gw.example.com",
			channels: ["acme.trade"],
			clock,
			fetch: fetchImpl,
			connectTimeoutMs: 10000,
		});
		const closed = vi.fn();
		transport.on("close", closed);
		transport.open();
		await flush();
		await clock.advance(10000);
		await flush();
		expect(closed).toHaveBeenCalledWith(1006, expect.stringContaining("connect timeout"));
	});
});
