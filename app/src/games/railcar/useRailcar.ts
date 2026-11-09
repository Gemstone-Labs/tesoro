"use client";

/**
 * The live Railcar page: reads the boarding car or the Player's car, turns it into the one screen (`railcarView`), sends the
 * Player's actions (board, step off, Jump, Brake), signals while the ride runs and finishes the ride from the pages of the
 * Players the result pays. The rules of what to do next are pure (flow.ts, finish.ts, brake.ts); who signs what is
 * signers.ts: the wallet signs the boarding, nothing after it once core records the seat key on the seat.
 *
 * The Brake (brake.ts): while the draw is asked for the page binds its seat's Brake seat and the next ones; once every
 * seat is bound an aboard Player's page ticks instead of signalling, and a Brake rides on the next tick. Only this page
 * shows it. A page whose seat names no seat key of this device's (the wallet route) signals, and its Brake is one
 * wallet-signed tick of its own; that wallet signs one signal as the ride starts (the early copy, `earlyCopyDue`), so the
 * rollup's public copy of the wallet never marks the moment of the Brake.
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
import { connReader, fits, simulatedUnits, type Reader } from "@/lib/chain/settle-plan";
import { sponsorStatus, sponsoredSend } from "@/lib/chain/sponsor-client";
import { prepareEntryTicket, readyBackingTicket } from "@/lib/chain/ticket";
import { seatKeys, type SeatKey } from "@/lib/seat/seat-key";
import { countingFor } from "@/lib/seat/signature-counter";
import { browserStore } from "@/lib/storage";
import { bindTargets, brakeState, earlyCopyDue, pageSend, tellCues, type EarlyCopy } from "./brake";
import { ENTRY_GEMAS, RAILCAR_PROGRAM_ID, bindBrakeIx, brakeSeatPda, carPda, checkDepartureIx, commitTableIx, configPda, decodeBrakeSeat, decodeCarAccount, decodeConfig, decodeTable, jumpIx, openCarIx, signalIx, startRideIx, tablePda, tickIx, type BrakeSeatView, type RailcarConfigView, type TableView } from "./chain";
import { backerSeatedIn, boardingEntry, type BoardingBacking } from "./boarding";
import { stepOffFor } from "./step-off";
import { sendStepOff } from "./step-off-send";
import { finishRide } from "./finish";
import { mayFinish, nextRideStep, pageIntervalMs, queueChoice, watchedRide } from "./flow";
import type { RailcarWatch } from "./RailcarScreen";
import { boardingSigner, brakeRoute, finishSender, joinSeatKey, jumpSigner } from "./signers";
import type { RailcarBrake, RailcarOffer } from "./RailcarScreen";
import { playTells } from "./tells";
import { RAILCAR_FEES } from "./payout";
import { RideTicker } from "./ticker";
import { railcarView, type RailcarView } from "./view";

/** Compute asked for when the Player pays the boarding themselves (the relayer's server sets its own). */
const SELF_PAID_UNITS = 400_000;
/** Finish steps one poll of one page sends; the next poll (or another page) carries on. */
const FINISH_PER_POLL = 8;
/** How often a page sends its share of the bindings while some seat is still unbound. */
const BIND_EVERY_MS = 3_000;

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
  /** My Brake: null off the car or outside the ride. */
  brake: RailcarBrake | null;
  playAgain(): void;
}

/** My Brake on this car, as this page last knew it (ride ms of the press), kept across reloads. */
const brakeKey = (account: string, carNo: bigint) => `railcar:brake:${account}:${carNo}`;
const recallBrake = (account: string, carNo: bigint): number | null => {
  try {
    const v = browserStore()?.getItem(brakeKey(account, carNo));
    return v ? Number(v) : null;
  } catch {
    return null;
  }
};
const rememberBrake = (account: string, carNo: bigint, ms: number) => {
  try {
    browserStore()?.setItem(brakeKey(account, carNo), String(ms));
  } catch {
    // site data blocked: the Brake seat (read with the seat key) still says
  }
};

