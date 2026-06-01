# LPdispurse Project Status

**Last reviewed:** 2026-05-31

## What this project is

LP staking rewards system for LMNR token (migrating to xLMNR) on Stellar. Three parts:

1. **`rewards_disbursement_bot/`** — Original Python disbursement bot. Superseded by the staking contract for active stakers; code still here for reference.
2. **`staking-site/`** — **Source of truth that's now ported** into the LUMENAIRE GitHub repo. Original Next.js 14 site with Vercel cron, Merkle indexer, on-chain admin client.
3. **`contracts/lp-staking/`** — Soroban contract (Rust, soroban-sdk 22.0.0). Live on mainnet at `CBDA7H3X...BVAE`. Has `upgrade()` entry point but currently NO `set_lmnr_token` setter (would need to be added for in-place SAC swap).

## Active deployment landscape

| Component | Location | Status |
|-----------|----------|--------|
| Legacy staking site | `lmnr-staking.vercel.app` → `staking.lumenbro.com` | Still live, still running daily cron on legacy LMNR contract |
| Legacy staking contract | mainnet `CBDA7H3X...BVAE` | Live, cron posting Merkle roots daily 00:00 UTC |
| Admin wallet | `GCKGWGRR...RP7D` | Active, shared with an unrelated price-feed bot at 06:00 UTC |
| **NEW: LUMENAIRE site** | `XLMNR/LUMENAIRE` repo, deployed to `v0-v0jose60639eb37ccd-*.vercel.app` (Vercel project name is a v0 leftover) | In active development on `site-rebuild` branch — see `LUMENAIRE_SITE_STATUS.md` |
| XLM/LMNR LP | pool `8d94b8d2...0351` | 14 trustlines, alive — eventually deprecated when xLMNR pools come online |
| xLMNR asset | issuer `GDKA6WVMFSA73BMEVKPO6WXSSWP4MPRBDJVSXLLSEVIEVH226L5RJ7NL`, code `xLMNR` | Live per stellar.toml (Lumenaire v2) |

## Known characteristics & gotchas

- **LMNR token SAC is stored, not hardcoded**, but **has no setter** — `initialize` is the only writer. Migration to xLMNR requires either adding `set_lmnr_token` admin function (see `MIGRATION_xLMNR.md`) OR deploying a fresh staking contract pre-initialized with xLMNR SAC.
- **Pool IDs are storage-backed** via `add_pool`/`remove_pool` — easily added/removed without source changes.
- **Admin wallet is shared** with another project doing `set_prices` calls at 06:00 UTC. Ours runs at 00:00 UTC. No conflict but worth noting.
- **`@vercel/blob`** stores Merkle proofs and per-epoch manifests. Tied to Vercel — porting to another host requires swapping the blob backend.
- **Epoch carryover** — when a new Merkle root is posted, existing stakers carry over without re-proving (commit 5854a3f fixed reward accumulation across epochs).
- **LUMENAIRE Vercel project** name is `v0-v0jose60639eb37ccd` (a Vercel v0 generator leftover from before the dev brought us in). Team `stellarowlpha`. Should be renamed eventually.

## Files of note

- `contracts/lp-staking/src/lib.rs` — contract entry points; `upgrade()` at L152, `initialize()` is only place LmnrToken gets set
- `contracts/lp-staking/src/storage.rs` — DataKey + getters/setters; `set_lmnr_token` helper exists at L68 but no public entry point exposes it
- `staking-site/app/api/cron/route.ts` — daily cron handler, `maxDuration: 300`
- `staking-site/lib/indexer.ts` — Horizon snapshot → Merkle build → on-chain post → batch reconcile
- `staking-site/lib/constants.ts` — `CONTRACT_SPEC` (base64 XDR), env-driven `POOL_CONFIG`
- `.env.production.local` — Vercel-pulled secrets for the LEGACY lmnr-staking project (DO NOT COMMIT, in `.gitignore`)
- **`/home/brandonian/LUMENAIRE/`** — separate repo clone; the in-progress site rebuild + staking port lives there, NOT in this project folder

## Cross-references

- [LUMENAIRE site status](LUMENAIRE_SITE_STATUS.md) — what's done/pending on the rebuild branch
- [xLMNR migration roadmap](MIGRATION_xLMNR.md) — contract changes, deployment sequence, verified build setup

## Open work tracked

- xLMNR contract migration (in flight as of 2026-05-31 — user has new contract address)
- LUMENAIRE marketing site has 3 of 8 sections deferred (Tokenomics blocked on dev, Trade/Journey/Footer unblocked)
- Staking page integration ready, dormant until xLMNR env vars set in Vercel
- Env var handoff doc still pending
