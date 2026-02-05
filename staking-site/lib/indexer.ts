/**
 * Off-chain indexer: snapshots LP balances from Horizon, builds Merkle trees,
 * stores proofs in Vercel Blob, and posts roots on-chain.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { put } from "@vercel/blob";
import { HORIZON_URL } from "./constants";
import { createAdminClient } from "./contract";
import { buildMerkleTree, computeLeaf } from "./merkle";

export interface LpHolder {
  address: string;
  balance: bigint; // in stroops (7 decimals)
}

export interface PoolSnapshot {
  poolIndex: number;
  poolId: string;
  holders: LpHolder[];
  ledger: number;
}

/**
 * Query Horizon for all accounts holding shares in a given liquidity pool.
 * Returns addresses and their LP share balances.
 */
export async function snapshotPool(poolId: string): Promise<LpHolder[]> {
  const server = new Horizon.Server(HORIZON_URL);
  const holders: LpHolder[] = [];

  let page = await server
    .accounts()
    .forLiquidityPool(poolId)
    .limit(200)
    .call();

  while (true) {
    for (const account of page.records) {
      // Find the liquidity pool share balance for this specific pool
      const lpBalance = account.balances.find(
        (b: any) =>
          b.asset_type === "liquidity_pool_shares" &&
          b.liquidity_pool_id === poolId
      );

      if (lpBalance && parseFloat(lpBalance.balance) > 0) {
        // Convert decimal string to stroops (7 decimal places)
        const stroops = BigInt(
          Math.round(parseFloat(lpBalance.balance) * 1e7)
        );
        holders.push({ address: account.account_id, balance: stroops });
      }
    }

    // Paginate
    if (page.records.length < 200) break;
    page = await page.next();
  }

  return holders;
}

/**
 * Build a Merkle tree for a pool snapshot, store proofs in Vercel Blob,
 * and post the root on-chain.
 */
export async function processPool(snapshot: PoolSnapshot): Promise<{
  root: string;
  epochId: string;
  holderCount: number;
}> {
  const { poolIndex, holders, ledger } = snapshot;

  if (holders.length === 0) {
    console.log(`Pool ${poolIndex}: no holders, skipping`);
    return { root: "", epochId: "0", holderCount: 0 };
  }

  // Read current epoch from contract to determine next epoch_id
  const adminClient = createAdminClient();
  let nextEpochId: bigint;
  try {
    const tx = await adminClient.get_merkle_root({ pool_index: poolIndex });
    nextEpochId = BigInt(tx.result.epoch_id) + 1n;
  } catch {
    nextEpochId = 1n; // First epoch
  }

  // Compute leaves
  const leaves = holders.map((h) =>
    computeLeaf(poolIndex, h.address, h.balance, nextEpochId)
  );

  // Build tree
  const tree = buildMerkleTree(leaves);

  // Store per-user proofs in Vercel Blob
  for (let i = 0; i < holders.length; i++) {
    const proofData = {
      poolIndex,
      address: holders[i].address,
      balance: holders[i].balance.toString(),
      epochId: nextEpochId.toString(),
      proof: tree.proofs[i].map((b) => b.toString("hex")),
    };

    await put(
      `proofs/${poolIndex}/${holders[i].address}.json`,
      JSON.stringify(proofData),
      { access: "public", addRandomSuffix: false }
    );
  }

  // Post root on-chain (raw Soroban RPC — bypasses ContractClient signing)
  const rootHex = tree.root.toString("hex");
  console.log(
    `Pool ${poolIndex}: posting root ${rootHex} (epoch ${nextEpochId}, ${holders.length} holders)`
  );

  await adminClient.rawSetMerkleRoot(poolIndex, tree.root, ledger);

  // Store a manifest for this epoch
  const manifest = {
    poolIndex,
    epochId: nextEpochId.toString(),
    root: rootHex,
    snapshotLedger: ledger,
    holderCount: holders.length,
    holders: holders.map((h) => ({
      address: h.address,
      balance: h.balance.toString(),
    })),
    createdAt: new Date().toISOString(),
  };

  await put(
    `manifests/${poolIndex}/epoch-${nextEpochId}.json`,
    JSON.stringify(manifest),
    { access: "public", addRandomSuffix: false }
  );

  return {
    root: rootHex,
    epochId: nextEpochId.toString(), // Convert BigInt to string for JSON serialization
    holderCount: holders.length,
  };
}
