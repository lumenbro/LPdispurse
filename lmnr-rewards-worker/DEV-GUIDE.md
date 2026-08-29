# xLMNR LP Rewards — Dashboard Guide

**https://lmnr-rewards.bpeterscqa.workers.dev/admin**

Sign in with **LMNR013@gmail.com**. Cloudflare Access handles the login — no
password to remember, no wallet to connect.

> **This is live and paying real xLMNR right now.** Anything you enable pays out
> on the hour, automatically. There is no confirmation step after you save.

---

## The three cards

### 1. Disbursement wallet
Shows the wallet that sends the rewards.

| Column | Meaning |
|---|---|
| Balance | What's actually in the wallet |
| Burn / day | Total you've configured across all enabled pools |
| **Runway** | **How many days until it runs dry** |

**Runway is the number to watch.** When xLMNR hits zero, payments silently stop —
no error, no alert, LPs just stop receiving. Same for XLM, which pays the network
fees. Top up by sending to the address shown (there's a Copy button).

Colours: green = healthy, amber = under 10 days, red = under 3 days.

### 2. Reward instances
One row per pool. This is where you set what gets paid.

- **On** — the switch. Off means that pool pays nothing.
- **Pool** — a label for you; rename it freely.
- **Daily amount** — tokens per day for that pool, split across its LPs by their
  share of the pool. Someone with 10% of the LP gets 10% of this.
- **Min payment** — skips payouts below this so tiny amounts don't waste fees.
  `0.001` is sensible.
- **Memo** — appears on the payment in the LP's wallet. E.g. `xLMNR LP reward`.

Each pool has its **own** amount. The total you're emitting is the sum of the
enabled rows — so adding a pool *increases* total emission, it doesn't split the
existing budget. Worth keeping in mind for supply.

Capped at **100,000 per pool per day** as a safety limit.

### 3. On-chain pools
Every liquidity pool containing xLMNR, read live from Stellar, with how many LPs
each has. **Tick one to add it.**

New pools arrive **switched off with amount 0** on purpose — nothing starts
paying until you set an amount and flip it on.

---

## Making a change

1. Tick a pool, or edit an amount on an existing row
2. **Press "Preview payouts"** — shows exactly who gets what, per address, with
   their LP share. Nothing is sent.
3. Press **Save config**

Changes take effect on the next hourly run. No deploy, no restart.

---

## Good to know

- **Payments are hourly.** A daily amount of 2,400 pays 100 per hour.
- **One transaction per pool per hour**, so fees are negligible (~0.00008 XLM).
- **LPs do nothing.** No claiming, no signing, no fees on their side — tokens
  just arrive. Same model as ACT.
- **Re-running an hour never double-pays** — each hour is recorded once.
- **LPs must hold an xLMNR trustline** to receive. Anyone in an xLMNR pool
  already does, so this rarely comes up; the preview flags any who don't.

## What the dashboard can't do
Deliberately. It can only decide *who gets paid and how much*.
It cannot withdraw from the wallet, move funds anywhere else, or change which
wallet pays.

## If something looks wrong
Switch every row **Off** and Save — that halts all payments immediately.
Then message Brandon.
