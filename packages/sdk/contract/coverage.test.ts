// Contract-coverage test. Parses the vendored AsyncAPI document and asserts every message
// `type` discriminator it declares has a typed model in `messages.ts` — and vice versa.
// Hermetic: it reads the vendored copy so CI (single-checkout) can FAIL, not skip, when a
// message type is added/renamed. The vendored file is version-pinned + checksummed by
// CONTRACTS.lock (enforced by pin.test.ts); this coverage test is version-agnostic.
// `SUKKO_ASYNCAPI_PATH` overrides the path for local runs against a live `../sukko` checkout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	AUTH_ERROR_CODES,
	CLIENT_MESSAGE_TYPES,
	ERROR_CODES,
	HISTORY_ERROR_CODES,
	PUBLISH_ERROR_CODES,
	RECONNECT_ERROR_CODES,
	SERVER_MESSAGE_TYPES,
	SUBSCRIBE_ERROR_CODES,
	UNSUBSCRIBE_ERROR_CODES,
} from "../src/messages";

const contractPath =
	process.env.SUKKO_ASYNCAPI_PATH ??
	fileURLToPath(new URL("./client-ws.asyncapi.yaml", import.meta.url));

const doc = parse(readFileSync(contractPath, "utf8")) as unknown;

/**
 * Collect every message `type` discriminator declared in the contract: an object of the shape
 * `{ type: "string", const: "<value>" }` that is the value of a property literally named `type`.
 * This captures message discriminators (`{ type: { const: "message" } }`) while excluding status
 * enums such as `{ status: { const: "accepted" } }`, which are keyed `status`, not `type`.
 */
function collectMessageTypeConsts(node: unknown, keyOfNode: string | null, acc: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectMessageTypeConsts(item, null, acc);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	if (keyOfNode === "type" && obj.type === "string" && typeof obj.const === "string") {
		acc.add(obj.const);
	}
	for (const [k, v] of Object.entries(obj)) collectMessageTypeConsts(v, k, acc);
}

const declared = new Set<string>();
collectMessageTypeConsts(doc, null, declared);

/**
 * Collect the error codes the contract declares, keyed by the ENCLOSING message type (its nearest
 * `type: { const: "..." }` discriminator). A `code` schema that is an enum or a single const is
 * recorded under the message it belongs to — per-message, never aggregated, because the same code
 * string means different things on different frames (e.g. `not_available` is a replay failure on
 * `error` but the Direct capability signal on `reconnect_error`). The SDK must model each message's
 * code set exactly; an aggregate check is category-blind and would miss a code moving between
 * messages.
 */
function collectErrorCodesByMessage(
	node: unknown,
	currentType: string | undefined,
	acc: Map<string, Set<string>>,
): void {
	if (Array.isArray(node)) {
		for (const item of node) collectErrorCodesByMessage(item, currentType, acc);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	const t = obj.type as Record<string, unknown> | undefined;
	const nextType =
		t && typeof t === "object" && typeof t.const === "string" ? t.const : currentType;
	const code = obj.code;
	if (code !== null && typeof code === "object") {
		const c = code as Record<string, unknown>;
		const key = nextType ?? "(no-message-type)";
		const set = acc.get(key) ?? new Set<string>();
		acc.set(key, set);
		if (Array.isArray(c.enum)) for (const v of c.enum) if (typeof v === "string") set.add(v);
		if (typeof c.const === "string") set.add(c.const);
	}
	for (const v of Object.values(obj)) collectErrorCodesByMessage(v, nextType, acc);
}

const errorCodesByMessage = new Map<string, Set<string>>();
collectErrorCodesByMessage(doc, undefined, errorCodesByMessage);

// The SDK's per-message error-code arrays, each paired with its contract message type.
const ERROR_CODE_CASES: ReadonlyArray<readonly [type: string, codes: readonly string[]]> = [
	["publish_error", PUBLISH_ERROR_CODES],
	["reconnect_error", RECONNECT_ERROR_CODES],
	["error", ERROR_CODES],
	["subscribe_error", SUBSCRIBE_ERROR_CODES],
	["unsubscribe_error", UNSUBSCRIBE_ERROR_CODES],
	["auth_error", AUTH_ERROR_CODES],
	["history_error", HISTORY_ERROR_CODES],
];

// Declared-unsupported codes (Smithy-style per-item IDs), keyed by {type, code}: a contract code the
// SDK deliberately does not model, with a reason. Keeps the gate honest — a new contract code is RED
// (must be modelled or declared here), never a silent miss. Empty today.
const UNSUPPORTED_ERROR_CODES: ReadonlyArray<{ type: string; code: string; reason: string }> = [];

describe("AsyncAPI contract coverage", () => {
	it("loaded a versioned contract", () => {
		// Version-agnostic: the exact version + checksum are pinned by pin.test.ts.
		expect((doc as { info?: { version?: string } }).info?.version).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("models exactly the message types the contract declares (no missing, no extra)", () => {
		const modelled = new Set<string>([...SERVER_MESSAGE_TYPES, ...CLIENT_MESSAGE_TYPES]);
		const missing = [...declared].filter((t) => !modelled.has(t)).sort();
		const extra = [...modelled].filter((t) => !declared.has(t)).sort();
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});

	it("declares 26 message types (18 server + 8 client)", () => {
		expect(declared.size).toBe(26);
		expect(SERVER_MESSAGE_TYPES.length).toBe(18);
		expect(CLIENT_MESSAGE_TYPES.length).toBe(8);
	});

	it("has no `force_disconnect` message type — it is close code 4000, not a message", () => {
		expect(declared.has("force_disconnect")).toBe(false);
	});
});

describe("WS error-code coverage (per message type)", () => {
	it("covers every error message type the contract declares (no silently-uncovered message)", () => {
		const contractErrorMsgs = [...errorCodesByMessage.keys()].sort();
		const covered = ERROR_CODE_CASES.map(([type]) => type).sort();
		expect(contractErrorMsgs).toEqual(covered);
	});

	for (const [type, sdkCodes] of ERROR_CODE_CASES) {
		it(`models ${type} codes exactly (no missing, no phantom)`, () => {
			const allowed = new Set(
				UNSUPPORTED_ERROR_CODES.filter((u) => u.type === type).map((u) => u.code),
			);
			const contractCodes = [...(errorCodesByMessage.get(type) ?? new Set<string>())]
				.filter((c) => !allowed.has(c))
				.sort();
			expect([...sdkCodes].sort()).toEqual(contractCodes);
		});
	}
});
