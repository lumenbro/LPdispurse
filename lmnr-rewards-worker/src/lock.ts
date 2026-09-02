import type { Cadence } from "./cadence";
import { CADENCE_SLACK_MS, cadenceDue } from "./cadence";
import type { PendingRun } from "./ledger";

/**
 * PayoutLock — the serialization authority for one reward instance.
 *
 * WHY THIS EXISTS. Workers KV is eventually consistent, has no compare-and-set,
 * and resolves concurrent writes last-writer-wins. That is enough to make a
 * SEQUENTIAL retry safe, but it cannot stop two invocations racing: an hourly
 * cron tick and an operator pressing "run" arrive at different edges, both read
 * "not paid yet", and both pay. A Durable Object is single-threaded per object,
 * so routing every payout decision for an instance through one object turns
 * that race into two ordered calls.
 *
 * COST SHAPE — this is deliberate, do not move work in here. The object holds
 * ONLY the decision and the state. Every slow thing (Horizon paging, building
 * and submitting transactions) stays in the Worker, between `begin` and
 * `commit`. Durable Object duration is billed on wall time, so a payout that
 * takes 30 seconds inside the object would bill ~30s per pool per hour; the
 * same payout with the object used as a lock bills a few milliseconds.
 *
 * On the Workers Paid plan (1,000,000 DO requests and 400,000 GB-s included per
 * month) three pools paying hourly is roughly 4,400 requests and well under
 * 100 GB-s a month — under half a percent of the included allowance. There is
 * one object per reward instance and a handful of small keys in each, so SQLite
 * storage is kilobytes against a 5 GB-month allowance.
 *
 * IT IS AN AUTHORITY, NOT A CACHE. The KV records still get written, but only
 * as an audit trail. When the two disagree, this object is right.
 */

/**
 * How long a granted lease stays valid.
 *
 * Must comfortably exceed a real payout (Horizon paging, building and
 * submitting up to a few transactions) or a slow-but-healthy run would have its
 * lease expire under it and a second run could start. Must also be far shorter
 * than the hourly tick, so a Worker that dies mid-payout does not block the
 * next tick. Five minutes sits between those.
 */
const LEASE_MS = 5 * 60_000;

interface Lease {
  token: string;
  expiresAt: number;
}

export type BeginResult =
  | { action: "pay"; token: string; coverageFrom: number; coverageTo: number }
  | { action: "resolve"; token: string; pending: PendingRun }
  | { action: "wait"; waitMs: number }
  | { action: "busy"; expiresAt: number }
  | { action: "attempted"; until: number }
  | { action: "needs-attention"; pending: PendingRun };

