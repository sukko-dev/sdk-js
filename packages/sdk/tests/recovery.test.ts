import { describe, expect, it } from "vitest";
import type { Clock } from "../src/_clock";
import { RecoveryEngine } from "../src/recovery";
import { type VectorInput, type VectorMachine, isAdvance, runScenario } from "./_vectors";

// The recovery engine only reads clock.now(), so a sync clock lets vector `advance` steps run
// synchronously (no sleepers to await).
class SyncClock implements Clock {
	private t = 0;
	now(): number {
		return this.t;
	}
	advanceSync(ms: number): void {
		this.t += ms;
	}
	sleep(): Promise<void> {
		throw new Error("recovery engine does not sleep");
	}
	rng(): number {
		return 0.5;
	}
}

const FLOOR = 10000;
const DEADLINE = 10000;

function makeEngine(): { engine: RecoveryEngine; clock: SyncClock } {
	const clock = new SyncClock();
	const engine = new RecoveryEngine({
		clientId: "c1",
		clock,
		replayFloorMs: FLOOR,
		recoveryDeadlineMs: DEADLINE,
	});
	return { engine, clock };
}

describe("RecoveryEngine — live gap → replay", () => {
	it("replays immediately when the floor is open", () => {
		const { engine } = makeEngine();
		expect(engine.handleGap("acme.x", "2-100")).toEqual([
			{ action: "send_replay", channel: "acme.x", from_pos: "2-100" },
		]);
	});

	it("waits out the per-channel floor, then replays on due()", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // first replay at t=0
		engine.handleReplayComplete("acme.x");
		clock.advanceSync(3000);
		expect(engine.handleGap("acme.x", "2-150")).toEqual([]); // floor not elapsed → floor_wait
		expect(engine.due()).toEqual([]); // still waiting
		clock.advanceSync(FLOOR); // past the floor
		expect(engine.due()).toEqual([{ action: "send_replay", channel: "acme.x", from_pos: "2-150" }]);
	});

	it("coalesces a second gap during floor-wait onto the earlier anchor", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100");
		engine.handleReplayComplete("acme.x");
		clock.advanceSync(1000);
		engine.handleGap("acme.x", "2-150"); // floor_wait, anchor=2-150
		expect(engine.handleGap("acme.x", "2-200")).toEqual([]); // coalesced — anchor unchanged
		clock.advanceSync(FLOOR);
		expect(engine.due()).toEqual([{ action: "send_replay", channel: "acme.x", from_pos: "2-150" }]);
	});

	it("starts a follow-up cycle for a gap that lands mid-replay", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying
		engine.handleGap("acme.x", "2-200"); // mid-replay → followup anchor
		clock.advanceSync(FLOOR); // floor open for the follow-up
		expect(engine.handleReplayComplete("acme.x")).toEqual([
			{ action: "send_replay", channel: "acme.x", from_pos: "2-200" },
		]);
	});

	it("holds the follow-up in floor-wait when the floor has NOT elapsed, then fires it on due()", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying (lastReplayAt=0)
		engine.handleGap("acme.x", "2-200"); // followup
		clock.advanceSync(2000); // floor not elapsed
		expect(engine.handleReplayComplete("acme.x")).toEqual([]); // → floor_wait, not immediate
		expect(engine.due()).toEqual([]);
		clock.advanceSync(FLOOR);
		expect(engine.due()).toEqual([{ action: "send_replay", channel: "acme.x", from_pos: "2-200" }]);
	});

	it("is a no-op for replay_complete on an idle channel (stray/duplicate complete)", () => {
		const { engine } = makeEngine();
		expect(engine.handleReplayComplete("never.seen")).toEqual([]);
	});

	it("ignores a gap once Direct (no replayable pos on the Direct backend)", () => {
		const { engine } = makeEngine();
		engine.markConnected();
		engine.handleNotAvailable(["acme.x"]);
		expect(engine.handleGap("acme.x", "2-100")).toEqual([]); // Direct is terminal for pos-recovery
	});

	it("fires due() independently per channel", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.a", "1-1"); // replaying, deadline at t=DEADLINE
		engine.handleReplayComplete("acme.a"); // acme.a idle
		clock.advanceSync(1);
		engine.handleGap("acme.b", "2-2"); // replaying, deadline at t=DEADLINE+1
		clock.advanceSync(DEADLINE); // t=DEADLINE+1: only acme.b's... acme.a idle, acme.b deadline reached
		const actions = engine.due();
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ action: "raise_recovery_interrupted", channel: "acme.b" });
	});
});

