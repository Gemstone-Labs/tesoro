const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type Verify = (token: string, ip: string | null) => Promise<boolean>;

/** True when TURNSTILE_SECRET_KEY is set, so sign-ups must carry a valid token. */
export const turnstileConfigured = () => Boolean(process.env.TURNSTILE_SECRET_KEY);

/** Asks Cloudflare whether a token is genuine. A network or parse failure counts as not verified. */
export const verifyWithCloudflare: Verify = async (token, ip) => {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
};

let verifier: Verify = verifyWithCloudflare;
/** Test seam: swaps the Cloudflare call for a fake. */
export function setVerifier(v: Verify | null) {
  verifier = v ?? verifyWithCloudflare;
}

/** Passes when no secret is configured (local, dev, tests); otherwise needs a token Cloudflare accepts. */
export async function passesChallenge(token: unknown, ip: string | null): Promise<boolean> {
  if (!turnstileConfigured()) return true;
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  return verifier(token, ip);
}
