import { NextResponse } from "next/server";
import { Horizon } from "@stellar/stellar-sdk";
import { getPoolConfig, HORIZON_URL } from "@/lib/constants";
import { processPool, snapshotPool } from "@/lib/indexer";

export const maxDuration = 60; // Vercel Pro: up to 60s

export async function GET(request: Request) {
  // Verify Vercel cron secret
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
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

  return NextResponse.json({
    message: "Indexer complete",
    ledger: currentLedger,
    results,
  });
}
