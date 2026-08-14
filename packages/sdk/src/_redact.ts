// Credential redaction (§V/§VIII, FR-017). `ws` and `fetch` embed the connection URL — including a
// `?token=`/`?api_key=` query param — in the error strings they throw, and a serialized client can
// carry a token. Every string that could reach a log record, thrown error, or serialized state MUST
// pass through `redact()` so credentials never leak. Redaction is asserted by test, not assumed.

const secrets = new Set<string>();

const REDACTED = "«redacted»";

// Ignore registered secrets shorter than this — a 1-3 char "secret" would garble every log line
// containing that character (over-redaction), and such values aren't real credentials. Matches sukko-py.
const MIN_SECRET_LEN = 4;

// Pattern masking, independent of what was registered. Covers the three sinks the SDK actually emits:
// query-string auth, auth headers, and JSON-serialized credential fields (the auth wire frame
// `{"type":"auth","data":{"token":…}}` and serialized options/push secrets).
const PATTERNS: readonly RegExp[] = [
	// ?token=…  &api_key=…  &access_token=…  (query-string credential leak in ws/fetch URLs)
	/([?&](?:token|api_key|apikey|access_token)=)[^&\s"'\\]+/gi,
	// Authorization: Bearer …   "X-API-Key": "…"   (header credential leak)
	/((?:authorization|x-api-key)["'\s:=]+(?:bearer\s+)?)[A-Za-z0-9._~+/=-]{8,}/gi,
	// "token":"…"  "api_key":"…"  "p256dh_key":"…"  "auth_secret":"…"  (serialized-state credential leak)
	/("(?:token|api_key|apikey|access_token|p256dh_key|auth_secret)"\s*:\s*")[^"]+/gi,
];

/**
 * Register concrete credential values (JWT, API key, push subscriber secrets) so they are masked
 * wherever they appear — even inside an opaque error string. No-ops on empty/too-short values.
 */
export function registerSecret(...values: (string | null | undefined)[]): void {
	for (const v of values) {
		if (v && v.length >= MIN_SECRET_LEN) secrets.add(v);
	}
}

/** Mask every registered secret value and every credential-shaped pattern in `input`. */
export function redact(input: string): string {
	let out = input;
	// Longest-first so a shorter secret that is a substring of a longer one doesn't fragment the
	// longer one and leave its remainder visible.
	for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
		// Literal, global replace — no regex escaping needed via split/join.
		if (out.includes(s)) out = out.split(s).join(REDACTED);
	}
	for (const re of PATTERNS) out = out.replace(re, `$1${REDACTED}`);
	return out;
}

/** Return `err` with its message redacted (a new Error, so the original stack/reference is untouched). */
export function redactError(err: unknown): Error {
	if (err instanceof Error) {
		const clone = new Error(redact(err.message));
		clone.name = err.name;
		return clone;
	}
	return new Error(redact(String(err)));
}

/** Clear all registered secrets. Test-only — the SDK never un-registers in production. */
export function clearSecrets(): void {
	secrets.clear();
}
