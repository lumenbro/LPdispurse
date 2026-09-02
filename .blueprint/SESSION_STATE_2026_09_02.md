# Session State — 2026-09-02 (rewards Worker era)

Snapshot for resuming after compaction. Supersedes the contract-era notes for
anything about the rewards bot; `CONTRACT_V2_REVIEW_LOG.md` is still the source
of truth for the staking contract.

## LIVE AND WORKING

### lmnr-rewards (Cloudflare Worker) — the active system
ACT-style push rewards. Hourly cron, pays LPs pro-rata in one transaction per pool.
- URL: `https://lmnr-rewards.bpeterscqa.workers.dev` (admin at `/admin`)
- Behind **Cloudflare Access**; allowlist `ADMIN_EMAILS` = brandon + LMNR013@gmail.com
- Secret: `DISBURSER_SECRET` (write-only). KV namespace `2a5c9e6c23284f4ea8c1124d5544e91f`
- **Verified live**: tx `e9e29e8f…`, 8 payments in one tx, memo attached, exactly
  pro-rata, 0.00008 XLM fee. Idempotency confirmed (`already-handled`, paid 0).
- **Currently in SOAK/TEST mode**: one pool (XLM/xLMNR), 240/day, memo
  `xLMNR REWARDS TEST`. Dev will switch to real pools/amounts/memo.

### Disbursement wallet `GBQ3DSET3RL3UONOS2J3ZHCBLMCELNC6KWCUEVGJBZRQNZIWNRXXTBHJ`
- ~39.7k xLMNR, ~5.4 XLM. `home_domain` = `www.thelumenaire.com`
- **Key is shared with the dev** (he imported to Lobstr, deliberately — he controls
  reward disbursement). Copies: dev's Lobstr, Brandon's xBull, CF secret.
  CLI copy was REMOVED. `~/.config/stellar/identity` now chmod 700/600.
  Removing his access = full key rotation, not a revoke.

### Federation — both resolve to the same wallet
- `rewards*thelumenaire.com` -> `lmnr-federation` Worker at `federation.lumenbro.com`
  (separate Worker, no secrets, deliberately NOT behind Access — must be public)
- `xLMNR-REWARDS*lobstr.co` -> dev set this in Lobstr
- `FEDERATION_SERVER` line added to the site toml (LUMENAIRE repo, commit 7af62f7)
- Lobstr only reverse-resolves its OWN names, which is why the lobstr one shows on
  received payments and ours does not. Not a bug.

## STOPPED / PARKED
- **Staking contract v2**: complete, 7 Codex review rounds ending clean, 74 tests,
  43/43 testnet. NOT deployed. Read `CONTRACT_V2_REVIEW_LOG.md` first.
  Do NOT run it and the rewards bot on the same pools — that pays twice.
- **sdex-mm ×6 workers**: all cron triggers removed (MAHORAGA repo, commit 8a94122,
  committed but NOT pushed). TEE signer is down so they cannot sign anyway.
- **lmnr-staking Vercel**: paused from console + cron schedule emptied.

## JUST SHIPPED
**Square-root distribution curve** (commit `a90cdf8`, deployed).
Global setting on the admin page, radio buttons Proportional vs Square root.
Chosen over a per-pool % cap because a cap flattens everyone above it to the same
payout (54% and 11% holders both get 750) removing any reason to deepen a pool.
Verified against live SHX pool, matches the model exactly:

| LP share | Proportional | Square root |
|---:|---:|---:|
| 54.09% | 1,622.6 | 1,093.7 |
| 10.94% | 328.3 | 491.9 |
| 0.03% | 0.9 | 26.0 |

Still set to **Proportional** — dev flips it himself.
Caveat told to dev: sqrt REWARDS splitting a position across wallets. It is a
distribution preference, not a Sybil defence.

## SHIPPED — per-pool payout cadence (commit `bfadb55`, deployed)
Per-pool **hourly / 12-hour / daily**, selected in the admin table ("Pays"
column, with a live "Per payment" figure beside it).

- **Cron stays hourly** (`0 * * * *`, confirmed in deploy output). Cadence is
  evaluated per pool on every tick; a pool whose period is funded declines.
- `dailyAmount` is still the DAILY budget; cadence only slices it.
- Missed ticks are skipped, never caught up.
- **Two guards.** (1) the calendar key at the cadence's granularity, as before.
  (2) `paidThroughAt` — the new one, and the load-bearing one.
- **Why paid-through and not "time since last payment"**: the obvious guard only
  closes one direction. A daily pool that paid a whole day at 00:00, switched to
  hourly at 09:00, has trivially had an hour elapse — it would pay 15 more
  slices on a day already funded. Asking "is now past the point the last payment
  paid through?" closes both directions.
- **The invariant is that coverage never overlaps** — every instant is paid for
  exactly once. Verified over a 30-day sim including a plan that flips cadence
  every single tick.
- **Not a bug, tell the dev**: switching to Daily *prepays* 24 hours, so that
  calendar day's spend looks larger and the next day pays nothing. The admin
  page says this.
- `paidThroughAfter` anchors to `max(now, previous)` so the 5-min jitter slack
  cannot compound (measuring from `now` alone makes 55-minute "hours" → 26
  payments/day, ~8% overspend).
- **Also fixed a pre-existing collision**: the ledger keyed on the pool alone,
  so two instances on one pool paying different assets (an advertised feature)
  shared a ledger entry and the second never paid. Keys are now
  `payout:<pool16>:<ASSET>:<stamp>`, with a read-only fallback to the old shape
  so the namespace move could not re-pay a live period. **Verified on the live
  KV**: at deploy time `payout:1810a5338d75c5bd:2026-09-02T05` was `done` and
  the new-shape key did not exist — the fallback is what stopped a re-pay.
  The fallback can be deleted after 2026-09-03 (one day past deploy).
- `npm test` — 52 assertions in `test/cadence.test.mjs`. `npm run typecheck` clean.

## DEV HAS CHANGED THE LIVE CONFIG (as of 2026-09-02 05:00 UTC)
Different from what the earlier notes said — read KV, not the notes:
- `XLM/xLMNR (TEST)` 240/day — now **disabled**
- `SHX/xLMNR` **2500/day, ENABLED**, memo `xLMNR-SHx YIELD (TESTING)`
- Paying live and hourly: 104.1666662 per hour, e.g. tx `b409da55…` at 05:00
- Neither instance has a `cadence` field yet → both read as hourly, unchanged
- Wallet: **38,737.5 xLMNR, 5.44 XLM**. At 2500/day that is ~15 days of runway.

## OTHER OPEN ITEMS
- **lumexo stale logo**: NOT our bug. app.lumexo.io caches
  `apayhub.authentic-payment.com/.../lmnr-logo-663x1024.jpg` in its own ticker.
  Nothing in either repo references it (only a partner *link* in partners.tsx).
  **Do NOT delete the apayhub file** — that yields a broken image, not a refetch.
  Fix is lumexo refreshing their record; message drafted for the dev to forward.
- Dev still to set real pools/amounts/memo (currently test values).
- At 3 pools x 4,000/day the ~39.7k balance lasts ~3 days. Wallet card shows runway.

## REPO / PUSH STATE
- `lumenbro/LPdispurse` — all pushed through `a90cdf8`
- `XLMNR/LUMENAIRE` — toml federation line pushed (`7af62f7`)
- `MAHORAGA/sdex-mm` — committed, NOT pushed
