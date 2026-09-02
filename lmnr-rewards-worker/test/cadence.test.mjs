import { cadenceDue, paidThroughAfter, budgetForCadence, intervalMs,
         paymentsPerDay, normalizeCadence, CADENCE_SLACK_MS } from "../.test-build/cadence.js";
import { periodKey, legacyPeriodKeys, instanceKey, periodEnd,
         getPending, setPending, clearPending, getPaidThroughAt,
         setPaidThroughAt, complete, getRun } from "../.test-build/ledger.js";

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const at = (iso) => new Date(iso);
const ms = (iso) => at(iso).getTime();

console.log("\n-- key derivation --");
const POOL = "8b0901329b099a6588996fb8b560fc96d7f79fd44c0610e6796f7d224ef3b8ac";
const ISS  = "GDKA6WVMFSA73BMEVKPO6WXSSWP4MPRBDJVSXLLSEVIEVH226L5RJ7NL";
const ik = instanceKey(POOL, "xLMNR", ISS);
t("instance key carries the FULL pool id, not a 16-char prefix", ik.startsWith(POOL), ik);
t("instance key carries the issuer, not just the code", ik.includes(ISS));
t("same code, different issuers are different instances",
  instanceKey(POOL, "USDC", ISS) !== instanceKey(POOL, "USDC", "G" + "B".repeat(55)));
t("native XLM does not collide with an issued asset coded XLM",
  instanceKey(POOL, "", "") !== instanceKey(POOL, "XLM", ISS));
t("two assets on one pool are distinct namespaces (the collision bug)",
  instanceKey(POOL, "xLMNR", ISS) !== instanceKey(POOL, "JDMC", ISS));

const noon = at("2026-09-02T12:34:56Z");
t("hourly stamp is the hour", periodKey(ik, noon, "hourly") === `payout:${ik}:2026-09-02T12`);
t("daily stamp is the day",   periodKey(ik, noon, "daily")  === `payout:${ik}:2026-09-02`);
t("12h PM half is B",         periodKey(ik, noon, "12h")    === `payout:${ik}:2026-09-02:B`);
t("12h AM half is A",         periodKey(ik, at("2026-09-02T11:59:59Z"), "12h") === `payout:${ik}:2026-09-02:A`);
t("12h halves are different keys",
  periodKey(ik, at("2026-09-02T00:00:00Z"), "12h") !== periodKey(ik, noon, "12h"));

const legacy = legacyPeriodKeys(POOL, "xLMNR", noon, "hourly");
t("legacy v2 shape (pool16 + code)", legacy[0] === "payout:8b0901329b099a65:xLMNR:2026-09-02T12", legacy[0]);
t("legacy v1 shape (pool16 only) -- the one live KV actually holds",
  legacy[1] === "payout:8b0901329b099a65:2026-09-02T12", legacy[1]);

console.log("\n-- periodEnd: seeding coverage from a calendar-only record --");
t("hourly period ends on the next hour boundary",
  periodEnd(at("2026-09-02T05:37:12Z"), "hourly") === ms("2026-09-02T06:00:00Z"));
t("12h AM period ends at noon",
  periodEnd(at("2026-09-02T05:37:12Z"), "12h") === ms("2026-09-02T12:00:00Z"));
t("12h PM period ends at midnight",
  periodEnd(at("2026-09-02T17:00:00Z"), "12h") === ms("2026-09-03T00:00:00Z"));
t("daily period ends at the next midnight",
  periodEnd(at("2026-09-02T05:37:12Z"), "daily") === ms("2026-09-03T00:00:00Z"));
t("seeded coverage never reaches beyond the period it describes",
  ["hourly","12h","daily"].every(c =>
    periodEnd(at("2026-09-02T05:37:12Z"), c) - ms("2026-09-02T05:37:12Z") <= intervalMs(c)));

