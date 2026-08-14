// Self-test for the parity-vector harness (T015). Real recovery/auth fixtures land with their
// machines (Phases 3–4); here a toy machine proves the runner replays inputs, threads virtual-time
// `advance` events, and produces an order-sensitive canonical action list.

import { describe, expect, it } from "vitest";
import {
	type VectorInput,
	type VectorMachine,
	type VectorScenario,
	isAdvance,
	runScenario,
} from "./_vectors";

// A toy machine: emits `tick` on advance and echoes any event as an `echo` action carrying its name.
class ToyMachine implements VectorMachine {
	private elapsed = 0;
	step(input: VectorInput) {
		if (isAdvance(input)) {
			this.elapsed += input.advance;
			return [{ action: "tick", elapsed: this.elapsed }];
		}
		return [{ action: "echo", event: input.event }];
	}
}

describe("parity-vector harness", () => {
	it("replays inputs in order and threads virtual-time advances", () => {
		const scenario: VectorScenario = {
			name: "toy/basic",
			machine: "toy",
			inputs: [{ event: "connected" }, { advance: 100 }, { event: "gap" }, { advance: 50 }],
			expect: [
				{ action: "echo", event: "connected" },
				{ action: "tick", elapsed: 100 },
				{ action: "echo", event: "gap" },
				{ action: "tick", elapsed: 150 },
			],
		};
		expect(runScenario(new ToyMachine(), scenario)).toEqual(scenario.expect);
	});

	it("is order-sensitive (a reordered expectation must not match)", () => {
		const scenario: VectorScenario = {
			name: "toy/order",
			machine: "toy",
			inputs: [{ event: "a" }, { event: "b" }],
			expect: [
				{ action: "echo", event: "a" },
				{ action: "echo", event: "b" },
			],
		};
		const actual = runScenario(new ToyMachine(), scenario);
		expect(actual).toEqual(scenario.expect);
		expect(actual).not.toEqual([...scenario.expect].reverse());
	});

	it("isAdvance discriminates advance inputs from events", () => {
		expect(isAdvance({ advance: 10 })).toBe(true);
		expect(isAdvance({ event: "x" })).toBe(false);
	});
});
