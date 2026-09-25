// Checksum guard for the vendored parity-vector corpus — the go.sum-style pin that platform
// ADR-0023 / sukko-js ADR-0004 rely on. Without it a stale or hand-edited vendored vector would
// still round-trip its own binding and pass silently. Fails when a vendored vector's sha256 no
// longer matches CHECKSUMS, or when a vector is vendored without a CHECKSUMS entry.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VECTORS_DIR = join(__dirname, "..", "contract", "vectors");

/** Parse the shasum-format CHECKSUMS file → { "recovery/<name>.json": "<sha256hex>" }. */
function readChecksums(): Record<string, string> {
	const raw = readFileSync(join(VECTORS_DIR, "CHECKSUMS"), "utf8");
	const sums: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const fields = trimmed.split(/\s+/);
		if (fields.length !== 2) throw new Error(`CHECKSUMS line not in shasum format: ${line}`);
		sums[fields[1].replace(/^\*/, "")] = fields[0];
	}
	return sums;
}

/** Every vendored recovery/*.json, relative to VECTORS_DIR (POSIX-style, matching CHECKSUMS keys). */
function vendoredVectors(): string[] {
	return readdirSync(join(VECTORS_DIR, "recovery"))
		.filter((f) => f.endsWith(".json"))
		.map((f) => `recovery/${f}`)
		.sort();
}

describe("vendored parity vectors match CHECKSUMS", () => {
	const recorded = readChecksums();

	it("has a non-empty CHECKSUMS", () => {
		expect(Object.keys(recorded).length).toBeGreaterThan(0);
	});

	for (const [name, want] of Object.entries(recorded)) {
		it(`${name} matches its recorded sha256`, () => {
			const data = readFileSync(join(VECTORS_DIR, name)); // throws if CHECKSUMS names a missing file
			const got = createHash("sha256").update(data).digest("hex");
			expect(got).toBe(want); // mismatch → re-vendor the vector and regenerate CHECKSUMS together
		});
	}

	it("records a checksum for every vendored vector (no unverified additions)", () => {
		for (const rel of vendoredVectors()) {
			expect(recorded, `${rel} is vendored but has no CHECKSUMS entry`).toHaveProperty([rel]);
		}
	});
});
