# xLMNR Staking — Environment & Handoff Guide (for the Dev)

**Last updated:** 2026-07-07
**Contract:** `CBDA7H3XLKL4ECSI54IPRGMYZLZFEIBR5FTEHI6DAH3UVHB53LMGBVAE` (mainnet, upgraded + xLMNR + funded + 3 pools registered)

This is what the dev needs to fully activate staking on the LUMENAIRE site.

---

## Current state (as of 2026-07-07)

- Site (thelumenaire.com) is on the dev's Vercel project (`stellarowlpha` team).
- The **cron currently runs on Brandon's own `lmnr-staking` project**
  (lmnr.lumenbro.com), which already holds the admin secret. Its `POOL_CONFIG`
  was just updated to the 3 new xLMNR pools — so Merkle roots for the new pools
  start posting at the next 00:00 UTC tick.
- The site's `/staking` page shows a "placeholder" banner until
  `NEXT_PUBLIC_CONTRACT_ID` is set on the dev's Vercel project.

---

## The 3 xLMNR pools (POOL_CONFIG)

```json
[
  {"index":1,"poolId":"8b0901329b099a6588996fb8b560fc96d7f79fd44c0610e6796f7d224ef3b8ac"},
  {"index":2,"poolId":"1810a5338d75c5bd1727ff476c182640cd98631b023703f82fbf0fa424b0ee54"},
  {"index":3,"poolId":"c074d9fb3d2d1bb7d608ef681b3d9a940ebb3eb9fb07a2e6cad1d69843b690c2"}
]
```

(index 1 = xLMNR/XLM, index 2 = xLMNR/SHX, index 3 = xLMNR/VELO)

---

## Environment variables

### PUBLIC — safe to paste anywhere (needed by the site to display + let users interact)

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_CONTRACT_ID` | `CBDA7H3XLKL4ECSI54IPRGMYZLZFEIBR5FTEHI6DAH3UVHB53LMGBVAE` |
| `NEXT_PUBLIC_ADMIN_WALLET` | the admin address (currently `GCKGWGRRJBUKYCTV2AZBSEI3SVLEBFOF7OD2AEFXA2XPZV3MJUGKRP7D`; change to the dev's address after admin handoff) |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.lightsail.network/` (or any mainnet Soroban RPC) |
| `NEXT_PUBLIC_HORIZON_URL` | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `Public Global Stellar Network ; September 2015` |
| `POOL_CONFIG` | the JSON above |

Setting just `NEXT_PUBLIC_CONTRACT_ID` removes the placeholder banner. The full
set above makes the dashboard read pools + reserves and lets users connect a
wallet and view their position.

### SECRET — generate your own, never share (only needed where the CRON runs)

| Variable | How to get it |
|----------|---------------|
| `ADMIN_SECRET_KEY` | The secret key of whatever account is contract admin. **Generate a fresh keypair for this — don't reuse a personal wallet.** After Brandon transfers admin to your public key, use that keypair's secret here. |
| `CRON_SECRET` | Any random string (e.g. `openssl rand -hex 32`). Bearer auth for `/api/cron`. |
| `BLOB_READ_WRITE_TOKEN` | Auto-created when you enable Vercel Blob storage on the project (Storage tab → create a Blob store). |

---

## IMPORTANT: proof storage coupling

The cron writes each user's Merkle **proof** to a Vercel Blob store. When a user
clicks "Stake," the site fetches their proof from Blob. **The cron's writes and
the site's reads must use the SAME Blob store**, or staking will fail with
"proof not found."

That means: whichever Vercel project runs the cron is where the proofs live, and
the site's `/api/proof` route must read from that same store.

### Recommended: co-locate the cron on the dev's project (clean end state)

Run BOTH the site and the cron on the dev's Vercel project. Then everything
shares one Blob store. To do this:

1. Complete the **admin handoff** (below) so the dev's keypair is contract admin.
2. Set ALL variables above (public + secret) on the dev's Vercel project.
3. Add the cron schedule — `vercel.json` at the repo root:
   ```json
   { "crons": [ { "path": "/api/cron", "schedule": "0 0 * * *" } ] }
   ```
   (Merging this makes the dev's project run the daily cron.)
4. Brandon disables/deletes the cron on the `lmnr-staking` project.

Until this co-location happens, the site can DISPLAY live data (reward pool,
pools, reserves — all read from the contract, no Blob needed), but the STAKE
action needs the cron + Blob on the same project as the site.

---

## Admin handoff (do NOT send private keys over chat)

The contract admin can post Merkle roots, add/remove pools, withdraw, and set
the reward rate. To transfer it to the dev safely — **no secret is ever sent**:

1. **Dev generates a keypair** (Stellar Lab / Freighter / xBull). Dev holds the secret.
2. Dev funds it with ~5 XLM for cron fees.
3. Dev sends Brandon **only the public key** (`G…`).
4. Brandon calls `set_admin(current_admin, dev_pubkey)` → dev is now sole admin.
5. Dev puts that keypair's **secret** into `ADMIN_SECRET_KEY` on their own Vercel
   project — it never leaves the dev's possession.

Public keys are safe to share anywhere. Secret keys never go over Telegram/email/
chat, even "encrypted" or "deleted after."

---

## Reward economics (current)

- Reward balance in contract: **10,990 xLMNR**
- Reward rate: **115,741 stroops/sec** ≈ **1,000 xLMNR/day total** across all pools
  → ~11 days of runway at current funding. Top up with `fund()` or lower the rate
  with `set_reward_rate()` to extend.

---

## Launch checklist

- [x] Contract upgraded to xLMNR + funded + 3 pools registered
- [x] Cron `POOL_CONFIG` updated to the 3 new pools (on Brandon's project)
- [ ] Merge site-rebuild → main (site goes live)
- [ ] Dev sets PUBLIC env vars on their Vercel → placeholder banner clears
- [ ] Admin handoff (dev generates keypair → Brandon set_admin)
- [ ] Co-locate cron on dev's project (or keep on Brandon's + share Blob token)
- [ ] Disable Brandon's old cron once dev's is running
- [ ] Stellar Expert verified-source registration (submit v0.2.0 release URL)