/** The wallet's early copy made for this car (see `earlyCopyDue`), kept across reloads so a reload does not ask again. */
const copyKey = (account: string, carNo: bigint) => `railcar:copied:${account}:${carNo}`;
const recallCopied = (account: string, carNo: bigint): boolean => {
  try {
    return browserStore()?.getItem(copyKey(account, carNo)) === "1";
  } catch {
    return false;
  }
};
const rememberCopied = (account: string, carNo: bigint) => {
  try {
    browserStore()?.setItem(copyKey(account, carNo), "1");
  } catch {
    // site data blocked: a reload asks once more
  }
};

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
  // The Brake pressed on this page, waiting for the next tick to carry it.
  const pendingBrake = useRef(false);
  const [pending, setPending] = useState(false);
  const [mine, setMine] = useState<BrakeSeatView | null>(null);
  const [copy, setCopy] = useState<{ car: bigint; state: EarlyCopy } | null>(null);
  const lastBind = useRef(0);
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
        if (send && me && (!ride || mayFinish(ride, me) || step.kind !== "finalize")) run(() => finishFromPage(send, car, snap.base, me));
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

  // Signals while the ride runs: aboard Players' pages together send about 5 a second (pages of Players who are off add at most
  // about 5 more). An aboard Player's page ticks instead once its seat is bound and the seat key can sign; the Brake rides on
  // the next tick.
  const aboardN = snap?.rollup?.aboard ?? 0;
  const ride = snap?.car && snap.rollup && snap.rollup.carNo === snap.car.carNo ? snap.rollup : null;
  const riding = !!snap?.car && snap.mine && !!ride && (ride.phase === "riding" || ride.phase === "drawing");
  const signalTable = snap?.car?.table ?? null;
  const mySeat = me && ride ? (ride.seats.find((x) => x.account.equals(me)) ?? null) : null;
  // The seat key signs ticks (and carries the Brake) when the seat names it (core records it at boarding); else the wallet
  // signs a Brake of its own.
  const brakeVia = mySeat ? brakeRoute(wallet, seat, mySeat.signer) : null;
  const tickKey = brakeVia?.kind === "next-tick" ? brakeVia.signer : null;
  const aboard = !!mySeat && mySeat.order === 0;
  const allBound = !!ride && ride.brakesBound >= ride.seated && ride.seated > 0;
  const myBound = allBound || (!!mine && !!ride && mine.bound && mine.carNo === ride.carNo);
  const sends = pageSend({ aboard: aboard && ride?.phase === "riding", myBound, canSign: !!tickKey });
  const carNo = ride?.carNo ?? null;
  const tableSeat = mySeat?.tableSeat ?? null;
  // One ticker per ride (ticker.ts): it beats on a fixed cadence without waiting for confirms, and reads what to send (tick or
  // signal, the Brake, the interval) at each beat, so a change of those never restarts it (a restart could resend its bytes).
  const interval = pageIntervalMs({ aboard: aboardN, seated: ride?.seated ?? aboardN, mine: aboard ? "aboard" : "off" });
  const beatFacts = useRef({ sends, tickKey, tableSeat, interval, refresh });
  useEffect(() => {
    beatFacts.current = { sends, tickKey, tableSeat, interval, refresh };
  });
  useEffect(() => {
    if (!riding || signalTable === null || carNo === null) return;
    const page = pageKey.current;
    const chain = getChain();
    const ticker = new RideTicker(
      {
        blockhash: async () => (await (await chain.tee(page)).getLatestBlockhash()).blockhash,
        send: async (signer, tx) => (await chain.tee(signer)).sendRawTransaction((await signer.signTransaction(tx)).serialize(), { skipPreflight: true }),
        statuses: async (sigs) => (await (await chain.tee(page)).getSignatureStatuses(sigs)).value.map((st) => (st ? { err: st.err } : null)),
      },
      {
        intervalMs: () => beatFacts.current.interval,
        next: () => {
          const f = beatFacts.current;
          if (f.sends === "tick" && f.tickKey && f.tableSeat !== null) {
            const brake = pendingBrake.current;
            return { signer: f.tickKey, ixs: [tickIx(f.tickKey.publicKey, signalTable, carNo, f.tableSeat, brake)], brake };
          }
          return { signer: page, ixs: [signalIx(page.publicKey, signalTable)], brake: false };
        },
        onLanded: (beat) => {
          if (beat.brake) pendingBrake.current = false;
        },
        // the ride is over on the rollup: read it now rather than at the next poll
        onEnded: () => void beatFacts.current.refresh().catch(() => undefined),
      },
    );
    return () => ticker.stop();
  }, [riding, signalTable, carNo]);

  // While the draw is asked for (and until every seat is bound) the page binds its own Brake seat and the next ones.
  useEffect(() => {
    if (!snap?.mine || !ride || !snap.car || tableSeat === null) return;
    const targets = bindTargets(ride, tableSeat);
    if (!targets.length || Date.now() - lastBind.current < BIND_EVERY_MS) return;
    lastBind.current = Date.now();
    const page = pageKey.current;
    const table = snap.car.table;
    void getChain()
      .sendTee(page, targets.map((i) => bindBrakeIx(page.publicKey, table, ride.carNo, i, ride.seats[i].account)))
      .catch(() => undefined);
  }, [snap, ride, tableSeat]);

  // The wallet route's early copy: one wallet-signed signal as the ride starts, so a later Brake is not the wallet's first
  // rollup transaction (whose public copy would mark the moment). A seat-key page sends nothing extra.
  const copyNow: EarlyCopy = !ride ? "none" : copy && copy.car === ride.carNo ? copy.state : meKey && recallCopied(meKey, ride.carNo) ? "done" : "none";
  const askCopy = useCallback(() => {
    if (brakeVia?.kind !== "wallet" || !ride || signalTable === null || !meKey) return;
    const car = ride.carNo;
    const signer = brakeVia.signer;
    setCopy({ car, state: "asking" });
    void getChain()
      .sendTee(signer, [signalIx(signer.publicKey, signalTable)])
      .then(
        () => true,
        // a signal the program refused still landed, and the copy with it; a declined prompt sent nothing
        (e: unknown) => e instanceof Error && e.message.startsWith("tee tx failed"),
      )
      .then((landed) => {
        if (landed) rememberCopied(meKey, car);
        setCopy({ car, state: landed ? "done" : "declined" });
      });
  }, [brakeVia, ride, signalTable, meKey]);
  const copyDue = earlyCopyDue({ route: brakeVia?.kind ?? null, riding, aboard, copy: copyNow });
  const copyAsked = useRef<bigint | null>(null);
  useEffect(() => {
    if (!copyDue || carNo === null || copyAsked.current === carNo) return;
    copyAsked.current = carNo;
    askCopy();
  }, [copyDue, carNo, askCopy]);

  // My own Brake seat, readable only with my seat key (its permission names my wallet and that key).
  useEffect(() => {
    if (!tickKey || !ride || signalTable === null || tableSeat === null) return;
    let live = true;
    void getChain()
      .tee(tickKey)
      .then((conn) => conn.getAccountInfo(brakeSeatPda(tablePda(signalTable), tableSeat), "confirmed"))
      .then((info) => live && setMine(info ? decodeBrakeSeat(info.data) : null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tickKey, ride, signalTable, tableSeat]);

  // The Tells as sound and vibration, from what the public Table shows.
  const tells = useRef<{ car: bigint; tell: number; falseScrews: number } | null>(null);
  useEffect(() => {
    if (!ride || ride.phase !== "riding" || !snap?.mine) return;
    const prev = tells.current && tells.current.car === ride.carNo ? tells.current : null;
    tells.current = { car: ride.carNo, tell: ride.tell, falseScrews: ride.falseScrews };
    const cues = tellCues(prev, ride);
    if (cues.length) playTells(cues);
  }, [ride, snap?.mine]);

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
        // The entry draws the Player's Gemas (more lines than one transaction draws are staged in an Entry Ticket first), or
        // under a Backing always comes from the Offer's Backing Ticket, opened now (or found again after a reload).
        const { funder, preview } = await boardingEntry(chain.base, me, backing ?? undefined);
        const staging = { signer: wallet, seat: seatKey, getToken, game: RAILCAR_PROGRAM_ID, entry: BigInt(ENTRY_GEMAS), lines: preview.ticketLines };
        const ticket = backing ? await readyBackingTicket({ ...staging, ...backing }) : preview.needsTicket ? await prepareEntryTicket(staging) : null;
        const remaining = ticket ? [] : await drawRemaining(preview.plan);
        // A Backed Player who opens the car opens it first: the open and a Backed join do not fit one transaction.
        const opensFirst = choice.kind === "open" && !!backing;
        const build = async (payer: PublicKey, sponsored: boolean) => {
          const pot = ticket ? { address: ticket.address, nonce: ticket.nonce, lines: ticket.lineCap } : freshPot(funder, preview.potLines, await readNextTicket(funder));
          const join = joinSeatIx({ payer, player: wallet.publicKey, car: match, game: RAILCAR_PROGRAM_ID, page: choice.kind === "join" ? choice.page : 0, pot, backing: backing ?? undefined, remaining, seatSigner: joinSeatKey(seatKey) });
          const ixs: TransactionInstruction[] = sponsored ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: SELF_PAID_UNITS })];
          if (choice.kind === "join" || opensFirst) ixs.push(join, checkDepartureIx(choice.carNo, match));
          else {
            if (choice.departFirst) ixs.push(checkDepartureIx(choice.departFirst.carNo, choice.departFirst.car));
            ixs.push(openCarIx({ payer, opener: wallet.publicKey, config: s.config!, n }), join, checkDepartureIx(choice.carNo, match));
          }
          return ixs;
        };
        if (opensFirst) {
          await sendEntryTx(wallet, getToken, async (payer, sponsored) => [
            ...(sponsored ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: SELF_PAID_UNITS })]),
            ...(choice.departFirst ? [checkDepartureIx(choice.departFirst.carNo, choice.departFirst.car)] : []),
            openCarIx({ payer, opener: wallet.publicKey, config: s.config!, n }),
          ]);
        }
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
        // The seat key signs it when the seat names it (no wallet signature); else the wallet, as the Player's own exit.
        const loaded = snap.loaded;
        await sendStepOff({
          wallet,
          seat,
          seatSigner: s.signer,
          build: (caller) => stepOffFor(getChain().core, read.current!, { caller, loaded, seat: s }),
          sponsored: (signer, ixs) => sponsoredSend(signer, getToken, ixs),
          selfPaid: (signer, ixs) => getChain().sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: SELF_PAID_UNITS }), ...ixs]),
        });
        remember(meKey, null);
      }),
    [act, wallet, me, meKey, getToken, snap, seat],
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

  const pressBrake = useCallback(() => {
    if (!brakeVia || !meKey || !snap?.car || !ride || tableSeat === null) return;
    if (brakeVia.kind === "next-tick") {
      // the next tick carries it: no transaction of its own, no wallet prompt
      pendingBrake.current = true;
      setPending(true);
      return;
    }
    // No seat key of this page's on the seat: one tick of its own, signed by the wallet, once its early copy landed.
    if (copyNow !== "done") {
      if (copyNow !== "asking") askCopy();
      return;
    }
    const signer = brakeVia.signer;
    const table = snap.car.table;
    const at = Math.max(0, Date.now() - ride.rideTs * 1000);
    void act("brake", async () => {
      await getChain().sendTee(signer, [tickIx(signer.publicKey, table, ride.carNo, tableSeat, true)]);
      rememberBrake(meKey, ride.carNo, at);
    });
  }, [act, brakeVia, meKey, snap, ride, tableSeat, copyNow, askCopy]);

  // The press the page knows: my Brake seat when it can read it, else this page's memory of the send.
  const knownPress = mine && ride && mine.used && mine.carNo === ride.carNo ? mine.pressMs : meKey && ride ? recallBrake(meKey, ride.carNo) : null;
  useEffect(() => {
    if (pending && !pendingBrake.current && ride && meKey) {
      // the tick that carried it went through: until my Brake seat is read again, the page remembers when
      rememberBrake(meKey, ride.carNo, Math.max(0, now - ride.rideTs * 1000));
      setPending(false);
    }
  }, [pending, now, ride, meKey]);
  const rideMs = ride && ride.phase === "riding" ? Math.max(0, now - ride.rideTs * 1000) : 0;
  const state = ride?.phase === "riding" ? brakeState({ aboard, allBound, myBound, canSign: !!brakeVia, walletCopied: brakeVia?.kind !== "wallet" || copyNow === "done", pressMs: knownPress, pending: pending || busy === "brake", rideMs }) : null;
  const brake: RailcarBrake | null = state ? { ...state, onBrake: pressBrake } : null;

  const playAgain = useCallback(() => {
    if (meKey) remember(meKey, null);
    void refresh();
  }, [meKey, refresh]);

  const my = meKey ? recall(meKey) : null;
  const myBacking = my && snap?.car && my.match === snap.car.match.toBase58() ? (my.backing ?? null) : null;
  const view =
    snap?.loaded && snap.car
      ? railcarView({ me: meKey, core: snap.loaded.car, seats: snap.loaded.seats, table: snap.rollup && snap.rollup.carNo === snap.car.carNo ? snap.rollup : snap.base && snap.base.carNo === snap.car.carNo ? snap.base : null, fees: RAILCAR_FEES, nowMs: now, myBacking, myBrakeMs: knownPress })
      : null;
  const watch: RailcarWatch | null = snap?.watching && !snap.mine ? { signedIn: !!wallet, nextSeated: snap.boarding ? snap.boarding.loaded.car.seated : null } : null;
  const blocked = offerProblem ? new BackingError(offerProblem).message : snap?.backerSeated ? "Your Backer is in this car: board the next one" : null;
  const shownOffer: RailcarOffer | null = offer ? { backer: offer.backer, sharePct: offer.shareBps / 100, ...(blocked ? { blocked } : {}) } : null;
  const missing = offerAddress && offer === null ? new BackingError("missing").message : null;
  return { view, busy, error: error ?? missing, signedIn: !!wallet, watch, offer: shownOffer, offerSpent: offer?.status === "consumed", board, stepOff, jump, brake, playAgain };
}

/** A share of the finish (finalize, room, chunks, closes) through the relayer, sized against the server's lookup tables. */
async function finishFromPage(send: (ixs: TransactionInstruction[]) => Promise<string>, car: { carNo: bigint; match: PublicKey }, base: TableView | null, mine: PublicKey): Promise<void> {
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
    fitsTx: (ixs) => fits(relayer, ixs, { units: 1_000_000, tables }),
    mine,
    simulate: (ix) => simulatedUnits(conn, relayer, [ix], { units: 1_000_000, tables }),
    send: (ixs) => send(ixs),
    maxSends: FINISH_PER_POLL,
    now: Math.floor(Date.now() / 1000),
  });
}
