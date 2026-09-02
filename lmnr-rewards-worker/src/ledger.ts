import type { Env } from "./config";
import type { Cadence } from "./cadence";

/**
 * Idempotency ledger.
 *
 * The Python bot wrote data/payout_ledger/<date>/<pool>.json to disk. Workers
 * has no filesystem, so that role moves to KV -- and it is load-bearing: cron
 * runs can be retried, and without a durable record a retry DOUBLE-PAYS.
 *
 * Protocol per period:
 *   1. reserve()  -> writes "pending" with the built tx hash BEFORE submitting
 *   2. submit
 *   3. complete() -> writes "done"
 * On a later run, a "pending" entry is resolved against Horizon: if the tx
 * actually landed we mark it done, otherwise the period is retried.
 *
 * TWO independent guards, because they fail in different directions:
 *   - the CALENDAR key below stops a retry inside the same period
 *   - `lastPaidAt` (bottom of this file) stops a cadence CHANGE from paying
 *     twice, since each cadence uses a different key namespace and a fresh
 *     namespace looks unpaid no matter what happened an hour ago
 */

export type RunState =
  | { status: "pending"; txHash: string; at: string }
  | { status: "done"; txHash: string; at: string; paid: string }
  | { status: "skipped"; reason: string; at: string };

/**
 * Ledger namespace for one reward instance.
 *
 * Includes the reward asset: a pool may run two instances paying two different
 * assets (JDM's tool does exactly this), and keying on the pool alone made the
 * first instance's ledger entry mark the second one "already handled" so it
 * never paid at all.
 */
export function instanceKey(poolId: string, rewardAssetCode: string): string {
  return `${poolId.slice(0, 16)}:${rewardAssetCode || "XLM"}`;
}

function stampFor(when: Date, cadence: Cadence): string {
  const iso = when.toISOString();
  if (cadence === "hourly") return iso.slice(0, 13); // YYYY-MM-DDTHH
  if (cadence === "12h") {
    return `${iso.slice(0, 10)}:${when.getUTCHours() < 12 ? "A" : "B"}`;
  }
  return iso.slice(0, 10); // YYYY-MM-DD
}

export function periodKey(instKey: string, when: Date, cadence: Cadence): string {
  return `payout:${instKey}:${stampFor(when, cadence)}`;
}

/**
 * The pre-cadence key shape (`payout:<pool16>:<stamp>`), read-only.
 *
 * Deploying the instance-scoped key above moves every live pool into a new
 * namespace, and a namespace with nothing in it looks like a period that was
 * never paid -- which would pay the current period a second time. Checking the
 * old key on a miss closes that window. Nothing writes this shape any more, so
 * it can be deleted once the longest cadence (1 day) has rolled past the
 * deploy.
 */
export function legacyPeriodKey(
  poolId: string,
  when: Date,
  cadence: Cadence
): string {
  return `payout:${poolId.slice(0, 16)}:${stampFor(when, cadence)}`;
}

export async function getRun(env: Env, key: string): Promise<RunState | null> {
  return (await env.LEDGER.get<RunState>(key, "json")) ?? null;
}

export async function reserve(env: Env, key: string, txHash: string) {
  const state: RunState = {
    status: "pending",
    txHash,
    at: new Date().toISOString(),
  };
  await env.LEDGER.put(key, JSON.stringify(state));
}

export async function complete(
  env: Env,
  key: string,
  txHash: string,
  paid: string
) {
  const state: RunState = {
    status: "done",
    txHash,
    at: new Date().toISOString(),
    paid,
  };
  // Keep for 90 days -- long enough to audit, short enough to bound storage.
  await env.LEDGER.put(key, JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

export async function skip(env: Env, key: string, reason: string) {
  const state: RunState = {
    status: "skipped",
    reason,
    at: new Date().toISOString(),
  };
  await env.LEDGER.put(key, JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

// --- paidThroughAt: the cadence-change guard ---
//
// The instant this instance's budget is already funded up to. Deliberately
// keyed WITHOUT the period, and deliberately written only when money actually
// moved -- a skipped period (no holders, everything under minPayment) is not a
// payment and must not push the next one out.
//
// No expirationTtl: this entry must outlive the longest cadence, and it is one
// tiny record per instance.

function paidThroughKey(instKey: string): string {
  return `paidthrough:${instKey}`;
}

export async function getPaidThroughAt(
  env: Env,
  instKey: string
): Promise<number | null> {
  const v = await env.LEDGER.get(paidThroughKey(instKey));
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function setPaidThroughAt(env: Env, instKey: string, at: number) {
  await env.LEDGER.put(paidThroughKey(instKey), new Date(at).toISOString());
}

/** Did a previously-reserved transaction actually land on chain? */
export async function txSucceeded(env: Env, txHash: string): Promise<boolean> {
  const res = await fetch(`${env.HORIZON_URL}/transactions/${txHash}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon ${res.status} checking tx ${txHash}`);
  const body: any = await res.json();
  return body?.successful === true;
}
