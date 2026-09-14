import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/_clock";
import { AuthManager, type AuthManagerOptions } from "../src/auth";
import { ConfigurationError, NotConnectedError, UnauthorizedError } from "../src/errors";

// The AuthManager's async steps (getToken, send, await-ack) settle over a few microtasks; `tick`
// flushes them without advancing virtual time (the clock is advanced explicitly for floor/proactive).
async function tick(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

function makeAuth(overrides: Partial<AuthManagerOptions> = {}): {
	auth: AuthManager;
	clock: FakeClock;
	sent: string[];
} {
	const clock = new FakeClock();
	const sent: string[] = [];
	const auth = new AuthManager({
		getToken: async () => "fresh",
		send: (token) => sent.push(token),
		clock,
		...overrides,
	});
	return { auth, clock, sent };
}

describe("AuthManager — refresh", () => {
	it("sends auth with a fresh token and resolves on auth_ack", async () => {
		const { auth, sent } = makeAuth();
		const refreshing = auth.refresh();
		await tick();
		expect(sent).toEqual(["fresh"]);
		auth.onAuthAck(0);
		await expect(refreshing).resolves.toBeUndefined();
	});

	it("falls back to the stored token when no getToken is configured", async () => {
		const { auth, sent } = makeAuth({ getToken: undefined, token: "stored" });
		const refreshing = auth.refresh();
		await tick();
		expect(sent).toEqual(["stored"]);
		auth.onAuthAck(0);
		await refreshing;
	});

	it("coalesces concurrent refreshes onto a single auth frame", async () => {
		const { auth, sent } = makeAuth();
		const a = auth.refresh();
		const b = auth.refresh(); // pending is claimed synchronously by `a` → `b` coalesces
		await tick();
		expect(sent).toEqual(["fresh"]);
		auth.onAuthAck(0);
		await Promise.all([a, b]);
	});

	it("floors a second refresh by the refresh interval", async () => {
		const { auth, clock, sent } = makeAuth({ floorMs: 30000 });
		const first = auth.refresh();
		await tick();
		auth.onAuthAck(0);
		await first;
		sent.length = 0;

		const second = auth.refresh(); // within the 30s floor of the first
		await tick();
		expect(sent).toEqual([]); // held by the floor
		await clock.advance(30000);
		await tick();
		expect(sent).toEqual(["fresh"]); // floor elapsed → sent
		auth.onAuthAck(0);
		await second;
	});

	it("grows the floor after a failure (backoff)", async () => {
		const { auth, clock, sent } = makeAuth({ floorMs: 1000 });
		const first = auth.refresh();
		await tick();
		auth.onAuthError("rate_limited", "slow down"); // failures → 1, rejects `first`
		await expect(first).rejects.toThrow();
		sent.length = 0;

		const second = auth.refresh(); // floor is now 1000 * 2^1 = 2000
		await tick();
		expect(sent).toEqual([]);
		await clock.advance(1999);
		await tick();
		expect(sent).toEqual([]); // still backing off
		await clock.advance(1);
		await tick();
		expect(sent).toEqual(["fresh"]);
		auth.onAuthAck(0);
		await second;
	});
});

describe("AuthManager — auth_error handling", () => {
	it("rejects an in-flight refresh and returns false (must not loop)", async () => {
		const { auth } = makeAuth();
		const refreshing = auth.refresh();
		await tick();
		expect(auth.onAuthError("invalid_token", "bad")).toBe(false);
		await expect(refreshing).rejects.toThrow(UnauthorizedError);
	});

	it("returns true for an unsolicited auth_error (no refresh in flight)", () => {
		const { auth } = makeAuth();
		expect(auth.onAuthError("token_expired", "expired")).toBe(true);
	});

	it("reactiveRefresh swallows the rejection", async () => {
		const { auth, sent } = makeAuth();
		const reactive = auth.reactiveRefresh();
		await tick();
		expect(sent).toEqual(["fresh"]);
		auth.onAuthError("invalid_token", "bad");
		await expect(reactive).resolves.toBeUndefined(); // swallowed, never rejects
	});
});

describe("AuthManager — escalation (fix over sukko-py #2)", () => {
	it("sends its OWN frame after an in-flight refresh finishes — never coalescing", async () => {
		const { auth, sent } = makeAuth();
		const refreshing = auth.refresh(); // in-flight, sends "fresh"
		await tick();
		expect(sent).toEqual(["fresh"]);

		const escalating = auth.escalate("jwt", true); // waits for the refresh to finish
		auth.onAuthAck(0); // resolves the refresh
		await refreshing;
		await tick();
		expect(sent).toEqual(["fresh", "jwt"]); // escalation sent its own JWT frame

		auth.onAuthAck(0); // resolves the escalation
		await expect(escalating).resolves.toBe(true);
	});

	it("proceeds to send its own frame even if the in-flight refresh FAILS", async () => {
		const { auth, sent } = makeAuth();
		const refreshing = auth.refresh();
		await tick();
		const escalating = auth.escalate("jwt", true);
		auth.onAuthError("invalid_token", "bad"); // the refresh fails
		await expect(refreshing).rejects.toThrow();
		await tick();
		expect(sent).toEqual(["fresh", "jwt"]); // escalation still sent

		auth.onAuthAck(0);
		await expect(escalating).resolves.toBe(true);
	});

	it("defers while disconnected: stores the token, sends nothing, returns false", async () => {
		const { auth, sent } = makeAuth();
		await expect(auth.escalate("jwt", false)).resolves.toBe(false);
		expect(sent).toEqual([]);
		expect(auth.currentToken).toBe("jwt");
	});

	it("defers (returns false) if the connection drops while awaiting an in-flight refresh (fix A)", async () => {
		const { auth, sent } = makeAuth();
		const refreshing = auth.refresh(); // pending = d1, sends "fresh"
		await tick();
		const escalating = auth.escalate("jwt", true); // waits on d1
		auth.close(); // rejects d1 with NotConnectedError
		await expect(refreshing).rejects.toThrow(NotConnectedError);
		await expect(escalating).resolves.toBe(false); // deferred — never hangs, never falsely true
		expect(auth.currentToken).toBe("jwt"); // JWT stored for the next reconnect
		expect(sent).toEqual(["fresh"]); // no escalation frame sent after close
	});

	it("records the send time so a subsequent refresh is floored (fix T-2, rate-limit budget)", async () => {
		const { auth, clock, sent } = makeAuth({ floorMs: 30000 });
		const escalating = auth.escalate("jwt", true);
		await tick();
		expect(sent).toEqual(["jwt"]);
		auth.onAuthAck(0);
		await escalating;
		sent.length = 0;

		// A refresh immediately after the escalation must wait out the floor (escalation set lastRefreshAt).
		const refreshing = auth.refresh();
		await tick();
		expect(sent).toEqual([]); // floored — no second auth frame inside the 30s window
		await clock.advance(30000);
		await tick();
		expect(sent).toEqual(["fresh"]);
		auth.onAuthAck(0);
		await refreshing;
	});

	it("keeps the escalated JWT even if a refresh completes during the wait (fix B — no de-escalation)", async () => {
		const { auth, sent } = makeAuth({ getToken: async () => "refreshed" });
		const refreshing = auth.refresh(); // pending = d1, sends "refreshed", sets token="refreshed"
		await tick();
		const escalating = auth.escalate("jwt", true);
		auth.onAuthAck(0); // resolves d1
		await refreshing;
		await tick();
		auth.onAuthAck(0); // resolves the escalation's own frame
		await escalating;
		expect(sent).toEqual(["refreshed", "jwt"]);
		expect(auth.currentToken).toBe("jwt"); // NOT "refreshed" — the escalated credential survives
	});
});

describe("AuthManager — proactive timer", () => {
	it("refreshes leadMs before exp (absolute Unix seconds)", async () => {
		const { auth, clock, sent } = makeAuth({ leadMs: 30000 });
		auth.onAuthAck(100); // exp = 100s → fire at 100_000 - 30_000 = 70_000ms
		await clock.advance(69999);
		await tick();
		expect(sent).toEqual([]);
		await clock.advance(1);
		await tick();
		expect(sent).toEqual(["fresh"]); // proactive refresh fired
	});

	it("does not schedule a proactive refresh when exp is 0 (no expiry)", async () => {
		const { auth, clock, sent } = makeAuth();
		auth.onAuthAck(0);
		await clock.advance(10_000_000);
		expect(sent).toEqual([]);
	});

	it("does not schedule a proactive refresh without getToken", async () => {
		const { auth, clock, sent } = makeAuth({ getToken: undefined, token: "t" });
		auth.onAuthAck(100);
		await clock.advance(10_000_000);
		expect(sent).toEqual([]);
	});

	it("a newer auth_ack reschedules (cancels the prior timer)", async () => {
		const { auth, clock, sent } = makeAuth({ leadMs: 0 });
		auth.onAuthAck(100); // fire at 100_000
		await clock.advance(50_000);
		auth.onAuthAck(200); // reschedule to 200_000; the 100_000 timer is cancelled
		await clock.advance(60_000); // t = 110_000 — the ORIGINAL deadline, now cancelled
		await tick();
		expect(sent).toEqual([]); // did not fire on the stale schedule
		await clock.advance(90_000); // t = 200_000
		await tick();
		expect(sent).toEqual(["fresh"]);
	});
});

describe("AuthManager — close()", () => {
	it("rejects a pending refresh with NotConnectedError and cancels the proactive timer", async () => {
		const { auth, clock, sent } = makeAuth({ leadMs: 0 });
		const refreshing = auth.refresh();
		await tick();
		auth.onAuthAck(100); // arms a proactive timer AND resolves this refresh
		await refreshing;

		const second = auth.refresh();
		await tick();
		auth.close();
		await expect(second).rejects.toThrow(NotConnectedError);

		// The proactive timer was cancelled — it never fires after close().
		sent.length = 0;
		await clock.advance(10_000_000);
		expect(sent).toEqual([]);
	});

	it("does not send a refresh frame when close() fires before the token resolves (fix C)", async () => {
		let releaseToken!: (t: string) => void;
		const { auth, sent } = makeAuth({
			getToken: () =>
				new Promise<string>((res) => {
					releaseToken = res;
				}),
		});
		const refreshing = auth.refresh(); // parks awaiting getToken
		await tick();
		expect(sent).toEqual([]); // nothing sent yet

		auth.close(); // rejects the pending refresh
		releaseToken("late-token"); // getToken resolves AFTER close
		await expect(refreshing).rejects.toThrow(NotConnectedError);
		await tick();
		expect(sent).toEqual([]); // the stale frame was NOT sent into a (possibly reconnected) epoch
	});
});

describe("AuthManager — fetchFreshToken (SSE reactive refresh)", () => {
	it("fetches via getToken and adopts it as the current credential", async () => {
		const { auth, sent } = makeAuth({ getToken: async () => "reactive-jwt" });
		expect(auth.canFetchFreshToken).toBe(true);
		await auth.fetchFreshToken();
		expect(auth.currentToken).toBe("reactive-jwt");
		expect(sent).toEqual([]); // no `auth` frame — SSE has no client→server channel
	});

	it("rejects with ConfigurationError when no getToken is configured", async () => {
		const { auth } = makeAuth({ getToken: undefined, token: "static" });
		expect(auth.canFetchFreshToken).toBe(false);
		await expect(auth.fetchFreshToken()).rejects.toBeInstanceOf(ConfigurationError);
		expect(auth.currentToken).toBe("static"); // unchanged
	});
});
