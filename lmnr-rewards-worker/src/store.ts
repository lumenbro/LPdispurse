import type { Env } from "./config";
import { toStroops } from "./config";
import { normalizeCadence, paymentsPerDay, type Cadence } from "./cadence";

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
  /**
   * How often this pool pays. `dailyAmount` stays the DAILY budget either way --
   * daily pays it in one payment, hourly pays 1/24 of it 24 times. Absent on
   * instances saved before this field existed, which reads as "hourly".
   */
  cadence: Cadence;
  /** Whole tokens; payouts below this are skipped so dust doesn't waste an op. */
  minPayment: string;
  memo: string;
  enabled: boolean;
}

const CONFIG_KEY = "config:instances";
const SETTINGS_KEY = "config:settings";

/** Global settings, applied to every pool. */
export interface Settings {
  /** "linear" = strict pro-rata; "sqrt" = compressed curve. */
  weightMode: "linear" | "sqrt";
}

export const DEFAULT_SETTINGS: Settings = { weightMode: "linear" };

export async function loadSettings(env: Env): Promise<Settings> {
  const s = await env.LEDGER.get<Settings>(SETTINGS_KEY, "json");
  return s && (s.weightMode === "sqrt" || s.weightMode === "linear")
    ? s
    : DEFAULT_SETTINGS;
}

export async function saveSettings(env: Env, s: Settings) {
  const mode = s.weightMode === "sqrt" ? "sqrt" : "linear";
  await env.LEDGER.put(SETTINGS_KEY, JSON.stringify({ weightMode: mode }));
}

/**
 * Hard ceiling the UI cannot exceed, in whole tokens per pool per day.
 *
 * The admin page is effectively a spending control: whoever can set the reward
 * amount can drain the disburser wallet in a single run. This cap is defence in
 * depth -- even a compromised UI or stolen session cannot set an absurd rate.
 */
export const MAX_DAILY_REWARD = 100_000;

/** Stellar asset codes: 1-12 alphanumeric. Anything else is not an asset. */
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
/** Stellar public keys: Ed25519, 56 chars of base32 starting with G. */
const ISSUER_RE = /^G[A-Z2-7]{55}$/;

export async function loadInstances(env: Env): Promise<RewardInstance[]> {
  const stored = await env.LEDGER.get<RewardInstance[]>(CONFIG_KEY, "json");
  if (stored && Array.isArray(stored) && stored.length > 0) {
    // Instances saved before cadence existed have no field; fill it in on read
    // so callers and the admin page never see `undefined`.
    return stored.map((i) => ({ ...i, cadence: normalizeCadence(i.cadence) }));
  }

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
      cadence: "hourly",
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
    // Strict syntax, not just presence. These strings reach both a payment
    // operation and the admin page's HTML, so a malformed one is either a
    // failed transaction or stored markup.
    if (r.rewardAssetCode && !ASSET_CODE_RE.test(r.rewardAssetCode)) {
      errors.push(`${where}: asset code must be 1-12 letters or digits`);
      continue;
    }
    if (r.rewardAssetIssuer && !ISSUER_RE.test(r.rewardAssetIssuer)) {
      errors.push(`${where}: issuer must be a Stellar public key (G...)`);
      continue;
    }
    if (r.cadence !== undefined && normalizeCadence(r.cadence) !== r.cadence) {
      errors.push(`${where}: cadence must be hourly, 12h or daily`);
      continue;
    }
    if ((r.memo ?? "").length > 28) {
      errors.push(`${where}: memo must be 28 characters or fewer`);
      continue;
    }
    // Sanity: catch a fat-fingered amount before it becomes a payment.
    // Both fields, not just dailyAmount -- a minPayment of "1e-7" is a finite
    // non-negative Number and passes the check above, then throws inside every
    // run when toStroops sees it.
    try {
      toStroops(String(r.dailyAmount));
      toStroops(String(r.minPayment ?? "0"));
    } catch {
      errors.push(`${where}: dailyAmount or minPayment is not a valid amount`);
      continue;
    }

    // Cadence and minPayment interact: a per-payment budget below the minimum
    // pays NOTHING, every run, forever, and the skipped value is not carried
    // forward. Refuse the config rather than let a pool silently stop paying.
    const perPayment = daily / paymentsPerDay(normalizeCadence(r.cadence));
    if (daily > 0 && minPay > 0 && perPayment < minPay) {
      errors.push(
        `${where}: ${daily}/day split ${paymentsPerDay(normalizeCadence(r.cadence))} ways ` +
          `is ${perPayment} per payment, below the ${minPay} minimum -- this pool ` +
          `would pay nothing. Lower the minimum or pay less often.`
      );
      continue;
    }

    out.push({
      poolId: r.poolId,
      poolName: String(r.poolName ?? r.poolId.slice(0, 8)).slice(0, 40),
      rewardAssetCode: String(r.rewardAssetCode ?? ""),
      rewardAssetIssuer: String(r.rewardAssetIssuer ?? ""),
      dailyAmount: String(r.dailyAmount),
      cadence: normalizeCadence(r.cadence),
      minPayment: String(r.minPayment ?? "0"),
      memo: String(r.memo ?? ""),
      enabled: Boolean(r.enabled),
    });
  }
  return { ok: errors.length === 0, errors, value: out };
}
