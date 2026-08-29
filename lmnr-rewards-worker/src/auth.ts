import type { Env } from "./config";

/**
 * Admin auth for the config UI.
 *
 * This page sets reward amounts, so it is a spending control -- it must never
 * be open like the tool in the reference screenshot appeared to be.
 *
 * Preferred: Cloudflare Access in front of /admin and /api/*. Access terminates
 * the login and injects `Cf-Access-Authenticated-User-Email`, which we check
 * against ADMIN_EMAILS. No shared secret to leak, and the dev logs in with his
 * own identity.
 *
 * Fallback (so the page is never unprotected before Access is configured):
 * an ADMIN_TOKEN secret sent as `Authorization: Bearer <token>`.
 */
export function checkAdmin(
  req: Request,
  env: Env
): { ok: true; who: string } | { ok: false; reason: string } {
  const email = req.headers.get("Cf-Access-Authenticated-User-Email");
  if (email) {
    const allowed = (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.length === 0) {
      return { ok: false, reason: "ADMIN_EMAILS is not configured" };
    }
    if (allowed.includes(email.toLowerCase())) return { ok: true, who: email };
    return { ok: false, reason: `${email} is not an allowed admin` };
  }

  const token = env.ADMIN_TOKEN;
  if (token) {
    const hdr = req.headers.get("Authorization") ?? "";
    const given = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    // Constant-time-ish compare: same length check plus full scan.
    if (given.length === token.length) {
      let diff = 0;
      for (let i = 0; i < token.length; i++) {
        diff |= given.charCodeAt(i) ^ token.charCodeAt(i);
      }
      if (diff === 0) return { ok: true, who: "token" };
    }
    return { ok: false, reason: "invalid or missing bearer token" };
  }

  return {
    ok: false,
    reason:
      "no auth configured - put Cloudflare Access in front of this Worker and set ADMIN_EMAILS, or set an ADMIN_TOKEN secret",
  };
}

export function denied(reason: string): Response {
  return Response.json({ ok: false, error: "forbidden", reason }, { status: 403 });
}
