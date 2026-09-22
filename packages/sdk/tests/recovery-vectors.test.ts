// Parity-vector binding for the `recovery` machine. Loads the vendored, checksum-pinned corpus
// (platform ADR-0023 / sdk-js ADR-0004) and replays each recovery scenario through the real
// RecoveryEngine via a thin VectorMachine adapter — proving the language-neutral schema binds to
// this SDK's pure FSM and that its canonical actions match the contract's expected effects.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Clock } from "../src/_clock";
import { RecoveryEngine } from "../src/recovery";
import {
	type VectorInput,
	type VectorMachine,
	type VectorScenario,
	isAdvance,
	runScenario,
} from "./_vectors";

const VECTORS_DIR = join(__dirname, "..", "contract", "vectors");

// A minimal virtual clock: `advance` inputs move `t`; RecoveryEngine only reads now().
class VectorClock implements Clock {
	t = 0;
	now(): number {
		return this.t;
	}
	sleep(): Promise<void> {
		return Promise.resolve();
	}
	rng(): number {
		return 0;
	}
}

// Adapter: map each language-neutral vector input to a RecoveryEngine call, returning the engine's
// canonical actions. `advance` moves virtual time then fires due() timers, exactly as the client would.
class RecoveryVectorMachine implements VectorMachine {
	private readonly clock = new VectorClock();
	private readonly engine: RecoveryEngine;
	constructor() {
		this.engine = new RecoveryEngine({ clientId: "c1", clock: this.clock });
		this.engine.markConnected();
	}
	step(input: VectorInput) {
		if (isAdvance(input)) {
			this.clock.t += input.advance;
			return this.engine.due();
		}
		switch (input.event) {
			case "gap":
				return this.engine.handleGap(input.channel as string, input.last_pos as string);
			case "replay_message":
				this.engine.handleReplayMessage(input.channel as string);
				return [];
			case "replay_complete":
				return this.engine.handleReplayComplete(input.channel as string);
			case "disconnect":
				return this.engine.handleDisconnect();
			default:
				throw new Error(`recovery vector: unhandled input event ${JSON.stringify(input)}`);
		}
	}
}

function loadScenario(rel: string): VectorScenario {
	return JSON.parse(readFileSync(join(VECTORS_DIR, rel), "utf8")) as VectorScenario;
}

describe("recovery parity vectors", () => {
	const recoveryDir = join(VECTORS_DIR, "recovery");
	const files = readdirSync(recoveryDir)
		.filter((f) => f.endsWith(".json"))
		.sort();
	// Every vendored recovery vector replays through the real RecoveryEngine and must produce the
	// scenario's canonical actions — adding a scenario is one JSON file (vendored), no test change.
	for (const file of files) {
		it(`replays ${file} to its canonical actions`, () => {
			const scenario = loadScenario(`recovery/${file}`);
			expect(scenario.machine).toBe("recovery");
			expect(runScenario(new RecoveryVectorMachine(), scenario)).toEqual(scenario.expect);
		});
	}
});
