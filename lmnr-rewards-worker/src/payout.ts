import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { MAX_OPS_PER_TX, fromStroops, type Env } from "./config";
import type { LpHolder } from "./horizon";

export interface Payout {
  address: string;
  stroops: bigint;
}

/** How a holder's LP balance is turned into a reward weight. */
export type WeightMode = "linear" | "sqrt";

/**
 * Integer square root (Newton's method) for bigint.
 * Used instead of Math.sqrt because LP balances are stroop-scale bigints and
 * float conversion would lose precision on large holdings.
 */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Extra resolution before the sqrt so small holders keep meaningful weight. */
const SQRT_SCALE = 1_000_000_000_000_000_000n; // 1e18

/**
 * Reward weight for a holder.
 *
 * `linear`  — weight = shares. Strictly pro-rata: a 54% holder earns 54%.
 * `sqrt`    — weight = sqrt(shares). Compresses the whole curve, so a large
 *             holder still earns more than a small one (unlike a hard cap,
 *             which flattens everyone above it to the same figure and removes
 *             any reason to deepen a pool you already lead), but the ratio
 *             between biggest and smallest narrows sharply.
 */
export function weightFor(shares: bigint, mode: WeightMode): bigint {
  return mode === "sqrt" ? isqrt(shares * SQRT_SCALE) : shares;
}

/**
 * Pro-rata split of one period's budget across holders, by LP share.
 *
 * Mirrors the Python bot's `percent = balance / total_shares`, but in integer
 * stroops so there is no float drift. Division truncates, so the sum of payouts
 * is always <= the budget: dust stays in the wallet rather than over-paying.
 */
export function computePayouts(
  holders: LpHolder[],
  budgetStroops: bigint,
  minPayoutStroops: bigint,
  mode: WeightMode = "linear"
): { payouts: Payout[]; skippedNoTrustline: string[]; dust: bigint } {
  const eligible = holders.filter((h) => h.hasTrustline && h.shares > 0n);
  const skippedNoTrustline = holders
    .filter((h) => !h.hasTrustline && h.shares > 0n)
    .map((h) => h.address);

  // Holders without a trustline are excluded from the denominator too, so the
  // remaining LPs share the full budget rather than silently burning a slice.
  const weights = new Map<string, bigint>();
  for (const h of eligible) weights.set(h.address, weightFor(h.shares, mode));
  const total = eligible.reduce((a, h) => a + weights.get(h.address)!, 0n);
  if (total === 0n) {
    return { payouts: [], skippedNoTrustline, dust: budgetStroops };
  }

  const payouts: Payout[] = [];
  let allocated = 0n;
  for (const h of eligible) {
    const amount = (budgetStroops * weights.get(h.address)!) / total; // truncating
    if (amount >= minPayoutStroops) {
      payouts.push({ address: h.address, stroops: amount });
      allocated += amount;
    }
  }
  return { payouts, skippedNoTrustline, dust: budgetStroops - allocated };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build ONE signed transaction paying every payout in the batch.
 * Returns the built tx so the caller can record its hash BEFORE submitting.
 */
export async function buildPaymentTx(
  env: Env,
  keypair: Keypair,
  batch: Payout[],
  rewardAsset?: { code: string; issuer: string },
  memo?: string
) {
  if (batch.length > MAX_OPS_PER_TX) {
    throw new Error(`batch of ${batch.length} exceeds ${MAX_OPS_PER_TX} ops`);
  }
  const server = new Horizon.Server(env.HORIZON_URL);
  const account = await server.loadAccount(keypair.publicKey());
  const code = rewardAsset?.code ?? env.REWARD_ASSET_CODE;
  const issuer = rewardAsset?.issuer ?? env.REWARD_ASSET_ISSUER;
  const asset = code ? new Asset(code, issuer) : Asset.native();
  const passphrase =
    env.NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

  // Fee is per-operation; pay a healthy multiple of base so a busy ledger
  // doesn't strand the run.
  const fee = String(BigInt(BASE_FEE) * BigInt(Math.max(batch.length, 1)) * 10n);

  let builder = new TransactionBuilder(account, {
    fee,
    networkPassphrase: passphrase,
  });
  for (const p of batch) {
    builder = builder.addOperation(
      Operation.payment({
        destination: p.address,
        asset,
        amount: fromStroops(p.stroops),
      })
    );
  }
  if (memo) builder = builder.addMemo(Memo.text(memo.slice(0, 28)));
  const tx = builder.setTimeout(120).build();
  tx.sign(keypair);
  return { tx, server };
}

// Period budgets now come from `budgetForCadence` in cadence.ts, which slices a
// per-instance daily budget rather than the single global var this used.
