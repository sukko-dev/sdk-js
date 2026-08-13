import { describe, expect, it } from "vitest";
import { FakeClock, SystemClock } from "../src/_clock";

describe("FakeClock", () => {
	it("does not resolve a sleep before its deadline, and resolves at it", async () => {
		const clock = new FakeClock();
		let resolved = false;
		const p = clock.sleep(1000).then(() => {
			resolved = true;
		});
		await clock.advance(999);
		expect(resolved).toBe(false);
		await clock.advance(1);
		await p;
		expect(resolved).toBe(true);
		expect(clock.now()).toBe(1000);
	});

	it("fires multiple sleepers in due order", async () => {
		const clock = new FakeClock();
		const order: number[] = [];
		const a = clock.sleep(300).then(() => order.push(300));
		const b = clock.sleep(100).then(() => order.push(100));
		const c = clock.sleep(200).then(() => order.push(200));
		await clock.advance(300);
		await Promise.all([a, b, c]);
		expect(order).toEqual([100, 200, 300]);
	});

	it("drains the sleeper queue after a normal resolve (pending === 0)", async () => {
		const clock = new FakeClock();
		const p = clock.sleep(100);
		expect(clock.pending).toBe(1);
		await clock.advance(100);
		await p;
		expect(clock.pending).toBe(0);
	});

	it("fires sleepers sharing a deadline together, in FIFO insertion order", async () => {
		const clock = new FakeClock();
		const order: string[] = [];
		const a = clock.sleep(100).then(() => order.push("a"));
		const b = clock.sleep(100).then(() => order.push("b"));
		await clock.advance(100);
		await Promise.all([a, b]);
		expect(order).toEqual(["a", "b"]); // stable FIFO among equal deadlines
		expect(clock.pending).toBe(0);
	});

	it("resolves sleep(0) at the current time without moving now()", async () => {
		const clock = new FakeClock({ start: 500 });
		let ran = false;
		const p = clock.sleep(0).then(() => {
			ran = true;
		});
		await clock.advance(0);
		await p;
		expect(ran).toBe(true);
		expect(clock.now()).toBe(500);
	});

	it("clamps a negative delay to 'immediately' and never rewinds now()", async () => {
		const clock = new FakeClock({ start: 1000 });
		let at = -1;
		const p = clock.sleep(-50).then(() => {
			at = clock.now();
		});
		await clock.advance(0);
		await p;
		expect(at).toBe(1000); // fired at current time, not 950
		expect(clock.now()).toBe(1000);
	});

	it("sets now() exactly to the target even when no sleeper fires", async () => {
		const clock = new FakeClock();
		clock.sleep(1000); // never reached
		await clock.advance(999);
		expect(clock.now()).toBe(999);
	});

	it("does not cross-reject a second sleep that reuses a signal from a resolved one", async () => {
		const clock = new FakeClock();
		const ac = new AbortController();
		const first = clock.sleep(100, ac.signal);
		await clock.advance(100);
		await expect(first).resolves.toBeUndefined();
		expect(clock.pending).toBe(0);
		// Reusing the same (not-yet-aborted) signal for a new sleep must work independently.
		const second = clock.sleep(100, ac.signal);
		ac.abort();
		await expect(second).rejects.toMatchObject({ name: "AbortError" });
		expect(clock.pending).toBe(0);
	});

	it("throws if advance() is called re-entrantly", async () => {
		const clock = new FakeClock();
		let innerError: unknown;
		const p = clock.sleep(100).then(async () => {
			try {
				await clock.advance(10);
			} catch (e) {
				innerError = e;
			}
		});
		await clock.advance(100);
		await p;
		expect(innerError).toBeInstanceOf(Error);
		expect((innerError as Error).message).toContain("not re-entrant");
	});

	it("sees the correct now() for a sleep chained inside another sleep's continuation", async () => {
		const clock = new FakeClock();
		let innerAt = -1;
		const p = clock.sleep(100).then(async () => {
			await clock.sleep(50);
			innerAt = clock.now();
		});
		await clock.advance(200);
		await p;
		expect(innerAt).toBe(150);
	});

	it("rejects with AbortError when the signal aborts, and drops the sleeper", async () => {
		const clock = new FakeClock();
		const ac = new AbortController();
		const p = clock.sleep(1000, ac.signal);
		expect(clock.pending).toBe(1);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		expect(clock.pending).toBe(0);
	});

	it("rejects immediately if the signal is already aborted", async () => {
		const clock = new FakeClock();
		const ac = new AbortController();
		ac.abort();
		await expect(clock.sleep(10, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
	});

	it("produces a deterministic RNG sequence for a given seed", () => {
		const a = new FakeClock({ seed: 42 });
		const b = new FakeClock({ seed: 42 });
		const seqA = [a.rng(), a.rng(), a.rng()];
		const seqB = [b.rng(), b.rng(), b.rng()];
		expect(seqA).toEqual(seqB);
		for (const v of seqA) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("honours a custom start time", () => {
		const clock = new FakeClock({ start: 1_700_000_000_000 });
		expect(clock.now()).toBe(1_700_000_000_000);
	});
});

describe("SystemClock", () => {
	it("returns real time and a real random", () => {
		const clock = new SystemClock();
		expect(clock.now()).toBeGreaterThan(0);
		const r = clock.rng();
		expect(r).toBeGreaterThanOrEqual(0);
		expect(r).toBeLessThan(1);
	});

	it("resolves a short real sleep", async () => {
		const clock = new SystemClock();
		await expect(clock.sleep(1)).resolves.toBeUndefined();
	});

	it("rejects a real sleep on abort", async () => {
		const clock = new SystemClock();
		const ac = new AbortController();
		const p = clock.sleep(10_000, ac.signal);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
	});
});