console.log("\n-- budget slicing --");
const daily = 240n * 10_000_000n; // divisible by 24 -- the easy case
for (const c of ["hourly", "12h", "daily"]) {
  t(`${c}: per-payment x payments/day == daily budget (divisible amount)`,
    budgetForCadence(daily, c) * BigInt(paymentsPerDay(c)) === daily);
}
t("hourly slice of 240 is 10", budgetForCadence(daily, "hourly") === 10n * 10_000_000n);

// The live SHX pool runs 2500/day, which is NOT divisible by 24. Exact equality
// does not hold there, and asserting only the divisible case would hide that.
const awkward = 2500n * 10_000_000n;
for (const c of ["hourly", "12h", "daily"]) {
  const per = budgetForCadence(awkward, c);
  const n = BigInt(paymentsPerDay(c));
  t(`${c}: non-divisible amount never EXCEEDS the daily budget`, per * n <= awkward);
  t(`${c}: shortfall is under one stroop per payment (${awkward - per * n} stroops/day)`,
    awkward - per * n < n);
}
t("truncation can never exceed the budget", budgetForCadence(1n, "hourly") * 24n <= 1n);

console.log("\n-- guard: normal operation --");
const payAt = (iso, c) => paidThroughAfter(ms(iso), null, c);
t("never paid -> due", cadenceDue(null, ms("2026-09-02T12:00:00Z")).due);
t("hourly cron jitter (tick 5s early) still pays",
  cadenceDue(payAt("2026-09-02T11:00:07Z", "hourly"), ms("2026-09-02T12:00:02Z")).due);
t("hourly: 10 min later is NOT due",
  !cadenceDue(payAt("2026-09-02T12:00:00Z", "hourly"), ms("2026-09-02T12:10:00Z")).due);
t("daily: 23h later is NOT due",
  !cadenceDue(payAt("2026-09-02T00:00:00Z", "daily"), ms("2026-09-02T23:00:00Z")).due);
t("daily: 24h later IS due",
  cadenceDue(payAt("2026-09-02T00:00:00Z", "daily"), ms("2026-09-03T00:00:00Z")).due);
t("12h: 11h later is NOT due",
  !cadenceDue(payAt("2026-09-02T00:00:00Z", "12h"), ms("2026-09-02T11:00:00Z")).due);
t("12h: 12h later IS due",
  cadenceDue(payAt("2026-09-02T00:00:00Z", "12h"), ms("2026-09-02T12:00:00Z")).due);
t("slack is far smaller than the shortest period",
  ["hourly","12h","daily"].every(c => CADENCE_SLACK_MS < intervalMs(c) / 2));
t("outage is skipped, not caught up: clock restarts from now",
  paidThroughAfter(ms("2026-09-02T15:00:00Z"), ms("2026-09-02T10:00:00Z"), "hourly")
    === ms("2026-09-02T16:00:00Z"));
t("a payment inside the slack window does NOT move the schedule earlier",
  paidThroughAfter(ms("2026-09-02T12:56:00Z"), ms("2026-09-02T13:00:00Z"), "hourly")
    === ms("2026-09-02T14:00:00Z"));

console.log("\n-- guard: THE HAZARD, both directions --");
t("guard 1 alone would allow the switch (keys are separate namespaces)",
  periodKey(ik, at("2026-09-02T09:00:00Z"), "hourly")
    !== periodKey(ik, at("2026-09-02T00:00:00Z"), "daily"));

// daily -> hourly: a full day was paid at 00:00; every remaining hour must be refused
const dailyPaid = payAt("2026-09-02T00:00:00Z", "daily");
let leaks = [];
for (let h = 1; h < 24; h++) {
  const nowMs = ms("2026-09-02T00:00:00Z") + h * 3600_000;
  if (cadenceDue(dailyPaid, nowMs).due) leaks.push(`${h}h`);
}
t("daily->hourly: no extra payment for the rest of the funded day",
  leaks.length === 0, `leaked at ${leaks.join(",")}`);
t("daily->hourly: releases once the funded day is over",
  cadenceDue(dailyPaid, ms("2026-09-03T00:00:00Z")).due);

