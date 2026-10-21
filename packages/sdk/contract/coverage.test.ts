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
 * Collect every error code the contract declares: the values of a schema property named `code`
 * that is an enum (`code: { enum: [...] }`) or a single const (`code: { const: "..." }`). This is
 * the authoritative WS error-code universe the SDK must model.
 */
function collectErrorCodes(node: unknown, acc: Set<string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectErrorCodes(item, acc);
		return;
	}
	if (node === null || typeof node !== "object") return;
	const obj = node as Record<string, unknown>;
	const code = obj.code;
	if (code !== null && typeof code === "object") {
		const c = code as Record<string, unknown>;
		if (Array.isArray(c.enum)) for (const v of c.enum) if (typeof v === "string") acc.add(v);
		if (typeof c.const === "string") acc.add(c.const);
	}
	for (const v of Object.values(obj)) collectErrorCodes(v, acc);
}

const contractErrorCodes = new Set<string>();
collectErrorCodes(doc, contractErrorCodes);

// Declared-unsupported WS error codes (Smithy-style per-item IDs): contract codes the SDK
// deliberately does not model, each with a reason. Keeps the gate honest — a new contract code
// is RED (must be handled or declared here), never a silent miss. Empty today.
const UNSUPPORTED_ERROR_CODES: ReadonlyArray<{ code: string; reason: string }> = [];

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

describe("WS error-code coverage", () => {
	const modelled = new Set<string>([
		...PUBLISH_ERROR_CODES,
		...RECONNECT_ERROR_CODES,
		...ERROR_CODES,
		...SUBSCRIBE_ERROR_CODES,
		...UNSUBSCRIBE_ERROR_CODES,
		...AUTH_ERROR_CODES,
		...HISTORY_ERROR_CODES,
	]);

	it("models every WS error code the contract declares (no missing, no phantom)", () => {
		const allowed = new Set(UNSUPPORTED_ERROR_CODES.map((u) => u.code));
		// Missing: a contract code the SDK neither models nor explicitly declares unsupported.
		const missing = [...contractErrorCodes]
			.filter((c) => !modelled.has(c) && !allowed.has(c))
			.sort();
		// Phantom: a code the SDK models that the contract no longer declares.
		const extra = [...modelled].filter((c) => !contractErrorCodes.has(c)).sort();
		expect({ missing, extra }).toEqual({ missing: [], extra: [] });
	});
});
