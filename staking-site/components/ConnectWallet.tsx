"use client";

import { useWallet } from "./WalletProvider";

export function ConnectWallet() {
  const { publicKey, connected, connecting, connect, disconnect } = useWallet();

  if (connected && publicKey) {
    const short = `${publicKey.slice(0, 4)}...${publicKey.slice(-4)}`;
    return (
      <div className="flex items-center gap-3">
        <span className="rounded-lg bg-lmnr-900/60 px-3 py-1.5 text-sm font-mono text-lmnr-200">
          {short}
        </span>
        <button
          onClick={disconnect}
          className="rounded-lg bg-red-900/40 px-3 py-1.5 text-sm text-red-300 hover:bg-red-900/60 transition"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={connect}
      disabled={connecting}
      className="rounded-lg bg-lmnr-600 px-5 py-2 text-sm font-semibold text-white hover:bg-lmnr-500 disabled:opacity-50 transition"
    >
      {connecting ? "Connecting..." : "Connect Wallet"}
    </button>
  );
}
