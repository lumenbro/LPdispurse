"use client";

import { useEffect, useState, useRef, useCallback } from "react";

const PRECISION = 1_000_000_000_000n; // 1e12 - matches contract

interface RewardsTickerProps {
  // Pool state
  accRewardPerShare: bigint;
  totalStaked: bigint;
  lastRewardTime: bigint;
  // Staker state
  stakedAmount: bigint;
  rewardDebt: bigint;
  pendingRewards: bigint;
  // Initial pending reward from contract (for fallback display)
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
  // Show more decimal places for the ticker effect
  const displayFrac = fracStr.slice(0, 4);
  return `${whole.toLocaleString()}.${displayFrac}`;
}

const STORAGE_KEY = "lmnr-reward-rate";

// Load cached reward rate from localStorage
function loadCachedRate(): bigint {
  if (typeof window === "undefined") return 0n;
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    return cached ? BigInt(cached) : 0n;
  } catch {
    return 0n;
  }
}

// Save reward rate to localStorage
function saveCachedRate(rate: bigint) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, rate.toString());
  } catch {
    // Ignore storage errors
  }
}

export function RewardsTicker({
  accRewardPerShare,
  totalStaked,
  lastRewardTime,
  stakedAmount,
  rewardDebt,
  pendingRewards,
  contractPendingReward,
  onSync,
  syncInterval = 30_000,
}: RewardsTickerProps) {
  const [displayReward, setDisplayReward] = useState<bigint>(contractPendingReward);
  const [isSyncing, setIsSyncing] = useState(false);
  const [derivedRewardRate, setDerivedRewardRate] = useState<bigint>(loadCachedRate);
  const lastSyncRef = useRef<number>(Date.now());

  // Track previous values to derive reward rate
  const prevStateRef = useRef<{
    accRewardPerShare: bigint;
    lastRewardTime: bigint;
    totalStaked: bigint;
  } | null>(null);

  // Derive reward rate from observed changes in acc_reward_per_share
  useEffect(() => {
    const prev = prevStateRef.current;

    if (prev && totalStaked > 0n) {
      const deltaAcc = accRewardPerShare - prev.accRewardPerShare;
      const deltaTime = lastRewardTime - prev.lastRewardTime;

      // Only calculate if there's been a meaningful change
      if (deltaAcc > 0n && deltaTime > 0n) {
        // reward_rate = (deltaAcc * totalStaked) / (deltaTime * PRECISION)
        const rate = (deltaAcc * totalStaked) / (deltaTime * PRECISION);
        if (rate > 0n) {
          setDerivedRewardRate(rate);
          saveCachedRate(rate);
          console.log(`[RewardsTicker] Derived reward rate: ${rate} stroops/sec (${Number(rate) * 86400 / 1e7} LMNR/day)`);
        }
      }
    }

    // Store current values for next comparison
    prevStateRef.current = {
      accRewardPerShare,
      lastRewardTime,
      totalStaked,
    };
  }, [accRewardPerShare, lastRewardTime, totalStaked]);

  // Can we do real-time simulation? Need derived rate and total staked
  const canSimulate = derivedRewardRate > 0n && totalStaked > 0n && stakedAmount > 0n;

  // Calculate pending reward at a given timestamp
  const calculateReward = useCallback(
    (nowSeconds: number): bigint => {
      // If we can't simulate, just return the last synced value
      if (!canSimulate) return contractPendingReward;

      let acc = accRewardPerShare;
      const lastTime = Number(lastRewardTime);

      if (nowSeconds > lastTime) {
        const elapsed = BigInt(nowSeconds - lastTime);
        const newRewards = elapsed * derivedRewardRate;
        acc += (newRewards * PRECISION) / totalStaked;
      }

      const accumulated = (stakedAmount * acc) / PRECISION;
      const pending = accumulated - rewardDebt;
      return pendingRewards + (pending > 0n ? pending : 0n);
    },
    [
      canSimulate,
      contractPendingReward,
      accRewardPerShare,
      totalStaked,
      lastRewardTime,
      derivedRewardRate,
      stakedAmount,
      rewardDebt,
      pendingRewards,
    ]
  );

  // Update display every second
  useEffect(() => {
    const update = () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      setDisplayReward(calculateReward(nowSeconds));
    };

    update(); // Initial calculation
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [calculateReward]);

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
      {!canSimulate && stakedAmount > 0n && (
        <div className="mt-1 text-xs text-gray-500">
          Syncs every {syncInterval / 1000}s
        </div>
      )}
    </div>
  );
}
