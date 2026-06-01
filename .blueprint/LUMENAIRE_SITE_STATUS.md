# LUMENAIRE Site Rebuild — Status

**Last updated:** 2026-05-31
**Repo:** `XLMNR/LUMENAIRE` (GitHub) — user has push access via `lumenbro` GitHub account
**Local clone:** `/home/brandonian/LUMENAIRE/` (NOT inside LPdispurse — separate clone)
**Active branch:** `site-rebuild` (off `main`)
**Vercel project:** `v0-v0jose60639eb37ccd` (team `stellarowlpha`) — name is a v0 generator leftover
**Preview URL:** `https://v0-v0jose60639eb37ccd-git-site-rebuild-stellarowlpha.vercel.app`
**Production URL** (untouched, still under-construction page): `https://www.thelumenaire.com`

## Stack

- Next.js 14 App Router
- TypeScript, Tailwind CSS, lucide-react
- pnpm for deps
- `@stellar/stellar-sdk`, `@vercel/blob`, `@creit-tech/stellar-wallets-kit` (added for staking integration)
- next.config.js has CORS headers for `/.well-known/stellar.toml`

## Marketing site progress (3 of 8 sections)

| # | Section | Status | Notes |
|---|---------|--------|-------|
| 1 | Nav | ✓ | Frosted glass, 6 pills + Staking pill + Buy $xLMNR CTA, mobile sheet, IntersectionObserver active-section tracking |
| 2 | Hero | ✓ | xLMNR character mascot (replaced LMNR cartoon), animated dots, glow halo, CTAs, supply strip, manifesto "Stellar moves the money / Lumenaire moves the people" |
| 3 | Features ("More Than a Meme") | ✓ | 3 cards: DeFi Platform, LP Staking (clickable, links to `/staking`), Higher Rewards |
| 4 | Tokenomics | ❌ pending | **Blocked on dev** for xLMNR-specific supply numbers (legacy spec had 30-50M burn target which dev removed) |
| 5 | Roadmap | ✓ | 5 phases per dev's final content: Launch & Liquidity (done) · xLMNR V2 Migration (active) · Staking (next) · Tipping Layer (next) · DeFi Suite (next) |
| 6 | Trade | ❌ pending | Unblocked — have xLMNR issuer from stellar.toml. Just need to build copy-to-clipboard + 3 DEX cards |
| 7 | Journey | ❌ pending | Unblocked — 3 short story cards |
| 8 | Footer | ❌ pending | Unblocked — community CTA + X handle `@X_LMNR` |

## Staking integration progress

- `/staking` route ported from `LPdispurse/staking-site/` — full UI working
- `/admin` route ported — admin dashboard with wallet connect
- `/api/cron/route.ts` + `/api/proof/[pool]/[address]/route.ts` ported
- 7 staking components under `components/staking/`, 5 lib modules under `lib/staking/`
- `WalletProvider` scoped via nested layout (only loads on `/staking` and `/admin`, not on marketing pages)
- Tailwind `lmnr-*` palette added
- Staking-specific CSS scoped via `.staking-root` class
- `bg-lmnr.jpg` background applied via background-image stack on `.staking-root` (NOT pseudo-elements — caused stacking-context bugs earlier; see commit `81b1942`)
- **`vercel.json` cron NOT enabled** — staking is dormant by design until xLMNR env vars are set in Vercel
- Placeholder banner on `/staking` shows when `NEXT_PUBLIC_CONTRACT_ID` is empty

## Important code locations

- `app/page.tsx` — marketing home, renders `<SiteNav />` + 5 section components
- `app/staking/page.tsx` + `app/staking/layout.tsx` + `app/staking/staking.css` — staking route + scoped styles
- `app/admin/page.tsx` + `app/admin/layout.tsx` — admin route
- `app/api/cron/route.ts` — daily reconcile + Merkle post (NOT triggered — no cron schedule)
- `app/api/proof/[pool]/[address]/route.ts` — proof lookup endpoint
- `components/site-nav.tsx` — handles both same-page sections (smooth scroll) AND route changes (Next.js Link)
- `components/staking/*` — full wallet/staking UI
- `lib/scroll.ts` — `smoothJumpTo(id)` shared utility
- `lib/staking/*` — contract client, Horizon helpers, Merkle, indexer

## Env vars needed when dev populates Vercel (currently unset → placeholder mode)

| Var | Source | Notes |
|-----|--------|-------|
| `NEXT_PUBLIC_CONTRACT_ID` | xLMNR staking contract addr | Setting this hides the placeholder banner |
| `NEXT_PUBLIC_ADMIN_WALLET` | admin G... address | For admin page wallet gate |
| `NEXT_PUBLIC_HORIZON_URL` | `https://horizon.stellar.org` | mainnet |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.lightsail.network/` or similar | Soroban RPC |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | `Public Global Stellar Network ; September 2015` | |
| `POOL_CONFIG` | JSON array of `{index, poolId}` | new xLMNR SDEX pool IDs |
| `CRON_SECRET` | random secret | bearer auth for /api/cron |
| `ADMIN_SECRET_KEY` | S... secret key | signs Merkle root + reconcile txs in cron |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob token | auto-set if Blob enabled on the project |

## Dev server (local)

Started with: `cd /home/brandonian/LUMENAIRE && nohup pnpm dev --hostname 0.0.0.0 --port 3000 > /tmp/lumenaire-dev.log 2>&1 & disown`

If it dies: `lsof -ti:3000 | xargs kill 2>/dev/null; rm -rf .next; nohup pnpm dev ...`

**WARNING:** Don't run `pnpm build` while dev server is running — they share `.next/` and `build` clobbers the dev cache, killing the server. Use `pnpm exec tsc --noEmit` for type-checking instead.

Prototype reference server: `cd /home/brandonian/staging/lumenaire-handoff-v2/design_handoff_lumenaire_site/prototype && python3 -m http.server 8000` (the design vision — original LMNR branding, used as visual ground truth for porting).

## What's next

1. Update staking contract for xLMNR (user has new contract address — needs strategy decision: upgrade legacy vs. fresh deploy)
2. Bring `/staking` to feature parity with `staking.lumenbro.com` (full audit of behavior)
3. Dev populates Vercel env vars, restores cron schedule
4. (Eventually) build Tokenomics + Trade + Journey + Footer to ship the full site
