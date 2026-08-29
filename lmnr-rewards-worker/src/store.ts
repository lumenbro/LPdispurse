import type { Env } from "./config";
import { toStroops } from "./config";

/**
 * A reward instance = one pool paying one asset. A pool may have several
 * (JDM's tool does this: the same pool paying both JDMC and xLMNR).
 */
export interface RewardInstance {
  poolId: string;
  poolName: string;
  /** "" for native XLM, otherwise the asset code. */
  rewardAssetCode: string;
  rewardAssetIssuer: string;
  /** Whole tokens per day, split across the period. */
  dailyAmount: string;
  /** Whole tokens; payouts below this are skipped so dust doesn't waste an op. */
  minPayment: string;
  memo: string;
  enabled: boolean;
}

const CONFIG_KEY = "config:instances";

/**
 * Hard ceiling the UI cannot exceed, in whole tokens per pool per day.
 *
 * The admin page is effectively a spending control: whoever can set the reward
 * amount can drain the disburser wallet in a single run. This cap is defence in
 * depth -- even a compromised UI or stolen session cannot set an absurd rate.
 */
export const MAX_DAILY_REWARD = 100_000;

export async function loadInstances(env: Env): Promise<RewardInstance[]> {
  const stored = await env.LEDGER.get<RewardInstance[]>(CONFIG_KEY, "json");
  if (stored && Array.isArray(stored) && stored.length > 0) return stored;

  // Fall back to wrangler.toml vars so the worker keeps running before anyone
  // has touched the admin page.
  return env.POOL_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((poolId) => ({
      poolId,
      poolName: poolId.slice(0, 8),
      rewardAssetCode: env.REWARD_ASSET_CODE,
      rewardAssetIssuer: env.REWARD_ASSET_ISSUER,
      dailyAmount: env.DAILY_REWARD_PER_POOL,
      minPayment: env.MIN_PAYOUT,
      memo: "",
      enabled: true,
    }));
}

export async function saveInstances(env: Env, list: RewardInstance[]) {
  await env.LEDGER.put(CONFIG_KEY, JSON.stringify(list));
}

/** Reject anything malformed or over the cap before it can reach a payment. */
export function validateInstances(list: unknown): {
  ok: boolean;
  errors: string[];
  value: RewardInstance[];
} {
  const errors: string[] = [];
  if (!Array.isArray(list)) {
    return { ok: false, errors: ["payload must be an array"], value: [] };
  }
  const out: RewardInstance[] = [];
  const seen = new Set<string>();

  for (const [i, raw] of list.entries()) {
    const r = raw as Partial<RewardInstance>;
    const where = `instance ${i}`;

    if (!r.poolId || !/^[0-9a-f]{64}$/.test(r.poolId)) {
      errors.push(`${where}: poolId must be 64 hex chars`);
      continue;
    }
    const key = `${r.poolId}:${r.rewardAssetCode ?? ""}:${r.rewardAssetIssuer ?? ""}`;
    if (seen.has(key)) {
      errors.push(`${where}: duplicate pool + reward asset`);
      continue;
    }
    seen.add(key);

    const daily = Number(r.dailyAmount);
    if (!isFinite(daily) || daily < 0) {
      errors.push(`${where}: dailyAmount must be a non-negative number`);
      continue;
    }
    if (daily > MAX_DAILY_REWARD) {
      errors.push(
        `${where}: dailyAmount ${daily} exceeds the ${MAX_DAILY_REWARD} cap`
      );
      continue;
    }
    const minPay = Number(r.minPayment ?? "0");
    if (!isFinite(minPay) || minPay < 0) {
      errors.push(`${where}: minPayment must be a non-negative number`);
      continue;
    }
    if (r.rewardAssetCode && !r.rewardAssetIssuer) {
      errors.push(`${where}: a non-native asset needs an issuer`);
      continue;
    }
    if ((r.memo ?? "").length > 28) {
      errors.push(`${where}: memo must be 28 characters or fewer`);
      continue;
    }
    // Sanity: catch a fat-fingered amount before it becomes a payment.
    try {
      toStroops(String(r.dailyAmount));
    } catch {
      errors.push(`${where}: dailyAmount is not a valid amount`);
      continue;
    }

    out.push({
      poolId: r.poolId,
      poolName: String(r.poolName ?? r.poolId.slice(0, 8)).slice(0, 40),
      rewardAssetCode: String(r.rewardAssetCode ?? ""),
      rewardAssetIssuer: String(r.rewardAssetIssuer ?? ""),
      dailyAmount: String(r.dailyAmount),
      minPayment: String(r.minPayment ?? "0"),
      memo: String(r.memo ?? ""),
      enabled: Boolean(r.enabled),
    });
  }
  return { ok: errors.length === 0, errors, value: out };
}
