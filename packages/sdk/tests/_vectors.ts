// Parity-vector harness (NFR-007). A scenario is a language-neutral JSON list of inputs replayed
// against a PURE state machine; the machine emits an ordered list of canonical actions that must
// equal the scenario's `expect`. Both SDKs (sukko-js canonical, sukko-py vendored) replay the same
// fixtures, so "identical behaviour" is a real cross-language equality check, not two self-checks.
//
// Fixtures live in `contract/vectors/*.json` (added alongside the recovery/auth machines in later
// phases — see contract/vectors/README.md for the schema). This module is the runner + types only.

/** A virtual-time advance, in milliseconds — drives timing-gated paths deterministically. */
export interface AdvanceInput {
	advance: number;
}

/** A named event fed to the machine, with arbitrary canonical payload keys. */
export interface EventInput {
	event: string;
	[key: string]: unknown;
}

export type VectorInput = AdvanceInput | EventInput;

/** A canonical action a machine emits: a snake_case `action` tag plus canonical arg keys. */
export interface VectorAction {
	action: string;
	[key: string]: unknown;
}

export interface VectorScenario {
	name: string;
	machine: string; // "recovery" | "auth" | "subscriptions"
	inputs: VectorInput[];
	expect: VectorAction[];
}

/** A pure, vector-drivable machine: consumes one input, returns zero+ canonical actions. No I/O. */
export interface VectorMachine {
	step(input: VectorInput): VectorAction[];
}

export function isAdvance(input: VectorInput): input is AdvanceInput {
	return typeof (input as AdvanceInput).advance === "number";
}

/** Replay a scenario's inputs through the machine and return the concatenated action list. */
export function runScenario(machine: VectorMachine, scenario: VectorScenario): VectorAction[] {
	const actions: VectorAction[] = [];
	for (const input of scenario.inputs) {
		for (const a of machine.step(input)) actions.push(a);
	}
	return actions;
}
