// Client-side routing over a receive-only (SSE-shaped) transport: publish→REST, subscribe/unsubscribe
// →reconnect-with-updated-channels, escalate→reconnect, refreshToken WS-only, and PossibleGap-on-reopen.
// The transport-only parser/liveness behaviour lives in sse.test.ts; this file drives SukkoClient with a
// controllable receive-only fake so the CLIENT decisions are witnessed deterministically.

import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../src/_clock";
import { SukkoClient } from "../src/client";
import { TypedEventEmitter } from "../src/emitter";
import { TransportError } from "../src/errors";
import type { FetchLike } from "../src/http";
import type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "../src/transport";

/** A receive-only transport (SSE-shaped): no client→server channel, connect-time channels via setChannels. */
class FakeSseTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	channelsHistory: string[][] = []; // every setChannels() payload, in order
	token = "";
	openCount = 0;
	sent: string[] = []; // must stay empty — send() is a no-op on a receive-only transport

	get state(): TransportState {
		return this._state;
	}
	get capabilities(): TransportCapabilities {
		return { canSend: false, canSubscribe: false, canPublish: false, canPauseReceive: false };
	}
	get url(): string {
		return "https://gw.example.com";
	}
	setToken(token: string): void {
		this.token = token;
	}
	setChannels(channels: string[]): void {
		this.channelsHistory.push([...channels]);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	pause(): void {}
	resume(): void {}
	open(): void {
		if (this._state === "open" || this._state === "opening") return;
		this._state = "opening";
		this.openCount++;
		queueMicrotask(() => {
			if (this._state === "opening") {
				this._state = "open";
				this.emit("open");
			}
		});
	}
	close(): void {
		this._state = "closed"; // client-initiated close does not echo (mirrors the real SseTransport)
	}
	simulateClose(code: number): void {
		this._state = "closed";
		this.emit("close", code, "");
	}
	simulateMessage(data: unknown): void {
		this.emit("message", JSON.stringify(data));
	}
	get lastChannels(): string[] | undefined {
		return this.channelsHistory.at(-1);
	}
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeClient(fetchImpl?: FetchLike): { client: SukkoClient; transport: FakeSseTransport } {
	const transport = new FakeSseTransport();
	const client = new SukkoClient({
		transport,
		autoConnect: false,
		reconnect: true,
		token: "api-key",
		fetch:
			fetchImpl ??
			(async () => new Response(JSON.stringify({ status: "accepted" }), { status: 202 })),
	});
	return { client, transport };
}

afterEach(() => vi.restoreAllMocks());

describe("SSE client — connect-time channels", () => {
	it("connecting with no subscribed channels is a benign no-op (idle until subscribe)", async () => {
		const { client, transport } = makeClient();
		expect(() => client.connect()).not.toThrow();
		await flush();
		expect(client.state).toBe("disconnected"); // nothing to stream → stays idle, no throw
		expect(transport.openCount).toBe(0);
	});

	it("opens with the desired channel set fed in at connect time", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a", "acme.b"]);
		client.connect();
		await flush();
		expect(client.state).toBe("connected");
		expect(transport.lastChannels).toEqual(["acme.a", "acme.b"]);
		expect(transport.token).toBe("api-key");
		expect(transport.sent).toEqual([]); // no client→server frames ever
		client.disconnect();
	});

	it("subscribe() opens the stream on a receive-only transport (subscription drives the connection)", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a"]); // no explicit connect() — subscribing opens the stream
		await flush();
		expect(client.state).toBe("connected");
		expect(transport.lastChannels).toEqual(["acme.a"]);
		client.disconnect();
	});

	it("subscribe() after a deliberate disconnect() only records intent (no resurrection)", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a"]);
		await flush();
		client.disconnect();
		const openCountAfterDisconnect = transport.openCount;

		client.subscribe(["acme.b"]); // must NOT reopen into the closed delivery queue
		await flush();
		expect(transport.openCount).toBe(openCountAfterDisconnect);
		expect(client.subscriptions.has("acme.b")).toBe(true); // intent recorded
	});

	it("subscribe() while open reconnects with the updated set — not a backoff reconnect", async () => {
		const { client, transport } = makeClient();
		const reconnecting = vi.fn();
		client.on("reconnecting", reconnecting);
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();
		expect(transport.openCount).toBe(1);

		client.subscribe(["acme.b"]);
		await flush();
		expect(transport.openCount).toBe(2); // reopened
		expect(transport.lastChannels).toEqual(["acme.a", "acme.b"]); // full desired set
		expect(reconnecting).not.toHaveBeenCalled(); // an intentional restart, not the failure/backoff path
		client.disconnect();
	});

	it("subscribe() while still opening restarts with the updated set (mid-open churn)", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a"]); // transport → "opening" (open resolves on a microtask)
		expect(transport.state).toBe("opening");
		client.subscribe(["acme.b"]); // second subscribe BEFORE the first open settles
		await flush();
		expect(client.state).toBe("connected");
		expect(transport.lastChannels).toEqual(["acme.a", "acme.b"]); // the settled stream carries both
		client.disconnect();
	});

	it("re-applies the current desired set on a transient-drop reconnect (the choke-point)", async () => {
		const clock = new FakeClock();
		const transport = new FakeSseTransport();
		const client = new SukkoClient({
			transport,
			autoConnect: false,
			reconnect: true,
			token: "api-key",
			clock,
			fetch: async () => new Response(null, { status: 202 }),
		});
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();
		client.subscribe(["acme.b"]); // desired is now a+b, reopens
		await flush();
		expect(transport.lastChannels).toEqual(["acme.a", "acme.b"]);

		const historyLenBeforeDrop = transport.channelsHistory.length;
		transport.simulateClose(1006); // transient network drop → backoff reconnect
		await clock.advance(30000); // fire the backoff sleeper (load-bearing — nothing reopens before it)
		await flush();
		// The reconnect fed setChannels again (history grew) with the CURRENT desired set — not a stale one
		// cached from the first connect, and not skipped entirely.
		expect(transport.channelsHistory.length).toBeGreaterThan(historyLenBeforeDrop);
		expect(transport.lastChannels).toEqual(["acme.a", "acme.b"]);
		expect(client.state).toBe("connected");
		client.disconnect();
	});

	it("unsubscribing the last channel closes the stream but keeps the client alive to resubscribe", async () => {
		const { client, transport } = makeClient();
		const items: Array<{ type: string; channel?: string }> = [];
		void (async () => {
			for await (const item of client.messages()) {
				items.push(item as { type: string; channel?: string });
			}
		})();
		client.subscribe(["acme.a"]);
		await flush();

		client.unsubscribe(["acme.a"]);
		await flush();
		expect(client.state).toBe("disconnected");
		expect(transport.state).toBe("closed"); // stream closed — an SSE request needs ≥1 channel

		// The client is NOT torn down: a later subscribe() reopens and the SAME messages() consumer resumes.
		client.subscribe(["acme.b"]);
		await flush();
		expect(client.state).toBe("connected");
		expect(transport.lastChannels).toEqual(["acme.b"]);
		transport.simulateMessage({
			type: "message",
			channel: "acme.b",
			data: { n: 1 },
			history: false,
		});
		await flush();
		expect(items.some((i) => i.type === "message")).toBe(true); // delivery queue survived
		client.disconnect();
	});
});

