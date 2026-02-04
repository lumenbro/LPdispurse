import { ConnectWallet } from "@/components/ConnectWallet";
import { StakingDashboard } from "@/components/StakingDashboard";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">LMNR Staking</h1>
          <p className="mt-1 text-sm text-gray-400">
            Stake your SDEX LP positions and earn LMNR rewards
          </p>
        </div>
        <ConnectWallet />
      </div>

      {/* Dashboard */}
      <StakingDashboard />

      {/* Footer */}
      <footer className="mt-12 border-t border-lmnr-700/20 pt-6 text-center text-xs text-gray-500">
        <p>
          LMNR LP Staking &middot;{" "}
          <a
            href="https://lumenbro.com"
            className="text-lmnr-400 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            lumenbro.com
          </a>
        </p>
      </footer>
    </main>
  );
}
