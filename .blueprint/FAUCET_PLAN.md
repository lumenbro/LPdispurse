# Faucet — Deferred Feature Scope

**Status:** Deferred. Will be implemented after the marketing site is finalized.
**Date scoped:** 2026-06-17
**Source:** Dev's Telegram request 2026-06-15: *"may as well create a faucet ppl can come collect 100 tokens a day or whatever, and we'd be in business."* Dev confirmed smart-contract approach 2026-06-16.

## Goal

A small daily faucet on the LUMENAIRE landing page (`thelumenaire.com` root, NOT `/staking`) where new visitors can claim a small amount of xLMNR (~100 per day) to bootstrap the holder base.

**Why landing page, not /staking:** different user persona. The faucet is for first-time visitors who don't yet hold xLMNR; `/staking` is for users who already provide LP. Mixing them confuses both audiences.

## Design decisions made

| Decision | Rationale |
|----------|-----------|
| **Smart contract, NOT backend-signed** | No admin secret in env vars. Trustless rate limit. Dev approved 2026-06-16. |
| **Standard G... addresses (no passkey wallet)** | User decision 2026-06-17. Protocol 27/28 will add native smart-account support; not worth building custom passkey flow now. |
| **Skip smart-account wallet pattern** (lumenbro.com style) | Same reason as above. Adds friction + deployment cost per user. |
| **Per-address daily rate limit via Soroban temporary storage** | Industry standard. TTL on temp storage = the cooldown. Auto-deletes after expiry → zero ongoing storage cost. |
| **Defense stack (industry standard)** | Cloudflare Turnstile (free) + contract rate limit + Vercel Edge IP soft limit. Skip social verification, PoW, quest platforms — overkill for this drip value. |
| **Possible optional addition: require xLMNR trustline before claim** | Near-free Sybil dampener — each Sybil identity must add a trustline (0.5 XLM min balance), filtering drive-by attacks. |

## Architecture sketch

```
thelumenaire.com landing page
  ↓
[Connect wallet — any Stellar wallet]
  ↓
[Cloudflare Turnstile invisible challenge]      ← Layer 1: bot deterrence
  ↓
[Claim 100 $xLMNR] button
  ↓
API route /api/faucet-claim (Vercel)
  ↓ verify turnstile token + IP rate limit       ← Layer 3
  ↓ build + return tx for user to sign
  ↓
User signs in wallet, submits
  ↓
Faucet Soroban contract: claim(user)
  ↓ check temporary storage rate limit            ← Layer 2: the real one
  ↓ transfer 100 xLMNR to user
  ↓ set TTL temp entry → auto-expires after 24h
```

## Contract design (~80 LOC + tests)

Separate package `contracts/faucet/` in LPdispurse — NOT bolted onto `lp-staking`. Faucet is a different concern; don't bloat the audited staking contract.

```rust
pub fn initialize(env, admin, token, drip_amount, cooldown_secs)
pub fn claim(env, user) -> Result<i128>     // user.require_auth + rate-limit check
pub fn fund(env, funder, amount)            // load xLMNR in
pub fn withdraw(env, admin, amount)         // admin pull funds out
pub fn set_drip_amount(env, admin, amount)  // admin adjust
pub fn set_cooldown(env, admin, secs)       // admin adjust
pub fn set_admin(env, admin, new_admin)     // transfer admin
pub fn upgrade(env, admin, new_wasm_hash)   // future-proof
```

Storage:
- Instance: Admin, Token, DripAmount, CooldownSecs
- Temporary: `LastClaim(Address)` with TTL = cooldown — rate limit auto-resets when expires

## Open questions for dev before implementation

1. **Drip amount + cooldown:** 100 xLMNR / 24h? Or different?
2. **Initial faucet funding:** how much xLMNR seed (50K = ~500 days @ full daily claims)?
3. **Captcha decision:** Cloudflare Turnstile (free, invisible) or zero friction?
4. **Trustline requirement:** require user has xLMNR trustline before claim? (near-free Sybil dampener)
5. **Landing page placement:** dedicated `<Faucet>` section, OR add a Claim button to Hero CTA row alongside Buy/Follow/Whitepaper?

## Implementation steps when greenlit

1. Branch `contracts/faucet` in LPdispurse
2. Write contract + tests
3. Tag `faucet/v0.1.0` → verified build workflow produces WASM
4. Deploy + initialize on mainnet (admin = same wallet as staking, or fresh keypair)
5. Fund with seed xLMNR
6. New `<Faucet>` component on LUMENAIRE site
7. API route `/api/faucet-claim` with Turnstile verification
8. (Optional) Trustline check in contract claim()
9. Stellar Expert verified-source registration

## Estimated effort

- Contract + tests + verified build: **~1 day**
- Frontend section + API route + Turnstile integration: **~half a day**
- Mainnet deploy + verification: **~1 hour**

Total: ~1.5 days of focused work, deferrable until the marketing site is fully shipped.

## Why we're deferring

User decision 2026-06-17: finalize the marketing site first (Trade, Journey, Footer sections still pending). Faucet is a net-new feature on top of an already-extended scope. Better to ship the announced site (with `/staking`) first, then add the faucet as a v2 feature.
