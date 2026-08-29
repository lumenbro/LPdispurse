import type { Env } from "./config";

export interface LpHolder {
  address: string;
  /** LP shares held, as a bigint in stroops. */
  shares: bigint;
  /** True if the account can actually receive the reward asset. */
  hasTrustline: boolean;
}

/**
 * Accounts holding shares in a pool, with reward-asset trustline status.
 *
 * The account records Horizon returns already include every balance, so the
 * trustline check costs no extra requests. It matters because a payment to an
 * account without a trustline fails the ENTIRE transaction, not just that op.
 * (LP providers in an xLMNR pool will normally already hold one, but a pool
 * pairing two non-reward assets would not.)
 */
export async function getPoolHolders(
  env: Env,
  poolId: string
): Promise<LpHolder[]> {
  const holders: LpHolder[] = [];
  let url =
    `${env.HORIZON_URL}/accounts?liquidity_pool=${poolId}&limit=200`;

  for (let page = 0; page < 20; page++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`Horizon ${res.status} for pool ${poolId.slice(0, 8)}`);
    }
    const body: any = await res.json();
    const records: any[] = body?._embedded?.records ?? [];

    for (const acct of records) {
      const lp = acct.balances?.find(
        (b: any) =>
          b.asset_type === "liquidity_pool_shares" &&
          b.liquidity_pool_id === poolId
      );
      if (!lp || Number(lp.balance) <= 0) continue;

      const hasTrustline = acct.balances?.some(
        (b: any) =>
          b.asset_code === env.REWARD_ASSET_CODE &&
          b.asset_issuer === env.REWARD_ASSET_ISSUER
      );

      holders.push({
        address: acct.account_id,
        shares: BigInt(String(lp.balance).replace(".", "").replace(/^0+/, "") || "0"),
        hasTrustline: Boolean(hasTrustline),
      });
    }

    const next = body?._links?.next?.href;
    if (!next || records.length === 0) break;
    url = next;
  }

  return holders;
}
