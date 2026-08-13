import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/_clock";
import { clearSecrets } from "../src/_redact";
import {
	ConflictError,
	EditionRequiredError,
	ForbiddenError,
	PayloadTooLargeError,
	ProtocolError,
	RateLimitedError,
	ServiceUnavailableError,
	TransportError,
	UnauthorizedError,
	ValidationError,
} from "../src/errors";
import { type FetchLike, HttpApi, type TokenProvider } from "../src/http";

afterEach(() => clearSecrets()); // registered secrets are process-global — reset between tests

function makeApi(
	fetchImpl: FetchLike,
	token: TokenProvider = () => "jwt",
): { api: HttpApi; clock: FakeClock } {
	const clock = new FakeClock();
	const api = new HttpApi({ baseUrl: "https://gw.example.com/", token, fetch: fetchImpl, clock });
	return { api, clock };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

describe("HttpApi — request", () => {
	it("sends an authed JSON request and parses the response", async () => {
		let url = "";
		let init: RequestInit | undefined;
		const { api } = makeApi(async (u, i) => {
			url = u;
			init = i;
			return jsonResponse({ status: "accepted" });
		});

		const result = await api.request("POST", "/api/v1/publish", {
			json: { channel: "acme.x", data: { a: 1 } },
		});

		expect(url).toBe("https://gw.example.com/api/v1/publish"); // trailing slash stripped
		expect(init?.method).toBe("POST");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer jwt");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(JSON.parse(init?.body as string)).toEqual({ channel: "acme.x", data: { a: 1 } });
		expect(result).toEqual({ status: "accepted" });
	});

	it("reads the token fresh per request (rotation)", async () => {
		let token = "old-token-value";
		const auths: Array<string | undefined> = [];
		const { api } = makeApi(
			async (_u, i) => {
				auths.push((i?.headers as Record<string, string>).Authorization);
				return jsonResponse({});
			},
			() => token,
		);
		await api.request("POST", "/p");
		token = "new-token-value";
		await api.request("POST", "/p");
		expect(auths).toEqual(["Bearer old-token-value", "Bearer new-token-value"]);
	});

	it("omits Authorization + Content-Type + body when there is no token and no json", async () => {
		let init: RequestInit | undefined;
		const { api } = makeApi(
			async (_u, i) => {
				init = i;
				return jsonResponse({});
			},
			() => undefined,
		);
		await api.request("GET", "/p");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
		expect(headers["Content-Type"]).toBeUndefined(); // no json body → no Content-Type
		expect(init?.body).toBeUndefined();
	});

	it("returns {} for an empty 2xx body", async () => {
		const { api } = makeApi(async () => new Response(null, { status: 204 }));
		expect(await api.request("POST", "/p")).toEqual({});
	});

	it("throws ProtocolError on a malformed 2xx body", async () => {
		const { api } = makeApi(async () => new Response("not json{", { status: 200 }));
		await expect(api.request("GET", "/p")).rejects.toBeInstanceOf(ProtocolError);
	});
});

describe("HttpApi — typed error mapping", () => {
	it("maps gateway status codes to typed errors", async () => {
		const cases: Array<[number, new (...args: never[]) => Error]> = [
			[400, ValidationError],
			[401, UnauthorizedError],
			[403, ForbiddenError], // a plain 403 (code ≠ EDITION_LIMIT) is a policy denial, not the edition gate
			[409, ConflictError],
			[413, PayloadTooLargeError],
			[429, RateLimitedError],
			[503, ServiceUnavailableError],
		];
		for (const [status, ErrorType] of cases) {
			const { api } = makeApi(async () =>
				jsonResponse({ code: "FORBIDDEN", message: "m" }, status),
			);
			await expect(api.request("POST", "/p")).rejects.toBeInstanceOf(ErrorType);
		}
	});

	it("maps a 403 carrying EDITION_LIMIT to EditionRequiredError (the edition gate)", async () => {
		const { api } = makeApi(async () =>
			jsonResponse({ code: "EDITION_LIMIT", message: "pro required" }, 403),
		);
		await expect(api.request("POST", "/p")).rejects.toBeInstanceOf(EditionRequiredError);
	});

	it("yields a clean typed error from a non-JSON / empty error body", async () => {
		const { api } = makeApi(async () => new Response("<html>oops</html>", { status: 503 }));
		await expect(api.request("POST", "/p")).rejects.toBeInstanceOf(ServiceUnavailableError);
	});

	it("parses Retry-After (delta-seconds → ms) onto the 429 RateLimitedError", async () => {
		const { api } = makeApi(async () =>
			jsonResponse({ code: "RATE", message: "slow" }, 429, { "Retry-After": "30" }),
		);
		await expect(api.request("POST", "/p")).rejects.toMatchObject({ retryAfterMs: 30000 });
	});

	it("ignores a non-numeric Retry-After (HTTP-date/garbage → undefined, never NaN)", async () => {
		const { api } = makeApi(async () =>
			jsonResponse({ code: "RATE", message: "slow" }, 429, {
				"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT",
			}),
		);
		const err = (await api.request("POST", "/p").catch((e: unknown) => e)) as RateLimitedError;
		expect(err).toBeInstanceOf(RateLimitedError);
		expect(err.retryAfterMs).toBeUndefined();
	});

	it("surfaces an edition-gated 403 as EditionRequiredError even without a code", async () => {
		const { api } = makeApi(async () => new Response("", { status: 403 })); // no JSON body
		await expect(
			api.request("POST", "/api/v1/push/subscribe", { editionGated: true }),
		).rejects.toBeInstanceOf(EditionRequiredError);
	});

	it("wraps a fetch rejection in a TransportError", async () => {
		const { api } = makeApi(async () => {
			throw new TypeError("network down");
		});
		await expect(api.request("POST", "/p")).rejects.toBeInstanceOf(TransportError);
	});
});

describe("HttpApi — timeout + redaction", () => {
	it("times out via the injected clock and rejects with TransportError", async () => {
		// A fetch that only settles when its signal aborts.
		const fetchImpl: FetchLike = (_u, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
		const { api, clock } = makeApi(fetchImpl);
		const pending = api.request("POST", "/p");
		await clock.advance(10000); // connectTimeoutMs default → aborts the fetch
		await expect(pending).rejects.toBeInstanceOf(TransportError);
	});

	it("redacts a registered token in a thrown TransportError message", async () => {
		const secret = "supersecrettoken12345";
		const { api } = makeApi(
			// A non-credential-shaped leak: only the per-request registerSecret(token) can mask it (the
			// `?token=` PATTERN would mask it regardless, hiding a broken registration).
			async () => {
				throw new Error(`connect to node-${secret}.internal failed`);
			},
			() => secret,
		);
		await expect(api.request("POST", "/p")).rejects.toThrow(TransportError);
		const err = await api.request("POST", "/p").catch((e: Error) => e);
		expect(err.message).not.toContain(secret);
	});
});
