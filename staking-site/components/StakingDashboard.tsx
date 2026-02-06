"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./WalletProvider";
import { createReadClient, createUserClient } from "@/lib/contract";
import type { PoolState, StakerInfo, MerkleRootData } from "@/lib/contract";
import { CONTRACT_ID } from "@/lib/constants";
import { RewardsTicker } from "./RewardsTicker";
import { AddLiquidityPanel } from "./AddLiquidityPanel";
import { EpochCountdown } from "./EpochCountdown";
import {
  fetchPoolInfo,
  fetchUserPoolBalances,
  type PoolReserveInfo,
  type UserPoolBalances,
} from "@/lib/horizon";

interface PoolData {
  index: number;
  state: PoolState;
  merkleRoot: MerkleRootData | null;
  stakerInfo: StakerInfo | null;
  pendingReward: bigint;
  poolId: string | null;
  poolInfo: PoolReserveInfo | null;
}

function formatLmnr(stroops: bigint): string {
  const whole = stroops / 10000000n;
  const frac = stroops % 10000000n;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  return fracStr
    ? `${whole.toLocaleString()}.${fracStr}`
    : whole.toLocaleString();
}

function formatLp(stroops: bigint): string {
  return formatLmnr(stroops);
}

export function StakingDashboard() {
  const { publicKey, connected, signTransaction } = useWallet();
  const [pools, setPools] = useState<PoolData[]>([]);
  const [rewardBalance, setRewardBalance] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [txPending, setTxPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userPoolBalances, setUserPoolBalances] = useState<
    Record<number, UserPoolBalances>
  >({});

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

      const poolData: PoolData[] = [];
      const balancesMap: Record<number, UserPoolBalances> = {};

      for (let i = 0; i < poolCount; i++) {
        const stateTx = await client.get_pool_state({ pool_index: i });
        const state = stateTx.result;

        let merkleRoot: MerkleRootData | null = null;
        try {
          const rootTx = await client.get_merkle_root({ pool_index: i });
          merkleRoot = rootTx.result;
        } catch {
          // No merkle root yet
        }

        // Fetch pool ID from contract
        let poolId: string | null = null;
        let poolInfo: PoolReserveInfo | null = null;
        try {
          const idTx = await client.get_pool_id({ pool_index: i });
          poolId = Buffer.from(idTx.result).toString("hex");
          poolInfo = await fetchPoolInfo(poolId);
        } catch {
          // Pool ID not found or Horizon error
        }

        let stakerInfo: StakerInfo | null = null;
        let pendingReward = 0n;
        if (publicKey) {
          try {
            const stakerTx = await client.get_staker_info({
              user: publicKey,
              pool_index: i,
            });
            stakerInfo = stakerTx.result;
          } catch {
            // No stake
          }

          try {
            const pendingTx = await client.pending_reward({
              user: publicKey,
              pool_index: i,
            });
            pendingReward = BigInt(pendingTx.result);
          } catch {
            // No pending
          }

          // Fetch user's asset balances for this pool
          if (poolId && poolInfo) {
            try {
              balancesMap[i] = await fetchUserPoolBalances(
                publicKey,
                poolId,
                poolInfo.assetA,
                poolInfo.assetB
              );
            } catch {
              // Horizon error
            }
          }
        }

        poolData.push({
          index: i,
          state,
          merkleRoot,
          stakerInfo,
          pendingReward,
          poolId,
          poolInfo,
        });
      }

      setPools(poolData);
      setUserPoolBalances(balancesMap);
    } catch (err) {
      console.error("Failed to fetch contract data:", err);
      setError("Failed to load contract data. Check your configuration.");
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleStake = async (poolIndex: number) => {
    if (!publicKey || !signTransaction) return;
    setTxPending(`stake-${poolIndex}`);
    setError(null);

    try {
      console.log("[Staking] stake: fetching proof...", { poolIndex, publicKey });
      const res = await fetch(`/api/proof/${poolIndex}/${publicKey}`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(
          data.error || "No proof available. Wait for next epoch."
        );
      }

      const proofData = await res.json();
      console.log("[Staking] stake: proof received", { balance: proofData.balance, proofLen: proofData.proof?.length });
      const proofBuffers = proofData.proof.map((hex: string) =>
        Buffer.from(hex, "hex")
      );

      console.log("[Staking] stake: simulating tx...");
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.stake({
        user: publicKey,
        pool_index: poolIndex,
        lp_balance: BigInt(proofData.balance),
        proof: proofBuffers,
      });
      console.log("[Staking] stake: simulation done, calling signAndSend...");
      await tx.signAndSend();
      console.log("[Staking] stake: success");
      await fetchData();
    } catch (err: any) {
      console.error("[Staking] stake FAILED:", err);
      setError(err?.message || JSON.stringify(err) || "Stake failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleClaim = async (poolIndex: number) => {
    if (!publicKey || !signTransaction) return;
    setTxPending(`claim-${poolIndex}`);
    setError(null);

    try {
      console.log("[Staking] claim: simulating tx...", { poolIndex });
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.claim({
        user: publicKey,
        pool_index: poolIndex,
      });
      console.log("[Staking] claim: simulation done, calling signAndSend...");
      await tx.signAndSend();
      console.log("[Staking] claim: success");
      await fetchData();
    } catch (err: any) {
      console.error("[Staking] claim FAILED:", err);
      setError(err?.message || JSON.stringify(err) || "Claim failed");
    } finally {
      setTxPending(null);
    }
  };

  const handleUnstake = async (poolIndex: number) => {
    if (!publicKey || !signTransaction) return;
    setTxPending(`unstake-${poolIndex}`);
    setError(null);

    try {
      console.log("[Staking] unstake: simulating tx...", { poolIndex });
      const client = createUserClient(publicKey, signTransaction);
      const tx = await client.unstake({
        user: publicKey,
        pool_index: poolIndex,
      });
      console.log("[Staking] unstake: simulation done, calling signAndSend...");
      await tx.signAndSend();
      console.log("[Staking] unstake: success");
      await fetchData();
    } catch (err: any) {
      console.error("[Staking] unstake FAILED:", err);
      setError(err?.message || JSON.stringify(err) || "Unstake failed");
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

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-lmnr-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Global stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-5">
          <p className="text-sm text-gray-400">Reward Pool Balance</p>
          <p className="mt-1 text-2xl font-bold text-lmnr-200">
            {formatLmnr(rewardBalance)} LMNR
          </p>
        </div>
        <div className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-5">
          <p className="text-sm text-gray-400">Active Pools</p>
          <p className="mt-1 text-2xl font-bold text-lmnr-200">
            {pools.length}
          </p>
        </div>
      </div>

      {/* Risk-free notice */}
      <div className="rounded-xl border border-lmnr-700/20 bg-lmnr-900/30 px-5 py-4 text-sm text-gray-300 leading-relaxed">
        <span className="font-semibold text-lmnr-200">Your LP tokens never leave your wallet.</span>{" "}
        Staking is risk-free — no tokens are transferred or locked. The system periodically
        snapshots your SDEX LP balance and tracks rewards based on your share. You retain
        full control of your liquidity at all times.
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/20 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Pool cards */}
      {pools.map((pool) => (
        <div
          key={pool.index}
          className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-6"
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">
              {pool.poolInfo
                ? `${pool.poolInfo.assetA.code} / ${pool.poolInfo.assetB.code}`
                : `Pool #${pool.index}`}
            </h3>
            {pool.merkleRoot && (
              <span className="rounded-full bg-lmnr-700/30 px-3 py-1 text-xs text-lmnr-200">
                Epoch {pool.merkleRoot.epoch_id.toString()}
              </span>
            )}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            <div>
              <span className="text-gray-400">Total Staked</span>
              <p className="font-mono text-gray-200">
                {formatLp(BigInt(pool.state.total_staked))} LP
              </p>
            </div>
            <div>
              <span className="text-gray-400">Your Stake</span>
              <p className="font-mono text-gray-200">
                {pool.stakerInfo
                  ? `${formatLp(BigInt(pool.stakerInfo.staked_amount))} LP`
                  : connected
                    ? "Not staked"
                    : "--"}
              </p>
            </div>
            {pool.poolInfo && (
              <>
                <div>
                  <span className="text-gray-400">
                    Reserve {pool.poolInfo.assetA.code}
                  </span>
                  <p className="font-mono text-gray-200">
                    {parseFloat(pool.poolInfo.reserveA).toLocaleString()}
                  </p>
                </div>
                <div>
                  <span className="text-gray-400">
                    Reserve {pool.poolInfo.assetB.code}
                  </span>
                  <p className="font-mono text-gray-200">
                    {parseFloat(pool.poolInfo.reserveB).toLocaleString()}
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Pending rewards ticker */}
          {connected && pool.stakerInfo && (
            <div className="mb-4">
              <RewardsTicker
                accRewardPerShare={BigInt(pool.state.acc_reward_per_share)}
                totalStaked={BigInt(pool.state.total_staked)}
                lastRewardTime={BigInt(pool.state.last_reward_time)}
                stakedAmount={BigInt(pool.stakerInfo.staked_amount)}
                rewardDebt={BigInt(pool.stakerInfo.reward_debt)}
                pendingRewards={BigInt(pool.stakerInfo.pending_rewards)}
                isCurrentEpoch={
                  !!pool.merkleRoot &&
                  BigInt(pool.stakerInfo.epoch_id) === BigInt(pool.merkleRoot.epoch_id)
                }
                contractPendingReward={pool.pendingReward}
                onSync={fetchData}
                syncInterval={30_000}
              />
            </div>
          )}

          {/* Actions */}
          {connected && (
            <div className="space-y-3">
              <div className="flex gap-3">
                {(!pool.stakerInfo ||
                  BigInt(pool.stakerInfo.staked_amount) === 0n ||
                  (pool.merkleRoot &&
                    BigInt(pool.stakerInfo.epoch_id) !==
                      BigInt(pool.merkleRoot.epoch_id))) && (
                  <button
                    onClick={() => handleStake(pool.index)}
                    disabled={txPending !== null}
                    className="rounded-lg bg-lmnr-600 px-5 py-2 text-sm font-semibold text-white hover:bg-lmnr-500 disabled:opacity-50 transition"
                  >
                    {txPending === `stake-${pool.index}`
                      ? "Staking..."
                      : "Stake"}
                  </button>
                )}

                {pool.pendingReward > 0n && (
                  <button
                    onClick={() => handleClaim(pool.index)}
                    disabled={txPending !== null}
                    className="rounded-lg bg-green-700 px-5 py-2 text-sm font-semibold text-white hover:bg-green-600 disabled:opacity-50 transition"
                  >
                    {txPending === `claim-${pool.index}`
                      ? "Claiming..."
                      : "Claim"}
                  </button>
                )}

                {pool.stakerInfo &&
                  BigInt(pool.stakerInfo.staked_amount) > 0n && (
                    <button
                      onClick={() => handleUnstake(pool.index)}
                      disabled={txPending !== null}
                      className="rounded-lg border border-gray-600 px-5 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50 transition"
                    >
                      {txPending === `unstake-${pool.index}`
                        ? "Unstaking..."
                        : "Unstake"}
                    </button>
                  )}
              </div>

              {/* Epoch countdown: shown when user has LP shares but isn't staked or is stale */}
              {userPoolBalances[pool.index] &&
                parseFloat(userPoolBalances[pool.index].lpShares) > 0 &&
                (!pool.stakerInfo ||
                  BigInt(pool.stakerInfo.staked_amount) === 0n ||
                  (pool.merkleRoot &&
                    BigInt(pool.stakerInfo.epoch_id) !==
                      BigInt(pool.merkleRoot.epoch_id))) && (
                  <EpochCountdown />
                )}

              {/* Add Liquidity panel */}
              {pool.poolId && pool.poolInfo && (
                <AddLiquidityPanel
                  poolId={pool.poolId}
                  poolInfo={pool.poolInfo}
                  userBalances={userPoolBalances[pool.index] ?? null}
                  txPending={txPending}
                  setTxPending={setTxPending}
                  setError={setError}
                  onSuccess={fetchData}
                />
              )}
            </div>
          )}

          {!connected && (
            <p className="text-sm text-gray-500">
              Connect your wallet to stake and earn LMNR rewards.
            </p>
          )}
        </div>
      ))}

      {pools.length === 0 && (
        <div className="rounded-xl border border-lmnr-700/30 bg-lmnr-900/40 p-8 text-center text-gray-400">
          No pools configured yet. The admin needs to add pools and post the
          first Merkle root.
        </div>
      )}
    </div>
  );
}
