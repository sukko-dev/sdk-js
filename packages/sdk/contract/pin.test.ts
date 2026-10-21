// Contract-pin test — the tamper-evident half of the L0 "keep up" gate (ADR-0040).
//
// The platform contracts (canonical home: sukko/ws/docs) are vendored here and pinned
// by version + sha256 in CONTRACTS.lock. This test FAILS when a vendored file drifts
// from the lock (a hand-edit, a partial re-vendor) or when its declared `info.version`
// no longer matches the lock — so the vendored copy cannot silently diverge from what
// it claims to be. The companion scheduled sync job (CI) is the other half: it fails
// when the platform's PUBLISHED contract version is newer than the pinned one, forcing
// a re-vendor. Neither uses an auto-PR (the org blocks Actions from opening PRs).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface LockEntry {
	file: string;
	version: string;
	sha256: string;
}

const lock = JSON.parse(
	readFileSync(fileURLToPath(new URL("./CONTRACTS.lock", import.meta.url)), "utf8"),
) as { contracts: LockEntry[] };

describe("vendored contracts are pinned (CONTRACTS.lock)", () => {
	it("pins exactly the two platform contracts", () => {
		expect(lock.contracts.map((c) => c.file).sort()).toEqual([
			"client-ws.asyncapi.yaml",
			"gateway.openapi.yaml",
		]);
	});

	for (const entry of lock.contracts) {
		describe(entry.file, () => {
			const raw = readFileSync(fileURLToPath(new URL(`./${entry.file}`, import.meta.url)));

			it("sha256 matches the lock (tamper-evident)", () => {
				expect(createHash("sha256").update(raw).digest("hex")).toBe(entry.sha256);
			});

			it("declared info.version matches the lock", () => {
				const doc = parse(raw.toString("utf8")) as { info?: { version?: string } };
				expect(doc.info?.version).toBe(entry.version);
			});
		});
	}
});
