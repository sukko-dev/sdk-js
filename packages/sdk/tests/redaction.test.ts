import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, redact, redactError, registerSecret } from "../src/_redact";

afterEach(() => clearSecrets());

describe("redact", () => {
	it("masks a registered secret value wherever it appears (e.g. inside a ws error URL)", () => {
		const token = "eyJhbGciOiJFZDI1NTE5In0.payload.sig";
		registerSecret(token);
		const wsError = `WebSocket connection to 'wss://gw.sukko.io/ws?token=${token}' failed`;
		const out = redact(wsError);
		expect(out).not.toContain(token);
		expect(out).toContain("«redacted»");
	});

	it("masks a `?token=` query param even when the value was never registered", () => {
		const out = redact("connect wss://host/ws?token=abc123.def.ghi failed");
		expect(out).not.toContain("abc123.def.ghi");
		expect(out).toContain("token=«redacted»");
	});

	it("masks `&api_key=` and `&access_token=` query params", () => {
		expect(redact("GET /publish?api_key=SECRETKEY123&x=1")).not.toContain("SECRETKEY123");
		expect(redact("url?access_token=zzzYYYxxx000")).not.toContain("zzzYYYxxx000");
	});

	it("masks an Authorization: Bearer header value", () => {
		const out = redact("fetch failed { Authorization: Bearer aaaa.bbbb.cccc-dddd }");
		expect(out).not.toContain("aaaa.bbbb.cccc-dddd");
	});

	it("masks an X-API-Key header value", () => {
		const out = redact('headers: {"X-API-Key": "keykeykeykey1234"}');
		expect(out).not.toContain("keykeykeykey1234");
	});

	it("leaves credential-free strings untouched", () => {
		const clean = "reconnecting to wss://gw.sukko.io/ws (attempt 3)";
		expect(redact(clean)).toBe(clean);
	});

	it("registerSecret ignores empty/nullish/too-short values", () => {
		registerSecret("", null, undefined, "abc"); // < MIN_SECRET_LEN (4)
		expect(redact("nothing to redact here, abc kept")).toBe("nothing to redact here, abc kept");
	});
});

describe("redact — serialized state sink (SC-005)", () => {
	it("masks a token in the serialized auth wire frame even when unregistered (JSON-field pattern)", () => {
		// The SDK's own most sensitive frame: {"type":"auth","data":{"token":…}} via JSON.stringify.
		const token = "eyJhbGciOiJFZDI1NTE5In0.body.sig";
		const serialized = JSON.stringify({ type: "auth", data: { token } });
		const out = redact(serialized);
		expect(out).not.toContain(token);
		expect(out).toContain('"token":"«redacted»"');
	});

	it("masks api_key / push p256dh_key / auth_secret in serialized state", () => {
		const serialized = JSON.stringify({
			api_key: "AKIAsecretkey1234",
			p256dh_key: "BPp256dhkeyvalue999",
			auth_secret: "authsecretvalue888",
		});
		const out = redact(serialized);
		expect(out).not.toContain("AKIAsecretkey1234");
		expect(out).not.toContain("BPp256dhkeyvalue999");
		expect(out).not.toContain("authsecretvalue888");
	});

	it("also masks a registered token in serialized state (value-based, once wiring calls registerSecret)", () => {
		const token = "registeredtokenvalue777";
		registerSecret(token);
		const out = redact(JSON.stringify({ auth: { bearer: token } })); // shape the pattern doesn't cover
		expect(out).not.toContain(token);
	});

	it("masks longest-first so a shorter secret that is a substring does not fragment a longer one", () => {
		registerSecret("abcd", "abcdefghijkl"); // "abcd" is a prefix of the longer secret
		const out = redact("value=abcdefghijkl end");
		expect(out).not.toContain("abcdefghijkl");
		expect(out).not.toContain("efghijkl"); // the remainder must not survive
	});
});

describe("redactError", () => {
	it("returns a new Error with a redacted message, preserving the name", () => {
		registerSecret("supersecrettoken");
		const original = new TypeError("failed with supersecrettoken in url");
		const red = redactError(original);
		expect(red).toBeInstanceOf(Error);
		expect(red.name).toBe("TypeError");
		expect(red.message).not.toContain("supersecrettoken");
		expect(original.message).toContain("supersecrettoken"); // original untouched
	});

	it("handles non-Error throwables", () => {
		expect(redactError("boom ?token=leakedvalue123").message).not.toContain("leakedvalue123");
	});
});
