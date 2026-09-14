import { describe, expect, it } from "vitest";
import { DeliveryQueue } from "../src/backpressure";
import { ConfigurationError } from "../src/errors";
import type { DeliveryItem, Message } from "../src/messages";

function msg(n: number): Message {
	return { type: "message", ts: n, channel: "acme.x", data: { n } };
}

async function drain(q: DeliveryQueue, count: number): Promise<DeliveryItem[]> {
	const out: DeliveryItem[] = [];
	for (let i = 0; i < count; i++) {
		const r = await q.next();
		if (r.done) break;
		out.push(r.value);
	}
	return out;
}

describe("DeliveryQueue construction", () => {
	it("rejects a buffer below the recovery floor (fail-fast, §II)", () => {
		expect(() => new DeliveryQueue({ maxsize: 199, policy: "drop_oldest", floor: 200 })).toThrow(
			ConfigurationError,
		);
	});

	it("accepts a buffer at exactly the floor", () => {
		expect(
			() => new DeliveryQueue({ maxsize: 200, policy: "drop_oldest", floor: 200 }),
		).not.toThrow();
	});

	it("rejects a zero-capacity buffer", () => {
		expect(() => new DeliveryQueue({ maxsize: 0, policy: "drop_oldest", floor: 0 })).toThrow(
			ConfigurationError,
		);
	});
});

describe("DeliveryQueue delivery", () => {
	it("delivers pushed items in FIFO order", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		q.push(msg(1));
		q.push(msg(2));
		const out = await drain(q, 2);
		expect(out.map((m) => (m as Message).ts)).toEqual([1, 2]);
	});

	it("awaits a pending consumer and resolves it when an item arrives", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		const pending = q.next();
		q.push(msg(42));
		const r = await pending;
		expect((r.value as Message).ts).toBe(42);
	});

	it("preserves FIFO when two items are pushed while a consumer is parked", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		const first = q.next(); // parks
		q.push(msg(1)); // wakes the parked consumer with 1
		q.push(msg(2)); // buffered
		expect((await first).value).toMatchObject({ ts: 1 });
		expect((await q.next()).value).toMatchObject({ ts: 2 });
	});

	it("throws on a second concurrent next() rather than silently orphaning the first waiter", () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		void q.next(); // parks
		expect(() => q.next()).toThrow(/single-consumer/);
	});

	it("terminates a parked consumer with done on close() (teardown releases it)", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		const parked = q.next();
		q.close();
		expect(await parked).toEqual({ value: undefined, done: true });
	});

	it("ends the iterator on close() after draining buffered items", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		q.push(msg(1));
		q.close();
		expect((await q.next()).value).toMatchObject({ ts: 1 }); // buffered item drains first
		expect(await q.next()).toEqual({ value: undefined, done: true });
	});

	it("resolves a waiting consumer with done on close()", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		const pending = q.next();
		q.close();
		expect(await pending).toEqual({ value: undefined, done: true });
	});

	it("is iterable via for-await", async () => {
		const q = new DeliveryQueue({ maxsize: 8, policy: "drop_oldest", floor: 4 });
		q.push(msg(1));
		q.push(msg(2));
		q.close();
		const seen: number[] = [];
		for await (const item of q) seen.push((item as Message).ts);
		expect(seen).toEqual([1, 2]);
	});
});

describe("DeliveryQueue overflow (incapable transport)", () => {
	it("drop_oldest evicts the oldest and surfaces a coalesced Overflow marker before the next item", async () => {
		const q = new DeliveryQueue({ maxsize: 2, policy: "drop_oldest", floor: 2 });
		q.push(msg(1));
		q.push(msg(2));
		q.push(msg(3)); // evicts 1
		q.push(msg(4)); // evicts 2
		const out = await drain(q, 3);
		expect(out[0]).toEqual({ type: "overflow", dropped: 2 }); // coalesced
		expect(out.slice(1).map((m) => (m as Message).ts)).toEqual([3, 4]);
	});

	it("drop_newest discards the incoming item and counts the drop", async () => {
		const q = new DeliveryQueue({ maxsize: 2, policy: "drop_newest", floor: 2 });
		q.push(msg(1));
		q.push(msg(2));
		q.push(msg(3)); // dropped (newest)
		const out = await drain(q, 3);
		expect(out[0]).toEqual({ type: "overflow", dropped: 1 });
		expect(out.slice(1).map((m) => (m as Message).ts)).toEqual([1, 2]);
	});

	it("still surfaces a pending Overflow marker after close() (drops that already happened)", async () => {
		const q = new DeliveryQueue({ maxsize: 1, policy: "drop_newest", floor: 1 });
		q.push(msg(1));
		q.push(msg(2)); // dropped → dropped=1
		q.close();
		const out = await drain(q, 3);
		expect(out[0]).toEqual({ type: "overflow", dropped: 1 });
		expect(out[1]).toMatchObject({ ts: 1 });
		expect(out).toHaveLength(2); // then done
	});

	it("a recovery burst at exactly the floor fits without any overflow (co-fill invariant)", async () => {
		const floor = 200;
		const q = new DeliveryQueue({ maxsize: 256, policy: "drop_oldest", floor });
		for (let i = 0; i < floor; i++) q.push(msg(i));
		expect(q.size).toBe(floor);
		const out = await drain(q, floor);
		expect(out.some((m) => m.type === "overflow")).toBe(false);
		expect(out).toHaveLength(floor);
	});
});
