import { cadenceDue, paidThroughAfter, budgetForCadence, intervalMs,
         paymentsPerDay, normalizeCadence, CADENCE_SLACK_MS } from "../.test-build/cadence.js";
import { periodKey, legacyPeriodKey, instanceKey } from "../.test-build/ledger.js";

let pass = 0, fail = 0;
const t = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const at = (iso) => new Date(iso);
const ms = (iso) => at(iso).getTime();

console.log("\n-- key derivation --");
const POOL = "8b0901329b099a6588996fb8b560fc96d7f79fd44c0610e6796f7d224ef3b8ac";
const ik = instanceKey(POOL, "xLMNR");
t("instance key scopes pool+asset", ik === "8b0901329b099a65:xLMNR", ik);
t("native asset is named, not blank", instanceKey("aa".repeat(32), "") === "aaaaaaaaaaaaaaaa:XLM");
t("two assets on one pool are distinct namespaces (the collision bug)",
  instanceKey("aa".repeat(32), "xLMNR") !== instanceKey("aa".repeat(32), "JDMC"));

const noon = at("2026-09-02T12:34:56Z");
t("hourly stamp is the hour", periodKey(ik, noon, "hourly") === `payout:${ik}:2026-09-02T12`);
t("daily stamp is the day",   periodKey(ik, noon, "daily")  === `payout:${ik}:2026-09-02`);
t("12h PM half is B",         periodKey(ik, noon, "12h")    === `payout:${ik}:2026-09-02:B`);
t("12h AM half is A",         periodKey(ik, at("2026-09-02T11:59:59Z"), "12h") === `payout:${ik}:2026-09-02:A`);
t("12h halves are different keys",
  periodKey(ik, at("2026-09-02T00:00:00Z"), "12h") !== periodKey(ik, noon, "12h"));
t("legacy key is the old pool-only shape, same stamp",
  legacyPeriodKey(POOL, noon, "hourly") === "payout:8b0901329b099a65:2026-09-02T12");

console.log("\n-- budget slicing: the daily spend is invariant --");
const daily = 240n * 10_000_000n;
for (const c of ["hourly", "12h", "daily"]) {
  t(`${c}: per-payment x payments/day == daily budget`,
    budgetForCadence(daily, c) * BigInt(paymentsPerDay(c)) === daily);
}
t("hourly slice of 240 is 10", budgetForCadence(daily, "hourly") === 10n * 10_000_000n);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
