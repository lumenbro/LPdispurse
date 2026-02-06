"use client";

import { useEffect, useState, useRef } from "react";

export interface RewardsTickerProps {
  // Pool state
  totalStaked: bigint;
  // Staker state
  stakedAmount: bigint;
  // Whether this staker is in the current epoch (false = stale, rewards frozen)
  isCurrentEpoch: boolean;
  // Pending reward from contract view (simulate_acc_reward projected to current time)
  contractPendingReward: bigint;
  // Global reward rate from contract (stroops/sec) — 0 if not yet fetched
  rewardRate: bigint;
  // Sync callback - called periodically to refresh from contract
  onSync?: () => Promise<void>;
  // Sync interval in ms (default 30s)
  syncInterval?: number;
}

function formatLmnr(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = stroops % 10_000_000n;
  const fracStr = frac.toString().padStart(7, "0");
  const displayFrac = fracStr.slice(0, 4);
  return `${whole.toLocaleString()}.${displayFrac}`;
}

export function RewardsTicker({
  totalStaked,
  stakedAmount,
  isCurrentEpoch,
  contractPendingReward,
  rewardRate,
  onSync,
  syncInterval = 30_000,
}: RewardsTickerProps) {
  const [displayReward, setDisplayReward] = useState<bigint>(contractPendingReward);
  const [isSyncing, setIsSyncing] = useState(false);
  const lastSyncRef = useRef<number>(Date.now());
  const lastSyncTimeRef = useRef<number>(Date.now() / 1000);

  // Compute exact per-user rate from contract values
  // userRate = globalRate * stakedAmount / totalStaked
  const userRate =
    rewardRate > 0n && totalStaked > 0n && stakedAmount > 0n
      ? (rewardRate * stakedAmount) / totalStaked
      : 0n;

  const canSimulate = userRate > 0n && isCurrentEpoch;

  // Record sync time when contractPendingReward changes
  useEffect(() => {
    lastSyncTimeRef.current = Date.now() / 1000;
  }, [contractPendingReward]);

  // Update display every second
  useEffect(() => {
    const update = () => {
      if (!canSimulate) {
        setDisplayReward(contractPendingReward);
        return;
      }

      const now = Date.now() / 1000;
      const elapsed = BigInt(Math.max(0, Math.round(now - lastSyncTimeRef.current)));
      setDisplayReward(contractPendingReward + userRate * elapsed);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [canSimulate, contractPendingReward, userRate]);

  // Periodic sync with contract
  useEffect(() => {
    if (!onSync) return;

    const sync = async () => {
      const now = Date.now();
      if (now - lastSyncRef.current < syncInterval) return;

      setIsSyncing(true);
      try {
        await onSync();
        lastSyncRef.current = now;
      } finally {
        setIsSyncing(false);
      }
    };

    const interval = setInterval(sync, syncInterval);
    return () => clearInterval(interval);
  }, [onSync, syncInterval]);

  // Don't show ticker if not staked or no rewards
  if (stakedAmount <= 0n && contractPendingReward <= 0n) {
    return null;
  }

  return (
    <div className="rounded-lg bg-gradient-to-r from-lmnr-700/30 to-green-900/30 px-4 py-3 border border-lmnr-600/20">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">Pending Rewards</span>
        <div className="flex items-center gap-2">
          {isSyncing && (
            <span className="text-xs text-lmnr-400 animate-pulse">syncing...</span>
          )}
          {canSimulate && (
            <span className="text-xs text-green-500/60">live</span>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-2xl font-bold font-mono text-green-400 tabular-nums">
          {formatLmnr(displayReward)}
        </span>
        <span className="text-lg text-green-400/70">LMNR</span>
      </div>
      {canSimulate && (
        <div className="mt-1 flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
          </span>
          <span className="text-xs text-green-400/60">Earning rewards</span>
        </div>
      )}
      {!isCurrentEpoch && stakedAmount > 0n && (
        <div className="mt-1 text-xs text-yellow-400/80">
          Rewards paused — will resume after next epoch scan
        </div>
      )}
      {isCurrentEpoch && !canSimulate && stakedAmount > 0n && (
        <div className="mt-1 text-xs text-gray-500">
          Syncs every {syncInterval / 1000}s
        </div>
      )}
    </div>
  );
}
