import { Keypair } from "@stellar/stellar-sdk";
import { fromStroops, isDryRun, toStroops, type Env } from "./config";
import { getPoolHolders } from "./horizon";
import {
  complete,
  getPaidThroughAt,
  getRun,
  instanceKey,
  legacyPeriodKeys,
  periodEnd,
  periodKey,
  skip,
  txSucceeded,
  type PendingRun,
} from "./ledger";
import {
  budgetForCadence,
  cadenceDue,
  paidThroughAfter,
  cadenceLabel,
  humanDuration,
  normalizeCadence,
  paymentsPerDay,
  type Cadence,
} from "./cadence";
import { buildPaymentTx, chunk, computePayouts } from "./payout";
import { MAX_OPS_PER_TX, fromStroops as fs } from "./config";
import { Keypair as KP } from "@stellar/stellar-sdk";
import { adminPage } from "./admin-ui";
import { checkAdmin, denied } from "./auth";
import { discoverPools } from "./discover";
import { PayoutLock, lockFor } from "./lock";

// Re-exported so the Durable Object binding in wrangler.toml can find the class.
export { PayoutLock };
import {
  loadInstances,
  loadSettings,
  saveInstances,
  saveSettings,
  validateInstances,
  type RewardInstance,
} from "./store";

interface PoolResult {
  pool: string;
  cadence: Cadence;
  holders: number;
  paid: string;
  recipients: number;
  txHash?: string;
  status: string;
  note?: string;
}