export class PayoutLock {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: unknown) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body: any = await req.json().catch(() => ({}));
    if (url.pathname === "/begin") return Response.json(await this.begin(body));
    if (url.pathname === "/commit") return Response.json(await this.commit(body));
    if (url.pathname === "/state") return Response.json(await this.snapshot());
    return new Response("not found", { status: 404 });
  }

  private async snapshot() {
    const s = this.state.storage;
    return {
      coverageTo: (await s.get<number>("coverageTo")) ?? null,
      attemptedThrough: (await s.get<number>("attemptedThrough")) ?? null,
      pending: (await s.get<PendingRun>("pending")) ?? null,
      lease: (await s.get<Lease>("lease")) ?? null,
      needsAttention: (await s.get<boolean>("needsAttention")) ?? false,
    };
  }

  /**
   * Decide whether a payout may proceed, and take the lease if so.
   *
   * `seedCoverageTo` migrates state that predates this object: the KV records
   * written by earlier versions. It is only ever applied when this object has
   * no coverage of its own, and only ever moves coverage FORWARD, so replaying
   * a stale seed cannot un-fund a period.
   */
  private async begin(input: {
    now: number;
    cadence: Cadence;
    seedCoverageTo?: number | null;
    /** Dry runs get a decision but take no lease and write nothing. */
    dry?: boolean;
  }): Promise<BeginResult> {
    const s = this.state.storage;
    const now = input.now;
    const dry = Boolean(input.dry);

    let coverageTo = (await s.get<number>("coverageTo")) ?? null;
    if (coverageTo === null && typeof input.seedCoverageTo === "number") {
      coverageTo = input.seedCoverageTo;
      if (!dry) await s.put("coverageTo", coverageTo);
    }

    // An unresolved payout outranks everything: until we know whether it landed,
    // no new payment may be built.
    const pending = (await s.get<PendingRun>("pending")) ?? null;
    if (pending) {
      if (await s.get<boolean>("needsAttention")) {
        return { action: "needs-attention", pending };
      }
      const lease = await this.activeLease(now);
      if (lease && !dry) return { action: "busy", expiresAt: lease.expiresAt };
      const token = await this.grant(now, dry);
      return { action: "resolve", token, pending };
    }

    const lease = await this.activeLease(now);
    if (lease && !dry) return { action: "busy", expiresAt: lease.expiresAt };

    const decision = cadenceDue(coverageTo, now);
    if (!decision.due) return { action: "wait", waitMs: decision.waitMs };

    // A period already examined and found to have nothing to pay is not
    // re-examined until it ends, so repeated manual runs cannot re-scan it.
    const attempted = (await s.get<number>("attemptedThrough")) ?? 0;
    if (now < attempted) return { action: "attempted", until: attempted };

    const token = await this.grant(now, dry);
    return {
      action: "pay",
      token,
      coverageFrom: Math.max(now, coverageTo ?? now),
      coverageTo: Math.max(now, coverageTo ?? now) + intervalOf(input.cadence),
    };
  }

  private async activeLease(now: number): Promise<Lease | null> {
    const lease = (await this.state.storage.get<Lease>("lease")) ?? null;
    if (!lease) return null;
    if (lease.expiresAt <= now) {
      // Expired: the holder died. Drop it so the next caller can proceed.
      await this.state.storage.delete("lease");
      return null;
    }
    return lease;
  }

  private async grant(now: number, dry: boolean): Promise<string> {
    const token = crypto.randomUUID();
    if (!dry) {
      await this.state.storage.put("lease", { token, expiresAt: now + LEASE_MS });
    }
    return token;
  }

  /**
   * Record the outcome of a leased attempt.
   *
   * Every outcome is rejected unless it carries the current lease token, so a
   * Worker whose lease expired while it was stalled cannot come back and
   * overwrite the state of whoever took over.
   */
  private async commit(input: {
    token: string;
    outcome:
      | { kind: "pending"; pending: PendingRun }
      | { kind: "paid"; coverageTo: number }
      | { kind: "skipped"; until: number }
      | { kind: "resolved-paid"; coverageTo: number }
      | { kind: "resolved-failed" }
      | { kind: "needs-attention" }
      | { kind: "abandoned" };
  }): Promise<{ ok: boolean; reason?: string }> {
    const s = this.state.storage;
    const lease = (await s.get<Lease>("lease")) ?? null;
    if (!lease || lease.token !== input.token) {
      return { ok: false, reason: "lease expired or held by another run" };
    }
    const o = input.outcome;

    switch (o.kind) {
      case "pending":
        // Written BEFORE submitting, so a crash mid-submit is recoverable. The
        // lease is deliberately kept: this run is still in progress.
        await s.put("pending", o.pending);
        return { ok: true };

      case "paid":
      case "resolved-paid": {
        const prev = (await s.get<number>("coverageTo")) ?? 0;
        // Never move coverage backwards, whatever a late caller claims.
        await s.put("coverageTo", Math.max(prev, o.coverageTo));
        await s.delete("pending");
        await s.delete("lease");
        return { ok: true };
      }

      case "resolved-failed":
        // The payout never landed. Drop it and let the period be retried.
        await s.delete("pending");
        await s.delete("lease");
        return { ok: true };

      case "needs-attention":
        // Partial multi-transaction payout. Keep the pending record and refuse
        // to pay this instance again until a human clears it.
        await s.put("needsAttention", true);
        await s.delete("lease");
        return { ok: true };

      case "skipped":
        await s.put("attemptedThrough", o.until);
        await s.delete("lease");
        return { ok: true };

      case "abandoned":
        await s.delete("lease");
        return { ok: true };
    }
  }
}

function intervalOf(c: Cadence): number {
  return c === "hourly" ? 3_600_000 : c === "12h" ? 43_200_000 : 86_400_000;
}

// --- client side, used from the Worker ---

export interface LockClient {
  begin(input: {
    now: number;
    cadence: Cadence;
    seedCoverageTo?: number | null;
    dry?: boolean;
  }): Promise<BeginResult>;
  commit(token: string, outcome: any): Promise<{ ok: boolean; reason?: string }>;
  snapshot(): Promise<any>;
}

/** One object per reward instance, so pools never block each other. */
export function lockFor(ns: DurableObjectNamespace, instanceKey: string): LockClient {
  const stub = ns.get(ns.idFromName(instanceKey));
  const call = async (path: string, body: unknown) => {
    const res = await stub.fetch(`https://payout-lock${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`payout lock ${path} failed: ${res.status}`);
    return res.json() as any;
  };
  return {
    begin: (input) => call("/begin", input),
    commit: (token, outcome) => call("/commit", { token, outcome }),
    snapshot: () => call("/state", {}),
  };
}

export { CADENCE_SLACK_MS };
