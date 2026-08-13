// Shared REST plumbing for the gateway (§X consolidation) — one authed JSON client that REST publish,
// push, and (later) auth build on. Header-default auth is read FRESH per request via a token callback,
// so a token rotated by the auth machinery is picked up without rebuilding the client. Every non-2xx
// response is mapped to a typed `SukkoError` (edition, over-size, rate-limit, …); a `Retry-After` is
// parsed onto the 429 `RateLimitedError`. The `fetch` and `clock` are injectable test seams. The JS
// analog of sukko-py's `_http.HttpApi`.

import { type Clock, SystemClock } from "./_clock";
import { redact, registerSecret } from "./_redact";
import { SUKKO_DEFAULTS } from "./constants";
import {
	EditionRequiredError,
	ProtocolError,
	type SukkoError,
	TransportError,
	errorFromHttpStatus,
} from "./errors";

/** The subset of the WHATWG `fetch` signature the SDK uses; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Returns the current credential (JWT / api-key), read per request so rotation is picked up. */
export type TokenProvider = () => string | undefined;

export interface HttpApiOptions {
	/** The gateway HTTP origin, e.g. `https://gw.example.com` (trailing slash tolerated). */
	baseUrl: string;
	/** Current-credential getter, called per request. */
	token: TokenProvider;
	/** Injectable `fetch`. Default: the global `fetch`. */
	fetch?: FetchLike;
	/** Injectable clock for the request timeout. Default: SystemClock. */
	clock?: Clock;
	/** Per-request deadline in ms. Default: `connectTimeoutMs`. */
	timeoutMs?: number;
}

export interface RequestOptions {
	/** JSON request body; sets `Content-Type: application/json`. */
	json?: unknown;
	/** A raw, pre-serialized request body for cases `JSON.stringify` can't express — the push
	 * `device_id` int64 must ride the wire as an UNQUOTED number literal. Mutually exclusive with
	 * `json`; also sets `Content-Type: application/json`. */
	body?: string;
	/** Marks an endpoint whose only 4xx cause is the edition gate (the push endpoints), so a 403
	 * reliably becomes `EditionRequiredError` even when the gateway omits the `code`. */
	editionGated?: boolean;
}

/** A thin authed JSON client over one gateway origin. */
export class HttpApi {
	private readonly baseUrl: string;
	private readonly token: TokenProvider;
	private readonly fetchImpl: FetchLike;
	private readonly clock: Clock;
	private readonly timeoutMs: number;

	constructor(options: HttpApiOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.token = options.token;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.clock = options.clock ?? new SystemClock();
		this.timeoutMs = options.timeoutMs ?? SUKKO_DEFAULTS.connectTimeoutMs;
	}

	/**
	 * Send an authed JSON request and resolve to the parsed JSON object (an empty body → `{}`). Rejects
	 * with a typed `SukkoError` on any non-2xx response or transport failure.
	 */
	async request<T = Record<string, unknown>>(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const text = await this.requestText(method, path, options);
		if (text === "") return {} as T;
		try {
			return JSON.parse(text) as T;
		} catch (err) {
			throw new ProtocolError(`malformed response body: ${messageOf(err)}`);
		}
	}

	/**
	 * Like `request` but resolves to the RAW response text (still authed + typed-error mapped). For a
	 * caller that must parse the body itself — the push `device_id` is an int64 that `JSON.parse` would
	 * round through a lossy JS `number`, so it is extracted from the raw text as a string.
	 */
	async requestText(method: string, path: string, options: RequestOptions = {}): Promise<string> {
		const token = this.token();
		registerSecret(token); // §IX: mask it if a URL/header ever lands in an error string
		const headers: Record<string, string> = {};
		if (token) headers.Authorization = `Bearer ${token}`;
		const body =
			options.body ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined);
		if (body !== undefined) headers["Content-Type"] = "application/json";

		// Race the request against a clock-driven deadline (aborts the fetch on timeout).
		const aborter = new AbortController();
		const timer = new AbortController();
		void this.clock.sleep(this.timeoutMs, timer.signal).then(
			() => aborter.abort(),
			() => {},
		);

		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers,
				body,
				signal: aborter.signal,
			});
		} catch (err) {
			throw new TransportError(redact(`http request failed: ${messageOf(err)}`));
		} finally {
			timer.abort();
		}

		if (response.status >= 400) {
			throw await errorForResponse(response, options.editionGated ?? false);
		}
		return response.text();
	}
}

/** Map a non-2xx response to a typed error, reading `{code, message}` and `Retry-After` from it. */
async function errorForResponse(response: Response, editionGated: boolean): Promise<SukkoError> {
	// A push 403 is only ever the edition gate — surface it typed even if the gateway omits `code`.
	if (editionGated && response.status === 403) {
		return new EditionRequiredError("this feature requires a higher edition");
	}
	let code = "";
	let message = "";
	try {
		const body = JSON.parse(await response.text()) as { code?: unknown; message?: unknown };
		if (typeof body.code === "string") code = body.code;
		if (typeof body.message === "string") message = body.message;
	} catch {
		// Non-JSON error body — fall back to the status→type mapping with empty code/message.
	}
	// §IX: the gateway's message/code can echo the rejected credential (e.g. an auth error quoting the
	// token) — redact before it becomes a thrown error string.
	return errorFromHttpStatus(
		response.status,
		redact(code),
		redact(message),
		parseRetryAfter(response.headers),
	);
}

/** Parse a `Retry-After` header (delta-seconds → ms). Undefined if absent/non-numeric — the HTTP-date
 * form is not honored (the gateway sends delta-seconds when it sends the header). */
function parseRetryAfter(headers: Headers): number | undefined {
	const value = headers.get("Retry-After");
	if (value === null) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
