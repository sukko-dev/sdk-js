import { describe, expect, it } from "vitest";
import { buildChannel, parseChannel } from "../src/utils";

describe("parseChannel", () => {
	it("parses a 2-part channel", () => {
		expect(parseChannel("acme.trades")).toEqual({
			tenant: "acme",
			suffix: "trades",
		});
	});

	it("keeps a dotted suffix verbatim (opaque)", () => {
		expect(parseChannel("acme.rooms.eng.general")).toEqual({
			tenant: "acme",
			suffix: "rooms.eng.general",
		});
	});

	it("accepts an interior empty segment (suffix is opaque)", () => {
		expect(parseChannel("acme..trades")).toEqual({
			tenant: "acme",
			suffix: ".trades",
		});
	});

	it("returns null for a 1-part channel (no dot)", () => {
		expect(parseChannel("acme")).toBeNull();
	});

	it("returns null for an empty tenant (leading dot)", () => {
		expect(parseChannel(".trades")).toBeNull();
	});

	it("returns null for an empty whole suffix (trailing dot)", () => {
		expect(parseChannel("acme.")).toBeNull();
	});

	it("returns null for the empty string", () => {
		expect(parseChannel("")).toBeNull();
	});
});

describe("buildChannel", () => {
	it("builds {tenant}.{suffix}, preserving a dotted suffix verbatim", () => {
		expect(buildChannel("acme", "rooms.eng.messages")).toBe("acme.rooms.eng.messages");
	});

	it("throws a TypeError on an empty tenant", () => {
		expect(() => buildChannel("", "trades")).toThrow(TypeError);
		expect(() => buildChannel("", "trades")).toThrow(/non-empty/);
	});

	it("throws a TypeError on a tenant containing a dot", () => {
		expect(() => buildChannel("a.b", "trades")).toThrow(TypeError);
	});

	it("throws a TypeError on an empty suffix", () => {
		expect(() => buildChannel("acme", "")).toThrow(TypeError);
	});
});

describe("buildChannel + parseChannel round-trip", () => {
	it("parse(build(...)) recovers the tenant and suffix", () => {
		expect(parseChannel(buildChannel("acme", "rooms.eng.messages"))).toEqual({
			tenant: "acme",
			suffix: "rooms.eng.messages",
		});
	});
});
