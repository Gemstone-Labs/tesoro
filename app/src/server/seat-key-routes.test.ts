import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields, type SignedScope } from "../lib/chain/signed-request";
import { handleReview } from "./admin/review";
import { handleOrders } from "./admin/orders";
import { handleAge } from "./age/routes";
import { handleDepositAck } from "./deposit-ack/routes";
import { handleRedeem } from "./invite/redeem";
import { handleListingAdmin } from "./listing/service";
import { DemoHttpError, type AuthEnv } from "./request-auth";

const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const wallet = Keypair.generate();
const seat = Keypair.generate();

/** The seat key signs for the wallet's address; a route that did not opt in must refuse it whatever the signature. */
function seatRequest(scope: SignedScope, step: string, fields: SignedFields = {}) {
  const address = wallet.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage(scope, step, address, ts, nonce, fields, seat.publicKey.toBase58())), seat.secretKey);
  return { step, address, ts, nonce, signature: Buffer.from(sig).toString("base64"), signer: seat.publicKey.toBase58(), ...fields };
}
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};
/** The wallet is an admin who also plays: its stolen seat key must still get nothing. */
const none = { admins: [wallet.publicKey.toBase58()] } as never;

describe("a seat key on a wallet-only route (ticket 10)", () => {
  it("is refused by admin review and orders, listing, age, deposit acknowledgment and invite", async () => {
    expect(await refused(handleReview(none, seatRequest("tesoro-admin", "review"), null, dev))).toBe("wallet-only");
    expect(await refused(handleOrders(none, seatRequest("tesoro-admin", "orders"), null, dev))).toBe("wallet-only");
    expect(await refused(handleListingAdmin(none, seatRequest("tesoro-admin", "studios"), null, dev))).toBe("wallet-only");
    expect(await refused(handleAge(none, seatRequest("tesoro-age", "confirm"), null, dev))).toBe("wallet-only");
    expect(await refused(handleDepositAck(none, seatRequest("tesoro-deposit-ack", "confirm", { version: 1 }), null, dev))).toBe("wallet-only");
    expect(await refused(handleRedeem(none, seatRequest("tesoro-invite", "redeem", { code: "x" }), null, dev))).toBe("wallet-only");
  });
});

/** The opt-in is visible in the source: a new route cannot accept a seat key without appearing in this list. */
describe("which routes opt in to seat keys", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") && !f.includes(".test.") ? [join(dir, f)] : []));
  it("only the sponsor build and the presence touch set seatKey", () => {
    const optedIn = files(join(__dirname, "..")).filter((f) => /seatKey:\s*true/.test(readFileSync(f, "utf8"))).map((f) => f.slice(join(__dirname, "..").length + 1));
    expect(optedIn.sort()).toEqual(["server/presence/routes.ts", "server/sponsor/routes.ts"]);
  });
});
