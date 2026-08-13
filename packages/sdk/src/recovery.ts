// Reconnect / gap-recovery engine (T023, FR-004/005/006/007) — the pos-anchored recovery state
// machine. A PURE action machine: it never performs I/O. `handle*` methods and the clock-driven
// `due()` return canonical `RecoveryAction`s the client executes (send a `replay`, send a `reconnect`,
// emit a `PossibleGap`, or raise a `RecoveryInterrupted`). The clock is injected, so gap-coalescing,
// the per-channel replay floor, and the detection deadline are all deterministically testable — and
// the machine is directly parity-vector-drivable (NFR-007: actions are the canonical encoding).
//
// NEVER compares `pos` values — they are opaque by contract. Gaps for a channel arrive in connection
// order, so the FIRST un-recovered gap's `last_pos` is the anchor; later gaps within a cycle just mean
// "more loss" (replaying from the earlier anchor covers them — conservative anchor: may re-deliver,
// never misses). Per channel: idle → floor-wait → replaying (with a pending follow-up anchor).
//
// Two corrections over the sukko-py reference (owed back there): the detection deadline is a **per-
// frame-reset idle timer** (measures server silence, not consumer slowness — FR-006 fix #3), and
// `buildReconnect()` **probes with an empty `last_pos`** once connected-once so a pure-Direct session
// actually elicits `not_available` and degrades (FR-007 fix #1) instead of silently dropping.

import type { Clock } from "./_clock";
import { SUKKO_DEFAULTS } from "./constants";

/** Send `replay{channel, from_pos}` to recover a live gap. */
export interface SendReplay {
	action: "send_replay";
	channel: string;
	from_pos: string;
}

/** Send `reconnect{client_id, last_pos}` to replay everything missed across a disconnect (or probe). */
export interface SendReconnect {
	action: "send_reconnect";
	client_id: string;
	last_pos: Record<string, string>;
}

/** Surface a Direct-backend `PossibleGap` for `channel` — no `last_pos` to anchor a replay. */
export interface EmitPossibleGap {
	action: "emit_possible_gap";
	channel: string;
}

/** Surface a `RecoveryInterruptedError` — a truncated recovery, never a bare disconnect (§III). */
export interface RaiseRecoveryInterrupted {
	action: "raise_recovery_interrupted";
	channel: string;
	reason: string;
}

export type RecoveryAction =
	| SendReplay
	| SendReconnect
	| EmitPossibleGap
	| RaiseRecoveryInterrupted;

type Phase = "idle" | "floor_wait" | "replaying";

interface ChannelState {
	phase: Phase;
	anchor: string | null; // from_pos for the pending/active replay (first un-recovered gap)
	followupAnchor: string | null; // first gap seen while replaying → next cycle's anchor
	lastReplayAt: number; // for the per-channel replay-floor rate limit
	floorWake: number | null; // absolute time floor_wait may fire
	deadline: number | null; // absolute "no recovery frame by now" idle deadline
}

function freshChannel(): ChannelState {
	return {
		phase: "idle",
		anchor: null,
		followupAnchor: null,
		lastReplayAt: Number.NEGATIVE_INFINITY,
		floorWake: null,
		deadline: null,
	};
}

export interface RecoveryEngineOptions {
	clientId: string;
	clock: Clock;
	replayFloorMs?: number;
	recoveryDeadlineMs?: number;
}

/** Owns `client_id` + per-channel opaque `pos`, and the per-channel recovery FSM. */
export class RecoveryEngine {
	readonly clientId: string;
	private readonly clock: Clock;
	private readonly floor: number;
	private readonly deadline: number;
	private readonly pos = new Map<string, string>();
	private readonly channels = new Map<string, ChannelState>();
	private readonly historyDeadline = new Map<string, number>();
	private direct = false;
	private connectedOnce = false;

	constructor(options: RecoveryEngineOptions) {
		this.clientId = options.clientId;
		this.clock = options.clock;
		this.floor = options.replayFloorMs ?? SUKKO_DEFAULTS.replayFloorMs;
		this.deadline = options.recoveryDeadlineMs ?? SUKKO_DEFAULTS.recoveryDeadlineMs;
	}

	/** True once the backend has reported `not_available` (Direct — pos-recovery unavailable). */
	get isDirect(): boolean {
		return this.direct;
	}

