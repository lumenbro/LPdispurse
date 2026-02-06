"use client";

import { useState } from "react";
import {
  Horizon,
  TransactionBuilder,
  Operation,
  LiquidityPoolAsset,
  BASE_FEE,
  getLiquidityPoolId,
  LiquidityPoolFeeV18,
} from "@stellar/stellar-sdk";
import { useWallet } from "./WalletProvider";
import { HORIZON_URL, NETWORK_PASSPHRASE } from "@/lib/constants";
import type { PoolReserveInfo, UserPoolBalances } from "@/lib/horizon";

interface Props {
  poolId: string;
  poolInfo: PoolReserveInfo;
  userBalances: UserPoolBalances | null;
  txPending: string | null;
  setTxPending: (v: string | null) => void;
  setError: (v: string | null) => void;
  onSuccess: () => void;
}

const SLIPPAGE_OPTIONS = [
  { label: "0.5%", value: 0.005 },
  { label: "1%", value: 0.01 },
  { label: "2%", value: 0.02 },
];

export function AddLiquidityPanel({
  poolId,
  poolInfo,
  userBalances,
  txPending,
  setTxPending,
  setError,
  onSuccess,
}: Props) {
  const { publicKey, signTransaction } = useWallet();
  const [open, setOpen] = useState(false);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [slippage, setSlippage] = useState(0.01);
  const [success, setSuccess] = useState<string | null>(null);

  const ratio =
    parseFloat(poolInfo.reserveA) > 0
      ? parseFloat(poolInfo.reserveB) / parseFloat(poolInfo.reserveA)
      : 0;

  const handleAmountAChange = (val: string) => {
    setAmountA(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && ratio > 0) {
      setAmountB((num * ratio).toFixed(7));
    } else {
      setAmountB("");
    }
  };

  const handleAmountBChange = (val: string) => {
    setAmountB(val);
    const num = parseFloat(val);
    if (!isNaN(num) && num > 0 && ratio > 0) {
      setAmountA((num / ratio).toFixed(7));
    } else {
      setAmountA("");
    }
  };

  const handleSubmit = async () => {
    if (!publicKey || !signTransaction) return;
    const numA = parseFloat(amountA);
    const numB = parseFloat(amountB);
    if (isNaN(numA) || numA <= 0 || isNaN(numB) || numB <= 0) {
      setError("Enter valid amounts for both assets.");
      return;
    }

    setTxPending("add-liquidity");
    setError(null);
    setSuccess(null);

    try {
      const server = new Horizon.Server(HORIZON_URL);
      const account = await server.loadAccount(publicKey);

      const lpAsset = new LiquidityPoolAsset(
        poolInfo.assetA.asset,
        poolInfo.assetB.asset,
        LiquidityPoolFeeV18
      );

      const builder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      });

      // If no LP trustline, add changeTrust first
      if (!userBalances?.hasLpTrustline) {
        builder.addOperation(
          Operation.changeTrust({ asset: lpAsset })
        );
      }

      // Compute min/max price from current ratio +/- slippage
      const currentPrice = ratio; // B per A
      const minPrice = { n: Math.round(currentPrice * (1 - slippage) * 1e7), d: 1e7 };
      const maxPrice = { n: Math.round(currentPrice * (1 + slippage) * 1e7), d: 1e7 };

      builder.addOperation(
        Operation.liquidityPoolDeposit({
          liquidityPoolId: poolId,
          maxAmountA: numA.toFixed(7),
          maxAmountB: numB.toFixed(7),
          minPrice,
          maxPrice,
        })
      );

      const tx = builder.setTimeout(60).build();
      const xdr = tx.toXDR();

      // Sign via wallet kit (omit networkPassphrase due to xBull bug)
      const { signedTxXdr } = await signTransaction(xdr);

      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        NETWORK_PASSPHRASE
      );
      const result = await server.submitTransaction(signedTx);
      console.log("[AddLiquidity] success:", result);

      setAmountA("");
      setAmountB("");
      setSuccess("Liquidity added successfully!");
      onSuccess();
    } catch (err: any) {
      console.error("[AddLiquidity] FAILED:", err);
      // Try to surface Horizon operation error codes
      const opCodes =
        err?.response?.data?.extras?.result_codes?.operations;
      if (opCodes) {
        setError(`Deposit failed: ${opCodes.join(", ")}`);
      } else {
        setError(err?.message || "Deposit failed");
      }
    } finally {
      setTxPending(null);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-3 rounded-lg border border-lmnr-600/40 px-4 py-2 text-sm text-lmnr-300 hover:bg-lmnr-600/10 transition"
      >
        + Add Liquidity
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-lmnr-700/30 bg-lmnr-900/60 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-white">Add Liquidity</h4>
        <button
          onClick={() => setOpen(false)}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Close
        </button>
      </div>

      {/* Pool reserves */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="text-gray-400">Pool {poolInfo.assetA.code}</span>
          <p className="font-mono text-gray-200">
            {parseFloat(poolInfo.reserveA).toLocaleString()}
          </p>
        </div>
        <div>
          <span className="text-gray-400">Pool {poolInfo.assetB.code}</span>
          <p className="font-mono text-gray-200">
            {parseFloat(poolInfo.reserveB).toLocaleString()}
          </p>
        </div>
      </div>

      {/* User balances */}
      {userBalances && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-gray-400">
              Your {poolInfo.assetA.code}
            </span>
            <p className="font-mono text-gray-200">
              {parseFloat(userBalances.balanceA).toLocaleString()}
            </p>
          </div>
          <div>
            <span className="text-gray-400">
              Your {poolInfo.assetB.code}
            </span>
            <p className="font-mono text-gray-200">
              {parseFloat(userBalances.balanceB).toLocaleString()}
            </p>
          </div>
        </div>
      )}

      {/* Trustline notice */}
      {userBalances && !userBalances.hasLpTrustline && (
        <div className="rounded border border-yellow-800/30 bg-yellow-900/10 px-3 py-2 text-xs text-yellow-200">
          No LP trustline — it will be added automatically in the transaction.
        </div>
      )}

      {/* Amount inputs */}
      <div className="space-y-2">
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {poolInfo.assetA.code} amount
          </label>
          <input
            type="number"
            value={amountA}
            onChange={(e) => handleAmountAChange(e.target.value)}
            placeholder="0.0"
            min="0"
            step="any"
            className="w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/80 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-400">
            {poolInfo.assetB.code} amount
          </label>
          <input
            type="number"
            value={amountB}
            onChange={(e) => handleAmountBChange(e.target.value)}
            placeholder="0.0"
            min="0"
            step="any"
            className="w-full rounded-lg border border-lmnr-700/30 bg-lmnr-900/80 px-3 py-2 font-mono text-sm text-white placeholder-gray-500 focus:border-lmnr-400 focus:outline-none"
          />
        </div>
      </div>

      {/* Slippage selector */}
      <div>
        <span className="mb-1 block text-xs text-gray-400">
          Slippage tolerance
        </span>
        <div className="flex gap-2">
          {SLIPPAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSlippage(opt.value)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                slippage === opt.value
                  ? "bg-lmnr-600 text-white"
                  : "border border-lmnr-700/30 text-gray-400 hover:text-white"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-500">
        After adding liquidity, your LP shares will be detected in the next
        hourly epoch scan.
      </p>

      {success && (
        <div className="rounded-lg border border-green-800/40 bg-green-900/20 px-3 py-2 text-xs text-green-300">
          {success}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={txPending !== null || !amountA || !amountB}
        className="w-full rounded-lg bg-lmnr-600 py-2 text-sm font-semibold text-white hover:bg-lmnr-500 disabled:opacity-50 transition"
      >
        {txPending === "add-liquidity" ? "Depositing..." : "Deposit Liquidity"}
      </button>
    </div>
  );
}