describe("RecoveryEngine — RecoveryInterrupted triggers (3)", () => {
	it("raises on a missing replay_complete past the detection deadline", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying, deadline = DEADLINE
		clock.advanceSync(DEADLINE + 1);
		expect(engine.due()).toEqual([
			{
				action: "raise_recovery_interrupted",
				channel: "acme.x",
				reason: expect.stringContaining("replay_complete"), // specific to the replay path, not history
			},
		]);
	});

	it("raises immediately on a disconnect mid-recovery", () => {
		const { engine } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying
		expect(engine.handleDisconnect()).toEqual([
			{
				action: "raise_recovery_interrupted",
				channel: "acme.x",
				reason: "disconnected mid-recovery",
			},
		]);
	});

	it("raises on a replay error code mid-recovery", () => {
		const { engine } = makeEngine();
		engine.handleGap("acme.x", "2-100");
		expect(engine.handleRecoveryFailure("acme.x", "replay_failed")).toEqual([
			{ action: "raise_recovery_interrupted", channel: "acme.x", reason: "replay_failed" },
		]);
	});
});

describe("RecoveryEngine — deadline is a per-frame idle timer (fix #3)", () => {
	it("does NOT raise if replay frames keep arriving, even past the original absolute deadline", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying, deadline at t=DEADLINE
		clock.advanceSync(DEADLINE - 1000);
		engine.handleReplayMessage("acme.x"); // reset: deadline now at t=(DEADLINE-1000)+DEADLINE
		clock.advanceSync(2000); // t = DEADLINE+1000 — past the ORIGINAL absolute deadline
		expect(engine.due()).toEqual([]); // but a frame reset it → no spurious interrupt
	});

	it("still raises once frames stop for a full deadline window", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100");
		clock.advanceSync(5000);
		engine.handleReplayMessage("acme.x"); // reset at t=5000 → deadline t=15000
		clock.advanceSync(DEADLINE + 1); // t=15001 > 15000
		expect(engine.due()).toHaveLength(1);
	});
});

describe("RecoveryEngine — reconnect + Direct degrade (fix #1)", () => {
	it("returns null on a fresh first connection (nothing to resume or probe)", () => {
		const { engine } = makeEngine();
		expect(engine.buildReconnect()).toBeNull();
	});

	it("probes with an empty last_pos once connected-once with no pos (Direct detection)", () => {
		const { engine } = makeEngine();
		engine.markConnected();
		expect(engine.buildReconnect()).toEqual({
			action: "send_reconnect",
			client_id: "c1",
			last_pos: {},
		});
	});

	it("resumes from stored pos when present", () => {
		const { engine } = makeEngine();
		engine.markConnected();
		engine.notePos("acme.x", "3-42");
		engine.notePos("acme.y", undefined); // Direct message — ignored
		expect(engine.buildReconnect()).toEqual({
			action: "send_reconnect",
			client_id: "c1",
			last_pos: { "acme.x": "3-42" },
		});
	});

	it("degrades to PossibleGap on not_available and stops probing", () => {
		const { engine } = makeEngine();
		engine.markConnected();
		expect(engine.handleNotAvailable(["acme.x", "acme.y"])).toEqual([
			{ action: "emit_possible_gap", channel: "acme.x" },
			{ action: "emit_possible_gap", channel: "acme.y" },
		]);
		expect(engine.isDirect).toBe(true);
		expect(engine.buildReconnect()).toBeNull(); // no more probing once Direct
	});
});

describe("RecoveryEngine — history deadline", () => {
	it("raises RecoveryInterrupted when history_complete never arrives", () => {
		const { engine, clock } = makeEngine();
		engine.noteHistoryRequest("acme.x");
		clock.advanceSync(DEADLINE + 1);
		expect(engine.due()).toEqual([
			{
				action: "raise_recovery_interrupted",
				channel: "acme.x",
				reason: expect.stringContaining("history_complete"),
			},
		]);
	});

	it("resets the history deadline on each history frame, and clears on complete", () => {
		const { engine, clock } = makeEngine();
		engine.noteHistoryRequest("acme.x");
		clock.advanceSync(DEADLINE - 1000);
		engine.handleHistoryMessage("acme.x"); // reset
		clock.advanceSync(2000);
		expect(engine.due()).toEqual([]); // not past the reset deadline
		engine.handleHistoryComplete("acme.x");
		clock.advanceSync(DEADLINE * 2);
		expect(engine.due()).toEqual([]); // cleared — nothing pending
	});

	it("raises mid-history on a disconnect and clears the deadline", () => {
		const { engine } = makeEngine();
		engine.noteHistoryRequest("acme.x");
		expect(engine.handleDisconnect()).toEqual([
			{
				action: "raise_recovery_interrupted",
				channel: "acme.x",
				reason: "disconnected mid-history",
			},
		]);
		expect(engine.due()).toEqual([]); // deadline was cleared
	});

	it("raises nothing on a disconnect of a fully-idle engine", () => {
		const { engine } = makeEngine();
		expect(engine.handleDisconnect()).toEqual([]);
	});
});

