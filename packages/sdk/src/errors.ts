// Typed error hierarchy (§XI Robust — no silent failures). Every contract close code, WS error
// frame, and HTTP status maps to a typed exception; nothing leaks a raw transport error to callers.
// Error messages built from transport/URL strings MUST be passed through `_redact` at the throw site
// (see `_redact.ts`) so credentials never leak — wired into the WS/REST/auth paths as those land.

import type { CloseDirection } from "./constants";

/** Base class for every error the SDK throws. Catch this to catch anything from the SDK. */
export class SukkoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** A method that requires an open connection was called while disconnected. */
export class NotConnectedError extends SukkoError {}

/** A method was called on a transport that lacks the required capability (e.g. `history()` over SSE). */
export class TransportError extends SukkoError {}

/** Invalid client configuration detected at construction — fail fast, never default silently (§II). */
export class ConfigurationError extends SukkoError {}

/**
 * A recovery (reconnect-replay, live replay, or history) was truncated: the detection deadline
 * elapsed with no frame, the connection dropped mid-recovery, or a replay error code arrived.
 * Advisory, not terminal — a later reconnect-replay may still recover the same gap.
 */
export class RecoveryInterruptedError extends SukkoError {
	/** The channel whose recovery was truncated, when the interruption is channel-scoped. */
	readonly channel?: string;
	constructor(message: string, channel?: string) {
		super(message);
		this.channel = channel;
	}
}

/** The server closed the connection, or a local timeout closed it. Carries the close code + direction. */
export class ConnectionClosedError extends SukkoError {
	readonly code: number;
	readonly direction: CloseDirection;
	constructor(code: number, direction: CloseDirection, message: string) {
		super(message);
		this.code = code;
		this.direction = direction;
	}
}

/** A malformed or unexpected server frame, or a response the SDK could not interpret. */
export class ProtocolError extends SukkoError {}

/**
 * The feature requires a higher edition than the tenant holds (gateway `EDITION_LIMIT`, HTTP 403) or
 * the feature is temporarily unavailable (`SERVICE_UNAVAILABLE`, HTTP 503). One typed hierarchy for
 * every edition-gated feature (SSE, push) — never a raw 403/503 (FR-021).
 */
export class EditionRequiredError extends SukkoError {}
export class ServiceUnavailableError extends SukkoError {}

/** Authentication failed and could not be recovered (hard authz reject — distinct from a transient retry). */
export class UnauthorizedError extends SukkoError {}

/** The caller is rate-limited; `retryAfterMs` is the server-advised wait when present (HTTP 429). */
export class RateLimitedError extends SukkoError {
	readonly retryAfterMs?: number;
	constructor(message: string, retryAfterMs?: number) {
		super(message);
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Channel-scoped `error`-frame codes that mean an in-flight replay was rejected or failed
 * (→ `RecoveryInterruptedError`). Mirrors the AsyncAPI `receiveReplayError` enum exactly (§I): every
 * code the contract lists as a `sendReplay` rejection. Distinct from `reconnect_error: not_available`
 * (→ Direct-degrade `PossibleGap`): the same `not_available` string means a replay failure on an
 * `error` frame but the Direct capability signal on a `reconnect_error` frame — disambiguated by the
 * carrying message type, never by the string alone (see recovery.ts / client.ts routing).
 */
export const REPLAY_ERROR_CODES: readonly string[] = [
	"not_subscribed",
	"invalid_request",
	"replay_in_progress",
	"replay_rate_limited",
	"offset_out_of_range",
	"not_available",
	"replay_failed",
];

/** Map a gateway HTTP status to a typed error (used by the REST/SSE layer). */
export function errorFromHttpStatus(status: number, code: string, message: string): SukkoError {
	switch (status) {
		case 401:
			return new UnauthorizedError(message);
		case 403:
			return new EditionRequiredError(message);
		case 429:
			return new RateLimitedError(message);
		case 503:
			return new ServiceUnavailableError(message);
		default:
			return code === "EDITION_LIMIT"
				? new EditionRequiredError(message)
				: new ProtocolError(`${code}: ${message}`);
	}
}
