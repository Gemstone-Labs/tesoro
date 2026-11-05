import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { matchPda } from "@/lib/chain/basket";
import { closeCarIx, joinSeatIx, reserveRoomIx, seatChunkIx, stepOffIx } from "@/lib/chain/many-seat";
import { RAILCAR_PROGRAM_ID, checkDepartureIx, finalizeIx, openCarIx, revealRideIx } from "@/games/railcar/chain";
import { MAX_ROOM_LINES, RECEIPT_RENT, planTransaction, type Ix } from "./rules";
import { RAILCAR_ID } from "./rules-railcar";

const key = () => Keypair.generate().publicKey;
const relayer = key();
const player = key();
const account = PublicKey.findProgramAddressSync([Buffer.from("account"), player.toBuffer()], new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"))[0];
let listed = true;
const ctx = { relayer, player, isGame: (p: PublicKey) => listed && p.equals(RAILCAR_ID) };
const plan = (ixs: (Ix | TransactionInstruction)[]) => planTransaction(ixs as Ix[], ctx);
const refused = (ixs: (Ix | TransactionInstruction)[], code: string) => expect(() => plan(ixs)).toThrowError(expect.objectContaining({ code }));

const pot = () => ({ address: key(), nonce: 3n, lines: 2 });
const config = (boarding = key()) => ({ operator: key(), tables: 2, nextCar: 8n, boardingMatch: boarding });
/** The app's own boarding builders, the relayer paying. */
const join = (car: PublicKey, by = player) => joinSeatIx({ payer: relayer, player: by, car, game: RAILCAR_PROGRAM_ID, page: 0, pot: pot() });
const open = (n = 4n, by = player) => openCarIx({ payer: relayer, opener: by, config: config(), n });
const mine = (n = 4n) => matchPda(account, n);

describe("Railcar boarding on the relayer", () => {
  it("joins the boarding car with its departure check: an entry admission the Player signs, the relayer fronting the seat's rent", () => {
    const car = key();
    const p = plan([join(car), checkDepartureIx(7n, car)]);
    expect(p).toMatchObject({ kind: "core", names: ["join_many_seat_match", "check_departure"], class: "admission" });
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
    expect(p.obligations.map((k) => k.toBase58())).toEqual([car.toBase58()]);
    expect(p.spend.refundable).toBeGreaterThan(0n);
  });

  it("boards with a Backer's Offer: the same admission, the Backer named as the entry's funder", () => {
    const car = key();
    const backerAccount = key();
    const backed = joinSeatIx({ payer: relayer, player, car, game: RAILCAR_PROGRAM_ID, page: 0, pot: pot(), backing: { offer: key(), backerAccount } });
    const p = plan([backed, checkDepartureIx(7n, car)]);
    expect(p).toMatchObject({ names: ["join_many_seat_match", "check_departure"], class: "admission" });
    expect(p.funders.map((k) => k.toBase58())).toEqual([backerAccount.toBase58()]);
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
  });

  it("opens the next car and boards it, and the 101st Player's full car leaves in the same transaction", () => {
    const p = plan([open(), join(mine()), checkDepartureIx(8n, mine())]);
    expect(p).toMatchObject({ names: ["open_car", "join_many_seat_match", "check_departure"], class: "admission", obligations: [] });
    const full = key();
    expect(plan([checkDepartureIx(7n, full), open(), join(mine()), checkDepartureIx(8n, mine())]).names).toHaveLength(4);
  });

  it("refuses an open for a car the Player does not join, or someone else's", () => {
    refused([open(4n), join(mine(5n)), checkDepartureIx(8n, mine(5n))], "bad-shape");
    const other = key();
    refused([open(4n, other), join(mine()), checkDepartureIx(8n, mine())], "bad-signer");
    refused([join(key(), other), checkDepartureIx(7n, key())], "bad-signer");
  });

  it("refuses a departure check for another car than the one joined, and shapes that are not boarding", () => {
    refused([join(key()), checkDepartureIx(7n, key())], "bad-shape");
    refused([open()], "bad-shape");
    refused([join(key())], "bad-shape");
    refused([checkDepartureIx(7n, key()), checkDepartureIx(8n, key())], "bad-shape");
  });

  it("refuses the relayer anywhere but the payer, and a changed flag or fixed account", () => {
    const o = open();
    o.keys[1] = { ...o.keys[1], pubkey: relayer };
    refused([o, join(mine()), checkDepartureIx(8n, mine())], "relayer-in-accounts");
    const flags = checkDepartureIx(7n, key());
    flags.keys[0] = { ...flags.keys[0], isWritable: true };
    refused([flags], "bad-flags");
    const record = checkDepartureIx(7n, key());
    record.keys[2] = { ...record.keys[2], pubkey: key() };
    refused([record], "bad-account");
  });

  it("pays nothing for a Railcar that is not Listed", () => {
    listed = false;
    try {
      refused([checkDepartureIx(7n, key())], "unknown-program");
    } finally {
      listed = true;
    }
  });
});

describe("Railcar's finish on the relayer", () => {
  it("the departure check alone: an exit that fronts nothing", () => {
    const car = key();
    expect(plan([checkDepartureIx(7n, car)])).toMatchObject({ names: ["check_departure"], class: "exit", spend: { refundable: 0n, sunk: 0n } });
  });

  it("finalize with the relayer as caller: a Game step fronting the receipt, with every seat page of a 100-seat car", () => {
    const car = { carNo: 7n, table: 1, tesoroMatch: key(), payer: key() };
    const p = plan([finalizeIx(relayer, car, 10)]);
    expect(p).toMatchObject({ kind: "game", names: ["finalize"], class: "exit", spend: { refundable: RECEIPT_RENT } });
    expect(p.obligations[0].equals(car.tesoroMatch)).toBe(true);
    refused([finalizeIx(key(), car, 1)], "bad-account");
    const eleven = finalizeIx(relayer, car, 10);
    eleven.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
    refused([eleven], "bad-accounts");
  });

  it("reveal_ride with the relayer as caller: an exit that only pays the fee, with every seat page of a 100-seat car", () => {
    const car = { carNo: 7n, table: 1, tesoroMatch: key() };
    const p = plan([revealRideIx(relayer, car, 10)]);
    expect(p).toMatchObject({ kind: "game", names: ["reveal_ride"], class: "exit", spend: { refundable: 0n, sunk: 0n } });
    expect(p.obligations[0].equals(car.tesoroMatch)).toBe(true);
    refused([revealRideIx(key(), car, 1)], "bad-account");
    const eleven = revealRideIx(relayer, car, 10);
    eleven.keys.push({ pubkey: key(), isSigner: false, isWritable: false });
    refused([eleven], "bad-accounts");
    const wrongCore = revealRideIx(relayer, car, 1);
    wrongCore.keys[4] = { ...wrongCore.keys[4], pubkey: key() };
    refused([wrongCore], "bad-account");
  });

  it("core's many-seat chunks, room, closes: the relayer calls and gets the rent back", () => {
    const car = key();
    expect(plan([seatChunkIx(relayer, car, 7, Array.from({ length: 40 }, () => ({ pubkey: key(), isSigner: false, isWritable: true })))])).toMatchObject({ names: ["many_seat_chunk"], class: "exit" });
    const opener = key();
    expect(plan([reserveRoomIx(relayer, { address: car, opener, n: 1n }, key(), 100)]).spend.refundable).toBeGreaterThan(0n);
    refused([reserveRoomIx(relayer, { address: car, opener, n: 1n }, key(), MAX_ROOM_LINES + 1)], "bad-args");
    const page = { index: 0, matchKey: car, payer: relayer, seats: [] };
    // The relayer paid the page: its rent comes back to the relayer. A page itself is never the relayer.
    expect(plan([closeCarIx(relayer, { address: car, payer: relayer }, [page])]).names).toEqual(["close_many_seat_match"]);
    const bad = closeCarIx(relayer, { address: car, payer: relayer }, [page]);
    bad.keys[3] = { ...bad.keys[3], pubkey: relayer };
    refused([bad], "bad-accounts");
  });

  it("a step-off is the Player's own (the Player signs), the relayer only paying and taking its rent back", () => {
    const seat = { index: 3, seated: true, shareBps: 0, placeBps: 0, place: 0, potLines: 1, hold: 0, refund: 0n, player: account, funder: account, pot: key(), signer: null };
    const p = plan([stepOffIx({ caller: player, car: key(), seat, markPayer: relayer, potPayer: relayer, sponsor: true })]);
    expect(p).toMatchObject({ names: ["step_off_many_seat_match"], class: "exit", playerSigns: true });
  });
});
