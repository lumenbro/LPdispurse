# Session State — LUMENAIRE / xLMNR (as of ~2026-07-23)

Snapshot to resume after conversation compaction. Cross-refs:
`LUMENAIRE_SITE_STATUS.md`, `ENV_HANDOFF.md`, `MIGRATION_xLMNR.md`,
`/home/brandonian/SECURITY_INCIDENT.md`, `/home/brandonian/KEYPO_RESEARCH.md`.

## ✅ DONE

- **Marketing site LIVE** at `https://www.thelumenaire.com` (merged site-rebuild → main, PRs #1/#2/#3).
  Home + `/collaborations` (Ascension + 5 partner cards) + `/staking` (Coming Soon gate) + `/admin`.
- **Repo:** `XLMNR/LUMENAIRE`, local clone `/home/brandonian/LUMENAIRE/`. Pushed via `lumenbro` GH account.
  Deploys on dev's Vercel project `v0-v0jose60639eb37ccd` (team `stellarowlpha`) — user has NO Vercel console
  access (only GitHub push + a deployment-view bypass). Cron runs on user's OWN `lmnr-staking` Vercel project.
- **Contract migration DONE:** `CBDA7H3XLKL4ECSI54IPRGMYZLZFEIBR5FTEHI6DAH3UVHB53LMGBVAE` upgraded to WASM
  `97cfe76e69c0f45159e8229a7f2e0d1c289cfefee05a01df92a81d2e7b39bcde` (v0.2.0, verified build), token pointer →
  xLMNR SAC `CCEIVLOFQHALNB2ZVQJW55OYKEL7GG52JIGLUGHLRTEAFMISNSMOM5XW`, funded 10,990 xLMNR, 3 pools added
  (idx1 xLMNR/XLM `8b090132…`, idx2 xLMNR/SHX `1810a533…`, idx3 xLMNR/VELO `c074d9fb…`). Old pool 0 inert.
- **Cron POOL_CONFIG** on `lmnr-staking` Vercel updated to the 3 new pools + redeployed.
- **Faucet:** using Stellar Forge / Stellar Drip (base44) as MVP — link-out in Hero + Partners card. Custom
  faucet SHELVED (`FAUCET_PLAN.md`).
- **stellar.toml:** valid, serves 200 at www, issuer matches, image resolves. Byte-identical to repo.

## 🔴 SECURITY INCIDENT (July 2026) — see SECURITY_INCIDENT.md
Admin/deployer key `SCZKOSUO…` (account `GCKGWGRR…RP7D`) was committed to PUBLIC repos
(lumenjoule-sdk, soroban-policies) → scraped → 80 XLM drained. Root cause confirmed = public-repo commit
(NOT the Vercel breach, NOT the removed Claude Code vercel MCP plugin — both were secondary/cleared).
Blast radius otherwise contained; ~29 keys across repos to rotate (list in SECURITY_INCIDENT.md).
Hardening done: WSL2 sshd bound to Tailscale-only (was 0.0.0.0), confirmed never brute-forced.

## ⚠️ OPEN ITEMS

1. **Staking contract v2 REWRITE + fresh redeploy (supersedes the old "rotate admin" item).**
   Decision made 2026-08-08: instead of rotating admin on v1, we REWRITE the contract with security
   fixes and redeploy fresh (zero stakers, so nothing to migrate). New admin = a fresh keypair generated
   in the CLI keychain (NOT xBull, NOT committed this time). Full plan + all fixes in
   **`CONTRACT_V2_REWRITE_PLAN.md`**. Two-pass review (Claude + independent Codex/gpt-5.6) found: H-1
   multi-epoch reward over-accrual (prove-once-harvest-forever, CONFIRMED by both), C-1 unauth initialize,
   H-2 remove_pool corruption, H-3 TTL ghost stake, H-4 overflow-wedge, + CEI/leaf-binding/two-step-admin.
   BLOCKED ON: dev's answer to the emission-model question (per-pool rate = 3× emission with 3 pools vs
   global budget — see plan doc, options A/B/C). Everything else is ready to implement the moment they
   answer. Staking `/staking` stays "Coming Soon" until v2 is deployed + funded. NOTE: v2 deploys with the
   new admin from genesis (via constructor), so no risky `set_admin` on the compromised key at all.
   Also decide: add a minimal `operator` role in v2 so the cron's hot Vercel key isn't the full admin.

