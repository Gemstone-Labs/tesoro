import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { accountKeyOf } from "../../lib/chain/account-key";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { matchAddressOf } from "../../lib/chain/match-id";
import { TESORO_CORE_ID } from "../../lib/chain/native";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { MemoryPresenceStore } from "./lease";
import { handleFresh, handleTouch } from "./routes";

const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };

function signed(kp: Keypair, match: string) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-presence", "touch", address, NOW, nonce, { match })), kp.secretKey);
  return { step: "touch", address, ts: NOW, nonce, match, signature: Buffer.from(sig).toString("base64") };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("queue presence routes", () => {
  it("the opener touches, then the Match is fresh; 20 s later still, 40 s later not", async () => {
    const store = new MemoryPresenceStore();
    let now = NOW;
    const deps = { store, now: () => now };
    const kp = Keypair.generate();
    const match = `${accountKeyOf(kp.publicKey.toBase58())}-3`;
    expect(await handleTouch(deps, signed(kp, match), null, dev, NOW)).toEqual({ ok: true });
    expect(await handleFresh(deps, `${match},x-1`)).toEqual({ fresh: [match] });
    now = NOW + 20_000;
    expect((await handleFresh(deps, match)).fresh).toEqual([match]);
    now = NOW + 40_000;
    expect((await handleFresh(deps, match)).fresh).toEqual([]);
  });
  it("refuses a Player who is not the opener, and a malformed key", async () => {
    const store = new MemoryPresenceStore();
    const deps = { store, now: () => NOW };
    const kp = Keypair.generate();
    const other = `${accountKeyOf(Keypair.generate().publicKey.toBase58())}-3`;
    expect(await code(handleTouch(deps, signed(kp, other), null, dev, NOW))).toBe("not-opener");
    expect(await code(handleTouch(deps, signed(kp, "nonsense"), null, dev, NOW))).toBe("bad-request");
    expect(store.map.size).toBe(0);
  });
  it("refuses a missing or oversized id list", async () => {
    const deps = { store: new MemoryPresenceStore() };
    expect(await code(handleFresh(deps, null))).toBe("bad-request");
    expect(await code(handleFresh(deps, Array.from({ length: 101 }, (_, i) => `k-${i}`).join(",")))).toBe("bad-request");
  });
});

describe("queue presence signed by the Match's seat key", () => {
  const coder = new Program(coreIdl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
  const arr = (k: PublicKey) => Array.from(k.toBytes());
  const wallet = Keypair.generate();
  const opener = new PublicKey(accountKeyOf(wallet.publicKey.toBase58()));
  const matchKey = `${opener.toBase58()}-3`;
  const ana = Keypair.generate();
  const ben = Keypair.generate();

  const matchData = async (a: { account: PublicKey; seat: PublicKey }, b: { account: PublicKey; seat: PublicKey } | null) => {
    const party = (p: { account: PublicKey; seat: PublicKey }) => ({ player: arr(p.account), funder: arr(p.account), shareBps: 0, signer: arr(p.seat) });
    const inner = {
      id: { opener: arr(a.account), n: new BN(3) }, meta: { challenge: false, asset: 0, listed: true }, game: arr(Keypair.generate().publicKey), settleAuthority: arr(Keypair.generate().publicKey), deploySlot: new BN(1),
      terms: { platformBps: 200, studioBps: 300, studioOwner: null, studioPriority: true }, entry: new BN(500), openedAt: new BN(1), deadline: new BN(2), deadlineAbs: new BN(3),
      a: party(a), b: b ? party(b) : null, potLines: [1, 1], stage: { open: {} }, run: null,
    };
    const k = () => Keypair.generate().publicKey;
    return Buffer.from(await coder.encode("matchState", { bump: 255, inner, listed: true, listingEpoch: 0, payer: k(), pots: [k(), k()], room: Array.from({ length: 5 }, () => ({ account: arr(PublicKey.default), left: 0 })) }));
  };
  const seatPing = (by: Keypair, match = matchKey, forWallet = wallet) => {
    const address = forWallet.publicKey.toBase58();
    const nonce = newNonce();
    const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-presence", "touch", address, NOW, nonce, { match }, by.publicKey.toBase58())), by.secretKey);
    return { step: "touch", address, ts: NOW, nonce, match, signer: by.publicKey.toBase58(), signature: Buffer.from(sig).toString("base64") };
  };
  const world = async (a = { account: opener, seat: ana.publicKey }, b: { account: PublicKey; seat: PublicKey } | null = null) => {
    const store = new MemoryPresenceStore();
    const reads: string[] = [];
    const data = await matchData(a, b);
    const readMatch = async (address: PublicKey) => {
      reads.push(address.toBase58());
      return address.equals(matchAddressOf(matchKey)!) ? { owner: TESORO_CORE_ID, data } : null;
    };
    return { deps: { store, now: () => NOW, readMatch }, store, reads };
  };

  it("accepts the opener side's seat key and touches the row", async () => {
    const { deps, store, reads } = await world();
    expect(await handleTouch(deps, seatPing(ana), null, dev, NOW)).toEqual({ ok: true });
    expect(store.map.size).toBe(1);
    expect(reads).toEqual([matchAddressOf(matchKey)!.toBase58()]);
  });
  it("refuses another Match's key, the joiner's key, a stranger and a wallet that is not the opener", async () => {
    const { deps, store } = await world(undefined, { account: new PublicKey(accountKeyOf(Keypair.generate().publicKey.toBase58())), seat: ben.publicKey });
    expect(await code(handleTouch(deps, seatPing(ben), null, dev, NOW))).toBe("not-your-seat-key");
    expect(await code(handleTouch(deps, seatPing(Keypair.generate()), null, dev, NOW))).toBe("not-your-seat-key");
    const other = await world({ account: opener, seat: Keypair.generate().publicKey });
    expect(await code(handleTouch(other.deps, seatPing(ana), null, dev, NOW))).toBe("not-your-seat-key");
    const notOpener = Keypair.generate();
    expect(await code(handleTouch(deps, seatPing(ana, matchKey, notOpener), null, dev, NOW))).toBe("not-opener");
    expect(store.map.size + other.store.map.size).toBe(0);
  });
  it("refuses a seat key when the server cannot read the Match", async () => {
    const { store } = await world();
    expect(await code(handleTouch({ store, now: () => NOW }, seatPing(ana), null, dev, NOW))).toBe("not-your-seat-key");
  });
});
