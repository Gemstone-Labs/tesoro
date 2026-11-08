/**
 * Railcar on the relayer's allow-list (spec story 65: a Listed Game gets sponsored SOL costs). Boarding mixes Railcar's and
 * tesoro_core's instructions in one transaction, so it has its own shapes:
 *
 *   board         join_many_seat_match + check_departure
 *   open          open_car + join_many_seat_match + check_departure
 *   101st Player  check_departure (the full car) + open_car + join_many_seat_match + check_departure (the new car)
 *   open alone    open_car, or check_departure (the full car) + open_car: a Backed Player opens the car first, since the
 *                 open and a Backed join do not fit one transaction (Railcar ticket 18); the join follows on its own
 *   depart        check_departure                    (anyone, at the departure time)
 *   reveal        reveal_ride                        (the relayer as caller; the ride for the round history)
 *   finalize      finalize                           (the relayer as caller; the result goes to core)
 *
 * The core join is checked by `planCore` with the core rows (`join_many_seat_match`); the Gemas rules are the head-to-head
 * entry's. Every Railcar account must be the one the IDL names there (fixed PDAs derived here, the car's own seeds checked
 * by the program), with exactly the IDL's signer and writable flags, and the relayer only where it pays or calls.
 * Settle chunks, room, closes and refunds are core instructions and travel alone through `planCore`.
 */
import { BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import railcarIdl from "@/lib/chain/idl/railcar.json";
import { settledPda } from "@/lib/chain/basket";
import { CAR_MATCH_RENT, CORE_ID, RECEIPT_RENT, RuleError, coreName, planCore, type Ix, type Plan } from "./rules";

export const RAILCAR_ID = new PublicKey((railcarIdl as { address: string }).address);
const coder = new BorshInstructionCoder(railcarIdl as unknown as Idl);

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
}
const layout = (name: string): IdlAccount[] => (railcarIdl.instructions as unknown as { name: string; accounts: IdlAccount[] }[]).find((i) => i.name === name)!.accounts;

/** Rent of a Railcar `Car` (8 + 94 bytes); it goes back to its payer when `finalize` closes it. */
export const CAR_RENT = (102n + 128n) * 6_960n;
/** Seat pages a car has at most: `finalize` takes every one. */
const MAX_PAGES = 10;

const SHAPES: readonly (readonly string[])[] = [
  ["join_many_seat_match", "check_departure"],
  ["open_car", "join_many_seat_match", "check_departure"],
  ["check_departure", "open_car", "join_many_seat_match", "check_departure"],
  ["open_car"],
  ["check_departure", "open_car"],
  ["check_departure"],
  ["reveal_ride"],
  ["finalize"],
];

