import Image from "next/image";
import { ConnectWallet } from "@/components/ConnectWallet";
import { StakingDashboard } from "@/components/StakingDashboard";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <div className="flex flex-col items-center sm:items-start">
          <Image
            src="/lumenaire-logo.webp"
            alt="Lumenaire"
            width={240}
            height={80}
            className="drop-shadow-[0_0_12px_rgba(0,220,180,0.3)]"
            priority
          />
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
