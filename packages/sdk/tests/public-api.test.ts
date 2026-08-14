// T042 — public-surface snapshot (NFR-008 no-dead-code). Pins the exported runtime surface so a member
// added or a disposition-removed member re-introduced fails loudly. Type-only exports are erased at
// runtime and cannot appear here; their shape is guarded by `isolatedDeclarations` + the barrel. `seq`
// (unmodelled per FR-022) is asserted absent by scanning the model source, since a type cannot be probed
// at runtime.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";
import { CLOSE_CODES, SUKKO_DEFAULTS, SukkoClient } from "../src/index";

describe("public API — barrel value exports", () => {
	it("exports exactly the intended runtime surface (no accidental add, no removed member back)", () => {
		// Value exports only — classes, constants, functions. Type-only exports (Message, options, the
		// transport interface, etc.) are compile-time and never appear at runtime.
		expect(Object.keys(sdk).sort()).toEqual([
			"CLIENT_ID_KEY",
			"CLOSE_CODES",
			"ConfigurationError",
			"ConflictError",
			"EditionRequiredError",
			"ForbiddenError",
			"NotConnectedError",
			"PayloadTooLargeError",
			"ProtocolError",
			"PushClient",
			"RateLimitedError",
			"RecoveryInterruptedError",
			"SUKKO_DEFAULTS",
			"ServiceUnavailableError",
			"SseTransport",
			"SukkoClient",
			"SukkoError",
			"TransportError",
			"TypedEventEmitter",
			"UnauthorizedError",
			"ValidationError",
			"buildChannel",
			"parseChannel",
		]);
	});
});

describe("public API — CLOSE_CODES", () => {
	it("carries the contract set plus the SDK-internal UNAUTHORIZED, and nothing off-contract", () => {
		expect(Object.keys(CLOSE_CODES).sort()).toEqual([
			"FORCE_DISCONNECT",
			"GOING_AWAY",
			"HEARTBEAT_TIMEOUT",
			"INTERNAL_ERROR",
			"NORMAL",
			"POLICY_VIOLATION",
			"UNAUTHORIZED",
		]);
		// The disposition removed these off-contract, unemitted codes (§I exact-match, NFR-008).
		const removed = CLOSE_CODES as unknown as Record<string, number>;
		expect(removed.AUTH_FAILED).toBeUndefined();
		expect(removed.SUBSCRIPTION_FAILED).toBeUndefined();
		expect(removed.PROTOCOL_ERROR).toBeUndefined();
		expect(CLOSE_CODES.UNAUTHORIZED).toBe(4001); // SDK-internal SSE→client signal, never a wire code
	});
});

describe("public API — SUKKO_DEFAULTS", () => {
	it("uses the camelCase knob keys; the old SCREAMING_CASE keys are gone", () => {
		expect(Object.keys(SUKKO_DEFAULTS).sort()).toEqual([
			"authRefreshBackoffMaxMs",
			"authRefreshFloorMs",
			"authRefreshLeadMs",
			"backoffBaseMs",
			"backoffMaxMs",
			"bufferSize",
			"connectTimeoutMs",
			"heartbeatIntervalMs",
			"historyLimit",
			"maxReplayMessages",
			"overflowPolicy",
			"pongTimeoutMs",
			"reconnectMaxAttempts",
			"recoveryDeadlineMs",
			"replayFloorMs",
			"sseIdleTimeoutMs",
			"staleConnectionThresholdMs",
		]);
		const old = SUKKO_DEFAULTS as unknown as Record<string, unknown>;
		for (const key of [
			"CONNECTION_TIMEOUT",
			"RECONNECT_ATTEMPTS",
			"RECONNECT_DELAY_BASE",
			"RECONNECT_DELAY_MAX",
			"HEARTBEAT_INTERVAL",
			"HEARTBEAT_TIMEOUT",
			"STALE_CONNECTION_THRESHOLD",
		]) {
			expect(old[key]).toBeUndefined();
		}
	});
});

describe("public API — SukkoClient methods", () => {
	const proto = SukkoClient.prototype as unknown as Record<string, unknown>;

	it("exposes the intended methods", () => {
		for (const method of [
			"connect",
			"disconnect",
			"subscribe",
			"unsubscribe",
			"publish",
			"restPublish",
			"history",
			"updateToken",
			"refreshToken",
			"escalate",
			"messages",
			"on",
			"off",
		]) {
			expect(typeof proto[method]).toBe("function");
		}
	});

	it("no longer exposes the removed recovery/reconnect methods (internalized, NFR-008)", () => {
		expect(proto.reconnectWithReplay).toBeUndefined();
		expect(proto.resetReconnectAttempts).toBeUndefined();
	});
});

/** Strip line + block comments so a scan sees only code (messages.ts mentions `seq` in prose). */
function stripComments(source: string): string {
	return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("public API — removed type exports stay gone (NFR-008)", () => {
	it("does not re-export the renamed/removed type names from the barrel", () => {
		// Type-only exports are erased at runtime, so a value snapshot can't see them — scan the barrel
		// source instead. `DataMessage` was renamed to `Message`; `AuthRefreshMessage` to an off-wire name.
		const code = stripComments(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
		for (const removed of ["DataMessage", "AuthRefreshMessage"]) {
			expect(new RegExp(`\\b${removed}\\b`).test(code)).toBe(false);
		}
	});
});

describe("message models — `seq` is not modelled (FR-022)", () => {
	it("declares no seq / from_seq / to_seq field anywhere in messages.ts (incl. inline `data: {}`)", () => {
		const code = stripComments(
			readFileSync(new URL("../src/messages.ts", import.meta.url), "utf8"),
		);
		// Position-independent so an inline nested field (`data: { …; from_seq: string }`) is caught too —
		// the `\b` before `seq` keeps `from_pos`/`sequence` from matching, and the explicit `from_seq`/
		// `to_seq` alternatives cover the underscore-prefixed forms.
		const fieldDecl = /\b(seq|from_seq|to_seq)\s*\??\s*:/;
		expect(fieldDecl.test(code)).toBe(false);
	});
});
