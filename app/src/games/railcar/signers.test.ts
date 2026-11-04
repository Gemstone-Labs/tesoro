import { Keypair, PublicKey, TransactionMessage, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { matchKeyOf } from "@/lib/chain/match-id";
import { closeCarIx, closeSeatIx, joinSeatIx, reserveRoomIx, seatChunkIx, type SeatView } from "@/lib/chain/many-seat";
import { resetEntryTokenState, setIdentityTokenGetter, sponsoredSendBuilt } from "@/lib/chain/sponsor-client";
import { SeatKeyManager, memorySeatKeyStore } from "@/lib/seat/seat-key";
import { counted, countingFor, resetWalletSignatures, walletSignatures } from "@/lib/seat/signature-counter";
import { RAILCAR_PROGRAM_ID, checkDepartureIx, finalizeIx } from "./chain";
import { boardingSigner, finishSender, joinSeatKey, jumpSigner } from "./signers";

const relayer = Keypair.generate().publicKey;
const walletKp = Keypair.generate();
const opener = Keypair.generate().publicKey;
const matchKey = matchKeyOf({ opener: opener.toBase58(), n: 4n });
const car = PublicKey.findProgramAddressSync([Buffer.from("match"), opener.toBuffer(), Buffer.from([4, 0, 0, 0, 0, 0, 0, 0])], new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"))[0];
const key = () => Keypair.generate().publicKey;

/** The Player's wallet, every signature counted as the app counts them (`__tesoroWalletSignatures`). */
const wallet = (): ChainSigner =>
  counted({
    publicKey: walletKp.publicKey,
    signTransaction: async (t) => t,
    signMessage: async (m: Uint8Array) => nacl.sign.detached(m, walletKp.secretKey),
    signSerialized: async (raw: Uint8Array) => {
      const tx = VersionedTransaction.deserialize(raw);
      tx.sign([walletKp]);
      return tx.serialize();
    },
  } as ChainSigner);

const requests: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  requests.length = 0;
  resetWalletSignatures();
  resetEntryTokenState();
  setIdentityTokenGetter(null);
  countingFor(matchKey);
  // The sponsor: builds the message it was asked for, the relayer paying, and sends what comes back.
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith("/submit")) return { ok: true, status: 200, json: async () => ({ signature: "sig" }) };
    const intent = JSON.parse(body.intent) as { ixs: { program: string; keys: { pubkey: string; signer: boolean; writable: boolean }[]; data: string }[] };
    const ixs = intent.ixs.map((i) => new TransactionInstruction({ programId: new PublicKey(i.program), keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.signer, isWritable: k.writable })), data: Buffer.from(i.data, "base64") }));
    const message = new TransactionMessage({ payerKey: relayer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
    return { ok: true, status: 200, json: async () => ({ message: Buffer.from(message.serialize()).toString("base64"), meta: "m", mac: "x" }) };
  });
});
afterEach(() => vi.unstubAllGlobals());

const seat = (i: number): SeatView => ({ index: i, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: key(), funder: key(), pot: key(), signer: null });

/** The finish of an `n`-seat car as finish.ts sends it: finalize, room, every chunk, every seat close, the car's close. */
function finishSteps(n: number, chunks: number): TransactionInstruction[][] {
  const pages = Math.ceil(n / 10);
  return [
    [checkDepartureIx(4n, car)],
    [finalizeIx(relayer, { carNo: 4n, table: 0, tesoroMatch: car, payer: key() }, pages)],
    [reserveRoomIx(relayer, { address: car, opener, n: 4n }, key(), 100)],
    ...Array.from({ length: chunks }, () => [seatChunkIx(relayer, car, 7, [])]),
    ...Array.from({ length: n }, (_, i) => [closeSeatIx({ caller: relayer, car, seat: seat(i), markPayer: relayer, potPayer: relayer, sponsor: true })]),
    [closeCarIx(relayer, { address: car, payer: relayer }, Array.from({ length: pages }, (_, p) => ({ index: p, matchKey: car, payer: relayer, seats: [] })))],
  ];
}

async function ride(n: number, chunks: number) {
  const w = wallet();
  const seatKey = await new SeatKeyManager({ store: memorySeatKeyStore() }).forMatch(matchKey, walletKp.publicKey);
  // Boarding: the one transaction the wallet signs (the seat key co-signs it once core names seat keys).
  const join = joinSeatIx({ payer: relayer, player: walletKp.publicKey, car, game: RAILCAR_PROGRAM_ID, page: 0, pot: { address: key(), nonce: 1n, lines: 1 }, seatSigner: joinSeatKey(seatKey) });
  await sponsoredSendBuilt(boardingSigner(w, seatKey), async () => "jwt", [join, checkDepartureIx(4n, car)], { entry: true });
  const afterBoarding = walletSignatures()[matchKey]?.total ?? 0;
  // The whole finish, with the seat key vouching for every request (the switch as it will be with seat keys ticket 08).
  const send = finishSender(seatKey, async () => "jwt", true)!;
  const steps = finishSteps(n, chunks);
  for (const ixs of steps) await send(ixs);
  const finishRequests = requests.filter((r) => r.url.endsWith("/build")).slice(1);
  return { afterBoarding, total: walletSignatures()[matchKey]?.total ?? 0, steps: steps.length, finishRequests, seatKey };
}

describe("a Railcar ride's wallet signatures (Privy bills each one)", () => {
  it("5 Players: the wallet signs the boarding; the departure check, finalize, room, chunks and closes need none", async () => {
    const r = await ride(5, 2);
    expect(r.afterBoarding).toBe(1);
    expect(r.steps).toBe(11);
    expect(r.total).toBe(1);
    // Every finish request is the seat key's: it names the key and its Match, and carries no wallet signature.
    expect(r.finishRequests).toHaveLength(r.steps);
    expect(r.finishRequests.every((q) => q.body.signer === r.seatKey.publicKey.toBase58() && q.body.match === car.toBase58())).toBe(true);
  });

  it("100 Players with the worst-case 145 settle chunks: still the one boarding signature", async () => {
    const r = await ride(100, 145);
    expect(r.steps).toBe(1 + 1 + 1 + 145 + 100 + 1);
    expect(r.total).toBe(1);
  });

  it("the Jump switches to the seat key with one flag; until then the wallet signs it", async () => {
    const w = wallet();
    const seatKey = await new SeatKeyManager({ store: memorySeatKeyStore() }).forMatch(matchKey, walletKp.publicKey);
    expect(jumpSigner(w, seatKey)).toBe(w);
    expect(jumpSigner(w, seatKey, true)).toBe(seatKey);
    expect(finishSender(null, async () => null, true)).toBeNull();
  });
});