describe("SSE client — publish routes over REST", () => {
	it("routes publish() to POST /api/v1/publish (never an in-band frame)", async () => {
		let url = "";
		let body: unknown;
		const { client, transport } = makeClient(async (u, init) => {
			url = u;
			body = init?.body;
			return new Response(null, { status: 202 });
		});
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();

		client.publish("acme.a", { hello: "world" });
		await flush();
		expect(url).toBe("https://gw.example.com/api/v1/publish");
		expect(JSON.parse(body as string)).toEqual({ channel: "acme.a", data: { hello: "world" } });
		expect(transport.sent).toEqual([]); // publish did NOT go over the (no-op) transport
		client.disconnect();
	});

	it("surfaces a REST publish failure on the publishError event (no floating promise)", async () => {
		const { client } = makeClient(
			async () =>
				new Response(JSON.stringify({ code: "TOO_LARGE", message: "nope" }), { status: 413 }),
		);
		const errors: Array<{ code: string }> = [];
		client.on("publishError", (e) => errors.push(e));
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();

		client.publish("acme.a", { big: "payload" });
		await flush();
		await flush();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.code).toBe("message_too_large");
		client.disconnect();
	});
});

describe("SSE client — auth", () => {
	it("escalate() reconnects presenting the new JWT, without awaiting an auth ack", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();
		expect(transport.openCount).toBe(1);

		await expect(client.escalate("new-jwt")).resolves.toBeUndefined(); // must not hang on an absent ack
		await flush();
		expect(transport.openCount).toBe(2); // reconnected
		expect(transport.token).toBe("new-jwt"); // the fresh JWT rode the reconnect
		client.disconnect();
	});

	it("escalate() while offline stores the JWT without reconnecting", async () => {
		const { client, transport } = makeClient();
		client.subscribe(["acme.a"]); // opens the stream
		await flush();
		client.disconnect(); // now closed + userDisconnected
		const openCountBefore = transport.openCount;

		await expect(client.escalate("offline-jwt")).resolves.toBeUndefined();
		await flush();
		expect(transport.openCount).toBe(openCountBefore); // did NOT reconnect while closed
	});

	it("refreshToken() is WebSocket-only — rejects with TransportError over SSE", async () => {
		const { client } = makeClient();
		client.subscribe(["acme.a"]);
		client.connect();
		await flush();
		await expect(client.refreshToken()).rejects.toBeInstanceOf(TransportError);
		client.disconnect();
	});
});

describe("SSE client — PossibleGap on reopen", () => {
	it("emits one PossibleGap per channel on a reopen, and none on the first open", async () => {
		const { client } = makeClient();
		const items: Array<{ type: string; channel?: string }> = [];
		void (async () => {
			for await (const item of client.messages()) {
				items.push(item as { type: string; channel?: string });
			}
		})();

		client.subscribe(["acme.a", "acme.b"]);
		client.connect();
		await flush(); // first open — a fresh subscription, nothing missed
		expect(items.filter((i) => i.type === "possible_gap")).toHaveLength(0);

		await client.escalate("jwt"); // forces a reopen WITHOUT changing the channel set
		await flush();
		const gaps = items.filter((i) => i.type === "possible_gap").map((i) => i.channel);
		expect(gaps.sort()).toEqual(["acme.a", "acme.b"]); // one per desired channel, replay unconfirmable
		client.disconnect();
	});
});