// hourly -> daily: an hour was paid; a full day must not go out on top of it
const hourlyPaid = payAt("2026-09-02T09:00:00Z", "hourly");
t("hourly->daily: blocked inside the funded hour",
  !cadenceDue(hourlyPaid, ms("2026-09-02T09:05:00Z")).due);
t("hourly->daily: releases at the end of the funded hour (only an hour is owed)",
  cadenceDue(hourlyPaid, ms("2026-09-02T10:00:00Z")).due);

// 12h -> hourly
const halfPaid = payAt("2026-09-02T12:00:00Z", "12h");
let leaks2 = [];
for (let h = 1; h < 12; h++) {
  if (cadenceDue(halfPaid, ms("2026-09-02T12:00:00Z") + h * 3600_000).due) leaks2.push(`${h}h`);
}
t("12h->hourly: no extra payment inside the funded half-day",
  leaks2.length === 0, `leaked at ${leaks2.join(",")}`);

// The invariant that actually holds: COVERAGE NEVER OVERLAPS. Every instant of
// time is funded by at most one payment. A daily payment prepays 24 hours, so
// the calendar day it lands in can show more than one day of spend -- that is
// front-loading, not double-paying, and the following day pays nothing.
console.log("\n-- invariant: no overlapping coverage, across cadence flips --");
function simulate(flipPlan, ticks = 24 * 30) {
  let paidThrough = null, spent = 0n;
  const covered = [];
  for (let tick = 0; tick < ticks; tick++) {
    const nowMs = ms("2026-09-02T00:00:00Z") + tick * 3600_000;
    const cadence = flipPlan(tick);
    if (!cadenceDue(paidThrough, nowMs).due) continue;
    const next = paidThroughAfter(nowMs, paidThrough, cadence);
    covered.push([Math.max(nowMs, paidThrough ?? nowMs), next]);
    spent += budgetForCadence(daily, cadence);
    paidThrough = next;
  }
  return { spent, covered };
}
const PLANS = {
  "hourly only":       () => "hourly",
  "daily only":        () => "daily",
  "12h only":          () => "12h",
  "daily->hourly":     (i) => (i < 9 ? "daily" : "hourly"),
  "hourly->daily":     (i) => (i < 9 ? "hourly" : "daily"),
  "12h->hourly":       (i) => (i < 9 ? "12h" : "hourly"),
  "hourly->12h":       (i) => (i < 9 ? "hourly" : "12h"),
  "flip every 3h":     (i) => ["hourly", "12h", "daily"][Math.floor(i / 3) % 3],
  "flip every tick":   (i) => ["hourly", "daily", "12h"][i % 3],
};
for (const [name, plan] of Object.entries(PLANS)) {
  const { spent, covered } = simulate(plan);
  let overlap = null;
  for (let i = 1; i < covered.length; i++) {
    if (covered[i][0] < covered[i - 1][1]) { overlap = i; break; }
  }
  t(`${name.padEnd(16)} coverage never overlaps`, overlap === null,
    overlap !== null ? `payment ${overlap} starts before ${overlap - 1} ends` : "");
  // 30 days of ticks; at most one extra day can be prepaid past the horizon.
  t(`${name.padEnd(16)} 30-day spend <= 30 days + 1 prepaid day`,
    spent <= daily * 31n, `spent ${spent / 10_000_000n}, cap ${daily * 31n / 10_000_000n}`);
}

// Slack must not compound: ticks that always arrive 4 min early stay on schedule.
console.log("\n-- slack cannot compound --");
{
  let paidThrough = null, payments = 0;
  for (let tick = 0; tick < 24; tick++) {
    const nowMs = ms("2026-09-02T00:00:00Z") + tick * 3600_000 - 4 * 60_000;
    if (!cadenceDue(paidThrough, nowMs).due) continue;
    payments++;
    paidThrough = paidThroughAfter(nowMs, paidThrough, "hourly");
  }
  t("24 early ticks produce exactly 24 hourly payments, not 25+", payments === 24, `got ${payments}`);
}

