# lp-staking v2 — Rewrite & Adversarial Review Log

**Status as of 2026-08-24:** v2 rewritten, 61 tests pass, builds `wasm32v1-none` (~36KB).
NOT yet committed, NOT deployed. Codex peer-review loop in progress (round 4).

## Decisions locked in
- **Fresh redeploy**, not upgrade-in-place (zero stakers on v1, so nothing to migrate).
- **NON-UPGRADEABLE**: no `upgrade` entry point. `withdraw` deliberately contains zero
  accumulator math so the treasury is always recoverable.
- **Per-pool `reward_rate`** stored in `PoolState` (Option A), tunable via `set_pool_rate`
  without redeploy. All pools start equal (~4000 tokens/day) = Python-bot parity.
- **Reward denominator = the epoch's authenticated `total_lp`** posted with each Merkle root.
  Mirrors the bot's `percent = balance / total_shares`. NOT `total_staked`.
- **Operator role**: `update_stake` only, DECREASE-ONLY on existing records.
- **soroban-sdk pinned `=27.0.6`** (mainnet is Protocol 27). Target is `wasm32v1-none`
  (`wasm32-unknown-unknown` is rejected by modern Soroban). rustc 1.95 ≥ MSRV 1.91.

## Review loop (Codex gpt-5.6-sol, medium, read-only)

### v1 review — findings that drove the rewrite
C-1 unauth `initialize`; H-1 stale-epoch reward over-accrual (prove-once-harvest-forever,
confirmed by both reviewers); H-2 `remove_pool` corruption; H-3 TTL ghost stake; H-4
overflow wedge; M-1 per-pool rate multiplication; M-2 no solvency accounting; M-3 arbitrary
token replacement; M-4 CEI; M-5 unbounded loop; L-1..L-4.

### v2 round 1 — 3 High, verdict "not ready"
- **H-NEW-1** operator could fabricate stake + drain via `claim` → **fixed**: decrease-only,
  existing records only.
- **H-NEW-2** stale positions diluted active stakers (I had frozen earnings but left the
  amount in the denominator — the exact "mixes both policies" error Codex warned about in the
  v1 review) → **fixed**: `total_lp` denominator.
- **H-NEW-3** no MAX_STAKE → a record could become permanently unsettleable as the
  accumulator grew. **REFUTED my claim** that U256+MAX_RATE+MIN_STAKE made overflow
  unreachable → **fixed**: `MAX_STAKE=1e21`, accumulator ceiling `1e35` that CLAMPS (never
  errors), `admin_force_clear_stake` emergency path with zero reward math.
- M-NEW-1 `snapshot_ledger=u32::MAX` locks epochs forever → **fixed** (freshness bounds).
- M-NEW-2 flooring discards emission under a frequent cron → **fixed** (`reward_remainder`).
- L-NEW-1/2/4 → **fixed**. Also corrected my WRONG TTL comments (Protocol 23+ auto-restores
  archived entries; a contract cannot observe one as missing).

### v2 round 2 — 1 High blocker
- **H-R2-1**: decrease-only rejected *increases*, but setting a stale record to an EQUAL or
  1-stroop-lower amount still advanced `epoch_id` and re-based debt on the LIVE accumulator,
  restarting accrual with no proof. My test only covered increases. → **fixed**: operator
  calls preserve `staker.epoch_id` and settle against `settle_acc`; admin retains advancement.
- L-R2-1 remainder re-scaled across a denominator change → **fixed** (cleared at boundary).
- L-R2-2 zero tombstones → **fixed**.
- **M-R2-1 (NOT a code fix — OFF-CHAIN)**: nothing on-chain checks that the SUM of leaf
  balances ≤ `total_lp`. A root with 10 users at 100 declaring `total_lp=100` accrues 10x
  intended emission. Must be asserted in the cron.

### v2 round 3 — 1 High blocker
- **Proof replay**: `stake` rejected same-epoch reuse only when `staked_amount > 0`, so after
  an operator zeroed the record (or unstake/claim removed it) the SAME current-epoch proof
  could be replayed to restore the old balance. → **fixed**: persistent
  `DataKey::LastProvenEpoch(user, pool)`, checked before any mutation, written on successful
  stake, never deleted by reconciliation/unstake/claim.
  4 regression tests added; VERIFIED they fail when the guard is disabled.

### v2 round 4 — CLEAN VERDICT
> "YES. This build is safe to deploy immutably to mainnet under the stated trusted-admin,
> non-custodial, and off-chain cron-invariant model. The round-3 replay blocker is closed.
> I found no remaining immutable-deployment blocker."

Verified: guard read after proof validation and before any mutation; written only after
staker+pool totals update (later failure rolls back the whole invocation); no key collision;
no marker can exist for a never-proven user; epoch 0 unreachable by proofs (first root is
epoch 1); inactive pools reject `stake` before the marker is read. Archival cannot turn a
spent marker into an absent one — under CAP-0066 an omitted archived entry fails the
transaction rather than decoding as `unwrap_or(0)`.
Cost: one persistent entry per distinct proven (user, pool).

**Artifact at verdict:** 61 tests pass, `wasm32v1-none` 36,644 bytes,
SHA-256 `37f34a86498301ba1cc071a1668c9612a1f7969cf2da1db915bb353787d46143`
(hash will change on any recompile — re-verify at deploy time).

## Remaining non-code risks (accepted, or to decide)
- **Trusted admin (I-2)**: even without `upgrade`, a compromised admin can drain the pool,
  post fabricated roots, reconcile stakes, change the reward token. **Multisig admin is the
  real answer before meaningful TVL.** DECIDE BEFORE DEPLOY.
- **`total_lp` is a trusted oracle** (M-R2-1) — cron correctness is economically load-bearing.
- Remainder reset discards <1 accumulator unit per epoch boundary (< ~1000 stroops at max
  total_lp); keep root cadence low and track cumulative dust.
- Lost admin key = treasury permanently lost (no upgrade path).

## Off-chain cron invariants (MUST implement before deploy)
Leaf format changed — contract and cron MUST match exactly or every proof fails:
```
SHA256(0x00 || "LPSTAKE_V2" || contract_address_xdr || pool_id(32)
       || pool_index_u32_be || user_address_xdr || lp_balance_i128_be || epoch_id_u64_be)
node = SHA256(0x01 || min(l,r) || max(l,r))
```
Plus: sum(leaf balances) ≤ `total_lp` (equal when all holders included); one leaf per
(pool,address,epoch); `MIN_STAKE ≤ total_lp ≤ MAX_STAKE`; each balance ≤ `total_lp`;
`prev_snapshot < snapshot_ledger ≤ current_ledger` and age ≤ 120,960 ledgers; proof len ≤ 32;
verify every proof locally against the root before posting; re-read on-chain epoch/prior
snapshot immediately before submit; operator key only (never the admin key) in the hot cron.
Full checklist is in the round-3 Codex output.

## Next steps
1. Finish the review loop until Codex returns a clean verdict.
2. Paired off-chain change in `staking-site/lib/contract.ts` (leaf format + `total_lp` +
   invariant assertions), tested against the contract.
3. Decide multisig admin.
4. Generate fresh admin + operator keypairs in the CLI keychain (NEVER commit; never put the
   admin key in Vercel — operator key only).
5. Deploy with constructor args, re-add 3 pools, move the 10,990 xLMNR from v1, run the
   stellar-expert verified-build workflow (bump it off `v22.8.1`).
