"use client";

/**
 * The live Railcar page: reads the boarding car or the Player's car, turns it into the one screen (`railcarView`), sends the
 * Player's actions (board, step off, Jump), signals while the ride runs and finishes the ride from the pages of the Players
 * the result pays. The rules of what to do next are pure (flow.ts, finish.ts); who signs what is signers.ts: the wallet
 * signs the boarding, nothing after it but the Jump until Railcar takes the seat key.
 *
 * Not run against a deployment yet: Railcar has no devnet program (ticket 15).
 */
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accountOfSigner, keypairSigner, type ChainSigner } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { BackingError, backingProblem, fetchOffer, type ChainOffer } from "@/lib/chain/backing";
import { countersPda, matchPda, settledPda } from "@/lib/chain/basket";
import { getChain } from "@/lib/chain/client";
import { drawRemaining, freshPot, nextMatchOf, readNextTicket, sendEntryTx } from "@/lib/chain/entry";
import { matchKeyOf } from "@/lib/chain/match-id";
import { joinSeatIx } from "@/lib/chain/many-seat";
import { loadCar, type LoadedCar } from "@/lib/chain/many-seat-plan";
import { connReader, fits, type Reader } from "@/lib/chain/settle-plan";
import { sponsorStatus, sponsoredSend } from "@/lib/chain/sponsor-client";
import { prepareBackingTicket, prepareEntryTicket } from "@/lib/chain/ticket";
import { seatKeys, type SeatKey } from "@/lib/seat/seat-key";
import { countingFor } from "@/lib/seat/signature-counter";
import { browserStore } from "@/lib/storage";
import { ENTRY_GEMAS, RAILCAR_PROGRAM_ID, carPda, checkDepartureIx, commitTableIx, configPda, decodeCarAccount, decodeConfig, decodeTable, jumpIx, openCarIx, signalIx, startRideIx, tablePda, type RailcarConfigView, type TableView } from "./chain";
import { backerSeatedIn, boardingEntry, stepOffFor, type BoardingBacking } from "./boarding";
import { finishRide } from "./finish";
import { mayFinish, nextRideStep, queueChoice, signalIntervalMs, watchedRide } from "./flow";
import type { RailcarWatch } from "./RailcarScreen";
import { boardingSigner, finishSender, joinSeatKey, jumpSigner } from "./signers";
import type { RailcarOffer } from "./RailcarScreen";
import { railcarView, type FeeRates, type RailcarView } from "./view";

/** Railcar's fee terms (Platform 2%, Studio 3%) and core's Leaderboard Fee (1%), until the screen reads them from the Game record. */
const FEES: FeeRates = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };
/** Compute asked for when the Player pays the boarding themselves (the relayer's server sets its own). */
const SELF_PAID_UNITS = 400_000;
/** Finish steps one poll of one page sends; the next poll (or another page) carries on. */
const FINISH_PER_POLL = 8;

/** The car this device boarded, kept across reloads (a convenience: the chain is the record). */
interface MyCar {
  carNo: string;
  table: number;
  match: string;
  /** `<opener Account>-<n>`: the seat key's name. */
  matchKey: string;
  /** Boarded with a Backer's Gemas: whose, and the Player's share of the winnings (the seat forgets them when it closes). */
  backing?: { backer: string; shareBps: number };
}
const memoryKey = (account: string) => `railcar:car:${account}`;
const remember = (account: string, car: MyCar | null) => {
  try {
    browserStore()?.setItem(memoryKey(account), car ? JSON.stringify(car) : "");
  } catch {
    // site data blocked: the page still finds the boarding car
  }
};
const recall = (account: string): MyCar | null => {
  try {
    const v = browserStore()?.getItem(memoryKey(account));
    return v ? (JSON.parse(v) as MyCar) : null;
  } catch {
    return null;
  }
};

/** The key an address names; null for none or for text that is not a key. */
function keyOf(address: string | null): PublicKey | null {
  if (!address) return null;
  try {
    return new PublicKey(address);
  } catch {
    return null;
  }
}

interface Snapshot {
  config: RailcarConfigView | null;
  /** The car shown: the Player's, else a ride in progress (watched), else the boarding one. */
  car: { carNo: bigint; table: number; match: PublicKey } | null;
  loaded: LoadedCar | null;
  /** The car boarding now, which the Queue boards (the shown car too unless a ride is watched). */
  boarding: { carNo: bigint; loaded: LoadedCar } | null;
  /** The shown car is a ride this page watches, not the Player's. */
  watching: boolean;
  rollup: TableView | null;
  base: TableView | null;
  previousFrozen: boolean;
  mine: boolean;
  /** The Offer's Backer holds a mark in the car shown (core would refuse the backed join there). */
  backerSeated: boolean;
}

