"use client";

/**
 * The live Railcar page: reads the boarding car or the Player's car, turns it into the one screen (`railcarView`), sends the
 * Player's actions (board, step off, Jump), signals while the ride runs and finishes the ride (finalize, room, chunks,
 * closes) from the pages of the Players the result pays. The rules of what to do next are pure (flow.ts); this file only
 * reads and sends.
 *
 * Not run against a deployment yet: Railcar has no devnet program (ticket 15). Base sends are the wallet's own until the
 * relayer's allow-list gains Railcar's instructions (hand-off); rollup sends are signed by a key made for this page.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { accountOfSigner, keypairSigner, type ChainSigner } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { basketPda, countersPda, matchPda, settledPda, spillPda, sponsorPda as coreSponsorPda } from "@/lib/chain/basket";
import { getChain } from "@/lib/chain/client";
import { drawRemaining, nextMatchOf, readNextTicket, freshPot, previewEntry, readEntryStores, sendEntryTx } from "@/lib/chain/entry";
import { decodeSeatMark, joinSeatIx, seatMarkPda, stepOffIx, type SeatView } from "@/lib/chain/many-seat";
import { closeIxs, loadCar, planSeatChunk, roomIxs, type LoadedCar } from "@/lib/chain/many-seat-plan";
import { decodeTicketHead } from "@/lib/chain/pot-store";
import { connReader, fits, supplySources, type Reader } from "@/lib/chain/settle-plan";
import { prepareEntryTicket } from "@/lib/chain/ticket";
import { browserStore } from "@/lib/storage";
import {
  ENTRY_GEMAS,
  RAILCAR_PROGRAM_ID,
  carPda,
  checkDepartureIx,
  commitTableIx,
  configPda,
  decodeCarAccount,
  decodeConfig,
  decodeTable,
  finalizeIx,
  jumpIx,
  openCarIx,
  signalIx,
  startRideIx,
  tablePda,
  type RailcarConfigView,
  type TableView,
} from "./chain";
import { mayFinish, nextRideStep, queueChoice, signalIntervalMs } from "./flow";
import { railcarView, type FeeRates, type RailcarView } from "./view";

/** Railcar's fee terms (Platform 2%, Studio 3%) and core's Leaderboard Fee (1%), until the screen reads them from the Game record. */
const FEES: FeeRates = { platformBps: 200, studioBps: 300, leaderboardBps: 100 };
const JOIN_UNITS = 400_000;

