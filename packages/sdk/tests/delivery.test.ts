// Delivery-path tests (T021, FR-022/FR-025/FR-026, SC-001 mechanism). The `messages()` iterator is
// the authoritative surface; the `.on("message")` emitter is the pre-queue tap; malformed/unknown
// frames must not kill the pump; back-pressure is asserted by MECHANISM (pause/resume calls), not by
// a memory measurement.

import { describe, expect, it } from "vitest";
import { SukkoClient } from "../src/client";
import { TypedEventEmitter } from "../src/emitter";
import type { Message } from "../src/messages";
import type {
	Transport,
	TransportCapabilities,
	TransportEvents,
	TransportState,
} from "../src/transport";

class FakeTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private _state: TransportState = "closed";
	pauseCalls = 0;
	resumeCalls = 0;
	constructor(private readonly canPauseReceive: boolean) {
		super();
	}
	get state(): TransportState {
		return this._state;
	}
	get capabilities(): TransportCapabilities {
		return {
			canSend: true,
			canSubscribe: true,
			canPublish: true,
			canPauseReceive: this.canPauseReceive,
		};
	}
	setToken(): void {}
	setChannels(_channels: string[]): void {}
	open(): void {
		this._state = "open";
		queueMicrotask(() => this.emit("open"));
	}
	close(): void {
		this._state = "closed";
	}
	send(): void {}
	pause(): void {
		this.pauseCalls++;
	}
	resume(): void {
		this.resumeCalls++;
	}
	deliver(msg: Partial<Message> & { type: string }): void {
		this.emit("message", JSON.stringify(msg));
	}
	deliverRaw(data: string): void {
		this.emit("message", data);
	}
}

function makeClient(canPauseReceive = false): { client: SukkoClient; transport: FakeTransport } {
	const transport = new FakeTransport(canPauseReceive);
	const client = new SukkoClient({ transport, autoConnect: false });
	return { client, transport };
}

function liveMessage(n: number): Message & { type: "message" } {
	return { type: "message", ts: n, channel: "acme.trade", data: { n } };
}

describe("messages() iterator", () => {
	it("yields live messages pushed by the transport", async () => {
		const { client, transport } = makeClient();
		const it = client.messages();
		const pending = it.next();
		transport.deliver(liveMessage(1));
		const { value } = await pending;
		expect(value).toMatchObject({ type: "message", channel: "acme.trade", data: { n: 1 } });
	});

	it("also fires the .on('message') emitter tap for the same frame", async () => {
		const { client, transport } = makeClient();
		const tapped: unknown[] = [];
		client.on("message", (m) => tapped.push(m));
		const it = client.messages();
		const pending = it.next();
		transport.deliver(liveMessage(7));
		await pending;
		expect(tapped).toHaveLength(1); // the tap fired alongside the iterator
	});

	it("drops a malformed frame and keeps the pump alive (FR-025)", async () => {
		const { client, transport } = makeClient();
		const it = client.messages();
		const pending = it.next();
		transport.deliverRaw("{not valid json");
		transport.deliver(liveMessage(2)); // the next good frame still arrives
		const { value } = await pending;
		expect(value).toMatchObject({ data: { n: 2 } });
	});

	it("drops an unknown message type and keeps the pump alive (forward-compat, FR-025)", async () => {
		const { client, transport } = makeClient();
		const it = client.messages();
		const pending = it.next();
		transport.deliver({ type: "some_future_type", whatever: true } as never);
		transport.deliver(liveMessage(3));
		const { value } = await pending;
		expect(value).toMatchObject({ data: { n: 3 } });
	});

	it("ends the iterator when the client disconnects (FR-026 lifetime-scoped)", async () => {
		const { client } = makeClient();
		const it = client.messages();
		const pending = it.next();
		client.disconnect();
		expect(await pending).toEqual({ value: undefined, done: true });
	});

	it("a throwing .on('message') listener breaks neither the messages() stream nor other listeners", async () => {
		const { client, transport } = makeClient();
		const other: number[] = [];
		client.on("message", () => {
			throw new Error("bad listener");
		});
		client.on("message", (m) => other.push((m as { data: { n: number } }).data.n));
		const it = client.messages();
		const pending = it.next();
		transport.deliver(liveMessage(5));
		const { value } = await pending;
		expect(value).toMatchObject({ data: { n: 5 } }); // authoritative stream still delivered
		expect(other).toEqual([5]); // the second listener still fired despite the first throwing
	});

	it("rejects a second concurrent messages() consumer without corrupting the first", async () => {
		const { client } = makeClient();
		const a = client.messages();
		void a.next(); // A becomes the active consumer
		const b = client.messages();
		await expect(b.next()).rejects.toThrow(/single-consumer/);
	});
});

describe("back-pressure (SC-001, by mechanism)", () => {
	it("pauses exactly once when the buffer fills, not before, and resumes once on drain", async () => {
		const { client, transport } = makeClient(true);
		const it = client.messages();
		const first = it.next(); // activate the consumer (queueConsumer = true)
		transport.deliver(liveMessage(0));
		await first; // consumed frame 0 → queue empty again

		// Fill to exactly the bound (256) but not over — no pause yet.
		for (let i = 1; i <= 256; i++) transport.deliver(liveMessage(i));
		expect(transport.pauseCalls).toBe(1); // paused precisely when the 256th push filled the buffer
		transport.deliver(liveMessage(257)); // over capacity, already paused → no re-pause
		expect(transport.pauseCalls).toBe(1);

		// Drain — resume fires once, the first pull that drops below capacity.
		for (let i = 0; i < 5; i++) await it.next();
		expect(transport.resumeCalls).toBe(1);
	});

	it("never pauses an incapable transport — the queue absorbs overflow instead", async () => {
		const { client, transport } = makeClient(false);
		const it = client.messages();
		const first = it.next();
		transport.deliver(liveMessage(0));
		await first;
		for (let i = 1; i <= 300; i++) transport.deliver(liveMessage(i));
		expect(transport.pauseCalls).toBe(0); // canPauseReceive: false → overflow policy handles it
	});
});
