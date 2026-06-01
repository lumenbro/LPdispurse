# xLMNR Migration Roadmap

**Status:** Planning — awaiting xLMNR SAC address + new SDEX pool ID(s) from dev.
**Date drafted:** 2026-05-14
**Contract on mainnet:** `CBDA7H3XLKL4ECSI54IPRGMYZLZFEIBR5FTEHI6DAH3UVHB53LMGBVAE`
**Admin wallet:** `GCKGWGRRJBUKYCTV2AZBSEI3SVLEBFOF7OD2AEFXA2XPZV3MJUGKRP7D`

---

## Current state (verified 2026-05-14)

- Vercel project `lmnr-staking` (prj_r92SCECnSLKE1sR1XhxGevO6AelC) running daily cron at 00:00 UTC
- Cron is healthy — 2026-05-15 00:00 run posted `set_merkle_root` + router `exec` (batch_update_stake), both succeeded
- Pool 0 = XLM/LMNR LP `8d94b8d20d3a71f08fe35279d766fae66af14d0cdacf2cd63b37c778db5b0351` — 14 trustlines, 388K shares, alive on SDEX
- Contract has `upgrade(admin, new_wasm_hash)` — in-place WASM swap works, state preserved
- LMNR token SAC is stored in `DataKey::LmnrToken` (instance storage), **set once at `initialize`**, **no setter exists**
- SDEX pool IDs are storage-backed via `add_pool` / `remove_pool` — not hardcoded
- No `.github/workflows/` exists yet — verified builds not set up

---

## What needs to change

### 1. Contract source changes (`contracts/lp-staking/src/`)

**Add a `set_lmnr_token` admin function.** This is the only structural blocker — without it we cannot switch the reward token without redeploying a fresh contract.

```rust
// lib.rs — add near set_admin / upgrade
pub fn set_lmnr_token(env: Env, admin: Address, new_token: Address) -> Result<(), ContractError> {
    Self::require_admin(&env, &admin)?;
    storage::extend_instance_ttl(&env);
    storage::set_lmnr_token(&env, &new_token);
    Ok(())
}
```

`storage::set_lmnr_token` already exists (`storage.rs:68`). Test should cover: non-admin rejected, admin succeeds, `reward_balance` reads from new token afterwards, pending rewards from old token are stranded (acceptable — admin should `withdraw` old LMNR before swapping).

**Suggested order of operations for the swap call sequence:**
1. `withdraw(admin, <full LMNR balance>)` — pull old LMNR out
2. `set_lmnr_token(admin, <xLMNR SAC>)` — flip the pointer
3. `fund(admin, <xLMNR amount>)` — load new reward token
4. `set_reward_rate(admin, <new rate>)` if rate needs adjusting for the new token's decimals/economics

### 2. Pool registry changes

Pool IDs are not hardcoded — they live in storage. Just call:
- `add_pool(admin, <new xLMNR pool ID 32 bytes>)` for each new SDEX LP
- `remove_pool(admin, 0)` to retire the old XLM/LMNR pool once liquidity has migrated

**Caveat:** `remove_pool` settles rewards and resets `total_staked` — existing stakers in pool 0 can still claim pending rewards afterwards, but they should claim them in **old LMNR** before step 1 (withdraw), or those rewards become unclaimable. **Communicate a claim deadline to current stakers before the cutover.**

### 3. Frontend (`staking-site/`)

- Regenerate TS bindings: `cd contracts/lp-staking && stellar contract bindings typescript --network public --contract-id <id> --output-dir ts-bindings`
- Update `staking-site/lib/constants.ts` `CONTRACT_SPEC` array with the new spec entries (will now include `set_lmnr_token`)
- Update Vercel env `POOL_CONFIG` with the new pool index + pool ID(s)
- Update copy: `app/page.tsx`, `app/layout.tsx`, `app/admin/page.tsx` — currently says "LMNR" everywhere
- If dev moves site to his own domain: bring `CRON_SECRET`, `ADMIN_SECRET_KEY`, `BLOB_READ_WRITE_TOKEN`, and `POOL_CONFIG` to the new host; reconfigure cron scheduler (Vercel-style cron only works on Vercel — elsewhere needs a different scheduler)

### 4. Vercel-specific dependencies if moving hosts

- `@vercel/blob` stores Merkle proofs + per-epoch manifests. On a non-Vercel host: swap to S3 / R2 / Supabase storage. Touched files: `staking-site/lib/indexer.ts` (`put`/`list` calls), `staking-site/app/api/proof/[pool]/[address]/route.ts`.
- `vercel.json` cron → host's equivalent (Cloudflare Cron Triggers, GitHub Actions schedule, systemd timer, etc.)
- `maxDuration: 300` in `app/api/cron/route.ts` is a Vercel-Pro setting; other hosts have their own timeouts

