import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import coreIdl from "./idl/tesoro_core.json";
import holdemIdl from "./idl/holdem.json";
import { SeatKeyManager, memorySeatKeyStore } from "@/lib/seat/seat-key";
import { SeatScopeError } from "@/lib/seat/seat-scope";
import { signedMessage } from "./signed-request";
import { SponsorError, requestTable, resetEntryTokenState, setIdentityTokenGetter, sponsorBuild, sponsorBuildEntry } from "./sponsor-client";
import { touchPresence } from "./presence";

const walletKp = Keypair.generate();
const opener = Keypair.generate().publicKey.toBase58();
const matchKey = `${opener}-3`;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const disc = (idl: { instructions: { name: string; discriminator: number[] }[] }, name: string) => Buffer.from(idl.instructions.find((i) => i.name === name)!.discriminator);
const ixOf = (data: Buffer) => new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data });
const wallet = (): ChainSigner => ({ publicKey: walletKp.publicKey, signTransaction: async (t) => t, signMessage: async (m) => nacl.sign.detached(m, walletKp.secretKey) });

const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
let reply: (body: Record<string, unknown>) => { status: number; json: unknown };
beforeEach(() => {
  calls.length = 0;
  resetEntryTokenState();
  setIdentityTokenGetter(null);
  reply = () => ({ status: 200, json: { message: "m", meta: "x", mac: "y" } });
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const r = reply(body);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  });
});
afterEach(() => vi.unstubAllGlobals());

async function seatKey() {
  return new SeatKeyManager({ store: memorySeatKeyStore() }).forMatch(matchKey, walletKp.publicKey);
}

describe("a seat key's request to the sponsor", () => {
  it("speaks for the wallet: address is the wallet, signer the key, match the Match, signed over a message that names the key", async () => {
    const seat = await seatKey();
    await sponsorBuild(seat, async () => "jwt", [ixOf(disc(coreIdl as never, "close_match"))]);
    const b = calls[0].body as Record<string, string | number>;
    expect(b).toMatchObject({ step: "build", address: walletKp.publicKey.toBase58(), signer: seat.publicKey.toBase58(), match: seat.seatMatch.toBase58() });
    const message = signedMessage("tesoro-sponsor", "build", b.address as string, b.ts as number, b.nonce as string, { intent: b.intent as string, match: b.match as string }, seat.publicKey.toBase58());
    expect(nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(b.signature as string, "base64"), seat.publicKey.toBytes())).toBe(true);
    // and not as a wallet message: the same fields without the key's name do not verify
    const walletForm = signedMessage("tesoro-sponsor", "build", b.address as string, b.ts as number, b.nonce as string, { intent: b.intent as string, match: b.match as string });
    expect(nacl.sign.detached.verify(new TextEncoder().encode(walletForm), Buffer.from(b.signature as string, "base64"), seat.publicKey.toBytes())).toBe(false);
  });

  it("asks for finish steps only: any other instruction needs the wallet and never leaves the page", async () => {
    const seat = await seatKey();
    for (const ix of [ixOf(disc(coreIdl as never, "open_match")), ixOf(disc(coreIdl as never, "join_match")), ixOf(disc(coreIdl as never, "redeem")), ixOf(Buffer.alloc(8, 7)), ixOf(Buffer.alloc(0))]) {
      await expect(sponsorBuild(seat, async () => null, [ix])).rejects.toBeInstanceOf(SeatScopeError);
    }
    expect(calls).toHaveLength(0);
    for (const [idl, name] of [[coreIdl, "match_chunk"], [coreIdl, "close_match"], [coreIdl, "refund_match"], [holdemIdl, "finalize"], [holdemIdl, "refund_untabled"], [holdemIdl, "close_assignment"]] as const) {
      await sponsorBuild(seat, async () => null, [ixOf(disc(idl as never, name))]);
    }
    expect(calls).toHaveLength(6);
  });

  it("sends a wallet request without a signer field", async () => {
    await sponsorBuild(wallet(), async () => "jwt", [ixOf(Buffer.alloc(8))]);
    expect(calls[0].body.signer).toBeUndefined();
    expect(calls[0].body.match).toBeUndefined();
  });

  it("asks for the table with the seat key and retries while the join is confirming", async () => {
    const seat = await seatKey();
    let n = 0;
    reply = (body) => {
      if (body.step !== "table") return { status: 200, json: { ok: true, signature: "sig", confirmed: true } };
      return ++n < 3 ? { status: 409, json: { error: "wait", code: "join-pending" } } : { status: 200, json: { message: Buffer.alloc(0).toString("base64"), meta: "m", mac: "k" } };
    };
    // the built message is not a valid transaction here: only the request side is under test
    await requestTable(seat, async () => "jwt", seat.seatMatch, 4, 0).catch(() => undefined);
    const tables = calls.filter((c) => c.body.step === "table");
    expect(tables).toHaveLength(3);
    expect(tables[0].body).toMatchObject({ address: walletKp.publicKey.toBase58(), signer: seat.publicKey.toBase58(), match: seat.seatMatch.toBase58() });
  });
});