console.log("\n-- normalization --");
t("undefined -> hourly", normalizeCadence(undefined) === "hourly");
t("garbage -> hourly",   normalizeCadence("weekly") === "hourly");
t("12h preserved",       normalizeCadence("12h") === "12h");


// ---------------------------------------------------------------------------
// Protocol tests.
//
// These drive the REAL ledger module (getPending/setPending/complete/
// setPaidThroughAt/periodEnd/keys) against an in-memory KV. The orchestration
// below is a MODEL of runPool's decision sequence, not the shipped function --
// runPool pulls in the Stellar SDK and Horizon. So these catch state-machine
// mistakes in the ledger and in the ordering, but they are not a substitute for
// exercising the deployed handler.
// ---------------------------------------------------------------------------
console.log("\n-- protocol: crash, recovery, cadence change in flight --");

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) { this.m.set(k, v); }
  async delete(k) { this.m.delete(k); }
}
const envOf = () => ({ LEDGER: new FakeKV() });

/** One tick of the decision sequence. `landed` says which tx hashes are on chain. */
async function tick(env, { ik, poolId, code, cadence, now, dry = false, landed = new Set(),
                           crashAfterSubmit = false }) {
  const key = periodKey(ik, now, cadence);

  const pending = await getPending(env, ik);
  if (pending) {
    const ok = pending.batches.map((b) => landed.has(b.txHash));
    const all = ok.length === pending.totalBatches && ok.every(Boolean);
    const any = ok.some(Boolean);
    if (all) {
      if (!dry) {
        await complete(env, pending.periodKey, pending.batches.at(-1).txHash, "unknown");
        await setPaidThroughAt(env, ik, pending.coverageTo);
        await clearPending(env, ik);
      }
      return { status: "recovered-already-paid" };
    }
    if (!any) { if (!dry) await clearPending(env, ik); }
    else return { status: "needs-attention" };
  }

  let prior = await getRun(env, key);
  if (!prior) {
    for (const lk of legacyPeriodKeys(poolId, code, now, cadence)) {
      prior = await getRun(env, lk);
      if (prior) break;
    }
  }
  if (prior) {
    if (!dry && (await getPaidThroughAt(env, ik)) === null) {
      await setPaidThroughAt(env, ik, periodEnd(now, cadence));
    }
    return { status: "already-handled" };
  }

  const paidThrough = await getPaidThroughAt(env, ik);
  if (!cadenceDue(paidThrough, now.getTime()).due) return { status: "cadence-wait" };
  if (dry) return { status: "dry-run" };

  const coverageTo = paidThroughAfter(now.getTime(), paidThrough, cadence);
  const hash = `tx-${cadence}-${now.toISOString()}`;
  await setPending(env, ik, {
    periodKey: key, cadence,
    coverageFrom: Math.max(now.getTime(), paidThrough ?? now.getTime()),
    coverageTo, batches: [{ index: 0, txHash: hash }], totalBatches: 1,
    at: now.toISOString(),
  });
  landed.add(hash);            // the transaction lands on chain
  if (crashAfterSubmit) return { status: "crashed", hash };
  await complete(env, key, hash, "1");
  await setPaidThroughAt(env, ik, coverageTo);
  await clearPending(env, ik);
  return { status: "paid", hash, coverageTo };
}

{ // crash between submit and complete, then the operator changes cadence
  const env = envOf(), landed = new Set();
  const K = instanceKey(POOL, "xLMNR", ISS);
  const r1 = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "daily",
    now: at("2026-09-02T00:00:00Z"), landed, crashAfterSubmit: true });
  t("daily payout submitted, then crashed before completing", r1.status === "crashed");

  const r2 = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
    now: at("2026-09-02T01:00:00Z"), landed });
  t("cadence changed while in flight: the payout is STILL recovered, not re-paid",
    r2.status === "recovered-already-paid", r2.status);
  t("recovery restores coverage from the payout's own window, not recovery time",
    (await getPaidThroughAt(env, K)) === ms("2026-09-03T00:00:00Z"),
    String(await getPaidThroughAt(env, K)));

  let extra = 0;
  for (let h = 2; h < 24; h++) {
    const r = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
      now: new Date(ms("2026-09-02T00:00:00Z") + h * 3600_000), landed });
    if (r.status === "paid") extra++;
  }
  t("...and no hourly payment goes out over the funded day", extra === 0, `${extra} extra`);
}

