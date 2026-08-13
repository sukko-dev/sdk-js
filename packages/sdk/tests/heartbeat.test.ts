import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/_clock";
import { HeartbeatMonitor } from "../src/heartbeat";

const INTERVAL = 30000;
const PONG = 5000;

describe("HeartbeatMonitor", () => {
	it("does not start on a receive-only transport (canSend: false)", async () => {
		const clock = new FakeClock();
		let sends = 0;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: false,
			send: () => sends++,
			onTimeout: () => {},
		});
		await hb.run(new AbortController().signal); // returns immediately
		await clock.advance(INTERVAL * 3);
		expect(sends).toBe(0);
	});

	it("sends a heartbeat each interval and stays alive while frames keep arriving", async () => {
		const clock = new FakeClock();
		let sends = 0;
		let timedOut = false;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {
				sends++;
				hb.noteActivity(); // simulate the server replying (pong / any frame) immediately
			},
			onTimeout: () => {
				timedOut = true;
			},
		});
		const ac = new AbortController();
		const running = hb.run(ac.signal);

		// Cycle 1: interval → send, then pong window → alive.
		await clock.advance(INTERVAL);
		expect(sends).toBe(1);
		await clock.advance(PONG);
		expect(timedOut).toBe(false);
		// Cycle 2.
		await clock.advance(INTERVAL);
		expect(sends).toBe(2);
		await clock.advance(PONG);
		expect(timedOut).toBe(false);

		ac.abort();
		await running; // resolves cleanly on abort
	});

	it("times out when no inbound frame arrives within pongTimeoutMs of a heartbeat", async () => {
		const clock = new FakeClock();
		let timedOut = false;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {}, // no pong / no activity
			onTimeout: () => {
				timedOut = true;
			},
		});
		const running = hb.run(new AbortController().signal);
		await clock.advance(INTERVAL); // send
		expect(timedOut).toBe(false); // pong window not elapsed yet
		await clock.advance(PONG); // no frame arrived → timeout
		expect(timedOut).toBe(true);
		await running; // the loop returned after firing onTimeout
	});

	it("any inbound frame (not just the send) keeps it alive", async () => {
		const clock = new FakeClock();
		let timedOut = false;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {}, // send does NOT note activity itself
			onTimeout: () => {
				timedOut = true;
			},
		});
		const ac = new AbortController();
		const running = hb.run(ac.signal);
		await clock.advance(INTERVAL); // heartbeat sent
		hb.noteActivity(); // a live message arrives during the pong window
		await clock.advance(PONG);
		expect(timedOut).toBe(false);
		ac.abort();
		await running;
	});

	it("resolves cleanly when aborted during the pong window (after the heartbeat is sent)", async () => {
		const clock = new FakeClock();
		let timedOut = false;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {},
			onTimeout: () => {
				timedOut = true;
			},
		});
		const ac = new AbortController();
		const running = hb.run(ac.signal);
		await clock.advance(INTERVAL); // heartbeat sent; now parked in the pong window
		ac.abort();
		await expect(running).resolves.toBeUndefined();
		expect(timedOut).toBe(false); // onTimeout never fires after abort
	});

	it("a frame arriving BEFORE the heartbeat is sent does not answer the probe (still times out)", async () => {
		const clock = new FakeClock();
		let timedOut = false;
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {},
			onTimeout: () => {
				timedOut = true;
			},
		});
		const running = hb.run(new AbortController().signal);
		await clock.advance(INTERVAL - 1);
		hb.noteActivity(); // a frame arrives just before the heartbeat goes out (lastActivityAt < sentAt)
		await clock.advance(1); // heartbeat sent
		await clock.advance(PONG); // pong window elapses with no NEW frame → timeout
		expect(timedOut).toBe(true);
		await running;
	});

	it("resolves cleanly when aborted mid-interval", async () => {
		const clock = new FakeClock();
		const hb = new HeartbeatMonitor({
			clock,
			intervalMs: INTERVAL,
			pongTimeoutMs: PONG,
			canSend: true,
			send: () => {},
			onTimeout: () => {},
		});
		const ac = new AbortController();
		const running = hb.run(ac.signal);
		await clock.advance(1000); // mid-interval
		ac.abort();
		await expect(running).resolves.toBeUndefined();
	});
});
