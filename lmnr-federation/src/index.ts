/**
 * SEP-2 federation server for thelumenaire.com.
 *
 * Lets a wallet resolve a human-readable name to a Stellar account, so the
 * rewards wallet shows up as `rewards*thelumenaire.com` instead of a raw G...
 * address. Same mechanism Lobstr uses for `name*lobstr.co`.
 *
 * Holds no keys and no secrets. Every value it returns is already public
 * on-chain, which is why it can sit outside Cloudflare Access -- and it must,
 * because wallets query it anonymously.
 *
 * Spec: https://developers.stellar.org/docs/tokens/publishing-asset-info
 *       (SEP-0002)
 */

interface Env {
  FEDERATION_DOMAIN: string;
}

/**
 * name -> Stellar account.
 *
 * Aliases are cheap, so accept the variations people might type. The first
 * entry is the canonical one returned on reverse (type=id) lookups.
 */
const CANONICAL = "rewards";

const NAMES: Record<string, string> = {
  // LP reward disbursement wallet (the Cloudflare Worker bot)
  rewards: "GBQ3DSET3RL3UONOS2J3ZHCBLMCELNC6KWCUEVGJBZRQNZIWNRXXTBHJ",
  "xlmnr-rewards": "GBQ3DSET3RL3UONOS2J3ZHCBLMCELNC6KWCUEVGJBZRQNZIWNRXXTBHJ",
  "lp-rewards": "GBQ3DSET3RL3UONOS2J3ZHCBLMCELNC6KWCUEVGJBZRQNZIWNRXXTBHJ",
  "reward-stream": "GBQ3DSET3RL3UONOS2J3ZHCBLMCELNC6KWCUEVGJBZRQNZIWNRXXTBHJ",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function notFound() {
  // SEP-2 expects 404 with a detail message when a name does not resolve.
  return json({ detail: "not found" }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").trim();
    const type = (url.searchParams.get("type") ?? "").trim().toLowerCase();

    // Plain visit: show what this is and what resolves.
    if (!q) {
      return json({
        service: "SEP-2 federation server",
        domain: env.FEDERATION_DOMAIN,
        usage: `?q=${CANONICAL}*${env.FEDERATION_DOMAIN}&type=name`,
        names: Object.keys(NAMES).map((n) => `${n}*${env.FEDERATION_DOMAIN}`),
      });
    }

    // Forward lookup: name*domain -> account id
    if (type === "name") {
      const at = q.lastIndexOf("*");
      if (at < 0) return json({ detail: "invalid stellar address" }, 400);

      const name = q.slice(0, at).toLowerCase();
      const domain = q.slice(at + 1).toLowerCase();

      // Only answer for our own domain; resolving other domains would be wrong.
      if (domain !== env.FEDERATION_DOMAIN.toLowerCase()) return notFound();

      const account_id = NAMES[name];
      if (!account_id) return notFound();

      return json({ stellar_address: `${name}*${domain}`, account_id });
    }

    // Reverse lookup: account id -> name
    if (type === "id") {
      const hit = Object.entries(NAMES).find(([, id]) => id === q);
      if (!hit) return notFound();
      // Report the canonical alias rather than whichever matched first.
      const name =
        NAMES[CANONICAL] === hit[1] ? CANONICAL : hit[0];
      return json({
        stellar_address: `${name}*${env.FEDERATION_DOMAIN}`,
        account_id: hit[1],
      });
    }

    // txid and forward types are optional in SEP-2 and not supported here.
    return json({ detail: "unsupported type" }, 400);
  },
};