2. **Transfer staking to dev's Vercel** (the "move it to Vercel for the dev" item). Dev sets the public env
   vars on his Vercel (`NEXT_PUBLIC_CONTRACT_ID`, `NEXT_PUBLIC_ADMIN_WALLET`, RPC/HORIZON/PASSPHRASE,
   `POOL_CONFIG`) → clears the Coming-Soon banner. Full list + the proof/Blob co-location caveat in
   ENV_HANDOFF.md (cron + site must share the Blob store; cleanest is co-locating cron on dev's project
   after admin handoff).

3. **Stellar Expert NOT resolving xLMNR — REAL ROOT CAUSE FOUND (2026-08-08).**
   Verified on 08-08: home_domain = `www.thelumenaire.com` (stable, last changed 07-30, serves 200),
   toml byte-identical to repo, parses clean. So the CONFIG is fine. The blocker is the LOGO:
   - The LIVE logo at `/images/xLMNR.png` is a **7.5MB, 1777×1777 PNG** the dev uploaded via GitHub web
     UI (commit `256a038 "Add files via upload"` on main). SE spec wants a small square PNG (~128px).
   - Per SE issue #646 (github.com/stellar-expert/stellar-expert-explorer/issues/646): Stellar Expert
     **permanently caches a logo "not found" from the FIRST crawl**. During the earlier flip-flops there
     was a 404 window (toml pointed at root `/xLMNR.png` after the rebuild moved images to `/images/`),
     so SE is stuck on that stale failure — and a 7.5MB image makes every re-crawl fetch time out, so it
     never self-heals. This (NOT the home_domain, NOT lag) is why it won't resolve.
   - NOTE: local repo `public/images/xLMNR.png` is a stale 909KB JPEG; LIVE main is the 7.5MB PNG. The dev
     has been doing repeated direct "Add files via upload" / "Delete" commits on main (115 commits ahead
     of our last site-rebuild sync) — this is the churn. `git fetch && git checkout main` to see live state.

   **FIX SHIPPED 2026-08-08 (dev approved "lets try it"):** commit `af4f4e4` on XLMNR/LUMENAIRE main.
   - Added `public/images/xLMNR-icon.png` = 256×256 transparent PNG, 109KB (jimp-downscaled from the live
     7.5MB logo; faithful — source is a black-bg square design, alpha all 255).
   - Repointed toml `ORG_LOGO` + `image` → `https://www.thelumenaire.com/images/xLMNR-icon.png` (NEW URL to
     bypass SE's sticky-failure cache on the old `/images/xLMNR.png` path). home_domain UNCHANGED (www).
   - FOLLOW-UP SHIPPED (dev asked "remove the black square"): commit `4688222` — circular-masked the
     badge so the outer black square + corner grid are transparent (feathered edge, ring glow preserved).
     SAME `/images/xLMNR-icon.png` path (105KB), so toml URL unchanged. This transparent version is the
     FINAL live logo. Color-keying black was the dev's failed approach (it ate the character's black
     linework) — a geometric circle mask was the fix.
   - NOW WAITING ON: Stellar Expert re-crawl to pick up the new small logo. Test:
     `curl -I https://www.thelumenaire.com/images/xLMNR-icon.png` (200 = deployed) and re-check SE asset page.
   - If SE STILL won't show it after the re-crawl (sticky cache is stubborn), next lever = open an issue on
     stellar-expert/stellar-expert-explorer asking them to force a re-parse, or IPFS-host the icon.
   - TOLD TOOLING NOTE: sharp native install kept timing out on WSL2; used `jimp` (pure JS) instead — it's in
     the scratchpad node_modules. Tell the dev to STOP re-uploading the big PNG or it'll collide.

4. **Marketing polish (minor, non-blocking):** icon optimization; ACT/JDM partner copy is generic.

## KEY FACTS / GOTCHAS
- Vercel primary domain = `www.thelumenaire.com`; apex 307-redirects to it (dashboard setting, not code —
  can't be changed from repo; only dev's Vercel dashboard). This is fine — keep www as home_domain.
- Dev = GH `XLMNR`, issuer key `GDKA6WVM…` is HIS (separate from compromised admin `GCKGWGRR…`).
- Don't run `pnpm build` while dev server runs (shares .next/); use `pnpm exec tsc --noEmit`.
- Restart dev server: `cd ~/LUMENAIRE && nohup pnpm dev --hostname 0.0.0.0 --port 3000 > /tmp/lumenaire-dev.log 2>&1 & disown`
