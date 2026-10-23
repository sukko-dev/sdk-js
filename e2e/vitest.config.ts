import { defineConfig } from "vitest/config";

// The live suite connects to a real gateway over a booted docker stack, so a single test
// spans connect + subscribe-ack + publish + delivery. Generous timeouts keep a slow boot
// from flaking the assertions.
export default defineConfig({
	test: {
		include: ["**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
