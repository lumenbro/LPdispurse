# lmnr-federation

SEP-2 federation server for `thelumenaire.com`, so the rewards wallet appears as
**`rewards*thelumenaire.com`** rather than a raw `G...` address — the same
mechanism behind `name*lobstr.co`.

Live: https://lmnr-federation.bpeterscqa.workers.dev

## Activation (one line, on the site repo)

Federation is inert until the toml advertises it. Add to
`LUMENAIRE/public/.well-known/stellar.toml`:

```toml
FEDERATION_SERVER="https://lmnr-federation.bpeterscqa.workers.dev"
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
