import { afterEach, beforeAll, expect, test } from "vitest";
import { type Fixture, disconnectAll, isPro, loadFixture, makeClient } from "./support";

// Web Push is Pro-gated (features.go WebPush:Pro), so this runs only against a push-enabled
// Pro+ stack — the source-built grid cell with the push topology. It proves the SDK's push
// CLIENT reaches the push surface: fetching the tenant's VAPID key (auto-generated on first
// fetch). Delivery itself is proven by the platform tester's `push` suite — a browser push
// receiver is out of scope for a Node SDK e2e.
let fx: Fixture;
beforeAll(() => {
	fx = loadFixture();
});
afterEach(disconnectAll);

test("Web Push VAPID key fetch against a live push-enabled gateway", async (ctx) => {
	if (!isPro(fx)) ctx.skip();

	const client = makeClient({ url: fx.wsUrl, token: fx.token });
	const key = await client.push.getVapidKey();
	expect(typeof key).toBe("string");
	expect(key.length).toBeGreaterThan(0);
});