{ // late recovery must not leave an unfunded gap
  const env = envOf(), landed = new Set();
  const K = instanceKey(POOL, "xLMNR", ISS);
  await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "daily",
    now: at("2026-09-02T00:00:00Z"), landed, crashAfterSubmit: true });
  await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "daily",
    now: at("2026-09-02T12:00:00Z"), landed });   // recovered 12h late
  t("late recovery does NOT push the funded window out by the outage",
    (await getPaidThroughAt(env, K)) === ms("2026-09-03T00:00:00Z"),
    String(await getPaidThroughAt(env, K)));
  const next = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "daily",
    now: at("2026-09-03T00:00:00Z"), landed });
  t("...so the next day still pays on time (no unfunded gap)", next.status === "paid", next.status);
}

{ // the live migration state: a v1 legacy key, no coverage record
  const env = envOf(), landed = new Set();
  const K = instanceKey(POOL, "xLMNR", ISS);
  await env.LEDGER.put("payout:8b0901329b099a65:2026-09-02T05",
    JSON.stringify({ status: "done", txHash: "b409da55", at: "2026-09-02T05:00:26Z", paid: "104.1666662" }));

  const r = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
    now: at("2026-09-02T05:30:00Z"), landed });
  t("migration: the v1 legacy key still blocks a re-pay of that hour",
    r.status === "already-handled", r.status);
  t("migration: coverage is SEEDED from the legacy record",
    (await getPaidThroughAt(env, K)) === ms("2026-09-02T06:00:00Z"),
    String(await getPaidThroughAt(env, K)));

  // The gap Codex found: switch to daily right after the legacy hour.
  const r2 = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "daily",
    now: at("2026-09-02T05:45:00Z"), landed });
  t("migration: switching to daily inside the legacy hour does NOT pay over it",
    r2.status === "cadence-wait", r2.status);
}

{ // dry runs must not mutate anything, including on the recovery path
  const env = envOf(), landed = new Set();
  const K = instanceKey(POOL, "xLMNR", ISS);
  await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
    now: at("2026-09-02T00:00:00Z"), landed, crashAfterSubmit: true });
  const before = JSON.stringify([...env.LEDGER.m.entries()].sort());
  const r = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
    now: at("2026-09-02T01:00:00Z"), landed, dry: true });
  const after = JSON.stringify([...env.LEDGER.m.entries()].sort());
  t("dry run reports the recovery", r.status === "recovered-already-paid", r.status);
  t("dry run writes NOTHING, even resolving a pending payout", before === after);
}

{ // a partial multi-batch payout must fail closed, not guess
  const env = envOf();
  const K = instanceKey(POOL, "xLMNR", ISS);
  await setPending(env, K, {
    periodKey: `payout:${K}:2026-09-02T00`, cadence: "hourly",
    coverageFrom: ms("2026-09-02T00:00:00Z"), coverageTo: ms("2026-09-02T01:00:00Z"),
    batches: [{ index: 0, txHash: "a" }, { index: 1, txHash: "b" }],
    totalBatches: 2, at: "2026-09-02T00:00:00Z",
  });
  const r = await tick(env, { ik: K, poolId: POOL, code: "xLMNR", cadence: "hourly",
    now: at("2026-09-02T01:00:00Z"), landed: new Set(["a"]) });
  t("one of two batches landed: refuses to pay and flags for a human",
    r.status === "needs-attention", r.status);
  t("...and the pending record is kept for reconciliation",
    (await getPending(env, K)) !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
