export interface Env {
  LEDGER: KVNamespace;
  HORIZON_URL: string;
  NETWORK: string;
  REWARD_ASSET_CODE: string;
  REWARD_ASSET_ISSUER: string;
  DAILY_REWARD_PER_POOL: string;
  MIN_PAYOUT: string;
  DRY_RUN: string;
  POOL_IDS: string;
  /** Set with: wrangler secret put DISBURSER_SECRET */
  DISBURSER_SECRET?: string;
}

/** Stroops per whole token (7 decimals). */
export const STROOPS = 10_000_000n;

/** Stellar hard limit on operations in one transaction. */
export const MAX_OPS_PER_TX = 100;

export function poolIds(env: Env): string[] {
  return env.POOL_IDS.split(",").map((s) => s.trim()).filter(Boolean);
}

export function isDryRun(env: Env): boolean {
  return String(env.DRY_RUN).toLowerCase() !== "false";
}

/** Whole tokens -> stroops, truncating (never round up: don't over-pay). */
export function toStroops(amount: string | number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const padded = (frac + "0000000").slice(0, 7);
  return BigInt(whole || "0") * STROOPS + BigInt(padded || "0");
}

/** Stroops -> the decimal string the Stellar SDK expects. */
export function fromStroops(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / STROOPS;
  const frac = (a % STROOPS).toString().padStart(7, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
