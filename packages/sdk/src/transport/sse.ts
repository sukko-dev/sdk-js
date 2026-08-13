// SSE transport (T036, FR-010, Pro-gated) — a receive-only `Transport` over `GET /sse`. Derived from
// the gateway OpenAPI: `channels` is a required comma-separated **connect-time** query param;
// `Last-Event-ID` resumes after a drop; the body is `text/event-stream` with `id:` / `event: message`
// / `data: {json}` records plus periodic `: keepalive` comments (no `retry:` field, no subprotocol).
//
// Its capabilities diverge from WebSocket **explicitly** (§XV), not silently: receive-only
// (`canSend`/`canSubscribe`/`canPublish` = false — publish goes via REST, (un)subscribe is
// connect-time, auth-refresh is a reconnect), and there is no read back-pressure
// (`canPauseReceive` = false → the client's delivery queue applies its overflow policy).
//
// Unlike the sukko-py reference (which leans on httpx line-iteration and skips an idle timeout), this
// reads the `fetch` `ReadableStream` with its OWN incremental byte parser (no `EventSource`) and adds
// an `sseIdleTimeoutMs` drop detector — the SOLE SSE liveness signal (no heartbeat over SSE). Both the
// `fetch` and the `clock` are injectable seams for deterministic tests.

import { type Clock, SystemClock } from "../_clock";
import { SUKKO_DEFAULTS } from "../constants";
import { TypedEventEmitter } from "../emitter";
import type { Transport, TransportCapabilities, TransportEvents, TransportState } from "./base";

/** The subset of the WHATWG `fetch` signature the transport uses; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SseTransportOptions {
	/** Base gateway URL; `GET {url}/sse` is opened (or `{url}` already ending in `/sse`). */
	url: string;
	/** Channels to stream — a required, connect-time subscription (comma-joined into the query). */
	channels: string[];
	/** JWT or api-key presented as `Authorization: Bearer`. */
	token?: string;
	/** Injectable clock for the idle + connect timers. Default: SystemClock. */
	clock?: Clock;
	/** Injectable `fetch`. Default: the global `fetch`. */
	fetch?: FetchLike;
	/** Max silence before the stream is treated as dead. Default: `sseIdleTimeoutMs`. */
	idleTimeoutMs?: number;
	/** Handshake deadline for the initial response. Default: `connectTimeoutMs`. */
	connectTimeoutMs?: number;
}

// SSE drops map onto the client's close-code reconnect policy: 1006 (abnormal) → transient (reconnect);
// 1008 (policy) → terminal (a 4xx like the Pro-gate 403 is not retryable); 1000 → clean client close.
const CLOSE_TRANSIENT = 1006;
const CLOSE_TERMINAL = 1008;
const CLOSE_NORMAL = 1000;

// Ceiling on a single unterminated line / accumulated frame. Legit messages are ≤64KB; 1M chars is a
// generous headroom whose only job is to stop a newline-less or never-dispatched flood from growing
// `buffer`/`dataParts` without bound (the idle timer can't catch it — bytes keep arriving). §XI robust.
const MAX_FRAME_CHARS = 1_048_576;

/**
 * A single SSE connection. Reuse-safe: `open()` after `close()` starts a fresh stream.
 *
 * Failure signalling diverges from `WebSocketTransport` **intentionally**: SSE reports EVERY failure
 * (network, non-200, connect/idle timeout, remote end) through `close(code, reason)` — never the
 * `error` event — where the code carries the reconnect verdict (1006 transient / 1008 terminal). A
 * consumer must treat a pre-`open` `close` as a failed connect attempt; it cannot rely on `error`.
 */
export class SseTransport extends TypedEventEmitter<TransportEvents> implements Transport {
	private readonly baseUrl: string;
	private readonly channels: string[];
	private token: string;
	private readonly clock: Clock;
	private readonly fetchImpl: FetchLike;
	private readonly idleTimeoutMs: number;
	private readonly connectTimeoutMs: number;

