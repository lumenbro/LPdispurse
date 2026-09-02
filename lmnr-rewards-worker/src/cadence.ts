/**
 * Per-pool payout cadence.
 *
 * The cron stays HOURLY. Cadence is decided per pool on each tick: a 12-hour or
 * daily pool simply declines to pay on the ticks that fall inside a period it
 * has already paid. Missed ticks are skipped, never caught up -- a Worker that
 * was down for six hours must not wake up and fire six payments.
 *
 * `dailyAmount` always means the DAILY budget. Cadence only decides how that
 * budget is sliced, so switching a pool from hourly to daily changes the size
 * and timing of payments but never the spend per day.
 */
export type Cadence = "hourly" | "12h" | "daily";

export function normalizeCadence(v: unknown): Cadence {
  // Anything unrecognised -- including `undefined` on instances saved before
  // this feature existed -- means hourly, which is the previous behaviour.
  return v === "12h" || v === "daily" ? v : "hourly";
}

export function paymentsPerDay(c: Cadence): number {
  return c === "hourly" ? 24 : c === "12h" ? 2 : 1;
}

export function intervalMs(c: Cadence): number {
  return c === "hourly" ? 3_600_000 : c === "12h" ? 43_200_000 : 86_400_000;
}

export function cadenceLabel(c: Cadence): string {
  return c === "hourly" ? "Hourly" : c === "12h" ? "Twice daily" : "Daily";
}

/**
 * Slack subtracted from the required interval before the lastPaidAt guard bites.
 *
 * Cron ticks are not exactly 3600s apart: a run at 15:00:07 pays through
 * 16:00:07, and the 16:00:02 tick would fall five seconds short of it and
 * silently stall an hourly pool for a whole hour. Five
 * minutes is far larger than observed cron jitter and far smaller than the
 * shortest cadence, so it cannot let a second payment through inside a period.
 */
export const CADENCE_SLACK_MS = 5 * 60_000;

/** One period's budget, from the daily budget. Integer stroops, truncating. */
export function budgetForCadence(dailyStroops: bigint, c: Cadence): bigint {
  return dailyStroops / BigInt(paymentsPerDay(c));
}

export interface CadenceDecision {
  /** True when a payment is allowed now. */
  due: boolean;
  /** How much longer to wait, in ms. 0 when due. */
  waitMs: number;
}

/**
 * The cadence guard, in one place so it can be tested directly.
 *
 * It reasons about PAID-THROUGH TIME rather than time-since-last-payment,
 * because a payment does not just mark an instant -- it buys a stretch of time.
 * A daily payment of the whole daily budget funds the next 24 hours; an hourly
 * payment funds the next hour. Nothing may pay again until that stretch is over.
 *
 * This is what makes a cadence CHANGE safe in both directions. "Has one
 * interval of the NEW cadence elapsed?" is not enough: a daily pool that paid a
 * full day at 00:00 and is switched to hourly at 09:00 has trivially had an
 * hour elapse, and would then pay 15 more hourly slices on a day that is
 * already fully funded. Asking "is 09:00 past the point the last payment paid
 * through?" gets that right, and gets the reverse direction right too.
 *
 * `paidThroughAt === null` means this instance has never paid -- allow it, or a
 * brand new pool would never start.
 */
export function cadenceDue(
  paidThroughAt: number | null,
  now: number
): CadenceDecision {
  if (paidThroughAt === null) return { due: true, waitMs: 0 };
  const releaseAt = paidThroughAt - CADENCE_SLACK_MS;
  return now >= releaseAt
    ? { due: true, waitMs: 0 }
    : { due: false, waitMs: releaseAt - now };
}

/**
 * The instant a payment made now, at this cadence, funds the pool through.
 *
 * Anchored to `max(now, previous paid-through)`, which matters in both
 * directions:
 *
 *  - A tick arriving inside the slack window (12:55 for a 13:00 period) must
 *    not move the schedule permanently earlier. Measuring purely from `now`
 *    would let the slack compound -- 55-minute "hours" are 26 payments a day,
 *    an 8% overspend -- so an early payment still funds through 14:00.
 *  - After an outage the previous paid-through is in the past, so `now` wins and
 *    the clock restarts from now. Missed periods are skipped, never caught up.
 */
export function paidThroughAfter(
  now: number,
  previousPaidThrough: number | null,
  cadence: Cadence
): number {
  return Math.max(now, previousPaidThrough ?? now) + intervalMs(cadence);
}

/** "3h 12m" / "48m" / "40s" -- for telling the operator how long the wait is. */
export function humanDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
