// Contract-coverage test (FR-016 / SC-004). Parses the vendored, version-pinned AsyncAPI v1.4.0
// document and asserts every message `type` discriminator it declares has a typed model in
// `messages.ts` — and vice versa. Hermetic: it reads the vendored copy so CI (single-checkout) can
// FAIL, not skip, when a message type is added/renamed. `SUKKO_ASYNCAPI_PATH` overrides the path for
// local runs against a live `../sukko` checkout.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES } from "../src/messages";

const contractPath =
	process.env.SUKKO_ASYNCAPI_PATH ??
	fileURLToPath(new URL("./client-ws.asyncapi.v1.4.0.yaml", import.meta.url));

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

describe("AsyncAPI v1.4.0 contract coverage", () => {
	it("loaded the version-pinned contract", () => {
		expect((doc as { info?: { version?: string } }).info?.version).toBe("1.4.0");
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