async function readSnapshot(read: Reader, tee: () => Promise<Connection | null>, me: PublicKey | null, my: MyCar | null, backer: PublicKey | null): Promise<Snapshot> {
  const [cfgInfo] = await read.many([configPda()]);
  const config = cfgInfo ? decodeConfig(cfgInfo.data) : null;
  let car: Snapshot["car"] = my ? { carNo: BigInt(my.carNo), table: my.table, match: new PublicKey(my.match) } : null;
  let boarding: Snapshot["boarding"] = null;
  let watching = false;
  if (!car && config && !config.boardingMatch.equals(PublicKey.default) && config.nextCar > 0n) {
    const carNo = config.nextCar - 1n;
    const [info] = await read.many([carPda(carNo)]);
    if (info) {
      const c = decodeCarAccount(info.data);
      car = { carNo, table: c.table, match: c.tesoroMatch };
      const loadedBoarding = await loadCar(read, c.tesoroMatch);
      if (loadedBoarding?.car.stage === "boarding") boarding = { carNo, loaded: loadedBoarding };
    }
  }
  // Not in a car: watch the ride in progress, if any, on the rollup's Tables.
  if (!my && config) {
    const conn = await tee();
    const infos = conn ? await conn.getMultipleAccountsInfo(Array.from({ length: config.tables }, (_, i) => tablePda(i)), "confirmed").catch(() => []) : [];
    const live = watchedRide(infos.flatMap((i) => (i ? [decodeTable(i.data)] : [])), Math.floor(Date.now() / 1000));
    if (live) {
      car = { carNo: live.carNo, table: live.index, match: live.tesoroMatch };
      watching = true;
    }
  }
  if (!car) return { config, car: null, loaded: null, boarding, watching, rollup: null, base: null, previousFrozen: false, mine: false, backerSeated: false };
  const loaded = boarding && boarding.carNo === car.carNo ? boarding.loaded : await loadCar(read, car.match);
  const mine = !!me && !!loaded?.seats.some((s) => s.seated && s.player.equals(me));
  // The Backer's mark is checked in the car the Queue boards, which a watched ride is not.
  const backerSeated = !!backer && !!boarding && !boarding.loaded.seats.some((x) => x.seated && !!me && x.player.equals(me)) && (await backerSeatedIn(read, boarding.loaded.car.address, backer));
  let rollup: TableView | null = null;
  let base: TableView | null = null;
  let previousFrozen = false;
  if (loaded && loaded.car.stage !== "boarding") {
    const [baseInfo] = await read.many([tablePda(car.table)]);
    base = baseInfo ? decodeTable(baseInfo.data) : null;
    const conn = await tee();
    const info = conn ? await conn.getAccountInfo(tablePda(car.table), "confirmed").catch(() => null) : null;
    rollup = info ? decodeTable(info.data) : null;
    if (rollup && rollup.carNo !== car.carNo && rollup.phase === "over") previousFrozen = !!(await read.many([settledPda(rollup.tesoroMatch)]))[0];
  }
  return { config, car, loaded, boarding, watching, rollup, base, previousFrozen, mine, backerSeated };
}

export interface RailcarPage {
  view: RailcarView | null;
  busy: string | null;
  error: string | null;
  signedIn: boolean;
  /** Set while this page watches a ride it is not in. */
  watch: RailcarWatch | null;
  /** The accepted Offer this page boards with (`?backing=`), null without one. */
  offer: RailcarOffer | null;
  /** The `?backing=` Offer has been used (this page boarded with it): the page drops it from its address. */
  offerSpent: boolean;
  board(): Promise<void>;
  stepOff(): Promise<void>;
  jump(): Promise<void>;
  playAgain(): void;
}

