// Build-script invariant — guards the two-phase build order against the `@sukko/sdk` rebuild race.
//
// The root `build` runs sdk alone, then the dependents. If phase 2 ever rebuilds `@sukko/sdk`
// concurrently (e.g. via a `./packages/*` glob that re-includes it), sdk's tsup "clean output
// folder" wipes `dist/index.d.ts` while a dependent's DTS build reads it → flaky
// `TS2307: Cannot find module '@sukko/sdk'`. A build race is not deterministically reproducible as a
// unit test, so this asserts the structural invariant instead — same house style as
// `public-api.test.ts` (read source, assert an invariant). Reverting the fix fails this test.

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url);

const rootPkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
const buildScript: string = rootPkg.scripts.build;
// The two phases are joined by `&&`: [ build sdk ] && [ build the dependents ].
const [phase1, phase2] = buildScript.split("&&");

// Every workspace package name under packages/*, discovered from disk so a newly-added package is
// automatically expected in the build rather than silently dropped.
const packageNames = readdirSync(new URL("packages/", ROOT), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map(
		(entry) =>
			JSON.parse(readFileSync(new URL(`packages/${entry.name}/package.json`, ROOT), "utf8")).name,
	);

describe("root build script — two-phase order", () => {
	it("has exactly two phases joined by &&", () => {
		expect(phase2, "build script must be `<sdk> && <dependents>`").toBeDefined();
		expect(buildScript.split("&&")).toHaveLength(2);
	});

	it("builds @sukko/sdk in phase 1", () => {
		expect(phase1).toContain("@sukko/sdk");
	});

	it("never rebuilds @sukko/sdk in phase 2 (no concurrent dist wipe)", () => {
		expect(phase2).not.toContain("@sukko/sdk");
		// The `./packages/*` glob re-includes packages/sdk — the original bug. Forbid it outright.
		expect(phase2).not.toContain("./packages/*");
	});

	it("builds every dependent package in phase 2", () => {
		const dependents = packageNames.filter((name) => name !== "@sukko/sdk");
		expect(dependents.length).toBeGreaterThan(0);
		for (const name of dependents) {
			expect(phase2, `phase 2 must build ${name}`).toContain(name);
		}
	});
});
