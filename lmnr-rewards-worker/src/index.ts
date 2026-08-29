import { Keypair } from "@stellar/stellar-sdk";
import {
  fromStroops,
  isDryRun,
  poolIds,
  toStroops,
  type Env,
} from "./config";
import { getPoolHolders } from "./horizon";
import {
  complete,
  getRun,
  periodKey,
  reserve,
  skip,
  txSucceeded,
} from "./ledger";
import {
  budgetForPeriod,
  buildPaymentTx,
  chunk,
  computePayouts,
} from "./payout";
import { MAX_OPS_PER_TX } from "./config";

interface PoolResult {
  pool: string;
  holders: number;
  paid: string;
  recipients: number;
  txHash?: string;
  status: string;
  note?: string;
}

async function runPool(
  env: Env,
  poolId: string,
  hourly: boolean,
  now: Date
): Promise<PoolResult> {
  const short = poolId.slice(0, 8);
  const key = periodKey(poolId, now, hourly);

  // --- Idempotency: has this period already been handled? ---
  const prior = await getRun(env, key);
  if (prior?.status === "done" || prior?.status === "skipped") {
    return {
      pool: short,
      holders: 0,
      paid: "0",
      recipients: 0,
      status: "already-handled",
      note: prior.status,
    };
  }
  if (prior?.status === "pending") {
    // A previous run died between reserving and confirming. Resolve it against
    // the chain rather than blindly resubmitting -- that is the double-pay path.
    if (await txSucceeded(env, prior.txHash)) {
      await complete(env, key, prior.txHash, "unknown");
      return {
        pool: short,
        holders: 0,
        paid: "unknown",
        recipients: 0,
        txHash: prior.txHash,
        status: "recovered-already-paid",
      };
    }
    // Not on chain -- safe to retry below.
  }

  const dry = isDryRun(env);

  const holders = await getPoolHolders(env, poolId);
  if (holders.length === 0) {
    // Never write the ledger during a dry run: marking the period "handled"
    // would make the real run skip it.
    if (!dry) await skip(env, key, "no holders");
    return { pool: short, holders: 0, paid: "0", recipients: 0, status: "no-holders" };
  }

  const budget = budgetForPeriod(env, hourly);
  const { payouts, skippedNoTrustline, dust } = computePayouts(
    holders,
    budget,
    toStroops(env.MIN_PAYOUT)
  );

  if (payouts.length === 0) {
    if (!dry) await skip(env, key, "no eligible payouts");
    return {
      pool: short,
      holders: holders.length,
      paid: "0",
      recipients: 0,
      status: "nothing-to-pay",
      note: skippedNoTrustline.length
        ? `${skippedNoTrustline.length} lack trustline`
        : "all below MIN_PAYOUT",
    };
  }

  const total = payouts.reduce((a, p) => a + p.stroops, 0n);

  if (dry) {
    console.log(
      `[DRY RUN] pool ${short}: would pay ${fromStroops(total)} ` +
        `${env.REWARD_ASSET_CODE} to ${payouts.length} holders ` +
        `(dust ${fromStroops(dust)}, ${skippedNoTrustline.length} no-trustline)`
    );
    for (const p of payouts) {
      console.log(`    ${p.address} <- ${fromStroops(p.stroops)}`);
    }
    return {
      pool: short,
      holders: holders.length,
      paid: fromStroops(total),
      recipients: payouts.length,
      status: "dry-run",
    };
  }

  if (!env.DISBURSER_SECRET) {
    throw new Error("DISBURSER_SECRET not set (wrangler secret put DISBURSER_SECRET)");
  }
  const keypair = Keypair.fromSecret(env.DISBURSER_SECRET);

  // With <=100 holders this is a single transaction; chunking is here so the
  // bot keeps working if the pool ever grows.
  const batches = chunk(payouts, MAX_OPS_PER_TX);
  if (batches.length > 1) {
    console.warn(
      `pool ${short}: ${payouts.length} recipients needs ${batches.length} txs`
    );
  }

  let lastHash = "";
  let paidTotal = 0n;
  for (const batch of batches) {
    const { tx, server } = await buildPaymentTx(env, keypair, batch);
    const hash = tx.hash().toString("hex");

    // Record the hash BEFORE submitting, so a crash mid-submit is recoverable.
    await reserve(env, key, hash);
    await server.submitTransaction(tx);

    lastHash = hash;
    paidTotal += batch.reduce((a, p) => a + p.stroops, 0n);
  }

  await complete(env, key, lastHash, fromStroops(paidTotal));
  console.log(
    `pool ${short}: paid ${fromStroops(paidTotal)} to ${payouts.length} holders (${lastHash})`
  );

  return {
    pool: short,
    holders: holders.length,
    paid: fromStroops(paidTotal),
    recipients: payouts.length,
    txHash: lastHash,
    status: "paid",
  };
}

async function runAll(env: Env, hourly: boolean) {
  const now = new Date();
  const results: PoolResult[] = [];
  for (const poolId of poolIds(env)) {
    try {
      results.push(await runPool(env, poolId, hourly, now));
    } catch (err: any) {
      // One bad pool must not abort the others.
      console.error(`pool ${poolId.slice(0, 8)} failed: ${err?.message ?? err}`);
      results.push({
        pool: poolId.slice(0, 8),
        holders: 0,
        paid: "0",
        recipients: 0,
        status: "error",
        note: String(err?.message ?? err),
      });
    }
  }
  return results;
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const hourly = event.cron !== "0 0 * * *";
    ctx.waitUntil(
      runAll(env, hourly).then((r) =>
        console.log("run complete:", JSON.stringify(r))
      )
    );
  },

  /**
   * Manual trigger + status endpoint.
   *   GET /run?dry=1   force a dry run regardless of the DRY_RUN var
   *   GET /            config summary (never exposes the secret)
   */
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/run") {
      const forceDry = url.searchParams.get("dry") === "1";
      const effEnv = forceDry ? { ...env, DRY_RUN: "true" } : env;
      const hourly = url.searchParams.get("daily") !== "1";
      const results = await runAll(effEnv as Env, hourly);
      return Response.json({ ok: true, dryRun: isDryRun(effEnv as Env), results });
    }

    return Response.json({
      worker: "lmnr-rewards",
      network: env.NETWORK,
      asset: `${env.REWARD_ASSET_CODE}:${env.REWARD_ASSET_ISSUER.slice(0, 8)}...`,
      pools: poolIds(env).map((p) => p.slice(0, 8)),
      dailyRewardPerPool: env.DAILY_REWARD_PER_POOL,
      minPayout: env.MIN_PAYOUT,
      dryRun: isDryRun(env),
      disburserConfigured: Boolean(env.DISBURSER_SECRET),
    });
  },
};
