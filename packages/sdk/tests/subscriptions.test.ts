import { describe, expect, it } from "vitest";
import { SubscriptionState } from "../src/subscriptions";

describe("SubscriptionState", () => {
	it("addDesired returns only newly-added channels and de-dupes", () => {
		const s = new SubscriptionState();
		expect(s.addDesired(["a", "b"])).toEqual(["a", "b"]);
		expect(s.addDesired(["b", "c"])).toEqual(["c"]);
		expect([...s.desiredChannels].sort()).toEqual(["a", "b", "c"]);
	});

	it("marks only desired channels as granted (server can't grant an undesired channel)", () => {
		const s = new SubscriptionState();
		s.addDesired(["a", "b"]);
		s.markGranted(["a", "b", "ghost"]);
		expect([...s.grantedChannels].sort()).toEqual(["a", "b"]);
		expect(s.grantedChannels.has("ghost")).toBe(false);
	});

	it("retains the not-granted delta for escalation when a channel is permission-filtered", () => {
		const s = new SubscriptionState();
		s.addDesired(["public", "private"]);
		s.markGranted(["public"]); // 'private' filtered by an api-key's permissions
		expect(s.notGranted()).toEqual(["private"]);
	});

	it("a forced ungrant keeps the channel desired so escalation re-subscribes it", () => {
		const s = new SubscriptionState();
		s.addDesired(["x"]);
		s.markGranted(["x"]);
		expect(s.notGranted()).toEqual([]);
		s.markForcedUngranted(["x"]); // permission revoked on refresh
		expect(s.desiredChannels.has("x")).toBe(true);
		expect(s.grantedChannels.has("x")).toBe(false);
		expect(s.notGranted()).toEqual(["x"]);
	});

	it("client unsubscribe drops from both desired and granted", () => {
		const s = new SubscriptionState();
		s.addDesired(["a", "b"]);
		s.markGranted(["a", "b"]);
		s.remove(["a"]);
		expect(s.desiredChannels.has("a")).toBe(false);
		expect(s.grantedChannels.has("a")).toBe(false);
		expect(s.notGranted()).toEqual([]);
	});

	it("clearGranted keeps desired so a new epoch re-subscribes the full set", () => {
		const s = new SubscriptionState();
		s.addDesired(["a", "b"]);
		s.markGranted(["a", "b"]);
		s.clearGranted();
		expect([...s.desiredChannels].sort()).toEqual(["a", "b"]);
		expect(s.grantedChannels.size).toBe(0);
		expect(s.notGranted().sort()).toEqual(["a", "b"]);
	});
});
