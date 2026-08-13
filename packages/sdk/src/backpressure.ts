// The client-lifetime delivery queue (FR-003). `messages()` drains it; the read-pump pushes into it.
// It is the authoritative back-pressure surface:
//   - a CAPABLE transport (canPauseReceive) is paused by the client when the queue is full and
//     resumed on drain — so the queue never actually overflows;
//   - an INCAPABLE transport (WHATWG socket auto-drains) can't be paused, so the queue applies
//     `overflowPolicy` and emits an in-band `Overflow` marker carrying the coalesced dropped count —
//     never a silent drop.
// Construction fails fast (§II) if the buffer is below the recovery floor (history + replay burst).

import { ConfigurationError } from "./errors";
import type { DeliveryItem } from "./messages";

export type OverflowPolicy = "drop_oldest" | "drop_newest";

export interface DeliveryQueueOptions {
	/** Max buffered items. Must be ≥ `floor`. */
	maxsize: number;
	/** What to drop when an incapable transport overflows the buffer. */
	policy: OverflowPolicy;
	/** `historyLimit + maxReplayMessages` — a recovery burst must fit without tripping back-pressure. */
	floor: number;
}

/** A bounded async-iterable queue of delivery items. Single-consumer (one `messages()` iterator). */
export class DeliveryQueue {
	private readonly items: DeliveryItem[] = [];
	private readonly maxsize: number;
	private readonly policy: OverflowPolicy;
	private closed = false;
	private waiter: ((result: IteratorResult<DeliveryItem>) => void) | null = null;
	private dropped = 0; // coalesced drops awaiting an Overflow marker

	constructor(options: DeliveryQueueOptions) {
		if (options.maxsize < 1) {
			throw new ConfigurationError(`bufferSize (${options.maxsize}) must be >= 1`);
		}
		if (options.maxsize < options.floor) {
			throw new ConfigurationError(
				`bufferSize (${options.maxsize}) must be >= historyLimit + maxReplayMessages (${options.floor})`,
			);
		}
		this.maxsize = options.maxsize;
		this.policy = options.policy;
	}

	/** Current buffered item count. */
	get size(): number {
		return this.items.length;
	}

	/** True when the buffer is at capacity — the client pauses a capable transport on this. */
	get isFull(): boolean {
		return this.items.length >= this.maxsize;
	}

	/**
	 * Enqueue an item. On an incapable transport at capacity this applies `overflowPolicy` and records
	 * a coalesced drop (surfaced as an `Overflow` marker before the next item). No-op after `close()`.
	 */
	push(item: DeliveryItem): void {
		if (this.closed) return;
		if (this.items.length >= this.maxsize) {
			if (this.policy === "drop_newest") {
				this.dropped++;
				this.wake();
				return;
			}
			this.items.shift(); // drop_oldest
			this.dropped++;
		}
		this.items.push(item);
		this.wake();
	}

	/**
	 * Close the queue: drains buffered items, then ends the iterator. Infallible, idempotent.
	 * The owning client lifecycle MUST call this on teardown (including error/early-return paths) to
	 * release a consumer parked in `next()` — otherwise that promise dangles (§XI deterministic teardown).
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			void this.next().then(resolve);
		}
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<DeliveryItem> {
		return this;
	}

	next(): Promise<IteratorResult<DeliveryItem>> {
		// 1. A coalesced overflow marker takes priority over the next buffered item.
		if (this.dropped > 0) {
			const dropped = this.dropped;
			this.dropped = 0;
			return Promise.resolve({ value: { type: "overflow", dropped }, done: false });
		}
		// 2. A buffered item.
		const item = this.items.shift();
		if (item !== undefined) return Promise.resolve({ value: item, done: false });
		// 3. Closed and empty — end the iterator.
		if (this.closed) return Promise.resolve({ value: undefined, done: true });
		// 4. Wait for the next push/close. Single-consumer: a second concurrent next() would orphan the
		// first waiter into a permanent hang — fail loudly instead (§XI no silent failure).
		if (this.waiter) {
			throw new Error("DeliveryQueue is single-consumer — concurrent next() is not allowed");
		}
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	private wake(): void {
		if (this.waiter) {
			const resolve = this.waiter;
			this.waiter = null;
			void this.next().then(resolve);
		}
	}
}