	/** Record the last-seen opaque `pos` for `channel`. A missing `pos` (Direct) is ignored. */
	notePos(channel: string, pos: string | undefined): void {
		if (pos !== undefined) this.pos.set(channel, pos);
	}

	/** Mark that the client has completed at least one connection — arms the reconnect probe (FR-007). */
	markConnected(): void {
		this.connectedOnce = true;
	}

	/**
	 * Drop every trace of `channel` — its stored `pos`, its recovery FSM entry, and any in-flight
	 * history deadline. Called on `unsubscribe`: without it the channel's `pos` would still ride along
	 * in the next reconnect-replay, and a later disconnect/deadline could raise a spurious
	 * `RecoveryInterrupted` for a channel the caller no longer cares about.
	 */
	forget(channel: string): void {
		this.pos.delete(channel);
		this.channels.delete(channel);
		this.historyDeadline.delete(channel);
	}

	private channel(channel: string): ChannelState {
		let rec = this.channels.get(channel);
		if (rec === undefined) {
			rec = freshChannel();
			this.channels.set(channel, rec);
		}
		return rec;
	}

	// --- live gap → replay --------------------------------------------------------------------

	/** A wire `gap` arrived. Coalesce per the conservative-anchor rule; replay if the floor is open. */
	handleGap(channel: string, lastPos: string): RecoveryAction[] {
		// On the Direct backend there is no pos-recovery — the server surfaces `possible_gap` via the
		// degrade path, never a replayable `gap`. Ignore any stray `gap` once Direct (never replay a
		// pos we cannot anchor).
		if (this.direct) return [];
		const now = this.clock.now();
		const rec = this.channel(channel);
		if (rec.phase === "idle") {
			rec.anchor = lastPos;
			const earliest = rec.lastReplayAt + this.floor;
			if (now >= earliest) return [this.beginReplay(rec, channel, lastPos, now)];
			rec.phase = "floor_wait";
			rec.floorWake = earliest;
			return [];
		}
		if (rec.phase === "floor_wait") return []; // coalesce onto the earlier anchor
		// replaying: retain the first mid-replay gap as the follow-up anchor
		if (rec.followupAnchor === null) rec.followupAnchor = lastPos;
		return [];
	}

	private beginReplay(
		rec: ChannelState,
		channel: string,
		fromPos: string,
		now: number,
	): SendReplay {
		rec.phase = "replaying";
		rec.anchor = null;
		rec.lastReplayAt = now;
		rec.floorWake = null;
		rec.deadline = now + this.deadline;
		return { action: "send_replay", channel, from_pos: fromPos };
	}

	/** A `replay_message` arrived — reset the idle deadline (measures server silence, not consumer speed). */
	handleReplayMessage(channel: string): void {
		const rec = this.channels.get(channel);
		if (rec !== undefined && rec.phase === "replaying")
			rec.deadline = this.clock.now() + this.deadline;
	}

	/** A `replay_complete` arrived. Start the follow-up cycle if a gap landed mid-replay, else idle. */
	handleReplayComplete(channel: string): RecoveryAction[] {
		const rec = this.channel(channel);
		rec.deadline = null;
		if (rec.phase !== "replaying") return [];
		const followup = rec.followupAnchor;
		rec.followupAnchor = null;
		if (followup === null) {
			rec.phase = "idle";
			return [];
		}
		const now = this.clock.now();
		const earliest = rec.lastReplayAt + this.floor;
		if (now >= earliest) return [this.beginReplay(rec, channel, followup, now)];
		rec.phase = "floor_wait";
		rec.anchor = followup;
		rec.floorWake = earliest;
		return [];
	}

	// --- clock-driven timers ------------------------------------------------------------------

	/** Fire floor-waits whose floor elapsed, and raise `RecoveryInterrupted` for any past its deadline. */
	due(): RecoveryAction[] {
		const now = this.clock.now();
		const actions: RecoveryAction[] = [];
		for (const [channel, rec] of this.channels) {
			if (
				rec.phase === "floor_wait" &&
				rec.floorWake !== null &&
				now >= rec.floorWake &&
				rec.anchor !== null
			) {
				actions.push(this.beginReplay(rec, channel, rec.anchor, now));
			} else if (rec.phase === "replaying" && rec.deadline !== null && now >= rec.deadline) {
				rec.phase = "idle";
				rec.deadline = null;
				rec.followupAnchor = null;
				actions.push({
					action: "raise_recovery_interrupted",
					channel,
					reason: "no replay_complete before detection deadline",
				});
			}
		}
		for (const [channel, at] of [...this.historyDeadline]) {
			if (now >= at) {
				this.historyDeadline.delete(channel);
				actions.push({
					action: "raise_recovery_interrupted",
					channel,
					reason: "no history_complete before detection deadline",
				});
			}
		}
		return actions;
	}