	private _state: TransportState = "closed";
	private aborter: AbortController | null = null; // the fetch/stream signal
	private idleTimer: AbortController | null = null;
	private closedByClient = false;
	private lastEventId: string | undefined;

	// Incremental parser state (reset per connection).
	private decoder = new TextDecoder();
	private buffer = "";
	private eventType = "message";
	private dataParts: string[] = [];
	private frameChars = 0; // running size of the accumulating frame (for the MAX_FRAME_CHARS cap)

	constructor(options: SseTransportOptions) {
		super();
		if (options.channels.length === 0) {
			throw new Error("SseTransport requires at least one channel (connect-time subscribe)");
		}
		this.baseUrl = options.url;
		this.channels = options.channels;
		this.token = options.token ?? "";
		this.clock = options.clock ?? new SystemClock();
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.idleTimeoutMs = options.idleTimeoutMs ?? SUKKO_DEFAULTS.sseIdleTimeoutMs;
		this.connectTimeoutMs = options.connectTimeoutMs ?? SUKKO_DEFAULTS.connectTimeoutMs;
	}

	// ---------------------------------------------------------------------------
	// Transport interface
	// ---------------------------------------------------------------------------

	get state(): TransportState {
		return this._state;
	}

	get capabilities(): TransportCapabilities {
		return { canSend: false, canSubscribe: false, canPublish: false, canPauseReceive: false };
	}

	setToken(token: string): void {
		this.token = token;
	}

	/** Receive-only — publish goes via REST, (un)subscribe is connect-time. No-op (`canSend: false`). */
	send(_data: string): void {}

	pause(): void {} // no-op — canPauseReceive: false
	resume(): void {} // no-op — see pause()

	open(): void {
		if (this._state === "opening" || this._state === "open") return;
		this._state = "opening";
		this.closedByClient = false;
		this.decoder = new TextDecoder();
		this.buffer = "";
		this.eventType = "message";
		this.dataParts = [];
		this.frameChars = 0;
		this.aborter = new AbortController();
		void this.run(this.aborter.signal);
	}

	close(code?: number, reason?: string): void {
		this.closedByClient = true;
		this.fail(code ?? CLOSE_NORMAL, reason ?? "");
	}

	// ---------------------------------------------------------------------------
	// Internal — connection + read loop
	// ---------------------------------------------------------------------------

	private buildUrl(): string {
		const path = this.baseUrl.endsWith("/sse")
			? this.baseUrl
			: `${this.baseUrl.replace(/\/$/, "")}/sse`;
		const sep = path.includes("?") ? "&" : "?";
		return `${path}${sep}channels=${encodeURIComponent(this.channels.join(","))}`;
	}

	private async run(signal: AbortSignal): Promise<void> {
		const headers: Record<string, string> = { Accept: "text/event-stream" };
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		if (this.lastEventId !== undefined) headers["Last-Event-ID"] = this.lastEventId;

		const connectTimer = this.armConnectTimeout();
		let response: Response;
		try {
			response = await this.fetchImpl(this.buildUrl(), { headers, signal });
		} catch {
			connectTimer.abort();
			if (signal.aborted) return; // this generation was already torn down — fail() has run
			this.fail(CLOSE_TRANSIENT, "sse connect failed"); // network error
			return;
		}
		connectTimer.abort();
		if (signal.aborted) return; // closed during the handshake

		if (response.status !== 200 || response.body === null) {
			// A 4xx is terminal — 400 (bad request), 401 (auth; reactive-reconnect deferred), 403
			// (Pro-gate) — EXCEPT 429 (tenant connection limit), a transient capacity condition that a
			// backoff-reconnect resolves. 5xx is transient. See the client's close-code policy.
			const s = response.status;
			const terminal = s >= 400 && s < 500 && s !== 429;
			this.fail(terminal ? CLOSE_TERMINAL : CLOSE_TRANSIENT, `sse connect status ${s}`);
			return;
		}

		this._state = "open";
		this.emit("open");
		this.resetIdle(signal);
		// Each terminal path re-checks this generation's own `signal`: on a torn-down connection
		// (close()/idle timeout) `fail()` has already run, and an unguarded second `fail()` would abort a
		// freshly-reopened NEXT generation (shared `this.aborter`) and emit a spurious close (finding A).
		try {
			await this.readLoop(response.body, signal);
			if (signal.aborted) return;
			this.fail(CLOSE_TRANSIENT, "sse stream ended"); // reader done → remote close → reconnect
		} catch {
			if (signal.aborted) return;
			this.fail(CLOSE_TRANSIENT, "sse stream error");
		}
	}