---

## Deployment sequence (assuming verified build workflow set up first)

1. Branch `xlmnr-migration`
2. Add `set_lmnr_token` + test in `contracts/lp-staking/`
3. Run `cargo test` — all tests pass
4. Commit + tag `v4.0.0`
5. GitHub Action builds verified WASM, publishes release artifact
6. `stellar contract install --wasm <release-artifact.wasm> --source admin --network public` → returns hash
7. `stellar contract invoke ... -- upgrade --admin <addr> --new_wasm_hash <hash>`
8. Verify on Stellar Expert that contract now shows verified source linked to v4.0.0 tag
9. **Communicate claim deadline** to existing stakers — give them N days to claim pending LMNR rewards
10. After deadline: `withdraw` old LMNR, `set_lmnr_token` to xLMNR, `fund` with xLMNR, `add_pool` new IDs, `remove_pool` old
11. Regen TS bindings, update site `CONTRACT_SPEC` + Vercel `POOL_CONFIG`, redeploy site
12. Trigger a manual cron run to seed first xLMNR epoch — verify proofs in blob + on-chain merkle root match

---

## Stellar Expert verified build setup

Reference: `/home/brandonian/soroban-policies/.github/workflows/verified-build.yml`

Pattern to copy:

```yaml
# .github/workflows/verified-build.yml
name: Verified Build
on:
  push:
    tags: ['v*']
  workflow_dispatch:
    inputs:
      release_name:
        description: 'Release name (e.g. v1.0.0)'
        required: true
        type: string

permissions:
  id-token: write
  contents: write
  attestations: write

jobs:
  release-lp-staking:
    uses: stellar-expert/soroban-build-workflow/.github/workflows/release.yml@v22.8.1
    with:
      release_name: ${{ github.event.inputs.release_name || github.ref_name }}
      release_description: 'LP Staking — Merkle-proof-gated LP share staking with epoch reward accumulator'
      package: 'lp-staking'  # must match Cargo.toml [package].name
    secrets:
      release_token: ${{ secrets.GITHUB_TOKEN }}
```

**Prereqs:**
- Repo must be on GitHub (currently local — needs push to a remote, public or private with workflow enabled)
- `Cargo.toml` package name must match the `package:` input
- Tag releases as `vX.Y.Z` to trigger
- After release, register the contract on https://stellar.expert/explorer/public/contract/validation pointing at the release tag

**Why this matters:** Stellar Expert's reusable workflow uses a pinned Docker image so the WASM hash is deterministic. Anyone can re-run the build and verify the hash matches what's on-chain. This is the Etherscan-equivalent "verified source" badge.

Reference repo's README explanation:
> Each tagged release (`v*`) triggers a GitHub Actions workflow that:
> 1. Compiles the contract with a pinned Rust toolchain
> 2. Generates an attestation
> 3. Creates a GitHub Release with build attestation
> 4. Enables Stellar Expert contract validation
>
> **Deploy from release artifacts** (not local builds) to maintain the trust chain.

---

## Open questions for the dev

1. **xLMNR SAC address** on mainnet?
2. **New SDEX pool IDs** — pairs (xLMNR/XLM? xLMNR/USDC?) and target launch dates
3. **Reward rate** — same per-second emissions as old LMNR, or different? (Stored as stroops/sec, so decimals must match xLMNR's)
4. **Claim deadline policy** — how long do current LMNR stakers get to claim pending rewards before old LMNR is withdrawn?
5. **Site migration** — keep on Vercel under dev's account, or port to dev's website infrastructure? (Affects blob storage + cron scheduling refactor scope)
6. **Token relationship** — is xLMNR a 1:1 wrap of LMNR, a swap, or new emission? Affects whether to honor old LP positions or require re-staking.

---

## Estimate

| Task | Scope | Time |
|------|-------|------|
| `set_lmnr_token` + tests | ~20 LOC + test cases | 1 hr |
| Verified build workflow setup | First-time Docker debug | 2–4 hr |
| Mainnet upgrade + token swap + pool migration | Sequential admin txs | 1 hr (careful) |
| Site updates (constants, copy, env) | If staying on Vercel | 1 hr |
| Site port to dev's host | If leaving Vercel — blob backend + cron rewrite | 1–2 days |
| Smoke test + first xLMNR epoch verification | End-to-end | 2 hr |

**Total if staying on Vercel:** ~1 day of focused work.
**Total if porting site:** ~3 days.