describe("RecoveryEngine — forget()", () => {
	it("drops a channel's stored pos so it no longer rides along in the next reconnect-replay", () => {
		const { engine } = makeEngine();
		engine.markConnected();
		engine.notePos("acme.x", "3-42");
		engine.notePos("acme.y", "3-99");
		engine.forget("acme.x");
		expect(engine.buildReconnect()).toEqual({
			action: "send_reconnect",
			client_id: "c1",
			last_pos: { "acme.y": "3-99" },
		});
	});

	it("clears a channel mid-replay so a later due() raises no spurious RecoveryInterrupted", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-100"); // replaying, deadline at t=DEADLINE
		engine.forget("acme.x");
		clock.advanceSync(DEADLINE + 1); // past the (now-forgotten) deadline
		expect(engine.due()).toEqual([]);
		expect(engine.nextDeadline()).toBeNull();
	});

	it("clears an in-flight history deadline for the channel", () => {
		const { engine, clock } = makeEngine();
		engine.noteHistoryRequest("acme.x");
		engine.forget("acme.x");
		clock.advanceSync(DEADLINE + 1);
		expect(engine.due()).toEqual([]);
	});
});

describe("RecoveryEngine — nextDeadline()", () => {
	it("returns null when nothing is pending", () => {
		const { engine } = makeEngine();
		expect(engine.nextDeadline()).toBeNull();
	});

	it("returns a floor-wait's wake time", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.x", "2-1"); // replay at t=0, lastReplayAt=0
		engine.handleReplayComplete("acme.x");
		clock.advanceSync(1000);
		engine.handleGap("acme.x", "2-2"); // floor_wait, wake at lastReplayAt(0)+FLOOR = 10000
		expect(engine.nextDeadline()).toBe(FLOOR);
	});

	it("returns the earliest across replay deadline and history deadline", () => {
		const { engine, clock } = makeEngine();
		engine.handleGap("acme.a", "1-1"); // replaying, deadline at t=DEADLINE
		clock.advanceSync(3000);
		engine.noteHistoryRequest("acme.b"); // history deadline at t=3000+DEADLINE
		// replay deadline (10000) < history deadline (13000) → earliest is the replay deadline
		expect(engine.nextDeadline()).toBe(DEADLINE);
	});
});

// ── Parity-vector fixtures (NFR-007): the engine's actions ARE the canonical encoding. ──
class RecoveryVectorMachine implements VectorMachine {
	private readonly engine: RecoveryEngine;
	constructor(private readonly clock: SyncClock) {
		this.engine = new RecoveryEngine({
			clientId: "c1",
			clock,
			replayFloorMs: FLOOR,
			recoveryDeadlineMs: DEADLINE,
		});
	}
	step(input: VectorInput) {
		if (isAdvance(input)) {
			this.clock.advanceSync(input.advance);
			return this.engine.due();
		}
		switch (input.event) {
			case "connected": {
				this.engine.markConnected();
				const reconnect = this.engine.buildReconnect();
				return reconnect ? [reconnect] : [];
			}
			case "gap":
				return this.engine.handleGap(input.channel as string, input.last_pos as string);
			case "not_available":
				return this.engine.handleNotAvailable(input.channels as string[]);
			default:
				return [];
		}
	}
}

describe("RecoveryEngine — parity-vector driven", () => {
	it("direct-degrade: connect (probe) then not_available → possible_gap", () => {
		const clock = new SyncClock();
		const actual = runScenario(new RecoveryVectorMachine(clock), {
			name: "recovery/direct-degrade",
			machine: "recovery",
			inputs: [{ event: "connected" }, { event: "not_available", channels: ["acme.orders"] }],
			expect: [
				{ action: "send_reconnect", client_id: "c1", last_pos: {} },
				{ action: "emit_possible_gap", channel: "acme.orders" },
			],
		});
		expect(actual).toEqual([
			{ action: "send_reconnect", client_id: "c1", last_pos: {} },
			{ action: "emit_possible_gap", channel: "acme.orders" },
		]);
	});

	it("gap then floor-wait then advance → send_replay", () => {
		const clock = new SyncClock();
		const machine = new RecoveryVectorMachine(clock);
		const actual = runScenario(machine, {
			name: "recovery/gap-replay",
			machine: "recovery",
			inputs: [{ event: "gap", channel: "acme.x", last_pos: "2-100" }],
			expect: [{ action: "send_replay", channel: "acme.x", from_pos: "2-100" }],
		});
		expect(actual).toEqual([{ action: "send_replay", channel: "acme.x", from_pos: "2-100" }]);
	});
});