/** The car this device boarded, kept across reloads (a convenience: the chain is the record). */
interface MyCar {
  carNo: string;
  table: number;
  match: string;
}
const memoryKey = (account: string) => `railcar:car:${account}`;
const remember = (account: string, car: MyCar | null) => {
  try {
    const s = browserStore();
    if (car) s?.setItem(memoryKey(account), JSON.stringify(car));
    else s?.setItem(memoryKey(account), "");
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

interface Snapshot {
  config: RailcarConfigView | null;
  /** The car shown: the Player's, else the boarding one. */
  car: { carNo: bigint; table: number; match: PublicKey } | null;
  loaded: LoadedCar | null;
  rollup: TableView | null;
  base: TableView | null;
  previousFrozen: boolean;
  mine: boolean;
}

async function readSnapshot(read: Reader, tee: () => Promise<Connection | null>, me: PublicKey | null, my: MyCar | null): Promise<Snapshot> {
  const [cfgInfo] = await read.many([configPda()]);
  const config = cfgInfo ? decodeConfig(cfgInfo.data) : null;
  let car: Snapshot["car"] = my ? { carNo: BigInt(my.carNo), table: my.table, match: new PublicKey(my.match) } : null;
  if (!car && config && !config.boardingMatch.equals(PublicKey.default) && config.nextCar > 0n) {
    const carNo = config.nextCar - 1n;
    const [info] = await read.many([carPda(carNo)]);
    if (info) {
      const c = decodeCarAccount(info.data);
      car = { carNo, table: c.table, match: c.tesoroMatch };
    }
  }
  if (!car) return { config, car: null, loaded: null, rollup: null, base: null, previousFrozen: false, mine: false };
  const loaded = await loadCar(read, car.match);
  const mine = !!me && !!loaded?.seats.some((s) => s.seated && s.player.equals(me));
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
  return { config, car, loaded, rollup, base, previousFrozen, mine };
}

export interface RailcarPage {
  view: RailcarView | null;
  busy: string | null;
  error: string | null;
  signedIn: boolean;
  board(): Promise<void>;
  stepOff(): Promise<void>;
  jump(): Promise<void>;
  playAgain(): void;
}

export function useRailcar(): RailcarPage {
  const { auth } = useAccount();
  const signer: ChainSigner | null = auth.signer ?? null;
  const me = signer ? accountOfSigner(signer) : null;
  const meKey = me?.toBase58() ?? null;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // A key made for this page: it signs the rollup's anyone-may steps (signals, start, commit) so the wallet is never asked.
  const pageKey = useRef<ChainSigner>(keypairSigner(Keypair.generate()));
  const stepping = useRef(false);
  const read = useRef<Reader | null>(null);

  const tee = useCallback(async () => {
    try {
      return await getChain().tee(pageKey.current);
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    read.current ??= connReader(getChain().base);
    const s = await readSnapshot(read.current, tee, me, meKey ? recall(meKey) : null);
    setSnap(s);
    return s;
  }, [me, meKey, tee]);

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

  // The next step for this car, sent by this page when it is one this page sends.
  useEffect(() => {
    if (!snap?.car || !snap.loaded || stepping.current) return;
    const t = snap.rollup && snap.rollup.carNo === snap.car.carNo ? snap.rollup : null;
    const step = nextRideStep({ mine: { carNo: snap.car.carNo, table: snap.car.table }, core: snap.loaded.car, rollup: snap.rollup, base: snap.base, previousFrozen: snap.previousFrozen, now: Math.floor(now / 1000) });
    const finisher = !!me && !!t && mayFinish(t, me);
    const aboard = snap.mine;
    const send = async (fn: () => Promise<unknown>) => {
      stepping.current = true;
      try {
        await fn();
      } catch {
        // another page may have sent the same step first: the next read shows where things are
      } finally {
        stepping.current = false;
      }
    };
    const chain = getChain();
    const page = pageKey.current;
    const car = snap.car;
    const loaded = snap.loaded;
    switch (step.kind) {
      case "depart":
        if (aboard && signer) void send(() => chain.sendBase(signer, [checkDepartureIx(car.carNo, car.match)]));
        return;
      case "start-ride":
        if (aboard) void send(() => chain.sendTee(page, [startRideIx(page.publicKey, { carNo: car.carNo, table: car.table, tesoroMatch: car.match }, loaded.car.pages, snap.rollup && snap.rollup.carNo !== car.carNo ? snap.rollup.tesoroMatch : null)]));
        return;
      case "finalize-previous":
        // The previous car's Players normally finalize it; a waiting car's page does it when they did not.
        if (aboard && signer)
          void send(async () => {
            const [info] = await read.current!.many([carPda(step.carNo)]);
            if (!info) return;
            const prev = decodeCarAccount(info.data);
            const prevLoaded = await loadCar(read.current!, prev.tesoroMatch);
            if (prevLoaded) await chain.sendBase(signer, [finalizeIx(signer.publicKey, { ...prev, carNo: step.carNo }, prevLoaded.car.pages)]);
          });
        return;
      case "commit":
        if (finisher) void send(() => chain.sendTee(page, [commitTableIx(page.publicKey, car.table)]));
        return;
      case "finalize":
        if (finisher && signer) {
          void send(async () => {
            const [carInfo] = await read.current!.many([carPda(car.carNo)]);
            if (!carInfo) return;
            const c = decodeCarAccount(carInfo.data);
            await chain.sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), finalizeIx(signer.publicKey, { ...c, carNo: car.carNo }, loaded.car.pages)]);
          });
        }
        return;
      case "settle":
        if (finisher && signer)
          void send(async () => {
            const room = await roomIxs(read.current!, signer.publicKey, loaded);
            if (room.length) await chain.sendBase(signer, room);
            const plan = await planSeatChunk(chain.core, read.current!, signer.publicKey, loaded, (ix) => fits(signer.publicKey, [ix], { units: 400_000 }));
            if (plan) await chain.sendBase(signer, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), plan.ix]);
          });
        return;
      case "close":
        if (finisher && signer)
          void send(async () => {
            for (const ix of await closeIxs(read.current!, signer.publicKey, loaded)) await chain.sendBase(signer, [ix]);
          });
        return;
      case "done":
        if (meKey && snap.mine) remember(meKey, null);
        return;
      default:
        return;
    }
  }, [snap, now, me, meKey, signer]);

  // Signals while the ride runs: open pages together send about 5 a second.
  const aboardN = snap?.rollup?.aboard ?? 0;
  const riding = !!snap?.car && snap.rollup?.carNo === snap.car.carNo && (snap.rollup.phase === "riding" || snap.rollup.phase === "drawing");
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
      }
    },
    [refresh],
  );

  const board = useCallback(
    () =>
      act("board", async () => {
        if (!signer || !me || !meKey) throw new Error("Sign in to board.");
        const chain = getChain();
        const stores = await readEntryStores(me);
        const preview = previewEntry(stores, BigInt(ENTRY_GEMAS));
        // An entry of more lines than one transaction draws is staged in an Entry Ticket first.
        const pot = preview.needsTicket
          ? await prepareEntryTicket({ signer, getToken: auth.getAccessToken, game: RAILCAR_PROGRAM_ID, entry: BigInt(ENTRY_GEMAS), lines: preview.ticketLines }).then((t) => ({ address: t.address, nonce: t.nonce, lines: t.lineCap }))
          : freshPot(me, preview.potLines, await readNextTicket(me));
        const remaining = preview.needsTicket ? [] : await drawRemaining(preview.plan);
        const s = await refresh();
        if (!s.config) throw new Error("Railcar is not open yet.");
        const loaded = s.car && !s.mine ? s.loaded : null;
        const choice = queueChoice({ config: s.config, boarding: loaded && s.car ? { car: loaded.car, carNo: s.car.carNo, pages: loaded.pages } : null, now: Math.floor(Date.now() / 1000), mine: s.mine });
        const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: JOIN_UNITS })];
        let mine: MyCar;
        if (choice.kind === "seated") return;
        if (choice.kind === "backer-seated") throw new Error("Your Backer is in this car: board the next one.");
        if (choice.kind === "join") {
          ixs.push(joinSeatIx({ payer: signer.publicKey, player: signer.publicKey, car: choice.car, game: RAILCAR_PROGRAM_ID, page: choice.page, pot, remaining }), checkDepartureIx(choice.carNo, choice.car));
          mine = { carNo: choice.carNo.toString(), table: s.car!.table, match: choice.car.toBase58() };
        } else {
          const n = nextMatchOf((await chain.base.getAccountInfo(countersPda(me)))?.data);
          const match = matchPda(me, n);
          if (choice.departFirst) ixs.push(checkDepartureIx(choice.departFirst.carNo, choice.departFirst.car));
          ixs.push(
            openCarIx({ payer: signer.publicKey, opener: signer.publicKey, config: s.config, n }),
            joinSeatIx({ payer: signer.publicKey, player: signer.publicKey, car: match, game: RAILCAR_PROGRAM_ID, page: 0, pot, remaining }),
            checkDepartureIx(choice.carNo, match),
          );
          mine = { carNo: choice.carNo.toString(), table: Number(choice.carNo % BigInt(s.config.tables)), match: match.toBase58() };
        }
        await sendEntryTx(signer, auth.getAccessToken, async () => ixs, { sponsorable: false });
        remember(meKey, mine);
      }),
    [act, signer, me, meKey, auth.getAccessToken, refresh],
  );

  const stepOff = useCallback(
    () =>
      act("step-off", async () => {
        if (!signer || !me || !meKey || !snap?.loaded) return;
        const seat = snap.loaded.seats.find((s: SeatView) => s.seated && s.player.equals(me));
        if (!seat) return;
        const r = read.current!;
        const [mark, pot, sponsor] = await r.many([seatMarkPda(snap.loaded.car.address, me), seat.pot, coreSponsorPda()]);
        if (!mark || !pot) throw new Error("Your seat could not be read. Try again.");
        const lines = snap.loaded.lines[seat.index] ?? [];
        const books = await supplySources(getChain().core, r, lines.map((l) => ({ source: l.source, cut: false })));
        const remaining = [basketPda(seat.funder), spillPda(seat.funder)].map((k) => ({ pubkey: k, isSigner: false, isWritable: true }));
        await getChain().sendBase(signer, [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          stepOffIx({ caller: signer.publicKey, car: snap.loaded.car.address, seat, markPayer: decodeSeatMark(mark.data).payer, potPayer: decodeTicketHead(pot.data).payer, sponsor: !!sponsor, remaining: [...remaining, ...books.metas] }),
        ]);
        remember(meKey, null);
      }),
    [act, signer, me, meKey, snap],
  );

  const jump = useCallback(
    () =>
      act("jump", async () => {
        if (!signer || !me || !snap?.car || !snap.rollup) return;
        const s = snap.rollup.seats.find((x) => x.account.equals(me));
        if (!s) return;
        // The wallet signs the Jump until Railcar takes the seat key (seat keys ticket 08).
        await getChain().sendTee(signer, [jumpIx(signer.publicKey, signer.publicKey, snap.car.table, snap.car.carNo, s.tableSeat)]);
      }),
    [act, signer, me, snap],
  );

  const playAgain = useCallback(() => {
    if (meKey) remember(meKey, null);
    void refresh();
  }, [meKey, refresh]);

  const view =
    snap?.loaded && snap.car
      ? railcarView({ me: meKey, core: snap.loaded.car, seats: snap.loaded.seats, table: snap.rollup && snap.rollup.carNo === snap.car.carNo ? snap.rollup : snap.base && snap.base.carNo === snap.car.carNo ? snap.base : null, fees: FEES, nowMs: now })
      : null;
  return { view, busy, error, signedIn: !!signer, board, stepOff, jump, playAgain };
}
