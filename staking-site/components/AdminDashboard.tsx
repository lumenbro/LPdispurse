"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { createReadClient, createUserClient } from "@/lib/contract";
import type { PoolState, MerkleRootData } from "@/lib/contract";
import { ADMIN_WALLET, CONTRACT_ID } from "@/lib/constants";

interface PoolInfo {
  index: number;
  state: PoolState;
  poolId: string | null;
  merkleRoot: MerkleRootData | null;
}

function formatLmnr(stroops: bigint): string {
  const whole = stroops / 10000000n;
  const frac = stroops % 10000000n;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr
    ? `${whole.toLocaleString()}.${fracStr}`
    : whole.toLocaleString();
}

function stroopsPerSecToLmnrPerDay(stroopsPerSec: bigint): string {
  const perDay = (stroopsPerSec * 86400n) / 10000000n;
  return perDay.toLocaleString();
}

export function AdminDashboard() {
  const { publicKey, connected, signTransaction } = useWallet();
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [rewardBalance, setRewardBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [txPending, setTxPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [newPoolId, setNewPoolId] = useState("");
  const [newRate, setNewRate] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  const [removePoolIndex, setRemovePoolIndex] = useState("");

  const isAdmin = connected && publicKey === ADMIN_WALLET;

  const fetchData = useCallback(async () => {
    if (!CONTRACT_ID) {
      setLoading(false);
      return;
    }

    try {
      const client = createReadClient();

      const countTx = await client.get_pool_count();
      const poolCount = Number(countTx.result);

      const balTx = await client.reward_balance();
      setRewardBalance(BigInt(balTx.result));

      const poolData: PoolInfo[] = [];
      for (let i = 0; i < poolCount; i++) {
        const stateTx = await client.get_pool_state({ pool_index: i });

        let poolId: string | null = null;
        try {
          const idTx = await client.get_pool_id({ pool_index: i });
          poolId = Buffer.from(idTx.result).toString("hex");
        } catch {
          // Pool ID not found (removed pool)
        }

        let merkleRoot: MerkleRootData | null = null;
        try {
          const rootTx = await client.get_merkle_root({ pool_index: i });
          merkleRoot = rootTx.result;
        } catch {
          // No merkle root yet
        }

        poolData.push({
          index: i,
          state: stateTx.result,
          poolId,
          merkleRoot,
        });
      }

      setPools(poolData);
    } catch (err) {
      console.error("Failed to fetch contract data:", err);
      setError("Failed to load contract data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const clearMessages = () => {
    setError(null);
    setSuccess(null);
  };

  const handleAddPool = async () => {
    if (!publicKey || !signTransaction) return;
    clearMessages();

    const hex = newPoolId.trim().replace(/^0x/, "");
    if (hex.length !== 64) {
      setError("Pool ID must be 64 hex characters (32 bytes).");
      return;
    }

    setTxPending("add-pool");
    try {
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.add_pool({
        admin: publicKey,
        pool_id: Buffer.from(hex, "hex"),
      });
      await tx.signAndSend();
      setSuccess(`Pool added at index ${tx.result ?? pools.length}.`);
      setNewPoolId("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add pool failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleRemovePool = async () => {
    if (!publicKey || !signTransaction) return;
    clearMessages();

    const idx = parseInt(removePoolIndex, 10);
    if (isNaN(idx) || idx < 0) {
      setError("Enter a valid pool index.");
      return;
    }

    setTxPending("remove-pool");
    try {
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.remove_pool({
        admin: publicKey,
        pool_index: idx,
      });
      await tx.signAndSend();
      setSuccess(`Pool #${idx} removed.`);
      setRemovePoolIndex("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove pool failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleSetRate = async () => {
    if (!publicKey || !signTransaction) return;
    clearMessages();

    const lmnrPerDay = parseFloat(newRate);
    if (isNaN(lmnrPerDay) || lmnrPerDay < 0) {
      setError("Enter a valid LMNR/day rate.");
      return;
    }

    // Convert LMNR/day → stroops/sec
    const stroopsPerSec = BigInt(
      Math.round((lmnrPerDay * 1e7) / 86400)
    );

    setTxPending("set-rate");
    try {
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.set_reward_rate({
        admin: publicKey,
        new_rate: stroopsPerSec,
      });
      await tx.signAndSend();
      setSuccess(
        `Reward rate set to ${lmnrPerDay} LMNR/day (${stroopsPerSec} stroops/sec).`
      );
      setNewRate("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Set rate failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleFund = async () => {
    if (!publicKey || !signTransaction) return;
    clearMessages();

    const lmnr = parseFloat(fundAmount);
    if (isNaN(lmnr) || lmnr <= 0) {
      setError("Enter a valid LMNR amount.");
      return;
    }

    const stroops = BigInt(Math.round(lmnr * 1e7));

    setTxPending("fund");
    try {
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.fund({
        funder: publicKey,
        amount: stroops,
      });
      await tx.signAndSend();
      setSuccess(`Funded ${lmnr} LMNR into the contract.`);
      setFundAmount("");
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fund failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleTriggerCron = async () => {
    clearMessages();
    setTxPending("cron");
    try {
      const res = await fetch("/api/cron", {
        headers: { authorization: `Bearer ${ADMIN_WALLET}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Cron failed");
      setSuccess(
        `Indexer ran: ${JSON.stringify(data.results ?? data, null, 2)}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cron trigger failed");
    } finally {
      setTxPending(null);
    }
  };

  if (!CONTRACT_ID) {
    return (
      <div className="rounded-xl border border-yellow-800/40 bg-yellow-900/20 p-6 text-center text-yellow-200">
        Contract not configured. Set NEXT_PUBLIC_CONTRACT_ID in your
        environment.
      </div>
    );
  }

  if (!ADMIN_WALLET) {
    return (
      <div className="rounded-xl border border-yellow-800/40 bg-yellow-900/20 p-6 text-center text-yellow-200">
        NEXT_PUBLIC_ADMIN_WALLET not configured.
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-8 text-center text-gray-400">
        Connect your wallet to access the admin panel.
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-red-800/40 bg-red-900/20 p-8 text-center text-red-300">
        Access denied. Connected wallet does not match the admin address.
        <p className="mt-2 font-mono text-xs text-gray-500">
          Expected: {ADMIN_WALLET}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-lmnr-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Messages */}
      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-green-800/40 bg-green-900/20 px-4 py-3 text-sm text-green-300 whitespace-pre-wrap">
          {success}
        </div>
      )}

      {/* Contract Overview */}
      <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">
          Contract Overview
        </h2>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <span className="text-gray-400">Contract</span>
            <p className="mt-1 break-all font-mono text-xs text-gray-300">
              {CONTRACT_ID}
            </p>
          </div>
          <div>
            <span className="text-gray-400">Reward Balance</span>
            <p className="mt-1 text-xl font-bold text-lmnr-200">
              {formatLmnr(rewardBalance)} LMNR
            </p>
          </div>
          <div>
            <span className="text-gray-400">Pool Count</span>
            <p className="mt-1 text-xl font-bold text-lmnr-200">
              {pools.length}
            </p>
          </div>
        </div>
      </section>

      {/* Pool Details */}
      <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
        <h2 className="mb-4 text-lg font-semibold text-white">Pools</h2>
        {pools.length === 0 ? (
          <p className="text-sm text-gray-400">No pools configured.</p>
        ) : (
          <div className="space-y-4">
            {pools.map((pool) => (
              <div
                key={pool.index}
                className="rounded-lg border border-lmnr-700/20 bg-lmnr-900/30 p-4"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-white">
                    Pool #{pool.index}
                  </span>
                  {pool.merkleRoot && (
                    <span className="rounded-full bg-lmnr-700/30 px-2 py-0.5 text-xs text-lmnr-200">
                      Epoch {pool.merkleRoot.epoch_id.toString()}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <div>
                    <span className="text-gray-400">Pool ID</span>
                    <p className="mt-0.5 break-all font-mono text-gray-300">
                      {pool.poolId
                        ? `${pool.poolId.slice(0, 8)}...${pool.poolId.slice(-8)}`
                        : "removed"}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Total Staked</span>
                    <p className="mt-0.5 font-mono text-gray-200">
                      {formatLmnr(BigInt(pool.state.total_staked))} LP
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Acc Reward/Share</span>
                    <p className="mt-0.5 font-mono text-gray-200">
                      {pool.state.acc_reward_per_share.toString()}
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-400">Merkle Root</span>
                    <p className="mt-0.5 break-all font-mono text-gray-300">
                      {pool.merkleRoot
                        ? `${Buffer.from(pool.merkleRoot.root).toString("hex").slice(0, 12)}...`
                        : "none"}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Admin Actions */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Add Pool */}
        <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
          <h2 className="mb-3 text-lg font-semibold text-white">Add Pool</h2>
          <p className="mb-3 text-xs text-gray-400">
            Enter the 64-character hex SDEX liquidity pool ID.
          </p>
          <input
            type="text"
            value={newPoolId}
            onChange={(e) => setNewPoolId(e.target.value)}
            placeholder="e.g. a1b2c3d4...64 hex chars"
            className="mb-3 w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/60 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
          />
          <button
            onClick={handleAddPool}
            disabled={txPending !== null || !newPoolId.trim()}
            className="rounded-lg bg-lmnr-600 px-4 py-2 text-sm font-semibold text-white hover:bg-lmnr-500 disabled:opacity-50 transition"
          >
            {txPending === "add-pool" ? "Adding..." : "Add Pool"}
          </button>
        </section>

        {/* Remove Pool */}
        <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
          <h2 className="mb-3 text-lg font-semibold text-white">
            Remove Pool
          </h2>
          <p className="mb-3 text-xs text-gray-400">
            Deactivates a pool. Stakers can still claim pending rewards.
          </p>
          <input
            type="number"
            value={removePoolIndex}
            onChange={(e) => setRemovePoolIndex(e.target.value)}
            placeholder="Pool index (0, 1, ...)"
            min="0"
            className="mb-3 w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/60 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
          />
          <button
            onClick={handleRemovePool}
            disabled={txPending !== null || !removePoolIndex}
            className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition"
          >
            {txPending === "remove-pool" ? "Removing..." : "Remove Pool"}
          </button>
        </section>

        {/* Set Reward Rate */}
        <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
          <h2 className="mb-3 text-lg font-semibold text-white">
            Reward Rate
          </h2>
          <p className="mb-3 text-xs text-gray-400">
            Set global LMNR distributed per day across all pools.
          </p>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="number"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              placeholder="e.g. 4000"
              min="0"
              step="any"
              className="w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/60 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
            />
            <span className="whitespace-nowrap text-sm text-gray-400">
              LMNR/day
            </span>
          </div>
          {newRate && !isNaN(parseFloat(newRate)) && (
            <p className="mb-3 text-xs text-gray-500">
              = {BigInt(Math.round((parseFloat(newRate) * 1e7) / 86400)).toString()}{" "}
              stroops/sec
            </p>
          )}
          <button
            onClick={handleSetRate}
            disabled={txPending !== null || !newRate}
            className="rounded-lg bg-lmnr-600 px-4 py-2 text-sm font-semibold text-white hover:bg-lmnr-500 disabled:opacity-50 transition"
          >
            {txPending === "set-rate" ? "Setting..." : "Set Rate"}
          </button>
        </section>

        {/* Fund Contract */}
        <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
          <h2 className="mb-3 text-lg font-semibold text-white">
            Fund Contract
          </h2>
          <p className="mb-3 text-xs text-gray-400">
            Transfer LMNR from your wallet into the contract reward pool.
          </p>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="number"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              placeholder="e.g. 10000"
              min="0"
              step="any"
              className="w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/60 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
            />
            <span className="whitespace-nowrap text-sm text-gray-400">
              LMNR
            </span>
          </div>
          <button
            onClick={handleFund}
            disabled={txPending !== null || !fundAmount}
            className="rounded-lg bg-green-700 px-4 py-2 text-sm font-semibold text-white hover:bg-green-600 disabled:opacity-50 transition"
          >
            {txPending === "fund" ? "Funding..." : "Fund"}
          </button>
        </section>
      </div>

      {/* Trigger Indexer */}
      <section className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6">
        <h2 className="mb-3 text-lg font-semibold text-white">
          Manual Indexer Run
        </h2>
        <p className="mb-3 text-xs text-gray-400">
          Trigger the cron indexer manually — snapshots LP holders, builds
          Merkle trees, and posts roots on-chain. Normally runs every 6 hours
          automatically.
        </p>
        <button
          onClick={handleTriggerCron}
          disabled={txPending !== null}
          className="rounded-lg border border-lmnr-600 px-4 py-2 text-sm font-semibold text-lmnr-200 hover:bg-lmnr-600/20 disabled:opacity-50 transition"
        >
          {txPending === "cron" ? "Running..." : "Run Indexer Now"}
        </button>
      </section>
    </div>
  );
}
