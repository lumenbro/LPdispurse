import { Keypair } from "@stellar/stellar-sdk";
import { fromStroops, isDryRun, toStroops, type Env } from "./config";
import { getPoolHolders } from "./horizon";
import {
  complete,
  getRun,
  periodKey,
  reserve,
  skip,
  txSucceeded,
} from "./ledger";
import { buildPaymentTx, chunk, computePayouts } from "./payout";
import { MAX_OPS_PER_TX, fromStroops as fs } from "./config";
import { Keypair as KP } from "@stellar/stellar-sdk";
import { adminPage } from "./admin-ui";
import { checkAdmin, denied } from "./auth";
import { discoverPools } from "./discover";
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
  hourly: boolean,
  now: Date,
  mode: "linear" | "sqrt" = "linear"
): Promise<PoolResult> {
  const poolId = inst.poolId;
  const short = inst.poolName || poolId.slice(0, 8);
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

  // Per-instance config from KV (set in the admin page), not global vars.
  const daily = toStroops(inst.dailyAmount);
  const budget = hourly ? daily / 24n : daily;
  const { payouts, skippedNoTrustline, dust } = computePayouts(
    holders,
    budget,
    toStroops(inst.minPayment),
    mode
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
    const { tx, server } = await buildPaymentTx(env, keypair, batch, {
      code: inst.rewardAssetCode,
      issuer: inst.rewardAssetIssuer,
    }, inst.memo);
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
  const instances = (await loadInstances(env)).filter((i) => i.enabled);
  const { weightMode } = await loadSettings(env);
  for (const inst of instances) {
    try {
      results.push(await runPool(env, inst, hourly, now, weightMode));
    } catch (err: any) {
      // One bad pool must not abort the others.
      console.error(`pool ${inst.poolName} failed: ${err?.message ?? err}`);
      results.push({
        pool: inst.poolName,
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
  // Fee model matches buildPaymentTx: base 100 stroops x ops x 10, hourly.
  const opsPerRun = instances.length * 10;
  const xlmPerDay = (100 * 10 * Math.max(opsPerRun, 1) * 24) / 1e7;

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
  const out: any[] = [];
  for (const inst of instances) {
    try {
      const holders = await getPoolHolders(env, inst.poolId);
      const budget = toStroops(inst.dailyAmount) / 24n;
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
        status: payouts.length ? "would pay" : "nothing to pay",
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
    const hourly = event.cron !== "0 0 * * *";
    ctx.waitUntil(
      runAll(env, hourly).then((r) =>
        console.log("run complete:", JSON.stringify(r))
      )
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
      const forceDry = url.searchParams.get("dry") === "1";
      const effEnv = forceDry ? ({ ...env, DRY_RUN: "true" } as Env) : env;
      const hourly = url.searchParams.get("daily") !== "1";
      const results = await runAll(effEnv, hourly);
      return Response.json({ ok: true, dryRun: isDryRun(effEnv), results });
    }

    return new Response("not found", { status: 404 });
  },
};
