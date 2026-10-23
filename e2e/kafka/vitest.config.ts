import { defineConfig } from "vitest/config";

// The kafka recovery cell: run only against a kafka-backend stack (SUKKO_E2E_BACKEND=kafka
// via e2e/run.sh), separate from the Community-direct suite. Recovery spans a disconnect,
// several publishes, a reconnect and replay — plus first-delivery on a fresh kafka topic can
// be slow — so the timeout is generous.
export default defineConfig({
	test: {
		include: ["*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 30_000,
		fileParallelism: false,
	},
});
