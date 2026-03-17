import { describe, expect, it } from "vitest";
import { buildChannel, getChannelCategory, parseChannel } from "../src/utils";

describe("buildChannel", () => {
	it("builds a 3-part channel string", () => {
		expect(buildChannel("tenant", "BTC", "trade")).toBe("tenant.BTC.trade");
	});

	it("handles empty parts", () => {
		expect(buildChannel("", "", "")).toBe("..");
	});
});

describe("parseChannel", () => {
	it("parses a 3-part channel", () => {
		expect(parseChannel("tenant.BTC.trade")).toEqual({
			tenant: "tenant",
			identifier: "BTC",
			category: "trade",
		});
	});

	it("parses a 4+ part channel (category includes dots)", () => {
		expect(parseChannel("tenant.BTC.trade.live")).toEqual({
			tenant: "tenant",
			identifier: "BTC",
			category: "trade.live",
		});
	});

	it("returns null for 2-part channel", () => {
		expect(parseChannel("tenant.BTC")).toBeNull();
	});

	it("returns null for 1-part channel", () => {
		expect(parseChannel("tenant")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseChannel("")).toBeNull();
	});
});

describe("getChannelCategory", () => {
	it("extracts category from 3-part channel", () => {
		expect(getChannelCategory("tenant.BTC.trade")).toBe("trade");
	});

	it("extracts category from 4+ part channel", () => {
		expect(getChannelCategory("tenant.BTC.trade.live")).toBe("trade.live");
	});

	it("returns empty for 2-part channel", () => {
		expect(getChannelCategory("tenant.BTC")).toBe("");
	});

	it("returns empty for empty string", () => {
		expect(getChannelCategory("")).toBe("");
	});
});
