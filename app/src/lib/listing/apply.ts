const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Price of a year's listing, in dollars. Paid on chain or invoiced; the admin records it. */
export const LISTING_YEAR_USD = 500;

export interface Application {
  programId: string;
  studio: string;
  gameName: string;
  contactEmail: string;
  site: string;
  blurb: string;
}

export type Checked = { ok: true; value: Application } | { ok: false; error: string };

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Checks the free apply form. The messages are shown to the Studio as they are. */
export function checkApplication(raw: unknown): Checked {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const v: Application = {
    programId: clean(o.programId),
    studio: clean(o.studio),
    gameName: clean(o.gameName),
    contactEmail: clean(o.contactEmail),
    site: clean(o.site),
    blurb: clean(o.blurb),
  };
  if (!v.studio || v.studio.length > 80) return { ok: false, error: "Tell us your Studio name (up to 80 characters)." };
  if (!v.gameName || v.gameName.length > 60) return { ok: false, error: "Tell us your Game’s name (up to 60 characters)." };
  if (!BASE58.test(v.programId)) return { ok: false, error: "That doesn’t look like a Solana program address." };
  if (!EMAIL.test(v.contactEmail) || v.contactEmail.length > 200) return { ok: false, error: "Enter an email we can reach you on." };
  if (v.site && (v.site.length > 200 || !/^https?:\/\/\S+$/.test(v.site))) return { ok: false, error: "The website should start with https://." };
  if (v.blurb.length > 600) return { ok: false, error: "Keep the description under 600 characters." };
  return { ok: true, value: v };
}
