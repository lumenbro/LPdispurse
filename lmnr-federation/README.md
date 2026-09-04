> ## DECOMMISSIONED 2026-09-04 — do not redeploy as-is
>
> The Cloudflare Worker was deleted and `FEDERATION_SERVER` was removed from the
> site toml. Stellar Expert was warning:
>
> > SEP service FEDERATION_SERVER ignored. URL hostname should match the
> > home_domain.
>
> SEP-1 expects the federation endpoint on the **same host that serves the
> toml**. This ran on `federation.lumenbro.com` while the toml is served from
> `thelumenaire.com` — a different registrable domain — so validators ignored
> the line and warned instead of using it. A subdomain of the *other* domain was
> never going to satisfy the check.
>
> Nothing depended on it. The rewards wallet is reachable as
> `xLMNR-REWARDS*lobstr.co`, which Lobstr hosts on its own domain.
>
> **If you bring it back**, serve it FROM `thelumenaire.com` — a `/federation`
> route on the LUMENAIRE site — not from a separate Worker on another domain.
> The code below is a correct SEP-2 implementation and is worth reusing; only
> the hosting location was wrong.
>
> **DNS is already clean.** `federation.lumenbro.com` was a Workers *Custom
> Domain*, which Cloudflare manages as an auto-created record — deleting the
> Worker removed it too. Cloudflare's authoritative nameservers return NXDOMAIN
> for the name and the apex is unaffected. Nothing to remove in the dashboard.
> (Checking immediately after a delete can show a cached answer and a 530 from
> an edge that has not caught up; query an authoritative NS to see the truth.)

# lmnr-federation

SEP-2 federation server for `thelumenaire.com`, so the rewards wallet appears as
**`rewards*thelumenaire.com`** rather than a raw `G...` address — the same
mechanism behind `name*lobstr.co`.

Live: https://lmnr-federation.bpeterscqa.workers.dev

**Use a custom domain in the published toml, not the workers.dev URL** — the
workers.dev subdomain is derived from the account email, and the toml is public.
`lumenbro.com` is already on Cloudflare DNS, so attaching
`federation.lumenbro.com` is a single dashboard step (Workers & Pages ->
lmnr-federation -> Domains & Routes -> Add -> Custom Domain).

`thelumenaire.com` would read better still, but its DNS is at GoDaddy and the
dev controls it; that needs a CNAME from him. The Worker answers on any hostname
routed to it, so both can coexist.

Do NOT change the account-wide workers.dev subdomain to solve this: it would
also rename `lmnr-rewards.bpeterscqa.workers.dev` and break the Cloudflare
Access policy bound to that hostname.

## Activation (one line, on the site repo)

Federation is inert until the toml advertises it. Add to
`LUMENAIRE/public/.well-known/stellar.toml`:

```toml
FEDERATION_SERVER="https://federation.lumenbro.com"
```

Additive only — it does not touch `[[CURRENCIES]]` or `ORG_LOGO`.

## Names

| Address | Resolves to |
|---|---|
| `rewards*thelumenaire.com` (canonical) | `GBQ3DSET…TBHJ` |
| `xlmnr-rewards*thelumenaire.com` | same |
| `lp-rewards*thelumenaire.com` | same |
| `reward-stream*thelumenaire.com` | same |

Reverse (`type=id`) lookups always return the canonical name. Add or change
names by editing `NAMES` in `src/index.ts` and redeploying.

Note: a federated address is exactly `name*domain` — one asterisk. Something
like `xLMNR*Reward*Stream` is not a valid Stellar address.

## Why it is a separate Worker

`lmnr-rewards` sits behind Cloudflare Access because its admin page controls
spending. A federation server must be **publicly queryable** by any wallet, so
it lives on its own Worker that holds no keys and no secrets — everything it
returns is already public on-chain.

## Verified
- forward `?q=rewards*thelumenaire.com&type=name` -> account id
- reverse `?q=G...&type=id` -> canonical name
- unknown name 404, foreign domain 404, malformed query 400
- CORS enabled (wallets query from browsers)