/** `offerAddress`: an accepted Offer to board with, from `/play/railcar?backing=<offer>`. */
export function useRailcar(offerAddress: string | null = null): RailcarPage {
  const { auth } = useAccount();
  const wallet: ChainSigner | null = auth.signer ?? null;
  const getToken = auth.getAccessToken;
  const me = wallet ? accountOfSigner(wallet) : null;
  const meKey = me?.toBase58() ?? null;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [seat, setSeat] = useState<SeatKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // A key made for this page: it signs the rollup's anyone-may steps (signals, start, commit) so the wallet is never asked.
  const pageKey = useRef<ChainSigner>(keypairSigner(Keypair.generate()));
  const stepping = useRef(false);
  const read = useRef<Reader | null>(null);
  // The Offer as the chain has it, read for one address (an address that is not a key reads as no Offer).
  const offerKey = useMemo(() => keyOf(offerAddress), [offerAddress]);
  const [offerRead, setOfferRead] = useState<{ address: string; offer: ChainOffer | null } | null>(null);
  // Read again after every action: boarding or a step-off uses the Offer.
  const [offerReads, setOfferReads] = useState(0);
  useEffect(() => {
    if (!offerKey) return;
    let live = true;
    void fetchOffer(offerKey)
      .catch(() => null)
      .then((o) => live && setOfferRead({ address: offerKey.toBase58(), offer: o }));
    return () => {
      live = false;
    };
  }, [offerKey, offerReads]);
  // undefined while unread; null when there is none.
  const offer: ChainOffer | null | undefined = !offerAddress ? undefined : !offerKey ? null : offerRead?.address === offerAddress ? offerRead.offer : undefined;
  // Judged once the Offer is read and, for one that exists, once the Player's Account is known.
  const nowSecs = Math.floor(now / 1000);
  const offerProblem = useMemo(
    () => (offerAddress && offer !== undefined && (offer === null || meKey) ? backingProblem(offer, { account: meKey ?? "", game: "railcar", entry: ENTRY_GEMAS, now: nowSecs }) : null),
    [offerAddress, offer, meKey, nowSecs],
  );
  const backing = useMemo<BoardingBacking | null>(() => (offer && !offerProblem ? { offer: offer.address, backerAccount: new PublicKey(offer.backer) } : null), [offer, offerProblem]);
  const backerKey = backing?.backerAccount.toBase58() ?? null;

  const tee = useCallback(async () => {
    try {
      return await getChain().tee(pageKey.current);
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    read.current ??= connReader(getChain().base);
    const s = await readSnapshot(read.current, tee, me, meKey ? recall(meKey) : null, backerKey ? new PublicKey(backerKey) : null);
    setSnap(s);
    return s;
  }, [me, meKey, tee, backerKey]);

  // The seat key this device holds for the Player's car (made at boarding).
  const myMatchKey = meKey ? (recall(meKey)?.matchKey ?? null) : null;
  const walletKey = wallet?.publicKey.toBase58() ?? null;
  useEffect(() => {
    if (!myMatchKey || !wallet) return;
    countingFor(myMatchKey);
    let live = true;
    void seatKeys()
      .find(myMatchKey, wallet.publicKey)
      .catch(() => null)
      .then((k) => live && setSeat(k));
    return () => {
      live = false;
    };
    // the wallet object changes with every render of the provider; its address is what the key belongs to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myMatchKey, walletKey]);

  // Poll: faster while a ride runs.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const s = await refresh().catch(() => null);
      if (stop) return;
      const riding = s?.rollup?.phase === "riding" || s?.rollup?.phase === "drawing";
      timer = setTimeout(loop, riding ? 400 : 1_500);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  // The clock the screen reads (the ride clock and the countdown).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // The next step for this car, sent by this page when it is one this page sends. Never with the wallet.
  useEffect(() => {
    if (!snap?.car || !snap.loaded || stepping.current) return;
    const car = snap.car;
    const ride = snap.rollup && snap.rollup.carNo === car.carNo ? snap.rollup : null;
    const step = nextRideStep({ mine: { carNo: car.carNo, table: car.table }, core: snap.loaded.car, rollup: snap.rollup, base: snap.base, previousFrozen: snap.previousFrozen, now: Math.floor(now / 1000) });
    const send = finishSender(seat, getToken);
    const page = pageKey.current;
    const chain = getChain();
    const run = (fn: () => Promise<unknown>) => {
      stepping.current = true;
      void fn()
        .catch(() => undefined) // another page may have sent the same step first: the next read shows where things are
        .finally(() => {
          stepping.current = false;
        });
    };
    if (!snap.mine) return;
    switch (step.kind) {
      case "depart":
        if (send) run(() => send([checkDepartureIx(car.carNo, car.match)]));
        return;
      case "start-ride":
        run(() => chain.sendTee(page, [startRideIx(page.publicKey, { carNo: car.carNo, table: car.table, tesoroMatch: car.match }, snap.loaded!.car.pages, snap.rollup && snap.rollup.carNo !== car.carNo ? snap.rollup.tesoroMatch : null)]));
        return;
      case "commit":
        if (me && ride && mayFinish(ride, me)) run(() => chain.sendTee(page, [commitTableIx(page.publicKey, car.table)]));
        return;
      case "finalize":
      case "settle":
      case "close":
        if (send && me && (!ride || mayFinish(ride, me) || step.kind !== "finalize")) run(() => finishFromPage(send, car, snap.base));
        return;
      case "done":
        if (meKey) remember(meKey, null);
        if (seat) void seatKeys().release(seat.seatMatchKey);
        return;
      default:
        // finalize-previous: the previous car's riders (or the keeper's sweep) finalize it; this page waits.
        return;
    }
  }, [snap, now, me, meKey, seat, getToken]);

  // Signals while the ride runs: open pages together send about 5 a second.
  const aboardN = snap?.rollup?.aboard ?? 0;
  const riding = !!snap?.car && snap.mine && snap.rollup?.carNo === snap.car.carNo && (snap.rollup.phase === "riding" || snap.rollup.phase === "drawing");
  const signalTable = snap?.car?.table ?? null;
  useEffect(() => {
    if (!riding || signalTable === null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const page = pageKey.current;
    const tick = async () => {
      await getChain()
        .sendTee(page, [signalIx(page.publicKey, signalTable)])
        .catch(() => undefined);
      if (!stop) timer = setTimeout(tick, signalIntervalMs(aboardN));
    };
    // A random first wait spreads the pages' signals over the interval.
    timer = setTimeout(tick, Math.random() * signalIntervalMs(aboardN));
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [riding, signalTable, aboardN]);

  const act = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      setBusy(name);
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message.split("\n")[0] : "That did not go through. Try again.");
      } finally {
        setBusy(null);
        setOfferReads((n) => n + 1);
      }
    },
    [refresh],
  );

  const board = useCallback(
    () =>
      act("board", async () => {
        if (!wallet || !me || !meKey) throw new Error("Sign in to board.");
        const chain = getChain();
        const s = await refresh();
        if (!s.config) throw new Error("Railcar is not open yet.");
        const loaded = s.boarding?.loaded ?? null;
        const seatedThere = !!loaded?.seats.some((x) => x.seated && x.player.equals(me));
        if (offerAddress && offerProblem) throw new BackingError(offerProblem);
        const choice = queueChoice({ config: s.config, boarding: loaded && s.boarding ? { car: loaded.car, carNo: s.boarding.carNo, pages: loaded.pages } : null, now: Math.floor(Date.now() / 1000), mine: seatedThere, backerSeated: s.backerSeated });
        if (choice.kind === "seated") return;
        if (choice.kind === "backer-seated") throw new Error("Your Backer is in this car: board the next one.");
        // The car's Match key names the seat key: the boarding car's opener and number, or the Player's own next Match.
        const n = choice.kind === "open" ? nextMatchOf((await chain.base.getAccountInfo(countersPda(me)))?.data) : 0n;
        const match = choice.kind === "join" ? choice.car : matchPda(me, n);
        const key = choice.kind === "join" ? matchKeyOf({ opener: loaded!.car.opener.toBase58(), n: loaded!.car.n }) : matchKeyOf({ opener: me.toBase58(), n });
        countingFor(key);
        const seatKey = await seatKeys().forMatch(key, wallet.publicKey);
        // The entry draws the Player's Gemas, or under a Backing the Backer's. More lines than one transaction draws are staged
        // in an Entry Ticket (a Backing Ticket for the Backer's) first.
        const { funder, preview } = await boardingEntry(chain.base, me, backing ?? undefined);
        const staging = { signer: wallet, seat: seatKey, getToken, game: RAILCAR_PROGRAM_ID, entry: BigInt(ENTRY_GEMAS), lines: preview.ticketLines };
        const ticket = !preview.needsTicket ? null : backing ? await prepareBackingTicket({ ...staging, ...backing }) : await prepareEntryTicket(staging);
        const remaining = ticket ? [] : await drawRemaining(preview.plan);
        const build = async (payer: PublicKey, sponsored: boolean) => {
          const pot = ticket ? { address: ticket.address, nonce: ticket.nonce, lines: ticket.lineCap } : freshPot(funder, preview.potLines, await readNextTicket(funder));
          const join = joinSeatIx({ payer, player: wallet.publicKey, car: match, game: RAILCAR_PROGRAM_ID, page: choice.kind === "join" ? choice.page : 0, pot, backing: backing ?? undefined, remaining, seatSigner: joinSeatKey(seatKey) });
          const ixs: TransactionInstruction[] = sponsored ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: SELF_PAID_UNITS })];
          if (choice.kind === "join") ixs.push(join, checkDepartureIx(choice.carNo, match));
          else {
            if (choice.departFirst) ixs.push(checkDepartureIx(choice.departFirst.carNo, choice.departFirst.car));
            ixs.push(openCarIx({ payer, opener: wallet.publicKey, config: s.config!, n }), join, checkDepartureIx(choice.carNo, match));
          }
          return ixs;
        };
        // The one wallet signature of the ride (the seat key co-signs once core names seat keys); the relayer pays.
        await sendEntryTx(boardingSigner(wallet, seatKey), getToken, build);
        const carNo = choice.carNo;
        remember(meKey, { carNo: carNo.toString(), table: Number(carNo % BigInt(s.config.tables)), match: match.toBase58(), matchKey: key, ...(backing && offer ? { backing: { backer: offer.backer, shareBps: offer.shareBps } } : {}) });
        setSeat(seatKey);
      }),
    [act, wallet, me, meKey, getToken, refresh, backing, offer, offerAddress, offerProblem],
  );

  const stepOff = useCallback(
    () =>
      act("step-off", async () => {
        if (!wallet || !me || !meKey || !snap?.loaded) return;
        const s = snap.loaded.seats.find((x) => x.seated && x.player.equals(me));
        if (!s) return;
        // A Backed seat's lines go home to the Backer; the Offer stays used, so the Player asks again to ride backed.
        const ix = await stepOffFor(getChain().core, read.current!, { caller: wallet.publicKey, loaded: snap.loaded, seat: s });
        // Stepping off is the Player's own exit: the wallet signs it, the relayer pays when it can.
        await sponsoredSend(wallet, getToken, [ix]).catch(() => getChain().sendBase(wallet, [ComputeBudgetProgram.setComputeUnitLimit({ units: SELF_PAID_UNITS }), ix]));
        remember(meKey, null);
      }),
    [act, wallet, me, meKey, getToken, snap],
  );

  const jump = useCallback(
    () =>
      act("jump", async () => {
        if (!wallet || !me || !snap?.car || !snap.rollup) return;
        const s = snap.rollup.seats.find((x) => x.account.equals(me));
        if (!s) return;
        const signer = jumpSigner(wallet, seat);
        await getChain().sendTee(signer, [jumpIx(signer.publicKey, snap.car.table, snap.car.carNo, s.tableSeat)]);
      }),
    [act, wallet, me, seat, snap],
  );

  const playAgain = useCallback(() => {
    if (meKey) remember(meKey, null);
    void refresh();
  }, [meKey, refresh]);

  const my = meKey ? recall(meKey) : null;
  const myBacking = my && snap?.car && my.match === snap.car.match.toBase58() ? (my.backing ?? null) : null;
  const view =
    snap?.loaded && snap.car
      ? railcarView({ me: meKey, core: snap.loaded.car, seats: snap.loaded.seats, table: snap.rollup && snap.rollup.carNo === snap.car.carNo ? snap.rollup : snap.base && snap.base.carNo === snap.car.carNo ? snap.base : null, fees: FEES, nowMs: now, myBacking })
      : null;
  const watch: RailcarWatch | null = snap?.watching && !snap.mine ? { signedIn: !!wallet, nextSeated: snap.boarding ? snap.boarding.loaded.car.seated : null } : null;
  const blocked = offerProblem ? new BackingError(offerProblem).message : snap?.backerSeated ? "Your Backer is in this car: board the next one" : null;
  const shownOffer: RailcarOffer | null = offer ? { backer: offer.backer, sharePct: offer.shareBps / 100, ...(blocked ? { blocked } : {}) } : null;
  const missing = offerAddress && offer === null ? new BackingError("missing").message : null;
  return { view, busy, error: error ?? missing, signedIn: !!wallet, watch, offer: shownOffer, offerSpent: offer?.status === "consumed", board, stepOff, jump, playAgain };
}

/** A share of the finish (finalize, room, chunks, closes) through the relayer, sized against the server's lookup tables. */
async function finishFromPage(send: (ixs: TransactionInstruction[]) => Promise<string>, car: { carNo: bigint; match: PublicKey }, base: TableView | null): Promise<void> {
  const status = await sponsorStatus();
  const conn = getChain().base;
  const relayer = new PublicKey(status.relayer);
  const tables = (await Promise.all((status.tables ?? []).map((t) => conn.getAddressLookupTable(new PublicKey(t)).then((r) => r.value)))).filter((t): t is AddressLookupTableAccount => !!t);
  await finishRide({
    read: connReader(conn),
    core: getChain().core as unknown as Parameters<typeof finishRide>[0]["core"],
    caller: relayer,
    carNo: car.carNo,
    match: car.match,
    committed: async () => !!base && base.carNo === car.carNo && base.phase === "over",
    fits: (ix) => fits(relayer, [ix], { units: 1_000_000, tables }),
    send: (ixs) => send(ixs),
    maxSends: FINISH_PER_POLL,
  });
}
