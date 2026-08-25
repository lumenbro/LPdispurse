# LUMENAIRE Site Rebuild — Status & Handoff

**Last updated:** 2026-07-07
**Repo:** `XLMNR/LUMENAIRE` (GitHub) — user pushes via `lumenbro` GitHub account (collaborator)
**Local clone:** `/home/brandonian/LUMENAIRE/` (separate from LPdispurse)
**Active branch:** `site-rebuild` — **21 commits ahead of `main`, NOT merged yet**
**HEAD commit:** `d4ffa46`
**Vercel project (dev's):** `v0-v0jose60639eb37ccd` on team `stellarowlpha` — user has NO console access (only GitHub push + a deployment-view bypass)
**Preview URL:** `https://v0-v0jose60639eb37ccd-git-site-rebuild-stellarowlpha.vercel.app`
**Production (untouched, still "Under Construction"):** `https://www.thelumenaire.com`

---

## STATUS: site is functionally COMPLETE. Not merged to main yet (user's call, pending launch coordination + the July security incident took priority).

### Pages (all built, all Vercel-green)
| Route | Contents |
|-------|----------|
| `/` (home) | Hero → Features → Tokenomics → Pairs → Roadmap → Journey → Footer |
| `/collaborations` | Intro → Ascension Initiative infographic → Partners (5 cards) |
| `/staking` | xLMNR infographic hero banner → live StakingDashboard (wallet connect) |
| `/admin` | Admin dashboard (wallet-gated) |
| `/api/cron`, `/api/proof/[pool]/[address]` | Server routes (staking) |

### Section components (`components/`)
site-nav, hero, hero-dots, features, tokenomics, pairs, roadmap, journey, ascension, partners, site-footer, logo + `components/staking/*` (7) + `lib/staking/*` (5)

### Key content values (latest per dev)
- **Max supply: 333M** (Hero strip + Tokenomics) — was 418M→400M→333M
- Tokenomics 4th tile: **"Liquidity Provision" / "Rewarded Staking Pools" / XLM·SHX·VELO**
- Hero manifesto: "Stellar moves the money. Lumenaire moves the people."
- Hero CTAs: Buy $xLMNR / **Claim Free xLMNR** (→ Stellar Drip faucet) / Follow Us / Whitepaper
- Pairs: "Over 75 Trading Pairs", live **top-20** from Horizon (hourly revalidate)
- Roadmap: 5 phases (Launch✓ / xLMNR V2 Migration🟣 / Staking / Tipping / DeFi Suite)
- Footer: Follow on X (@X_LMNR) + Follow on Telegram (t.me/X_LMNR)

### Partners (5 cards, /collaborations)
1. **Stellar Forge** (parent of Stellar Drip faucet) — CTA links to faucet
2. ACT — authentic-payment.com
3. JDM — justdumbmemescoins.netlify.app
4. BLUFAB — blufabric.org
5. GAMBIT — gambit64.com

### Faucet
Using Stellar Drip (Stellar Forge's, on base44) as MVP — link-out only (iframe blocked by x-frame-options). Custom faucet SHELVED — spec in `.blueprint/FAUCET_PLAN.md`.

---

## WHAT'S LEFT (all non-blocking, pending launch)

1. **Merge `site-rebuild` → main** — PR NOT opened yet. Draft is in `LUMENAIRE/PR_DESCRIPTION.md` (untracked scratch file — don't commit it). Opening the PR + merge deploys thelumenaire.com to the full site.
2. **Dev sets public env vars** on his Vercel (`NEXT_PUBLIC_*` + `POOL_CONFIG`) → clears the /staking placeholder banner. Full list in `.blueprint/ENV_HANDOFF.md`.
3. **Proof/Blob coupling caveat** (see ENV_HANDOFF.md): /staking DISPLAY works with public env, but the STAKE action needs cron + Blob co-located. Cleanest fix = co-locate cron on dev's project after admin handoff.
4. **Partner copy polish** — ACT/JDM have generic descriptions (their sites had no OG meta); dev can refine.

## CONTRACT SIDE — DONE (see MIGRATION_xLMNR.md + ENV_HANDOFF.md)
- Contract `CBDA7H3X…BVAE` upgraded to xLMNR, funded 10,990 xLMNR, 3 pools registered (XLM/SHX/VELO).
- Cron `POOL_CONFIG` on user's own `lmnr-staking` Vercel project flipped to the 3 new pools + redeployed → posts roots at next 00:00 UTC.
- ⚠️ **SECURITY INCIDENT (July 2026):** the contract admin/deployer key `SCZKOSUO…` was compromised (committed to public repos lumenjoule-sdk + soroban-policies, scraped, 80 XLM drained). `set_admin` to a fresh xBull key is PENDING — needs user's new pubkey. 10,990 xLMNR still safe (attacker hasn't touched contract). See `/home/brandonian/SECURITY_INCIDENT.md` for the full rotation checklist.

---

## HOW TO RESUME (dev server)
```
cd /home/brandonian/LUMENAIRE
nohup pnpm dev --hostname 0.0.0.0 --port 3000 > /tmp/lumenaire-dev.log 2>&1 & disown
# open http://localhost:3000
```
Type-check without clobbering dev server: `pnpm exec tsc --noEmit` (NOT `pnpm build` while dev runs — shares .next/).
Prototype reference (LMNR-era design): `cd /home/brandonian/staging/lumenaire-handoff-v2/design_handoff_lumenaire_site/prototype && python3 -m http.server 8000`

## PUSH FLOW
Each push to `site-rebuild` auto-deploys a Vercel preview. Confirm builds with:
`gh api repos/XLMNR/LUMENAIRE/commits/<sha>/status --jq .state`
