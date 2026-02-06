import { NextResponse } from "next/server";
import { Horizon } from "@stellar/stellar-sdk";
import { getPoolConfig, HORIZON_URL } from "@/lib/constants";
import { processPool, snapshotPool } from "@/lib/indexer";

export const maxDuration = 60; // Vercel Pro: up to 60s

// Helper to convert BigInts to strings for JSON serialization
function jsonSafe<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_, value) =>
      typeof value === "bigint" ? value.toString() : value
    )
  );
}

export async function GET(request: Request) {
  // Verify Vercel cron secret or admin wallet
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const adminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET;
  const token = authHeader?.replace("Bearer ", "");

  if (token !== cronSecret && token !== adminWallet) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pools = getPoolConfig();
  if (pools.length === 0) {
    return NextResponse.json({ message: "No pools configured" });
  }

  // Get current ledger sequence from Horizon
  const server = new Horizon.Server(HORIZON_URL);
  const ledgerPage = await server.ledgers().order("desc").limit(1).call();
  const currentLedger = ledgerPage.records[0].sequence;

  const results = [];

  for (const pool of pools) {
    try {
      console.log(`Indexing pool ${pool.index} (${pool.poolId})...`);
      const holders = await snapshotPool(pool.poolId);

      const result = await processPool({
        poolIndex: pool.index,
        poolId: pool.poolId,
        holders,
        ledger: currentLedger,
      });

      results.push({ pool: pool.index, ...result });
    } catch (error) {
      console.error(`Error processing pool ${pool.index}:`, error);
      results.push({
        pool: pool.index,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return NextResponse.json(
    jsonSafe({
      message: "Indexer complete",
      ledger: currentLedger,
      results,
    })
  );
}
