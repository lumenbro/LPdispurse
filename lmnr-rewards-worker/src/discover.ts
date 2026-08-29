import type { Env } from "./config";

export interface DiscoveredPool {
  poolId: string;
  name: string;
  assets: string[];
  holders: number;
  totalShares: string;
}

/**
 * Every on-chain liquidity pool containing the reward asset.
 * Drives the admin page's "enable this pool" checklist, so pools never have to
 * be typed in by hand.
 */
export async function discoverPools(env: Env): Promise<DiscoveredPool[]> {
  const asset = `${env.REWARD_ASSET_CODE}:${env.REWARD_ASSET_ISSUER}`;
  const url = `${env.HORIZON_URL}/liquidity_pools?reserves=${encodeURIComponent(asset)}&limit=200`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Horizon ${res.status} discovering pools`);

  const body: any = await res.json();
  const records: any[] = body?._embedded?.records ?? [];

  return records
    .map((r) => {
      const assets = (r.reserves ?? []).map((x: any) => {
        const a = String(x.asset);
        return a === "native" ? "XLM" : a.split(":")[0];
      });
      return {
        poolId: r.id,
        name: assets.join("/"),
        assets,
        holders: Number(r.total_trustlines ?? 0),
        totalShares: String(r.total_shares ?? "0"),
      };
    })
    .filter((p) => p.holders > 0)
    .sort((a, b) => b.holders - a.holders);
}
