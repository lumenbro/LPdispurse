# lp-staking v2 — Rewrite & Redeploy Plan

**Date:** 2026-08-08
**Why now:** The staking contract has **zero stakers** and needs a redeploy anyway to
rotate the admin off the compromised key. A two-pass security review (Claude + an
independent Codex/gpt-5.6 pass) found several real issues. Since nothing is live, the
clean move is a **fresh redeploy of a corrected contract** with a brand-new admin key
generated in the CLI keychain (never committed), rather than patching live state.

Current (v1) contract: `CBDA7H3XLKL4ECSI54IPRGMYZLZFEIBR5FTEHI6DAH3UVHB53LMGBVAE`
holds 10,990 xLMNR reward pool under the compromised admin `GCKGWGRR…RP7D`.

---

## ⛔ ONE DECISION NEEDED FROM THE DEV — emission model

The v1 contract applies the **full `reward_rate` to EACH pool independently**, so total
emission = `rate × number-of-pools`. With 3 pools that's **3× the tokens/sec** a single
"rate" implies — a silent over-emission / insolvency risk. Pick one for v2:

| Option | Behavior | Trade-off |
|---|---|---|
| **A. Global budget + weights** (recommended) | `rate` = total emission/sec for the whole contract, split across pools by a per-pool weight (MasterChef "allocation points"). | Adding pools never increases total emission. Most flexible. A bit more code. |
| **B. Global budget, equal split** | `rate` = total emission/sec, divided equally among active pools. | No over-emission, no tuning — but every pool emits equally regardless of size. |
| **C. Per-pool rate** (v1 behavior) | Each pool emits full `rate`/sec; total = rate × N. | Matches v1 exactly, but adding a pool multiplies total emission + liability. |

**Everything below is independent of this choice and will be implemented regardless.**

---

## Fixes going into v2

### Critical / High
- **H-1 (confirmed by both reviewers) — multi-epoch reward over-accrual.** In v1, a user
  who proves LP once in epoch 1 and then dumps their LP can **harvest rewards forever**,
  because the single pool-wide `prev_acc_reward_per_share` is overwritten (advanced) on
  every new epoch and stale stakers settle against that moving value.
  **Fix:** store an accumulator snapshot **keyed by epoch** (`EpochEndAcc(pool, epoch_id)`)
  captured when that epoch ends; stale stakers always settle against the snapshot for
  **their own** epoch (frozen), never a moving field. Prove-once = exactly one epoch of rewards.
- **C-1 — unauthenticated `initialize` (deploy front-running).** Anyone could initialize a
  freshly-deployed instance and seize admin.
  **Fix:** use a Soroban **constructor** (`__constructor`) so init is **atomic with deploy** —
  no window to front-run. Admin/token/rate are set at deploy time by the deployer.
- **H-2 — `remove_pool` corrupts accounting / doesn't actually deactivate.** v1 only zeroes
  `total_staked`; the pool stays usable, can go negative on unstake, and can be reactivated.
  **Fix:** explicit `active` flag; reject stakes/roots on inactive pools; stop accrual for
  inactive pools; don't zero `total_staked` while staker records exist (unstake/claim still work).
- **H-3 — persistent-storage TTL "ghost stake."** An idle staker's record can expire (~30d)
  while their amount lingers in `total_staked` (kept alive by others), diluting everyone; and
  `get_pool_state` silently defaults expired state to zero.
  **Fix:** much longer TTL for economically-live entries; stop silently defaulting critical
  pool state; document that idle stakers must be reconciled/kept warm.
- **H-4 — overflow can permanently wedge the contract.** A bad `reward_rate` makes
  `update_pool` panic, and `set_reward_rate` calls `update_pool` *before* storing a safer
  rate → unfixable without an upgrade.
  **Fix:** overflow-safe `mul_div` via `U256` for the accumulator + pending math; validate
  `0 ≤ rate ≤ MAX_RATE` on the way in so a wedging rate can never be stored.

### Medium / Low (cheap, included)
- **M-4 — CEI ordering:** update staker state **before** the token transfer in `claim`.
- **L-1 — Merkle leaf binding:** bind the leaf to the **contract address + actual `pool_id`**
  (not just the pool index) to kill cross-deployment proof replay. ⚠️ **Requires a matching
  change in the cron's off-chain tree builder** (`staking-site/lib/contract.ts`).
- **L-2 — monotonic `snapshot_ledger`:** reject non-increasing snapshot ledgers in `set_merkle_root`.
- **L-3 — reject negative rate** (folded into rate validation; use an explicit pause if wanted).
- **L-4 — two-step admin transfer** (`propose_admin` / `accept_admin`) so a typo'd address
  can't permanently lock out admin. (Less critical now since v2 deploys with the right admin
  from genesis, but good hygiene for future rotations.)

### Deferred / documented, not code (admin-trust — I-2)
Admin remains powerful by design (withdraw pool, post roots, `update_stake`, upgrade). For a
production launch, consider multisig admin + withdrawal caps + a public root-generation audit
trail. Not blocking for relaunch.

---

## Redeploy steps (once emission model is chosen)
1. Rewrite contract with the fixes above; add PoC tests proving H-1/H-2 **before-and-after**;
   run the full suite (all green) + smoke tests.
2. **Reproducible build pin** (so the stellar-expert verified build matches): pin
   `soroban-sdk = "=22.0.9"` (v1's actual resolved version — v1 `Cargo.lock` has 22.0.9,
   not 22.0.0), commit `Cargo.lock`, add `rust-toolchain.toml`, build `--locked`, pin the
   Soroban CLI/container.
3. **Generate fresh admin keypair in the CLI keychain** (do NOT commit; do NOT put the
   secret in any repo or Vercel env).
4. Deploy v2 with the constructor setting the new admin + xLMNR token + chosen rate.
5. Re-add the 3 pools (xLMNR/XLM, xLMNR/SHX, xLMNR/VELO).
6. Move the reward pool: `withdraw` 10,990 xLMNR from v1 (signed by old `mainnet-deployer`)
   → `fund` v2.
7. Update the cron (`lmnr-staking` Vercel): new `NEXT_PUBLIC_CONTRACT_ID`, new pool IDs, the
   L-1 leaf-binding change, and a **minimal operator key** — do NOT reuse the full admin key
   in Vercel plaintext (that reintroduces the incident). Ideal: separate operator role, or at
   minimum a dedicated key that only ever calls `update_stake`.
8. Run the stellar-expert verified-build workflow against the new WASM.

## Residual notes
- The cron currently signs `update_stake` with the **admin** key. v2 keeps `update_stake`
  admin-gated, so the cron still needs admin unless we add an operator role. Decide whether to
  add a minimal `operator` role in v2 (recommended: keeps the hot Vercel key least-privilege).
- L-1 leaf change is a **coordinated** change: contract + cron tree builder must match exactly
  or all proofs fail. Test against the cron before relaunch.
