import type { Env } from "./config";
import type { Cadence } from "./cadence";

/**
 * Idempotency ledger.
 *
 * The Python bot wrote data/payout_ledger/<date>/<pool>.json to disk. Workers
 * has no filesystem, so that role moves to KV -- and it is load-bearing: cron
 * runs can be retried, and without a durable record a retry DOUBLE-PAYS.
 *
 * THREE records per instance, because they answer different questions:
 *
 *   payout:<instance>:<stamp>   calendar. "Was this period handled?" Stops a
 *                               retry inside one period. Also the audit trail.
 *   paidthrough:<instance>      coverage. "Up to when is this instance already
 *                               funded?" Stops a cadence CHANGE from paying
 *                               twice, since each cadence writes calendar keys
 *                               in its own namespace and a fresh namespace
 *                               looks unpaid no matter what happened an hour
 *                               ago.
 *   pending:<instance>          in-flight. "Did a transaction we built ever
 *                               land?" Deliberately NOT keyed by period or
 *                               cadence: a transaction that is in flight when
 *                               the operator changes cadence must still be
 *                               recoverable, and a period-keyed pending record
 *                               becomes invisible the moment the key shape
 *                               changes under it.
 *
 * KV IS NOT A LOCK. It is eventually consistent, has no compare-and-set, and
 * concurrent writers are last-writer-wins. These records make a SEQUENTIAL
 * retry safe; they do not serialise two invocations racing (cron against a
 * manual /run). That needs a Durable Object and is not attempted here.
 */

export type RunState =
  | { status: "done"; txHash: string; at: string; paid: string }
  | { status: "skipped"; reason: string; at: string };

/**
 * A payout that has been built and is being submitted.
 *
 * Carries its own coverage window so recovery does not have to guess it from
 * the cadence in force at recovery time -- which may not be the cadence the
 * payment was sized for, and which would otherwise push the funded window
 * forward by however long the outage lasted, leaving a gap nobody pays for.
 */
export interface PendingRun {
  /** The calendar key this payout belongs to, as it was when built. */
  periodKey: string;
  cadence: Cadence;
  /** Coverage bought by this payout, ms since epoch, fixed at build time. */
  coverageFrom: number;
  coverageTo: number;
  /** Every transaction built for this payout, in submission order. */
  batches: { index: number; txHash: string }[];
  /** How many transactions the payout needs in total. */
  totalBatches: number;
  at: string;
}

/**
 * Ledger namespace for one reward instance.
 *
 * Full pool id and full asset identity, deliberately. A money ledger has no
 * reason to accept even a 64-bit collision domain when the whole id is in hand,
 * and the issuer matters: two assets can share a code, and an issued asset
 * coded "XLM" is not native XLM.
 */
export function instanceKey(
  poolId: string,
  rewardAssetCode: string,
  rewardAssetIssuer: string
): string {
  const asset = rewardAssetCode
    ? `${rewardAssetCode}-${rewardAssetIssuer}`
    : "native";
  return `${poolId}:${asset}`;
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
 * The instant the period containing `when` ends, for this cadence.
 *
 * Used to seed `paidthrough` when the calendar key says a period was already
 * handled but no coverage record exists -- which is exactly the state every
 * live instance was in at the deploy that introduced coverage tracking. Without
 * this, an operator who changed cadence in that window would have paid over a
 * period the calendar already owned.
 */
export function periodEnd(when: Date, cadence: Cadence): number {
  const d = new Date(when);
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  if (cadence === "hourly") return d.getTime() + 3_600_000;
  d.setUTCHours(when.getUTCHours() < 12 ? 0 : 12);
  if (cadence === "12h") return d.getTime() + 43_200_000;
  d.setUTCHours(0);
  return d.getTime() + 86_400_000;
}

/**
 * Older key shapes, READ ONLY.
 *
 * Each change of key shape moves every live instance into a namespace with
 * nothing in it, and an empty namespace looks like a period that was never
 * paid. Reading the old shapes on a miss closes that window.
 *
 *   v1  payout:<pool16>:<stamp>              (no asset at all -- two instances
 *                                             on one pool collided and the
 *                                             second never paid)
 *   v2  payout:<pool16>:<CODE>:<stamp>       (asset code, but no issuer)
 *
 * Safe to delete once no old Worker version can still be executing AND the
 * longest coverage any old version could have bought (24h) has expired -- so
 * at least 24h plus rollout margin after the last deploy that wrote them.
 */
export function legacyPeriodKeys(
  poolId: string,
  rewardAssetCode: string,
  when: Date,
  cadence: Cadence
): string[] {
  const stamp = stampFor(when, cadence);
  const p16 = poolId.slice(0, 16);
  return [
    `payout:${p16}:${rewardAssetCode || "XLM"}:${stamp}`, // v2
    `payout:${p16}:${stamp}`, // v1
  ];
}

export async function getRun(env: Env, key: string): Promise<RunState | null> {
  return (await env.LEDGER.get<RunState>(key, "json")) ?? null;
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

// --- pending: in-flight payouts, cadence-independent ---

function pendingKey(instKey: string): string {
  return `pending:${instKey}`;
}

export async function getPending(
  env: Env,
  instKey: string
): Promise<PendingRun | null> {
  return (await env.LEDGER.get<PendingRun>(pendingKey(instKey), "json")) ?? null;
}

export async function setPending(env: Env, instKey: string, run: PendingRun) {
  // No TTL: an unresolved in-flight payout must never expire quietly.
  await env.LEDGER.put(pendingKey(instKey), JSON.stringify(run));
}

export async function clearPending(env: Env, instKey: string) {
  await env.LEDGER.delete(pendingKey(instKey));
}

// --- paidthrough: coverage, the cadence-change guard ---
//
// Written only when money actually moved. A skipped period (no holders,
// everything under minPayment) is not a payment and must not push the next one
// out. No expirationTtl: it must outlive the longest cadence.

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

/**
 * Did a previously-reserved transaction actually land on chain?
 *
 * A 404 means "not in Horizon's history". Resolution happens at least one cron
 * tick after submission, so a 404 at that point is a genuine failure rather
 * than a transaction that has not propagated yet.
 */
export async function txSucceeded(env: Env, txHash: string): Promise<boolean> {
  const res = await fetch(`${env.HORIZON_URL}/transactions/${txHash}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon ${res.status} checking tx ${txHash}`);
  const body: any = await res.json();
  return body?.successful === true;
}
