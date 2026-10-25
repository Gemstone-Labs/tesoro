import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "../request-auth";
import type { Rpc } from "../history/rpc";
import { LISTING_YEAR_USD, checkApplication } from "@/lib/listing/apply";

/**
 * Studio listing paperwork (ticket 23). The Studio applies for free; an admin accepts, records the yearly payment
 * (on chain or invoiced) and marks the Game featured. Writing `listed_until` and the approved build to the chain is a
 * separate admin transaction (lib/chain/admin-listing.ts); this service never signs on chain.
 */

export interface StudioPayment {
  kind: "chain" | "invoice";
  reference: string;
  amountUsd: number;
  years: number;
  periodEnd: number;
}

export interface StudioApplication {
  id: number;
  programId: string;
  studio: string;
  gameName: string;
  contactEmail: string;
  site: string | null;
  blurb: string;
  status: "applied" | "accepted" | "rejected";
  featured: boolean;
  note: string | null;
  paidUntil: number | null;
  createdAt: number;
  payments: StudioPayment[];
}

export interface FeaturedGame {
  programId: string;
  studio: string;
  gameName: string;
  site: string | null;
  paidUntil: number;
}

/** The public apply form. Returns a plain message for the Studio either way. */
export async function applyForListing(rpc: Rpc, body: unknown): Promise<{ ok: true; message: string }> {
  const checked = checkApplication(body);
  if (!checked.ok) throw new DemoHttpError(400, "invalid", checked.error);
  const v = checked.value;
  const id = Number(await rpc("studio_apply", { p_program_id: v.programId, p_studio: v.studio, p_game_name: v.gameName, p_contact_email: v.contactEmail, p_site: v.site, p_blurb: v.blurb }));
  if (id < 0) throw new DemoHttpError(409, "exists", "This Game already has an application. We’ll email you once it is reviewed.");
  return { ok: true, message: "Thanks. We’ll review your Game and email you. Applying is free." };
}

/** Accepted, paid up and featured Games, for the Lobby and the catalogue. Public: no contact details. */
export async function featuredGames(rpc: Rpc): Promise<FeaturedGame[]> {
  return ((await rpc("studio_featured", {})) as FeaturedGame[]) ?? [];
}

const nonces = new NonceStore();
const STEPS = ["studios", "studio-decide", "studio-pay", "studio-feature"] as const;
export type AdminStep = (typeof STEPS)[number];

export interface AdminDeps {
  admins: string[];
  rpc: Rpc;
}

export type AdminReply = { applications: StudioApplication[]; yearUsd: number; now: number };

const need = (v: unknown, message = "Malformed request.") => {
  if (v === undefined || v === null || v === "") throw new DemoHttpError(400, "bad-request", message);
  return v;
};

/** Admin only: a wallet-signed request from an address in ADMIN_WALLETS (same rule as /api/admin/review). */
export async function handleListingAdmin(deps: AdminDeps, body: unknown, authorization: string | null, env?: AuthEnv, now = Date.now()): Promise<AdminReply> {
  if (!deps.admins.length) throw new DemoHttpError(503, "not-configured", "The listing page is not set up on this server.");
  const req = await verifySignedRequest("tesoro-admin", STEPS, body, authorization, { nonces, env, now });
  if (!deps.admins.includes(req.address.toBase58())) throw new DemoHttpError(403, "forbidden", "Not allowed.");
  const f = req.fields;
  if (req.step !== "studios") {
    const id = Number(need(f.id));
    if (!Number.isSafeInteger(id) || id < 1) throw new DemoHttpError(400, "bad-request", "Malformed request.");
    if (req.step === "studio-decide") {
      const status = need(f.intent);
      if (status !== "accepted" && status !== "rejected") throw new DemoHttpError(400, "bad-request", "Malformed request.");
      const note = typeof f.code === "string" ? f.code.slice(0, 600) : "";
      if (!(await deps.rpc("studio_decide", { p_id: id, p_status: status, p_note: note }))) throw new DemoHttpError(409, "decided", "This application was already decided.");
    } else if (req.step === "studio-pay") {
      const kind = need(f.version);
      const reference = String(need(f.code, "Add the transaction signature or the invoice number.")).trim();
      const years = Number(need(f.months));
      const amount = Number(need(f.position));
      if ((kind !== "chain" && kind !== "invoice") || !reference || reference.length > 120 || !Number.isInteger(years) || years < 1 || years > 5 || !Number.isFinite(amount) || amount < 0) {
        throw new DemoHttpError(400, "bad-request", "Check the payment details.");
      }
      const paidUntil = Number(await deps.rpc("studio_pay", { p_id: id, p_kind: kind, p_reference: reference, p_amount_usd: amount, p_years: years }));
      if (paidUntil === -1) throw new DemoHttpError(409, "not-accepted", "Accept the application before recording a payment.");
      if (paidUntil === -2) throw new DemoHttpError(409, "duplicate", "This payment was already recorded.");
    } else {
      if (!(await deps.rpc("studio_set_featured", { p_id: id, p_featured: Number(f.enabled) === 1 }))) throw new DemoHttpError(409, "not-accepted", "Only an accepted Game can be featured.");
    }
  }
  return { applications: ((await deps.rpc("studio_list", {})) as StudioApplication[]) ?? [], yearUsd: LISTING_YEAR_USD, now: Math.floor(now / 1000) };
}
