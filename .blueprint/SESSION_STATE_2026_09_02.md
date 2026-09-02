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

## NEXT BUILD — per-pool payout cadence (designed, not built)
Dev wants per-pool **hourly / 12-hour / daily** selection.

Design agreed:
- **Cron stays hourly.** Each pool decides per tick whether its period elapsed.
- Ledger key granularity by cadence: `pool:YYYY-MM-DDTHH` / `pool:YYYY-MM-DD:A|B`
  / `pool:YYYY-MM-DD`
- `dailyAmount` stays the DAILY budget; cadence only slices it (/24, /2, x1)
- **⚠️ THE HAZARD**: switching cadence mid-period double-pays, because the two
  schemes use different key namespaces. daily->hourly after today's payment
  creates an unseen key and pays again; hourly->daily can pay a full day extra.
  **FIX: also store `lastPaidAt` per pool and refuse to pay unless the current
  cadence interval has elapsed.** Calendar key stays for audit; timestamp is the
  guard.
- Missed runs are skipped, not caught up (no burst on recovery).
- Side effect: fewer/larger payments help small holders clear `minPayment`.

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