async function runPool(
  env: Env,
  inst: RewardInstance,
  now: Date,
  mode: "linear" | "sqrt" = "linear"
): Promise<PoolResult> {
  const poolId = inst.poolId;
  const short = inst.poolName || poolId.slice(0, 8);
  const cadence = normalizeCadence(inst.cadence);
  const asset = { code: inst.rewardAssetCode, issuer: inst.rewardAssetIssuer };
  const ik = instanceKey(poolId, asset.code, asset.issuer);
  const key = periodKey(ik, now, cadence);

  // Computed FIRST. Every write below is gated on it -- including the ones on
  // the recovery path, which previously ran before this was evaluated at all
  // and let a dry run mutate the ledger.
  const dry = isDryRun(env);
  const res = (extra: Partial<PoolResult>): PoolResult => ({
    pool: short,
    cadence,
    holders: 0,
    paid: "0",
    recipients: 0,
    status: "unknown",
    ...extra,
  });

  const lock = lockFor(env.PAYOUT_LOCK, ik);

  // Migration seed: state written before the lock existed. Only ever applied
  // when the lock has no coverage of its own, and only ever moves it forward.
  const seedCoverageTo = await legacyCoverage(env, ik, poolId, asset.code, now, cadence);

  const begin = await lock.begin({
    now: now.getTime(),
    cadence,
    seedCoverageTo,
    dry,
  });

  if (begin.action === "busy") {
    // Another invocation holds the lease. This is the race the lock exists for:
    // previously both would have read "not paid yet" from KV and both paid.
    return res({
      status: "locked",
      note: `another run is in progress until ${new Date(begin.expiresAt).toISOString()}`,
    });
  }

  if (begin.action === "wait") {
    return res({
      status: "cadence-wait",
      note: `${humanDuration(begin.waitMs)} until the next ${cadenceLabel(cadence).toLowerCase()} payment`,
    });
  }

  if (begin.action === "attempted") {
    return res({ status: "already-handled", note: "nothing to pay this period" });
  }

  if (begin.action === "needs-attention") {
    return res({
      status: "needs-attention",
      note: `a partial payout of ${begin.pending.totalBatches} transactions is unresolved; reconcile manually`,
    });
  }

  if (begin.action === "resolve") {
    // A payout was built and we do not know whether it landed. Resolved here,
    // outside the lock's own execution, because it means talking to Horizon.
    const pending = begin.pending;
    const landed = await Promise.all(
      pending.batches.map((b) => txSucceeded(env, b.txHash))
    );
    const allLanded =
      landed.length === pending.totalBatches && landed.every(Boolean);
    const anyLanded = landed.some(Boolean);
    const lastHash = pending.batches.at(-1)!.txHash;

    if (dry) {
      await lock.commit(begin.token, { kind: "abandoned" });
      return res({
        status: allLanded ? "recovered-already-paid" : "would-retry",
        txHash: lastHash,
        note: "dry run: not recorded",
      });
    }

    if (allLanded) {
      // Coverage as fixed when the payout was BUILT. Using the recovery time
      // would shift the funded window forward by the length of the outage and
      // leave that stretch unpaid by anyone.
      await lock.commit(begin.token, {
        kind: "resolved-paid",
        coverageTo: pending.coverageTo,
      });
      await complete(env, pending.periodKey, lastHash, "unknown");
      return res({
        status: "recovered-already-paid",
        paid: "unknown",
        txHash: lastHash,
      });
    }

    if (!anyLanded) {
      await lock.commit(begin.token, { kind: "resolved-failed" });
      return res({ status: "retrying", note: "previous payout never landed" });
    }

    // Some landed, some did not. Batch membership is not reproducible -- the
    // holder set moves between runs -- so there is no honest way to work out
    // what is still owed. Fail CLOSED rather than risk paying someone twice.
    console.error(
      `pool ${short}: partial payout, ${landed.filter(Boolean).length}/${pending.totalBatches} landed`
    );
    await lock.commit(begin.token, { kind: "needs-attention" });
    return res({
      status: "needs-attention",
      note:
        `${landed.filter(Boolean).length} of ${pending.totalBatches} transactions landed; ` +
        `reconcile manually before this pool pays again`,
    });
  }

  // begin.action === "pay": we hold the lease.
  const { token, coverageTo } = begin;

  try {
    const holders = await getPoolHolders(env, poolId, asset);
    if (holders.length === 0) {
      if (!dry) {
        await lock.commit(token, { kind: "skipped", until: periodEnd(now, cadence) });
        await skip(env, key, "no holders");
      }
      return res({ status: "no-holders" });
    }

    // Per-instance config from KV (set in the admin page), not global vars.
    const budget = budgetForCadence(toStroops(inst.dailyAmount), cadence);
    const { payouts, skippedNoTrustline, dust } = computePayouts(
      holders,
      budget,
      toStroops(inst.minPayment),
      mode
    );

    if (payouts.length === 0) {
      if (!dry) {
        await lock.commit(token, { kind: "skipped", until: periodEnd(now, cadence) });
        await skip(env, key, "no eligible payouts");
      }
      return res({
        holders: holders.length,
        status: "nothing-to-pay",
        note: skippedNoTrustline.length
          ? `${skippedNoTrustline.length} lack trustline`
          : "every share is below the minimum payment for this cadence",
      });
    }

    const total = payouts.reduce((a, p) => a + p.stroops, 0n);

    if (dry) {
      console.log(
        `[DRY RUN] pool ${short}: would pay ${fromStroops(total)} ` +
          `${asset.code || "XLM"} to ${payouts.length} holders ` +
          `(dust ${fromStroops(dust)}, ${skippedNoTrustline.length} no-trustline)`
      );
      for (const p of payouts) {
        console.log(`    ${p.address} <- ${fromStroops(p.stroops)}`);
      }
      return res({
        holders: holders.length,
        paid: fromStroops(total),
        recipients: payouts.length,
        status: "dry-run",
      });
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

    const record: PendingRun = {
      periodKey: key,
      cadence,
      coverageFrom: begin.coverageFrom,
      coverageTo,
      batches: [],
      totalBatches: batches.length,
      at: now.toISOString(),
    };

    let paidTotal = 0n;
    for (const [i, batch] of batches.entries()) {
      const { tx, server } = await buildPaymentTx(env, keypair, batch, asset, inst.memo);
      const hash = tx.hash().toString("hex");

      // Recorded BEFORE submitting, so a crash mid-submit is recoverable. Each
      // batch is appended rather than overwriting, so a partial multi-batch
      // payout is detectable instead of looking like a single failed attempt.
      record.batches.push({ index: i, txHash: hash });
      await lock.commit(token, { kind: "pending", pending: { ...record } });
      await server.submitTransaction(tx);

      paidTotal += batch.reduce((a, p) => a + p.stroops, 0n);
    }

    const lastHash = record.batches.at(-1)!.txHash;
    await lock.commit(token, { kind: "paid", coverageTo });
    // KV is the AUDIT trail from here on, not the authority. If the two ever
    // disagree, the lock is right.
    await complete(env, key, lastHash, fromStroops(paidTotal));
    console.log(
      `pool ${short} (${cadence}): paid ${fromStroops(paidTotal)} to ${payouts.length} holders (${lastHash})`
    );

    return res({
      holders: holders.length,
      paid: fromStroops(paidTotal),
      recipients: payouts.length,
      txHash: lastHash,
      status: "paid",
    });
  } catch (err) {
    // Release the lease on a failure that happened BEFORE anything was built,
    // so a transient Horizon error does not lock the pool out for five minutes.
    // Once a pending record exists the lease is left alone: the payout may be
    // in flight and only the resolve path may decide its fate.
    if (!dry) {
      const st = await lock.snapshot().catch(() => null);
      if (!st?.pending) {
        await lock.commit(token, { kind: "abandoned" }).catch(() => {});
      }
    }
    throw err;
  }
}

/**
 * Coverage implied by records written before the lock existed.
 *
 * Reads, in order of preference, the KV coverage record written by the previous
 * version, then any calendar record for this period under the current or older
 * key shapes. A calendar record means the period was handled, so it was funded
 *至 the end of that period.
 */
async function legacyCoverage(
  env: Env,
  ik: string,
  poolId: string,
  assetCode: string,
  now: Date,
  cadence: Cadence
): Promise<number | null> {
  const stored = await getPaidThroughAt(env, ik);
  if (stored !== null) return stored;

  const keys = [
    periodKey(ik, now, cadence),
    ...legacyPeriodKeys(poolId, assetCode, now, cadence),
  ];
  for (const k of keys) {
    if (await getRun(env, k)) return periodEnd(now, cadence);
  }
  return null;
}

async function runAll(env: Env) {
  const now = new Date();
  const results: PoolResult[] = [];
  const instances = (await loadInstances(env)).filter((i) => i.enabled);
  const { weightMode } = await loadSettings(env);
  for (const inst of instances) {
    try {
      results.push(await runPool(env, inst, now, weightMode));
    } catch (err: any) {
      // One bad pool must not abort the others.
      console.error(`pool ${inst.poolName} failed: ${err?.message ?? err}`);
      results.push({
        pool: inst.poolName,
        cadence: normalizeCadence(inst.cadence),
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

/** Balances, burn rate and runway for the disbursement wallet. */
async function walletStatus(env: Env) {
  if (!env.DISBURSER_SECRET) {
    return { ok: false, reason: "DISBURSER_SECRET is not set" };
  }
  const address = KP.fromSecret(env.DISBURSER_SECRET).publicKey();
  const res = await fetch(`${env.HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) {
    return { ok: false, reason: `account ${address} is not funded yet`, address };
  }
  if (!res.ok) return { ok: false, reason: `Horizon ${res.status}` };
  const acct: any = await res.json();

  const bal = (code: string, issuer?: string) => {
    const b = acct.balances?.find((x: any) =>
      code === "XLM"
        ? x.asset_type === "native"
        : x.asset_code === code && (!issuer || x.asset_issuer === issuer)
    );
    return b ? Number(b.balance) : 0;
  };

  const instances = (await loadInstances(env)).filter((i) => i.enabled);
  const rewardPerDay = instances.reduce((a, i) => a + Number(i.dailyAmount), 0);

  // Base reserve (1 XLM) + 0.5 per subentry is locked and cannot pay fees.
  const reserved = 1 + 0.5 * Number(acct.subentry_count ?? 0);
  const xlmBal = bal("XLM");
  const spendable = Math.max(0, xlmBal - reserved);
  // Fee model matches buildPaymentTx: base 100 stroops x ops x 10, where ops is
  // the recipient count (assumed ~10) and a pool is charged once per PAYMENT.
  // A daily pool therefore costs 1/24 of an hourly one in fees -- which is the
  // second reason to move a small pool off hourly, after clearing minPayment.
  const feeStroopsPerDay = instances.reduce(
    (a, i) => a + 100 * 10 * 10 * paymentsPerDay(normalizeCadence(i.cadence)),
    0
  );
  const xlmPerDay = Math.max(feeStroopsPerDay, 1000) / 1e7;

  const rewardBal = bal(env.REWARD_ASSET_CODE, env.REWARD_ASSET_ISSUER);
  const warnings: string[] = [];
  const rewardDays = rewardPerDay > 0 ? rewardBal / rewardPerDay : null;
  const xlmDays = xlmPerDay > 0 ? spendable / xlmPerDay : null;

  if (rewardBal === 0 && rewardPerDay > 0) {
    warnings.push(`No ${env.REWARD_ASSET_CODE} balance - runs will pay nothing.`);
  } else if (rewardDays !== null && rewardDays < 3) {
    warnings.push(`Less than 3 days of ${env.REWARD_ASSET_CODE} left.`);
  }
  if (xlmDays !== null && xlmDays < 10) {
    warnings.push("Low XLM for fees - the cron fails silently when it runs out.");
  }
  if (!acct.balances?.some((x: any) => x.asset_code === env.REWARD_ASSET_CODE)) {
    warnings.push(`No ${env.REWARD_ASSET_CODE} trustline on the wallet.`);
  }

  return {
    ok: true,
    address,
    reward: {
      balance: rewardBal.toFixed(7),
      perDay: rewardPerDay.toFixed(7),
      days: rewardDays,
    },
    xlm: {
      balance: xlmBal.toFixed(7),
      reserved: reserved.toFixed(1),
      perDay: xlmPerDay.toFixed(7),
      days: xlmDays,
    },
    suggestedTopUp:
      rewardPerDay > 0
        ? Math.max(0, rewardPerDay * 30 - rewardBal).toFixed(2)
        : null,
    warnings,
  };
}

/** What the next run would pay, per enabled instance. Sends nothing. */
async function previewAll(env: Env) {
  const instances = (await loadInstances(env)).filter((i) => i.enabled);
  const { weightMode } = await loadSettings(env);
  const now = new Date();
  const out: any[] = [];
  for (const inst of instances) {
    const cadence = normalizeCadence(inst.cadence);
    const asset = { code: inst.rewardAssetCode, issuer: inst.rewardAssetIssuer };
    try {
      // Reflect the guards, so the page does not promise a payment the next run
      // will decline. A pool that paid a minute ago is not about to pay again.
      // Ask the lock, not KV: it is the authority on whether a run is due.
      // `dry: true` means this takes no lease and changes nothing.
      const ik = instanceKey(inst.poolId, asset.code, asset.issuer);
      const peek = await lockFor(env.PAYOUT_LOCK, ik).begin({
        now: now.getTime(),
        cadence,
        seedCoverageTo: await legacyCoverage(env, ik, inst.poolId, asset.code, now, cadence),
        dry: true,
      });
      const decision =
        peek.action === "wait"
          ? { due: false, waitMs: peek.waitMs }
          : { due: true, waitMs: 0 };

      const holders = await getPoolHolders(env, inst.poolId, asset);
      // Per PAYMENT, not per day -- this is what one run actually sends.
      const budget = budgetForCadence(toStroops(inst.dailyAmount), cadence);
      const { payouts, skippedNoTrustline } = computePayouts(
        holders,
        budget,
        toStroops(inst.minPayment),
        weightMode
      );
      const totalShares = holders
        .filter((h) => h.hasTrustline)
        .reduce((a, h) => a + h.shares, 0n);
      out.push({
        poolName: inst.poolName,
        poolId: inst.poolId,
        cadence,
        cadenceLabel: cadenceLabel(cadence),
        paymentsPerDay: paymentsPerDay(cadence),
        dailyAmount: inst.dailyAmount,
        assetCode: asset.code || "XLM",
        due: decision.due,
        waitNote: decision.due
          ? null
          : `not due for ${humanDuration(decision.waitMs)}`,
        needsAttention: peek.action === "needs-attention",
        status:
          peek.action === "needs-attention"
            ? "NEEDS ATTENTION - a partial payout is unresolved"
            : peek.action === "resolve"
              ? "a previous payout is unresolved; the next run will check it"
              : !decision.due
                ? "waiting for its next payment"
                : payouts.length
                  ? "would pay"
                  : "nothing to pay",
        recipients: payouts.length,
        paid: fs(payouts.reduce((a, p) => a + p.stroops, 0n)),
        noTrustline: skippedNoTrustline.length,
        payouts: payouts.map((p) => {
          const h = holders.find((x) => x.address === p.address)!;
          const pct = totalShares > 0n
            ? Number((h.shares * 1000000n) / totalShares) / 10000
            : 0;
          return { address: p.address, share: pct.toFixed(4) + "%", amount: fs(p.stroops) };
        }),
      });
    } catch (err: any) {
      out.push({
        poolName: inst.poolName,
        poolId: inst.poolId,
        cadence,
        cadenceLabel: cadenceLabel(cadence),
        paymentsPerDay: paymentsPerDay(cadence),
        dailyAmount: inst.dailyAmount,
        assetCode: asset.code || "XLM",
        due: true,
        status: "error: " + (err?.message ?? err),
        recipients: 0,
        paid: "0",
        payouts: [],
      });
    }
  }
  return out;
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    // The cron MUST stay hourly. Cadence is per pool now and is evaluated on
    // every tick, so a slower cron does not make pools pay less often -- it
    // starves the hourly ones, which would then pay 1/24 of the daily budget
    // once a day.
    if (event.cron !== "0 * * * *") {
      console.warn(
        `cron is "${event.cron}", expected "0 * * * *" -- hourly pools will underpay`
      );
    }
    ctx.waitUntil(
      runAll(env).then((r) => console.log("run complete:", JSON.stringify(r)))
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // Public: harmless status only. Never exposes the secret.
    if (p === "/" || p === "/status") {
      const instances = await loadInstances(env);
      return Response.json({
        worker: "lmnr-rewards",
        network: env.NETWORK,
        asset: `${env.REWARD_ASSET_CODE}`,
        instances: instances.length,
        enabled: instances.filter((i) => i.enabled).length,
        dryRun: isDryRun(env),
        disburserConfigured: Boolean(env.DISBURSER_SECRET),
        weightMode: (await loadSettings(env)).weightMode,
      });
    }

    // Everything below configures or reveals payouts -> admin only.
    const auth = checkAdmin(req, env);
    if (!auth.ok) return denied(auth.reason);

    if (p === "/admin") {
      return new Response(
        adminPage(auth.who, env.REWARD_ASSET_CODE, env.REWARD_ASSET_ISSUER),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    if (p === "/api/config" && req.method === "GET") {
      return Response.json({ ok: true, instances: await loadInstances(env) });
    }

    if (p === "/api/config" && req.method === "POST") {
      const body: any = await req.json().catch(() => null);
      const { ok, errors, value } = validateInstances(body?.instances);
      if (!ok) return Response.json({ ok: false, errors }, { status: 400 });
      await saveInstances(env, value);
      const enabled = value.filter((i) => i.enabled);
      const totalDaily = enabled.reduce((a, i) => a + Number(i.dailyAmount), 0);
      console.log(`config saved by ${auth.who}: ${enabled.length} enabled, ${totalDaily}/day`);
      return Response.json({
        ok: true,
        count: value.length,
        enabled: enabled.length,
        totalDaily: String(totalDaily),
      });
    }

    if (p === "/api/settings" && req.method === "GET") {
      return Response.json({ ok: true, settings: await loadSettings(env) });
    }

    if (p === "/api/settings" && req.method === "POST") {
      const body: any = await req.json().catch(() => null);
      const mode = body?.weightMode;
      if (mode !== "linear" && mode !== "sqrt") {
        return Response.json(
          { ok: false, reason: "weightMode must be 'linear' or 'sqrt'" },
          { status: 400 }
        );
      }
      await saveSettings(env, { weightMode: mode });
      console.log(`weightMode set to ${mode} by ${auth.who}`);
      return Response.json({ ok: true, weightMode: mode });
    }

    if (p === "/api/pools") {
      return Response.json({ ok: true, pools: await discoverPools(env) });
    }

    if (p === "/api/wallet") {
      return Response.json(await walletStatus(env));
    }

    if (p === "/api/preview") {
      return Response.json({ ok: true, results: await previewAll(env) });
    }

    if (p === "/run") {
      // No cadence override: each pool uses its own configured cadence, and the
      // lastPaidAt guard applies here exactly as it does to the cron. A manual
      // run cannot be used to pay a pool twice inside its period.
      const forceDry = url.searchParams.get("dry") === "1";
      const effEnv = forceDry ? ({ ...env, DRY_RUN: "true" } as Env) : env;
      const results = await runAll(effEnv);
      return Response.json({ ok: true, dryRun: isDryRun(effEnv), results });
    }

    return new Response("not found", { status: 404 });
  },
};