	/** Earliest absolute time `due()` needs to run again, or null when nothing is pending. */
	nextDeadline(): number | null {
		const times: number[] = [];
		for (const rec of this.channels.values()) {
			if (rec.phase === "floor_wait" && rec.floorWake !== null) times.push(rec.floorWake);
			if (rec.deadline !== null) times.push(rec.deadline);
		}
		for (const at of this.historyDeadline.values()) times.push(at);
		return times.length > 0 ? Math.min(...times) : null;
	}

	// --- history ------------------------------------------------------------------------------

	/** Arm the detection deadline for an in-flight history request. */
	noteHistoryRequest(channel: string): void {
		this.historyDeadline.set(channel, this.clock.now() + this.deadline);
	}

	/** A history `message` arrived — reset the idle deadline for that channel. */
	handleHistoryMessage(channel: string): void {
		if (this.historyDeadline.has(channel)) {
			this.historyDeadline.set(channel, this.clock.now() + this.deadline);
		}
	}

	handleHistoryComplete(channel: string): void {
		this.historyDeadline.delete(channel);
	}

	// --- reconnect / failure ------------------------------------------------------------------

	/**
	 * The reconnect payload. With stored `pos`, resume from it. Otherwise, once connected-once, PROBE
	 * with an empty `last_pos` map (legal — the contract requires the key's presence, not a non-empty
	 * map) so a pure-Direct session elicits `not_available` and degrades (FR-007). Returns null only on
	 * a fresh first connection (nothing to resume, nothing to probe) and after a known Direct degrade.
	 */
	buildReconnect(): SendReconnect | null {
		if (this.direct) return null;
		if (this.pos.size > 0) {
			return { action: "send_reconnect", client_id: this.clientId, last_pos: this.posSnapshot() };
		}
		if (this.connectedOnce) {
			return { action: "send_reconnect", client_id: this.clientId, last_pos: {} };
		}
		return null;
	}

	private posSnapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [channel, pos] of this.pos) out[channel] = pos;
		return out;
	}

	/** `reconnect_error: not_available` — the backend is Direct. Degrade + one `PossibleGap` per channel. */
	handleNotAvailable(channels: Iterable<string>): RecoveryAction[] {
		this.direct = true;
		this.pos.clear();
		this.channels.clear();
		const actions: RecoveryAction[] = [];
		for (const channel of channels) actions.push({ action: "emit_possible_gap", channel });
		return actions;
	}

	/** A replay error mid-recovery (`replay_failed`, etc.) — raise `RecoveryInterrupted`, reset the channel. */
	handleRecoveryFailure(channel: string, reason: string): RecoveryAction[] {
		const rec = this.channels.get(channel);
		if (rec !== undefined) {
			rec.phase = "idle";
			rec.deadline = null;
			rec.followupAnchor = null;
		}
		return [{ action: "raise_recovery_interrupted", channel, reason }];
	}

	/**
	 * A disconnect happened. Any channel mid-recovery (floor-wait or replaying) is a truncated recovery
	 * → `RecoveryInterrupted` (advisory — a later reconnect-replay may recover it). Per-channel state
	 * resets; `pos` and `client_id` persist for the next reconnect-replay.
	 */
	handleDisconnect(): RecoveryAction[] {
		const actions: RecoveryAction[] = [];
		for (const [channel, rec] of this.channels) {
			if (rec.phase === "floor_wait" || rec.phase === "replaying") {
				actions.push({
					action: "raise_recovery_interrupted",
					channel,
					reason: "disconnected mid-recovery",
				});
			}
		}
		this.channels.clear();
		for (const channel of this.historyDeadline.keys()) {
			actions.push({
				action: "raise_recovery_interrupted",
				channel,
				reason: "disconnected mid-history",
			});
		}
		this.historyDeadline.clear();
		return actions;
	}
}
