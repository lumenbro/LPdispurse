/**
 * Off-chain indexer: snapshots LP balances from Horizon, builds Merkle trees,
 * stores proofs in Vercel Blob, and posts roots on-chain.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { put, list } from "@vercel/blob";
import { HORIZON_URL, CONTRACT_ID } from "./constants";
import { createAdminClient } from "./contract";
import {
  assertProofsValid,
  assertSnapshotInvariants,
  assertSnapshotLedger,
  buildMerkleTree,
  computeLeaf,
} from "./merkle";

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

/** Current ledger sequence, for snapshot-freshness checks. */
export async function getCurrentLedger(): Promise<number> {
  const server = new Horizon.Server(HORIZON_URL);
  const res = await server.ledgers().order("desc").limit(1).call();
  return res.records[0].sequence;
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
  let prevSnapshotLedger: number | null = null;
  try {
    const tx = await adminClient.get_merkle_root({ pool_index: poolIndex });
    nextEpochId = BigInt(tx.result.epoch_id) + 1n;
    prevSnapshotLedger = Number(tx.result.snapshot_ledger);
  } catch {
    nextEpochId = 1n; // First epoch
  }

  // The v2 leaf binds the contract address and the real pool_id, so both must
  // be read from the chain rather than assumed.
  const poolIdRes = await adminClient.get_pool_id({ pool_index: poolIndex });
  const poolId = Buffer.from(poolIdRes.result);
  const contractId = CONTRACT_ID;

  // total_lp is the epoch's reward DENOMINATOR. Every holder's share is
  // balance / total_lp, matching the original Python bot's total_shares.
  const totalLp = holders.reduce((acc, h) => acc + h.balance, 0n);

  // Hard stop before anything is posted: the contract cannot verify that the
  // leaves sum to total_lp, so a bad snapshot would irreversibly over-emit.
  assertSnapshotInvariants(
    holders.map((h) => ({ address: h.address, balance: h.balance })),
    totalLp,
    { exhaustive: true }
  );
  assertSnapshotLedger(ledger, await getCurrentLedger(), prevSnapshotLedger);

  // Compute leaves
  const leaves = holders.map((h) =>
    computeLeaf(contractId, poolIndex, poolId, h.address, h.balance, nextEpochId)
  );

  // Build tree
  const tree = buildMerkleTree(leaves);

  // Verify every proof locally BEFORE posting. This is the tripwire for a
  // leaf-format drift between merkle.ts and merkle.rs — without it, a mismatch
  // would only surface as every user's stake failing on-chain.
  assertProofsValid(leaves, tree);

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

  await adminClient.rawSetMerkleRoot(poolIndex, tree.root, ledger, totalLp);

  // Reconcile staker balances via batched router call (one batch per pool)
  const currentBalances = new Map<string, bigint>();
  for (const h of holders) {
    currentBalances.set(h.address, h.balance);
  }

  const MAX_BATCH_SIZE = 15; // Stay well within 100M instruction / memory limits

  const prevEpochId = nextEpochId - 1n;
  if (prevEpochId >= 1n) {
    try {
      const { blobs } = await list({
        prefix: `manifests/${poolIndex}/epoch-${prevEpochId}.json`,
      });
      if (blobs.length > 0) {
        const manifestResp = await fetch(blobs[0].url);
        const prevManifest = (await manifestResp.json()) as {
          holders: { address: string; balance: string }[];
        };

        // Collect all reconciliation entries for this pool
        const batchEntries: { user: string; newAmount: bigint }[] = [];

        // v2 OPERATOR MODEL: the cron key may only DECREASE an existing
        // stake. Increases and brand-new positions require the USER to call
        // stake() with a Merkle proof — that is what stops a compromised cron
        // key from minting entitlements and draining the reward pool.
        //
        // Consequence: a holder who does not re-prove in the new epoch simply
        // stops earning (their settlement is frozen at their epoch's snapshot).
        // That is intended, and it is why roots should be posted infrequently.
        for (const prev of prevManifest.holders) {
          const currentBal = currentBalances.get(prev.address);
          const prevBal = BigInt(prev.balance);

          if (currentBal === undefined) {
            console.log(`Pool ${poolIndex}: ${prev.address}: ${prevBal} -> 0 (exited)`);
            batchEntries.push({ user: prev.address, newAmount: 0n });
          } else if (currentBal < prevBal) {
            console.log(`Pool ${poolIndex}: ${prev.address}: ${prevBal} -> ${currentBal} (reduced)`);
            batchEntries.push({ user: prev.address, newAmount: currentBal });
          } else {
            // Equal or increased: NOT the operator's to write. The user
            // re-proves via stake() against the new epoch's root.
            console.log(
              `Pool ${poolIndex}: ${prev.address}: ${prevBal} -> ${currentBal} (no-op; user must re-prove)`
            );
          }
        }

        // New holders are deliberately NOT seeded here — they must prove.

        // Submit in chunks via Stellar Router
        if (batchEntries.length > 0) {
          const chunks: { user: string; newAmount: bigint }[][] = [];
          for (let i = 0; i < batchEntries.length; i += MAX_BATCH_SIZE) {
            chunks.push(batchEntries.slice(i, i + MAX_BATCH_SIZE));
          }

          console.log(
            `Pool ${poolIndex}: reconciling ${batchEntries.length} stakers in ${chunks.length} batch(es)`
          );

          for (let c = 0; c < chunks.length; c++) {
            console.log(
              `Pool ${poolIndex}: submitting batch ${c + 1}/${chunks.length} (${chunks[c].length} entries)`
            );
            await adminClient.rawBatchUpdateStake(poolIndex, chunks[c]);
          }

          console.log(`Pool ${poolIndex}: all batches complete`);
        }
      }
    } catch (e) {
      console.warn(
        `Pool ${poolIndex}: could not load previous manifest for reconciliation:`,
        e
      );
    }
  }

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
