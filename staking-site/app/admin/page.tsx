import { ConnectWallet } from "@/components/ConnectWallet";
import { AdminDashboard } from "@/components/AdminDashboard";

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">LMNR Admin</h1>
          <p className="mt-1 text-sm text-gray-400">
            Manage pools, rewards, and contract state
          </p>
        </div>
        <ConnectWallet />
      </div>

      <AdminDashboard />
    </main>
  );
}
