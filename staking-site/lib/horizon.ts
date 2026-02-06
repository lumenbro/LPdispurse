import { Horizon, Asset } from "@stellar/stellar-sdk";
import { HORIZON_URL } from "./constants";

const server = new Horizon.Server(HORIZON_URL);

export interface PoolAssetInfo {
  code: string;
  issuer: string | null;
  asset: Asset;
}

export interface PoolReserveInfo {
  assetA: PoolAssetInfo;
  assetB: PoolAssetInfo;
  reserveA: string;
  reserveB: string;
  totalShares: string;
}

export interface UserPoolBalances {
  balanceA: string;
  balanceB: string;
  lpShares: string;
  hasLpTrustline: boolean;
}

function parseAsset(reserve: { asset: string }): PoolAssetInfo {
  const raw = reserve.asset;
  if (raw === "native") {
    return { code: "XLM", issuer: null, asset: Asset.native() };
  }
  const [code, issuer] = raw.split(":");
  return { code, issuer, asset: new Asset(code, issuer) };
}

export async function fetchPoolInfo(
  poolId: string
): Promise<PoolReserveInfo> {
  const pool = await server.liquidityPools().liquidityPoolId(poolId).call();
  const r = pool.reserves;
  const assetA = parseAsset(r[0]);
  const assetB = parseAsset(r[1]);
  return {
    assetA,
    assetB,
    reserveA: r[0].amount,
    reserveB: r[1].amount,
    totalShares: pool.total_shares,
  };
}

export async function fetchUserPoolBalances(
  publicKey: string,
  poolId: string,
  assetA: PoolAssetInfo,
  assetB: PoolAssetInfo
): Promise<UserPoolBalances> {
  const account = await server.loadAccount(publicKey);

  let balanceA = "0";
  let balanceB = "0";
  let lpShares = "0";
  let hasLpTrustline = false;

  for (const bal of account.balances) {
    if (
      bal.asset_type === "liquidity_pool_shares" &&
      (bal as any).liquidity_pool_id === poolId
    ) {
      lpShares = bal.balance;
      hasLpTrustline = true;
    } else if (bal.asset_type === "native" && assetA.code === "XLM") {
      balanceA = bal.balance;
    } else if (bal.asset_type === "native" && assetB.code === "XLM") {
      balanceB = bal.balance;
    } else if (
      bal.asset_type !== "native" &&
      bal.asset_type !== "liquidity_pool_shares"
    ) {
      const creditBal = bal as Horizon.HorizonApi.BalanceLineAsset;
      if (
        creditBal.asset_code === assetA.code &&
        creditBal.asset_issuer === assetA.issuer
      ) {
        balanceA = creditBal.balance;
      }
      if (
        creditBal.asset_code === assetB.code &&
        creditBal.asset_issuer === assetB.issuer
      ) {
        balanceB = creditBal.balance;
      }
    }
  }

  return { balanceA, balanceB, lpShares, hasLpTrustline };
}