describe("the entry request", () => {
  const ixs = () => [ixOf(Buffer.alloc(8, 1))];

  it("is vouched for by the login alone: no signature, the identity token in its header, the wallet as address", async () => {
    setIdentityTokenGetter(async () => "id-token");
    const seat = await seatKey();
    const signMessage = vi.fn(wallet().signMessage);
    await sponsorBuildEntry({ ...wallet(), signMessage }, async () => "jwt", ixs());
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ step: "entry", address: walletKp.publicKey.toBase58() });
    expect(calls[0].body.signature).toBeUndefined();
    expect(calls[0].headers["privy-id-token"]).toBe("id-token");
    expect(calls[0].headers.authorization).toBe("Bearer jwt");
    expect(signMessage).not.toHaveBeenCalled();
    void seat;
  });

  it("falls back to the wallet-signed build when the server refuses it, and does not ask twice for a while", async () => {
    setIdentityTokenGetter(async () => "id-token");
    reply = (body) => (body.step === "entry" ? { status: 403, json: { error: "no", code: "wallet-not-yours" } } : { status: 200, json: { message: "m", meta: "x", mac: "y" } });
    const signMessage = vi.fn(wallet().signMessage);
    const w = { ...wallet(), signMessage };
    const built = await sponsorBuildEntry(w, async () => "jwt", ixs());
    expect(built.meta).toBe("x");
    expect(calls.map((c) => c.body.step)).toEqual(["entry", "build"]);
    expect(signMessage).toHaveBeenCalledTimes(1);
    calls.length = 0;
    await sponsorBuildEntry(w, async () => "jwt", ixs());
    expect(calls.map((c) => c.body.step)).toEqual(["build"]);
  });

  it("uses the wallet-signed build when there is no identity token to show", async () => {
    setIdentityTokenGetter(async () => null);
    await sponsorBuildEntry(wallet(), async () => "jwt", ixs());
    expect(calls.map((c) => c.body.step)).toEqual(["build"]);
  });

  it("carries a Backing Ticket's Offer beside the instructions, inside the signed intent when the wallet signs", async () => {
    setIdentityTokenGetter(async () => "id-token");
    const offer = Keypair.generate().publicKey;
    reply = (body) => (body.step === "entry" ? { status: 403, json: { error: "no", code: "wallet-not-yours" } } : { status: 200, json: { message: "m", meta: "x", mac: "y" } });
    await sponsorBuildEntry(wallet(), async () => "jwt", ixs(), Date.now(), { offer });
    expect(calls.map((c) => JSON.parse(c.body.intent as string).offer)).toEqual([offer.toBase58(), offer.toBase58()]);
    const b = calls[1].body as Record<string, string | number>;
    const message = signedMessage("tesoro-sponsor", "build", b.address as string, b.ts as number, b.nonce as string, { intent: b.intent as string });
    expect(nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(b.signature as string, "base64"), walletKp.publicKey.toBytes())).toBe(true);
    // with no hint the intent is the instructions alone
    calls.length = 0;
    await sponsorBuild(wallet(), async () => "jwt", ixs());
    expect(Object.keys(JSON.parse(calls[0].body.intent as string))).toEqual(["ixs"]);
  });

  it("does not hide other failures behind the fallback", async () => {
    setIdentityTokenGetter(async () => "id-token");
    reply = () => ({ status: 429, json: { error: "slow", code: "account-limit" } });
    await expect(sponsorBuildEntry(wallet(), async () => "jwt", ixs())).rejects.toBeInstanceOf(SponsorError);
    expect(calls).toHaveLength(1);
  });
});

describe("presence", () => {
  it("is signed by the seat key for the wallet's Account and names the key", async () => {
    const seat = await seatKey();
    await touchPresence(seat, async () => "jwt", matchKey);
    const b = calls[0].body as Record<string, string | number>;
    expect(b).toMatchObject({ step: "touch", address: walletKp.publicKey.toBase58(), signer: seat.publicKey.toBase58(), match: matchKey });
    const message = signedMessage("tesoro-presence", "touch", b.address as string, b.ts as number, b.nonce as string, { match: matchKey }, seat.publicKey.toBase58());
    expect(nacl.sign.detached.verify(new TextEncoder().encode(message), Buffer.from(b.signature as string, "base64"), seat.publicKey.toBytes())).toBe(true);
  });

  it("is the plain wallet request when the device holds no key", async () => {
    await touchPresence(wallet(), async () => "jwt", matchKey);
    expect(calls[0].body.signer).toBeUndefined();
    expect(b64(new Uint8Array())).toBe("");
    void PublicKey;
  });
});
