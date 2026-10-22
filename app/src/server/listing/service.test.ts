import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { beforeAll, describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import type { Rpc } from "../history/rpc";
import { applyForListing, featuredGames, handleListingAdmin } from "./service";

const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const admin = Keypair.generate();
const other = Keypair.generate();
const NOW = Date.now();
const PROGRAM = "TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH";
const form = { programId: PROGRAM, studio: "Moss Labs", gameName: "Word Duel", contactEmail: "hi@moss.example", site: "https://moss.example", blurb: "" };

let sql: PGlite;
let rpc: Rpc;
beforeAll(async () => {
  sql = new PGlite();
  await sql.exec("create role anon; create role authenticated;");
  await sql.exec(readFileSync(new URL("../../../supabase/migrations/0010_studio_listing.sql", import.meta.url), "utf8"));
  rpc = async (fn, args) => {
    const names = Object.keys(args);
    const call = names.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const res = await sql.query<Record<string, unknown>>(`select public.${fn}(${call}) as r`, names.map((k) => args[k]));
    return res.rows[0].r;
  };
});

function signed(kp: Keypair, step: string, fields: SignedFields = {}) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-admin", step, address, NOW, nonce, fields)), kp.secretKey);
  return { step, address, ts: NOW, nonce, signature: Buffer.from(sig).toString("base64"), ...fields };
}
const deps = () => ({ admins: [admin.publicKey.toBase58()], rpc });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};
const call = (step: string, fields: SignedFields = {}, kp = admin) => handleListingAdmin(deps(), signed(kp, step, fields), null, dev, NOW);

describe("studio listing paperwork", () => {
  it("takes a free application and refuses a second one for the same program", async () => {
    expect((await applyForListing(rpc, form)).ok).toBe(true);
    expect(await code(applyForListing(rpc, form))).toBe("exists");
    expect(await code(applyForListing(rpc, { ...form, contactEmail: "bad" }))).toBe("invalid");
  });

  it("is admin only", async () => {
    expect(await code(call("studios", {}, other))).toBe("forbidden");
    expect(await code(handleListingAdmin({ admins: [], rpc }, signed(admin, "studios"), null, dev, NOW))).toBe("not-configured");
  });

  it("refuses a payment and a feature flag before the application is accepted", async () => {
    const [app] = (await call("studios")).applications;
    expect(app).toMatchObject({ status: "applied", paidUntil: null, featured: false });
    expect(await code(call("studio-pay", { id: app.id, version: "invoice", code: "INV-1", months: 1, position: "500" }))).toBe("not-accepted");
    expect(await code(call("studio-feature", { id: app.id, enabled: 1 }))).toBe("not-accepted");
  });

  it("accepts once, records a $500 year, ignores a repeated reference, and features it", async () => {
    const { applications } = await call("studios");
    const id = applications[0].id;
    await call("studio-decide", { id, intent: "accepted", code: "Looks good" });
    expect(await code(call("studio-decide", { id, intent: "rejected" }))).toBe("decided");

    const afterPay = await call("studio-pay", { id, version: "invoice", code: "INV-1", months: 1, position: "500" });
    const a = afterPay.applications[0];
    expect(a.payments).toHaveLength(1);
    expect(a.payments[0]).toMatchObject({ kind: "invoice", reference: "INV-1", amountUsd: 500, years: 1 });
    expect(a.paidUntil! - Math.floor(Date.now() / 1000)).toBeGreaterThan(364 * 86_400);
    expect(await code(call("studio-pay", { id, version: "invoice", code: "INV-1", months: 1, position: "500" }))).toBe("duplicate");

    const second = (await call("studio-pay", { id, version: "chain", code: "5sigABC", months: 1, position: "500" })).applications[0];
    expect(second.paidUntil! - a.paidUntil!).toBeGreaterThan(364 * 86_400);

    expect(await featuredGames(rpc)).toEqual([]);
    await call("studio-feature", { id, enabled: 1 });
    const featured = await featuredGames(rpc);
    expect(featured).toHaveLength(1);
    expect(featured[0]).toMatchObject({ programId: PROGRAM, gameName: "Word Duel", studio: "Moss Labs" });
    expect(JSON.stringify(featured)).not.toContain("moss.example/hi");
    expect(Object.keys(featured[0])).not.toContain("contactEmail");
  });

  it("stops featuring a Game once its paid year is over", async () => {
    await sql.exec("update public.studio_applications set paid_until = now() - interval '1 day'");
    expect(await featuredGames(rpc)).toEqual([]);
  });

  it("lets a rejected program apply again", async () => {
    await sql.exec("update public.studio_applications set status = 'rejected'");
    expect((await applyForListing(rpc, form)).ok).toBe(true);
  });

  it("rejects malformed admin requests", async () => {
    expect(await code(call("studio-decide", { id: 0, intent: "accepted" }))).toBe("bad-request");
    expect(await code(call("studio-decide", { id: 1, intent: "maybe" }))).toBe("bad-request");
    expect(await code(call("studio-pay", { id: 1, version: "cash", code: "x", months: 1, position: "500" }))).toBe("bad-request");
    expect(await code(call("studio-pay", { id: 1, version: "invoice", code: "x", months: 9, position: "500" }))).toBe("bad-request");
  });
});
