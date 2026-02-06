"use client";

import { useEffect, useState, useRef } from "react";

export interface RewardsTickerProps {
  // Pool state (kept for potential future use)
  accRewardPerShare: bigint;
  totalStaked: bigint;
  lastRewardTime: bigint;
  // Staker state
  stakedAmount: bigint;
  rewardDebt: bigint;
  pendingRewards: bigint;
  // Whether this staker is in the current epoch (false = stale, rewards frozen)
  isCurrentEpoch: boolean;
  // Pending reward from contract view (simulate_acc_reward projected to current time)
  contractPendingReward: bigint;
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

const STORAGE_KEY = "lmnr-user-rate-v3";

function loadCachedRate(): bigint {
  if (typeof window === "undefined") return 0n;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    return cached ? BigInt(cached) : 0n;
  } catch {
    return 0n;
  }
}

function saveCachedRate(rate: bigint) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, rate.toString());
  } catch {
    // Ignore storage errors
  }
}

export function RewardsTicker({
  stakedAmount,
  isCurrentEpoch,
  contractPendingReward,
  onSync,
  syncInterval = 30_000,
}: RewardsTickerProps) {
  const [displayReward, setDisplayReward] = useState<bigint>(contractPendingReward);
  const [isSyncing, setIsSyncing] = useState(false);
  // Per-user reward rate in stroops/sec (derived from contractPendingReward deltas)
  const [userRate, setUserRate] = useState<bigint>(loadCachedRate);
  const lastSyncRef = useRef<number>(Date.now());

  // Track previous contractPendingReward to derive per-user rate
  const prevPendingRef = useRef<{ value: bigint; time: number } | null>(null);
  // Timestamp of last sync for extrapolation
  const lastSyncTimeRef = useRef<number>(Date.now() / 1000);

  // Derive per-user reward rate from contractPendingReward deltas between syncs
  useEffect(() => {
    if (!isCurrentEpoch || contractPendingReward <= 0n) {
      prevPendingRef.current = null;
      return;
    }

    const now = Date.now() / 1000;
    lastSyncTimeRef.current = now;

    const prev = prevPendingRef.current;
    if (prev && contractPendingReward > prev.value) {
      const deltaReward = contractPendingReward - prev.value;
      const deltaTime = now - prev.time;

      if (deltaTime > 5) {
        const rate = deltaReward / BigInt(Math.round(deltaTime));
        if (rate > 0n) {
          setUserRate(rate);
          saveCachedRate(rate);
          console.log(
            `[RewardsTicker] Derived user rate: ${rate} stroops/sec (${(Number(rate) * 86400 / 1e7).toFixed(2)} LMNR/day)`
          );
        }
      }
    }

    prevPendingRef.current = { value: contractPendingReward, time: now };
  }, [contractPendingReward, isCurrentEpoch]);

  const canSimulate = userRate > 0n && stakedAmount > 0n && isCurrentEpoch;

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
