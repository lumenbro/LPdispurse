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

## Testnet dry run — PASSED (2026-08-24)

Contract `CBX6CJ2TVE65N7TSPM3TB32M3ANRGFK4UOESJLCGTS5DNQONSTGPBFV7` (testnet).
Script: `scripts/testnet-dryrun.sh` (repeatable; `FRESH=1` for new keys).

Confirmed ON-CHAIN, not just in unit tests:
- Leaf format: `stake` accepted with a proof built by the TYPESCRIPT builder →
  merkle.ts and merkle.rs agree against a real deployed contract.
- Constructor set admin+operator atomically at deploy.
- **H-1**: stale pending `5787037037` immediately after the epoch-2 transition and
  IDENTICAL 45s later. Frozen settlement verified live.
- **H-R2-1**: operator reconciled a stale record down; `epoch_id` stayed 1.
- Negative tests all rejected: proof replay, operator withdraw, operator
  set_pool_rate, operator stake INCREASE.
- Real accrual + claim (~2314 TLMNR over ~50s at the 4000/day rate).

Setup gotchas found here (would have hit mainnet identically):
- Classic assets need a TRUSTLINE on every G-account holding them. **The staking
  UI must check the user has an xLMNR trustline before offering `claim`, or the
  transfer fails.**
- No liquidity pools or paired assets are needed to test: the contract never reads
  on-chain LP state (`pool_id` is just 32 bytes). One SAC reward token suffices.

## Cloudflare Workers signing — RESOLVED, no spike needed
`@stellar/stellar-sdk` signing is proven in production across ~10 Workers in this
account (Classic AND Soroban), with NO polyfills. Recipe: `nodejs_compat`, SDK
14.4–15.0, named imports, own hashing via `crypto.subtle`, `Uint8Array` at runtime.
Reference: `MAHORAGA/sdex-mm/src/trade/sdex-ops.ts` (local key),
`MAHORAGA/sdex-mm/src/trade/aqua-swap.ts` (full Soroban round trip in-isolate),
`LumenBroMobile/x-tip-bot` (cron triggers + Soroban).

**Better than a raw Worker secret — the "signer-rack":** a Rust axum service in a
Phala Intel-TDX enclave (`LumenBroMobile/phala-tee-signer/rust-signer/`). Keys derive
from a hardware root and never leave the enclave; Workers call it over `fetch()` and
push an `xdr.DecoratedSignature`. `POST /sign` DECODES THE XDR AND ENFORCES AN
OPERATION WHITELIST (403 otherwise).
→ Register an `lp-staking-*` policy prefix permitting ONLY `update_stake`. Then a
compromised Worker + leaked auth secret still cannot post roots or withdraw —
defense in depth over the on-chain decrease-only rule.
Docs: `MAHORAGA/sdex-mm/.blueprint/TEE-SIGNER.md`.

**Multisig pattern already in use** (answers the open admin question): sdex-mm runs
the TEE signer at weight 1 with a hardware "keystone" key at weight 10 and a high
threshold. Same shape as our operator/admin split — reuse it for the staking admin.

## Multi-leaf + proportionality + multisig — VERIFIED ON TESTNET (2026-08-24)

Contract `CC4NZ73RYXIGF5KZFJ5MPBXREKLFR23TAIUZQUQXRIL2XDYDTMQIWO4G`.

### Multi-leaf Merkle proofs (was previously unit-test-only)
4 holders, 2-element proof paths, ALL accepted by the deployed contract using
proofs built by the TypeScript builder. Forged proof (valid path + wrong balance)
correctly rejected. `total_staked` = 650000000000 = exact sum.

### Proportional accrual — EXACT
Over a clean 90s window, per-unit-stake accrual was IDENTICAL to 7 significant
figures across 0.5x / 1x / 2x / 3x stakes (`7.122507e-02`, spread 0.0000%).
Deltas exactly 0.5:1:2:3. The accumulator math is correct on-chain.

CAUTION FOR FUTURE RUNS: comparing raw `pending_reward` totals is INVALID —
stakes land in different ledgers (head start) and holders carry pending from
earlier epochs. An early version of the test flagged a false 6% anomaly that was
purely sampling drift. Always compare DELTAS over a common window. The script now
does this (`scripts/testnet-dryrun.sh` step 17).

### Multisig admin — WORKS, and thresholds ARE enforced
1. Added a co-signer (weight 10) to the admin account, master weight 1,
   thresholds 1 → `set_pool_rate` SUCCEEDED. **A classic multisig G-account can
   satisfy Soroban `require_auth`.** Safe to add the dev's wallet as a signer.