const railcarPda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, RAILCAR_ID)[0];
const corePda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE_ID)[0];
const s = (v: string) => Buffer.from(v);
const programData = PublicKey.findProgramAddressSync([RAILCAR_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];

/** What a Railcar account must be wherever it appears, when it is fixed (null: the instruction's own data decides). */
function fixed(name: string): PublicKey | null {
  switch (name) {
    case "config":
      return railcarPda(s("config"));
    case "authority":
      return railcarPda(s("authority"));
    case "event_authority":
      return railcarPda(s("__event_authority"));
    case "game_program":
    case "program":
      return RAILCAR_ID;
    case "program_data":
      return programData;
    case "game_record":
      return corePda(s("game"), RAILCAR_ID.toBuffer());
    case "core_config":
      return corePda(s("config"));
    case "economy":
      return corePda(s("economy"));
    case "core_event_authority":
      return corePda(s("__event_authority"));
    case "tesoro_program":
      return CORE_ID;
    case "system_program":
      return SystemProgram.programId;
    default:
      return null;
  }
}

const nameOf = (ix: Ix): string | null => {
  if (ix.programId.equals(CORE_ID)) return coreName(ix);
  if (ix.programId.equals(RAILCAR_ID)) return coder.decode(Buffer.from(ix.data))?.name ?? null;
  return null;
};

/**
 * Checks one Railcar instruction against its IDL layout; returns its accounts by name. The relayer may be `relayerSlot`
 * (where it calls or pays) and, besides, any of `receives` (where rent comes back to it).
 */
function checkRailcar(ix: Ix, name: string, relayer: PublicKey, relayerSlot: string | null, extra = 0, receives: readonly string[] = []): Map<string, PublicKey> {
  const accounts = layout(name);
  if (ix.keys.length < accounts.length || ix.keys.length > accounts.length + extra) throw new RuleError("bad-accounts", `${name} has the wrong number of accounts.`);
  const byName = new Map<string, PublicKey>();
  accounts.forEach((a, i) => {
    const k = ix.keys[i];
    if (k.isSigner !== !!a.signer || k.isWritable !== !!a.writable) throw new RuleError("bad-flags", `${name}: ${a.name} has the wrong signer or writable flag.`);
    if (k.pubkey.equals(relayer) && a.name !== relayerSlot && !receives.includes(a.name)) throw new RuleError("relayer-in-accounts", `${name}: the relayer may not be ${a.name}.`);
    const want = fixed(a.name);
    if (want && !k.pubkey.equals(want)) throw new RuleError("bad-account", `${name}: ${a.name} is not the expected address.`);
    byName.set(a.name, k.pubkey);
  });
  for (const k of ix.keys.slice(accounts.length)) {
    if (k.isSigner || k.pubkey.equals(relayer)) throw new RuleError("bad-accounts", `${name}: extra accounts may not sign or be the relayer.`);
  }
  if (relayerSlot && !byName.get(relayerSlot)?.equals(relayer)) throw new RuleError("bad-account", `${name}: the relayer is the ${relayerSlot}.`);
  if (ix.data.length > 64) throw new RuleError("too-large", "Instruction data is too large.");
  return byName;
}

const base = (names: string[]): Omit<Plan, "class" | "spend" | "cu"> => ({ kind: "core", names, obligations: [], pair: null, signers: [], seatSigners: [], playerSigns: false, funders: [], onboarding: false, invite: false, noGemas: false });

/** Checks an `open_car` of the Player's own next car (the relayer paying); returns the car's Match. */
function openedCar(ix: Ix, relayer: PublicKey, player: PublicKey): PublicKey {
  const a = checkRailcar(ix, "open_car", relayer, "payer");
  if (!a.get("opener")!.equals(player)) throw new RuleError("bad-signer", "The Player opens the car they board.");
  const n = BigInt((coder.decode(Buffer.from(ix.data))!.data as { n: { toString(): string } }).n.toString());
  const account = corePda(s("account"), player.toBuffer());
  const nBytes = Buffer.alloc(8);
  nBytes.writeBigUInt64LE(n);
  if (!a.get("opener_account")!.equals(account) || !a.get("counters")!.equals(corePda(s("counters"), account.toBuffer()))) throw new RuleError("bad-account", "open_car: the opener's Account is not the Player's.");
  const match = a.get("match_state")!;
  if (!match.equals(corePda(s("match"), account.toBuffer(), nBytes))) throw new RuleError("bad-shape", "open_car opens the Player's own next car.");
  return match;
}

/**
 * Accepts one of Railcar's sponsored shapes or throws a RuleError. `isGame` says whether Railcar is Listed (a Game that is not
 * Listed gets no sponsored costs).
 */
export function planRailcar(ixs: Ix[], relayer: PublicKey, player: PublicKey, isGame: (program: PublicKey) => boolean): Plan {
  if (!isGame(RAILCAR_ID)) throw new RuleError("unknown-program", "That program is not one we pay for.");
  const names = ixs.map((ix) => {
    const n = nameOf(ix);
    if (!n) throw new RuleError("unknown-instruction", "That instruction is not one we pay for.");
    return n;
  });
  if (!SHAPES.some((sh) => sh.length === names.length && sh.every((n, i) => n === names[i]))) throw new RuleError("bad-shape", `${names.join(" + ")} is not a transaction we pay for.`);
  const railcarAt = (n: string, i: number) => ixs[i].programId.equals(RAILCAR_ID) && names[i] === n;
  if (!names.every((n, i) => (n === "join_many_seat_match" ? ixs[i].programId.equals(CORE_ID) : railcarAt(n, i)))) throw new RuleError("bad-shape", "A Railcar transaction names Railcar's and core's instructions in their places.");

  if (names.length === 1 && names[0] === "reveal_ride") {
    const a = checkRailcar(ixs[0], "reveal_ride", relayer, "caller", MAX_PAGES);
    // Publishes the ride (an event); the relayer pays only the fee.
    return { ...base(names), kind: "game", class: "exit", spend: { refundable: 0n, sunk: 0n }, cu: 200_000, obligations: [a.get("match_state")!] };
  }
  if (names.length === 1 && names[0] === "finalize") {
    // The Car's rent goes back to whoever paid it: the relayer, when it paid a sponsored open_car.
    const a = checkRailcar(ixs[0], "finalize", relayer, "caller", MAX_PAGES, ["car_payer"]);
    const match = a.get("match_state")!;
    if (!a.get("receipt")!.equals(settledPda(match))) throw new RuleError("bad-account", "finalize: receipt is not the one for this Match.");
    // A Game step like the head-to-head Games' finalize: the relayer fronts the receipt's rent (`close_receipt` returns it).
    return { ...base(names), kind: "game", class: "exit", spend: { refundable: RECEIPT_RENT, sunk: 0n }, cu: 400_000, obligations: [match] };
  }
  if (names.length === 1 && names[0] === "check_departure") {
    const a = checkRailcar(ixs[0], "check_departure", relayer, null);
    return { ...base(names), class: "exit", spend: { refundable: 0n, sunk: 0n }, cu: 100_000, obligations: [a.get("match_state")!] };
  }

  // Opening alone: the Player's own next car, nobody boards it yet (the Backed join that follows has its own Gemas rule:
  // the Backer's, staged in a Backing Ticket). Railcar refuses an open while a car is boarding, so at most one waits.
  if (!names.includes("join_many_seat_match")) {
    const openAt = names.indexOf("open_car");
    const match = openedCar(ixs[openAt], relayer, player);
    if (openAt === 1 && checkRailcar(ixs[0], "check_departure", relayer, null).get("match_state")!.equals(match)) throw new RuleError("bad-shape", "The first departure check is for the car that is full.");
    return { ...base(names), class: "admission", spend: { refundable: CAR_RENT + CAR_MATCH_RENT, sunk: 0n }, cu: 200_000 + 100_000 * openAt, signers: [player], playerSigns: true, noGemas: true };
  }

  // Boarding: the core join decides the Gemas rules; Railcar's instructions must be about the same car and Player.
  const joinAt = names.indexOf("join_many_seat_match");
  const join = planCore([ixs[joinAt]], relayer, undefined, "railcar");
  const match = ixs[joinAt].keys[8].pubkey;
  const joiner = ixs[joinAt].keys[1].pubkey;
  if (!joiner.equals(player)) throw new RuleError("bad-signer", "The Player boards for themselves.");
  const departs = names.map((n, i) => (n === "check_departure" ? checkRailcar(ixs[i], "check_departure", relayer, null) : null));
  const after = departs.at(-1)!;
  if (!after.get("match_state")!.equals(match)) throw new RuleError("bad-shape", "The departure check after a join is for the car joined.");
  let spend = join.spend;
  let cu = join.cu + 100_000 * departs.filter(Boolean).length;
  const openAt = names.indexOf("open_car");
  if (openAt >= 0) {
    if (!openedCar(ixs[openAt], relayer, player).equals(match)) throw new RuleError("bad-shape", "open_car opens the car the Player joins.");
    spend = { refundable: spend.refundable + CAR_RENT + CAR_MATCH_RENT, sunk: spend.sunk };
    cu += 200_000;
    // A full car that has not left yet leaves first, in the same transaction.
    if (openAt === 1 && departs[0]!.get("match_state")!.equals(match)) throw new RuleError("bad-shape", "The first departure check is for the car that is full.");
  }
  return { ...join, kind: "core", names, class: "admission", spend, cu: Math.min(cu, 1_400_000), obligations: openAt >= 0 ? [] : [match] };
}
