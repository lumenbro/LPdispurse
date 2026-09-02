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

## Admin UI

`https://lmnr-rewards.<subdomain>.workers.dev/admin`

- **Disbursement wallet card** — address (copy button), balances, burn/day, and
  **runway in days** for both the reward asset and XLM fees, with a suggested
  30-day top-up. Runway is the number that matters: when either hits zero the
  cron fails quietly.
- **Reward instances** — one row per pool+asset, each with its own daily amount,
  minimum payment, memo, and an on/off toggle. A pool can appear more than once
  to pay multiple assets.
- **On-chain pool discovery** — every liquidity pool containing the reward asset,
  read live from Horizon, with holder counts. Tick one to add it; no pool IDs to
  type. New pools are added **disabled with amount 0** so nothing starts paying
  by accident.
- **Payout preview** — exactly what the next run would pay, per recipient, with
  LP shares. Sends nothing.

Config lives in KV, so changes take effect on the next run with **no redeploy**.

### Auth — required, because this page sets spending

Whoever can set a reward amount can drain the wallet in one run, so the page is
never open.

**Recommended: Cloudflare Access** in front of `/admin` and `/api/*`. Access
handles the login and injects `Cf-Access-Authenticated-User-Email`, which is
checked against `ADMIN_EMAILS` in `wrangler.toml`. No shared secret, and each
person logs in as themselves.

  Zero Trust -> Access -> Applications -> Add self-hosted
    domain: lmnr-rewards.<subdomain>.workers.dev
    paths:  /admin, /api
    policy: Allow -> Emails -> your address + the dev's

**Fallback until Access is set up:** an `ADMIN_TOKEN` secret sent as
`Authorization: Bearer <token>`. Already configured. Rotate with
`wrangler secret put ADMIN_TOKEN`.

### Guard rails
- `MAX_DAILY_REWARD` (100,000/pool/day) is enforced in code, so even a
  compromised session cannot set an absurd rate.
- Amounts, memo length, duplicate pool+asset pairs and malformed pool IDs are
  all validated server-side before anything is stored.

## First live run — verified 2026-08-29

Tx `e9e29e8f9b64e53b918c8988002c8ff813886a59dbb9dd623b28b47253137591`
(ledger 64173392, mainnet).

- 8 payments in ONE transaction, successful
- fee 0.00008 XLM total
- memo `xLMNR LP reward` attached
- paid 9.9999996 of a 10.0 budget — the 4-stroop shortfall is the intended
  truncating division, which guarantees the bot can never over-pay
- amounts matched on-chain LP shares (82.2% holder -> 8.2229, 0.095% -> 0.0095)
- KV ledger recorded `{status:"done", txHash, paid}` for the period

Everything that dry runs cannot exercise — transaction assembly, signing inside
the Worker isolate, memo, Horizon submission — worked on the first attempt.

### Ledger keys are per PERIOD, not per run
`payout:<pool>:<YYYY-MM-DDTHH>` for hourly (`YYYY-MM-DD` for daily). Re-running
inside the same hour is refused as `already-handled`; the next hour is a new
period and legitimately pays again. That is the intended behaviour, and it is
what makes a retried or duplicated cron invocation safe.

## Federated address

The disbursement wallet resolves as **`rewards*thelumenaire.com`**
(also `xlmnr-rewards`, `lp-rewards`, `reward-stream`).

Three pieces have to line up:
1. `home_domain` on the wallet -> `www.thelumenaire.com`
2. that site's stellar.toml -> `FEDERATION_SERVER="https://federation.lumenbro.com"`
3. the `lmnr-federation` Worker resolving the name

**Federation is sender-side only.** It lets someone TYPE the name when paying you;
it does NOT attach your name to payments you send. The recipient's wallet shows
the raw sender address — the same is true of any `*lobstr.co` address. It is also
not asset-specific.

So the thing LPs actually see on a reward payment is the **memo**, set per pool in
the dashboard. Keep it meaningful (e.g. `xLMNR LP Rewards`).

## Reward distribution curve

Global setting (all pools), on the admin page.

| Mode | Weight | Effect |
|---|---|---|
| **Proportional** | share | strict pro-rata; 54% of the pool earns 54% of rewards |
| **Square root** | sqrt(share) | compresses the whole curve |

Measured on the live SHX/xLMNR pool at 3,000/day:

| LP share | Proportional | Square root |
|---:|---:|---:|
| 54.09% | 1,622.6 | 1,093.7 |
| 27.84% | 835.1 | 784.6 |
| 10.94% | 328.3 | 491.9 |
| 3.78% | 113.5 | 289.3 |
| 0.10% | 3.1 | 47.8 |
| 0.03% | 0.9 | 26.0 |

Square root was chosen over a hard percentage cap because a cap flattens every
holder above it to the *same* payout — a 54% and an 11% holder would both receive
750 — which removes any reason to deepen a pool you already lead. Square root
keeps the ordering intact (more liquidity always earns more) while narrowing the
gap between largest and smallest.

Implementation note: weights use an integer `isqrt` on stroop-scale bigints,
pre-scaled by 1e18 so small holders keep meaningful resolution. Float `Math.sqrt`
would lose precision on large balances.

Caveat worth knowing: neither mode can stop someone splitting a position across
several wallets. Square root actually rewards splitting (two half-positions earn
more than one whole), so it is a distribution preference, not a Sybil defence.
