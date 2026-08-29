import type { Env } from "./config";

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
 */

export type RunState =
  | { status: "pending"; txHash: string; at: string }
  | { status: "done"; txHash: string; at: string; paid: string }
  | { status: "skipped"; reason: string; at: string };

export function periodKey(poolId: string, when: Date, hourly: boolean): string {
  const iso = when.toISOString();
  const stamp = hourly ? iso.slice(0, 13) : iso.slice(0, 10); // YYYY-MM-DDTHH | YYYY-MM-DD
  return `payout:${poolId.slice(0, 16)}:${stamp}`;
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

/** Did a previously-reserved transaction actually land on chain? */
export async function txSucceeded(env: Env, txHash: string): Promise<boolean> {
  const res = await fetch(`${env.HORIZON_URL}/transactions/${txHash}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Horizon ${res.status} checking tx ${txHash}`);
  const body: any = await res.json();
  return body?.successful === true;
}
