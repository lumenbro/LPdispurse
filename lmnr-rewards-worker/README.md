# lmnr-rewards-worker

ACT-style push rewards for xLMNR liquidity providers, on a Cloudflare Worker cron.

Every period it snapshots LP holders from Horizon, splits a fixed budget pro-rata by
LP share, and pays everyone in **one transaction**. Users do nothing — no claiming,
no proving, no fees on their side.

This is the serverless equivalent of the Python bot in `rewards_disbursement_bot/`.
Same logic; no always-on server.

## Why a Worker and not a server

The whole job is a few Horizon reads plus one transaction — currently **~15 recipients
across 3 pools**. Stellar allows 100 operations per transaction, so one tx covers
everyone with room to spare. A container would idle 99.99% of the time.

## Setup

```bash
npm install
wrangler kv namespace create LEDGER      # put the id in wrangler.toml
wrangler secret put DISBURSER_SECRET     # the S... key of the paying wallet
wrangler deploy
```

Verify before enabling live payments:

```bash
curl https://lmnr-rewards.<subdomain>.workers.dev/            # config summary
curl https://lmnr-rewards.<subdomain>.workers.dev/run?dry=1   # dry run, pays nothing
```

Only then set `DRY_RUN = "false"` in `wrangler.toml` and redeploy.

## Safety properties

- **Dry run by default.** `DRY_RUN = "true"` ships in the config; it cannot pay on
  first deploy.
- **Idempotent.** Each pool+period writes a KV record. The tx hash is stored
  *before* submission, so a crash mid-run is resolved against the chain on the next
  run instead of blindly re-paying. This replaces the Python bot's
  `data/payout_ledger/` directory — Workers has no filesystem, and without it a
  retried cron **double-pays**.
- **Never over-pays.** All math is integer stroops with truncating division, so the
  sum of payouts is always `<= budget`. Remainder dust stays in the wallet.
- **Trustline-safe.** A payment to an account without an xLMNR trustline fails the
  *entire* transaction. Horizon's account records already include balances, so the
  check is free. Holders lacking a trustline are excluded from the denominator too,
  so the remaining LPs share the full budget rather than burning a slice.
- **One bad pool can't abort the others** — each is try/caught independently.

## Key custody

`DISBURSER_SECRET` is a Cloudflare secret: `wrangler secret list` shows names only,
and there is no `secret get` (unlike `vercel env pull`, which writes values to disk —
how keys end up in repos).

**This key sends real funds.** Unlike the staking contract's poster/operator keys, a
compromise here drains whatever the wallet holds, instantly.

- Keep only a few days' emission in the wallet; **top it up manually**.
- Scope the Cloudflare API token to this Worker; keep 2FA/FIDO on the account.
- Never commit `.dev.vars`.

## Tuning emission

`DAILY_REWARD_PER_POOL` is per pool, so total = that x number of pools.

Benchmark: **ACT** (the project this mirrors) emits 40,000/month to LPs against a 20M
supply — about **2.4%/year**. The default here (4,000/day x 3 pools = ~4.4M/year
against 333M) is about **1.3%/year**, roughly half ACT's rate.

## Cadence

`[triggers] crons` — `"0 * * * *"` hourly (default) or `"0 0 * * *"` daily. The budget
is divided automatically. Hourly means more, smaller payments; the cost difference is
negligible (a 15-op transaction is ~0.00015 XLM).

## Not to be run alongside the staking contract

This **pushes** rewards; `contracts/lp-staking` has users **claim** them. They are two
designs for the same job — running both against the same pools pays twice.
