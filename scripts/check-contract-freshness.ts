// Contract-freshness check — the PR-free "keep up" half of the L0 gate (ADR-0040).
//
// pin.test.ts proves the vendored bytes match CONTRACTS.lock; this script proves the LOCK is not
// stale. It fetches each platform contract from the canonical upstream repo and FAILS (exit 1) when
// the upstream `info.version` is newer than the pinned one — forcing a re-vendor. Run on a schedule
// in CI (.github/workflows/contract-sync.yml) and locally via `bun run contract:check`. No auto-PR
// (the org blocks Actions from opening PRs); the red job is the signal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface LockEntry {
	file: string;
	upstream_path: string;
	version: string;
}
interface Lock {
	upstream_repo: string;
	contracts: LockEntry[];
}

const lock = JSON.parse(
	readFileSync(
		fileURLToPath(new URL("../packages/sdk/contract/CONTRACTS.lock", import.meta.url)),
		"utf8",
	),
) as Lock;

/** Compare two `a.b.c` semver cores. Returns >0 if a>b, <0 if a<b, 0 if equal. */
function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

async function upstreamVersion(repo: string, path: string): Promise<string> {
	const url = `https://raw.githubusercontent.com/${repo}/main/${path}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
	// `info.version` is the only key at 2-space indent named `version:` in these contracts (the
	// same extraction CONTRACTS.lock is generated with) — no YAML parser needed for one field.
	const m = (await res.text()).match(/^ {2}version:\s*(\S+)\s*$/m);
	if (!m) throw new Error(`no info.version in ${url}`);
	return m[1];
}

const stale: string[] = [];
for (const entry of lock.contracts) {
	const upstream = await upstreamVersion(lock.upstream_repo, entry.upstream_path);
	const cmp = compareSemver(upstream, entry.version);
	const tag = cmp > 0 ? "STALE" : cmp < 0 ? "AHEAD?" : "ok";
	console.log(`${tag.padEnd(7)} ${entry.file}: pinned ${entry.version}, upstream ${upstream}`);
	if (cmp > 0) {
		stale.push(
			`${entry.file}: upstream ${upstream} > pinned ${entry.version} — re-vendor from ${lock.upstream_repo} and regenerate CONTRACTS.lock, then handle any new message types / codes the coverage test flags.`,
		);
	}
}

if (stale.length > 0) {
	console.error(`\nContract(s) out of date:\n- ${stale.join("\n- ")}`);
	process.exit(1);
}
console.log("\nAll vendored contracts are current with upstream.");