2. Raised thresholds to 11 (needs 10+1 = both signers) → a single-signer contract
   call was correctly REJECTED. Threshold enforcement is real.
3. ⚠️ At 2-of-2, even `set-options` to LOWER the threshold again failed with
   `TxBadAuth`. **A 2-of-2 admin that loses one signer is permanently locked out —
   the treasury is unrecoverable, and there is no upgrade path.**
4. Recovery verified: `stellar tx new ... --build-only` → `stellar tx sign
   --sign-with-key A` → `stellar tx sign --sign-with-key B` → `stellar tx send`.
   Thresholds restored. THIS IS THE REQUIRED RUNBOOK for any 2-of-2 admin op.

### Admin multisig — decision needed
- **Either-signer (weights >= threshold individually):** either party can operate
  alone, including `withdraw` of the whole reward pool. Convenient, but the dev
  gets unilateral treasury access.
- **2-of-2 (threshold > any single weight):** neither can act alone. Safer against
  a single compromised key, BUT see (3): losing either signer is terminal.
  If chosen, BOTH parties must keep durable backups and rehearse the runbook.

## TEE signer unavailable (~$40/mo, not being paid)
Operator key will be a plain Cloudflare Worker secret (`sdex-ops.ts` pattern:
`wrangler secret put` + `Keypair.fromSecret`). Acceptable because the ON-CHAIN
restrictions bound the blast radius: a fully compromised operator key can ONLY
decrease existing stakes — it cannot withdraw, set rates, post roots, create
records, raise amounts, or move the admin. Worst case is griefing (users must
re-prove), never fund loss.
Hardening: CF account is FIDO/Windows-Hello 2FA; scope the API token to this
Worker only; never commit `.dev.vars`.

### ⚠️ Soroban require_auth is gated by the MEDIUM threshold (verified 2026-08-24)
Tested directly on testnet with a 2-signer admin account (master w:1, co-signer w:10):

| thresholds (low/med/high) | can the w:1 key invoke the contract? |
|---|---|
| 1 / 1 / 10  (the sdex-mm config) | YES — including `withdraw`. Funds actually moved. |
| 1 / 10 / 10 | NO — blocked. |

**The sdex-mm threshold numbers must NOT be copied here.** In sdex-mm the w:1 key is a
POLICY-GATED TEE signer that can only place trades, so med=1 is safe there. This contract
has no policy gate: any signer meeting MED threshold gets full admin, including draining
the reward pool.

Also: with high=10 and master weight 1, the admin's OWN key can no longer change the
account's thresholds — that op must be signed by the w:10 co-signer.

**Recommended admin config (option A):** you w:10, dev w:10, med=10, high=20.
Either party can operate the admin page; changing signers requires BOTH, so neither can
unilaterally remove the other. If either key is lost, signer changes freeze permanently
but the contract stays operable by the survivor (treasury never stranded).
Escape hatch: the contract's two-step propose_admin/accept_admin can migrate admin to a
fresh account as long as the current account can still meet MED.

### Renounce path — VERIFIED (2026-08-24)
Q: can the operator renounce by zeroing their own signer weight, leaving the dev in control?
A: YES.

1. `set-options --master-weight 0`, signed by the w:10 co-signer (set_options is a HIGH
   threshold op, so the w:1 master could NOT sign its own removal). Result: master weight 0.
2. The renounced key is then powerless — a contract invoke with it is rejected.
3. **The surviving added signer CAN still operate the contract.** Verified at protocol level:
   built an invoke with `source = admin ACCOUNT`, signed ONLY with the added (non-master)
   signer's key, submitted → SUCCESS. This is exactly the wallet-connect/admin-page path.

TOOLING NOTE: the Stellar CLI cannot do this — `contract invoke --sign-with-key <other>`
errors with "Address cannot be used to sign", and `--build-only` for a Soroban invoke
produces an unsimulated envelope (`TxMalformed` on submit). Multisig contract ops must go
through the SDK/wallet path: build -> `simulateTransaction` -> `assembleTransaction` ->
sign -> `sendTransaction`. Classic ops (set_options) DO work via
`tx new --build-only | tx sign | tx sign | tx send`.

FREEZE CAVEAT (accepted — the shared admin account is a burner): if `high_threshold`
exceeds the surviving signer's weight, signer/threshold changes become impossible forever.
The contract itself stays fully operable as long as MED is still satisfiable.

CLEANER ALTERNATIVE to renouncing: use the contract's two-step
`propose_admin` -> `accept_admin` to move admin to the dev's OWN single-sig account.
No shared account, no frozen-signer edge cases, and the dev ends up with a normal wallet
they fully control.
