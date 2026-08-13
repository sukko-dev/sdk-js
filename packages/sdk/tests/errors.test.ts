import { describe, expect, it } from "vitest";
import {
	ConfigurationError,
	ConnectionClosedError,
	EditionRequiredError,
	NotConnectedError,
	ProtocolError,
	REPLAY_ERROR_CODES,
	RateLimitedError,
	RecoveryInterruptedError,
	ServiceUnavailableError,
	SukkoError,
	UnauthorizedError,
	errorFromHttpStatus,
} from "../src/errors";

describe("error hierarchy", () => {
	it("every typed error extends SukkoError and reports its own class name", () => {
		const cases: SukkoError[] = [
			new NotConnectedError("x"),
			new ConfigurationError("x"),
			new RecoveryInterruptedError("x"),
			new ProtocolError("x"),
			new EditionRequiredError("x"),
			new ServiceUnavailableError("x"),
			new UnauthorizedError("x"),
		];
		for (const e of cases) {
			expect(e).toBeInstanceOf(SukkoError);
			expect(e).toBeInstanceOf(Error);
			expect(e.name).toBe(e.constructor.name);
			expect(e.message).toBe("x");
		}
	});

	it("ConnectionClosedError carries the close code and direction", () => {
		const e = new ConnectionClosedError(4000, "remote", "force disconnect");
		expect(e).toBeInstanceOf(SukkoError);
		expect(e.code).toBe(4000);
		expect(e.direction).toBe("remote");
	});

	it("RateLimitedError carries an optional retryAfterMs", () => {
		expect(new RateLimitedError("slow down", 5000).retryAfterMs).toBe(5000);
		expect(new RateLimitedError("slow down").retryAfterMs).toBeUndefined();
	});

	it("REPLAY_ERROR_CODES mirrors the AsyncAPI receiveReplayError enum exactly", () => {
		// The contract's `receiveReplayError` lists these seven codes as `sendReplay` rejections (§I).
		expect([...REPLAY_ERROR_CODES].sort()).toEqual(
			[
				"invalid_request",
				"not_available",
				"not_subscribed",
				"offset_out_of_range",
				"replay_failed",
				"replay_in_progress",
				"replay_rate_limited",
			].sort(),
		);
		// `not_available` IS a replay failure on an `error` frame — distinct from `reconnect_error:
		// not_available` (the Direct-degrade signal), which is routed by message type, not by this set.
		expect(REPLAY_ERROR_CODES).toContain("not_available");
		expect(REPLAY_ERROR_CODES).not.toContain("invalid_json"); // the generic malformed-frame error, not a replay code
	});
});

describe("errorFromHttpStatus", () => {
	it("maps each gateway status to the right typed error", () => {
		expect(errorFromHttpStatus(401, "UNAUTHORIZED", "m")).toBeInstanceOf(UnauthorizedError);
		expect(errorFromHttpStatus(403, "EDITION_LIMIT", "m")).toBeInstanceOf(EditionRequiredError);
		expect(errorFromHttpStatus(429, "TENANT_LIMIT_EXCEEDED", "m")).toBeInstanceOf(RateLimitedError);
		expect(errorFromHttpStatus(503, "SERVICE_UNAVAILABLE", "m")).toBeInstanceOf(
			ServiceUnavailableError,
		);
	});

	it("maps an EDITION_LIMIT code to EditionRequiredError even off a non-403 status", () => {
		expect(errorFromHttpStatus(400, "EDITION_LIMIT", "m")).toBeInstanceOf(EditionRequiredError);
	});

	it("falls back to ProtocolError for an unrecognised status/code", () => {
		const e = errorFromHttpStatus(500, "INTERNAL", "boom");
		expect(e).toBeInstanceOf(ProtocolError);
		expect(e.message).toContain("INTERNAL");
	});
});