	private async readLoop(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		const reader = body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done || signal.aborted) return;
				if (value) {
					this.resetIdle(signal); // any bytes (incl. `: keepalive`) prove liveness
					this.feed(this.decoder.decode(value, { stream: true }));
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	// ---------------------------------------------------------------------------
	// Internal — SSE parser
	// ---------------------------------------------------------------------------

	private feed(text: string): void {
		this.buffer += text;
		for (let nl = this.buffer.indexOf("\n"); nl !== -1; nl = this.buffer.indexOf("\n")) {
			let line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1); // `\r\n` (incl. split across chunks)
			this.parseLine(line);
			if (this._state === "closed") return; // a size-cap fail during parse — stop draining
		}
		// A single unterminated line (no "\n") must not grow the buffer without bound.
		if (this.buffer.length > MAX_FRAME_CHARS) this.fail(CLOSE_TERMINAL, "sse frame too large");
	}

	private parseLine(line: string): void {
		if (line === "") {
			this.dispatch();
			return;
		}
		if (line.startsWith(":")) return; // comment (`: keepalive`) — liveness already reset on the chunk
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") {
			this.eventType = value;
		} else if (field === "data") {
			this.dataParts.push(value);
			this.frameChars += value.length + 1;
			// A never-dispatched multi-line `data:` flood must not grow `dataParts` without bound.
			if (this.frameChars > MAX_FRAME_CHARS) this.fail(CLOSE_TERMINAL, "sse frame too large");
		} else if (field === "id") {
			this.lastEventId = value;
		}
		// `retry:` and unknown fields are ignored (no client-driven retry over SSE).
	}

	private dispatch(): void {
		const payload = this.dataParts.join("\n");
		const isMessage = this.eventType === "message";
		this.eventType = "message"; // reset on EVERY dispatch (SSE spec)
		this.dataParts = [];
		this.frameChars = 0;
		if (payload !== "" && isMessage) this.emit("message", payload);
	}

	// ---------------------------------------------------------------------------
	// Internal — timers + teardown
	// ---------------------------------------------------------------------------

	private armConnectTimeout(): AbortController {
		const ctrl = new AbortController();
		void this.clock.sleep(this.connectTimeoutMs, ctrl.signal).then(
			() => this.fail(CLOSE_TRANSIENT, "sse connect timeout"),
			() => {}, // cleared once the response arrives
		);
		return ctrl;
	}

	private resetIdle(streamSignal: AbortSignal): void {
		this.clearIdle();
		if (streamSignal.aborted) return;
		const ctrl = new AbortController();
		this.idleTimer = ctrl;
		void this.clock.sleep(this.idleTimeoutMs, ctrl.signal).then(
			() => this.fail(CLOSE_TRANSIENT, "sse idle timeout"),
			() => {}, // reset by the next chunk, or cleared on close
		);
	}

	private clearIdle(): void {
		this.idleTimer?.abort();
		this.idleTimer = null;
	}

	/** Terminal teardown. First call wins (idempotent); emits `close` unless the client initiated it. */
	private fail(code: number, reason: string): void {
		if (this._state === "closed") return;
		this._state = "closed";
		this.clearIdle();
		const wasClient = this.closedByClient;
		this.aborter?.abort(); // ends the in-flight fetch/read
		this.aborter = null;
		if (!wasClient) this.emit("close", code, reason);
	}
}
