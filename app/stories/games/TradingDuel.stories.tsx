import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { ASSETS, DRAW, FILL, LEAD, SIDE, STATUS, type Asset, type Book, type Duel } from "@/games/trading-duel/chain";
import { Chart } from "@/games/trading-duel/Chart";
import { FillHistory } from "@/games/trading-duel/FillHistory";
import { assetBySymbol, usdToMid, usePriceFeed, type Point } from "@/games/trading-duel/feed";
import { close, equity, liquidationMid, newLedger, open, type Ledger } from "@/games/trading-duel/math";
import { TradingScreen } from "@/games/trading-duel/TradingScreen";
import { TradingDuelPractice } from "@/games/trading-duel/practice/TradingDuelPractice";
import "@/games/trading-duel/trading.css";

const noop = () => undefined;
const pct = (mid: bigint, bp: number) => (mid * BigInt(bp)) / 10_000n;

type State = "countdown" | "flat" | "long" | "short" | "ended";

/** The Book for a state, opened against the first price the story sees. */
function ledgerFor(state: State, mid: bigint): Ledger {
  const l = newLedger();
  if (state === "long") {
    let b = open(l, SIDE.long, 1500n, 3, pct(mid, 9950), 15);
    b = close(b, pct(mid, 10040), 40).ledger;
    return open(b, SIDE.long, 3000n, 5, pct(mid, 9920), 60);
  }
  if (state === "short") return open(l, SIDE.short, 2000n, 20, (mid * 10_000n) / 10_350n, 70);
  if (state === "ended") return close(open(l, SIDE.long, 4000n, 5, pct(mid, 9900), 45), pct(mid, 10_060), 300, FILL.final).ledger;
  return l;
}

function Screen({ state, symbol }: { state: State; symbol: Asset["symbol"] }) {
  const asset = assetBySymbol(symbol);
  const feed = usePriceFeed(asset);
  const [t0] = useState(() => Date.now());
  const [ledger] = useState(() => ledgerFor(state, feed.tick?.mid ?? usdToMid(142.5)));
  const startsAt = state === "countdown" ? t0 + 8000 : state === "ended" ? t0 - 330_000 : t0 - 90_000;
  const opponent = state === "countdown" || state === "flat" ? { lead: "level" as const, trades: 0 } : { lead: "seat1" as const, trades: 2 };
  return (
    <TradingScreen
      asset={asset}
      entry={1000}
      feed={feed}
      ledger={ledger}
      seat={0}
      opponent={opponent}
      startsAt={startsAt}
      endsAt={startsAt + 300_000}
      ended={state === "ended"}
      busy={null}
      onOpen={noop}
      onClose={noop}
      onFlip={noop}
    />
  );
}

const meta = {
  title: "Games/Trading Duel",
  parameters: { layout: "padded", shell: "app" },
  argTypes: { symbol: { control: "inline-radio", options: ASSETS.map((a) => a.symbol) } },
} satisfies Meta<{ symbol: Asset["symbol"] }>;
export default meta;
type Story = StoryObj<{ symbol: Asset["symbol"] }>;

const screen = (state: State): Story => ({ args: { symbol: "SOL" }, render: (a) => <Screen key={a.symbol} state={state} symbol={a.symbol} /> });

/** Trading opens in a few seconds: orders are off. */
export const Countdown = screen("countdown");
/** Window open, no position. The price moves once a second (a made-up walk). */
export const Flat = screen("flat");
/** Long 5x, entered below the market. */
export const LongInProfit = screen("long");
/** Short 20x with the market a few percent above the entry: the liquidation line is close. */
export const ShortNearLiquidation = screen("short");
/** The window has closed: no orders, the final marks are in. */
export const Ended = screen("ended");

/** The real practice game against the bot, on the made-up price. */
export const PlayPractice: StoryObj = { render: () => <TradingDuelPractice /> };

/* ——— Chart ——— */

const ORIGIN = 1_800_000_000_000;
const NOW = ORIGIN + 150_000;

function walk(from: number, to: number, base = 142.5): Point[] {
  const out: Point[] = [];
  for (let t = from; t <= to; t += 2000) {
    const k = (t - ORIGIN) / 1000;
    out.push({ t, p: base * (1 + 0.006 * Math.sin(k / 23) + 0.003 * Math.sin(k / 6.1 + 1) + 0.0012 * Math.sin(k * 1.7)) });
  }
  return out;
}

const SERIES = walk(ORIGIN - 25_000, NOW);
const midAt = (sec: number) => usdToMid(SERIES.find((p) => p.t >= ORIGIN + sec * 1000)?.p ?? 142.5);

function chartProps(ledger: Ledger) {
  return {
    asset: ASSETS[0],
    series: SERIES,
    from: ORIGIN - 25_000,
    to: ORIGIN + 300_000,
    startsAt: ORIGIN,
    origin: ORIGIN,
    now: NOW,
    fills: ledger.fills,
    entry: ledger.side === SIDE.flat ? null : { price: Number(ledger.entry) / 1e8, side: ledger.side },
    liquidation: ledger.side === SIDE.flat ? null : Number(liquidationMid(ledger) ?? 0n) / 1e8 || null,
  };
}

const frame = (child: React.ReactNode) => <div className="td" style={{ maxWidth: 960 }}>{child}</div>;

export const ChartWaiting: StoryObj = {
  render: () => frame(<Chart {...chartProps(newLedger())} series={[]} />),
};

export const ChartNoPosition: StoryObj = {
  render: () => frame(<Chart {...chartProps(newLedger())} />),
};

export const ChartLongWithHistory: StoryObj = {
  render: () => {
    let l = open(newLedger(), SIDE.long, 1500n, 3, midAt(20), 20);
    l = close(l, midAt(60), 60).ledger;
    l = open(l, SIDE.long, 3000n, 5, midAt(90), 90);
    return frame(<Chart {...chartProps(l)} />);
  },
};

export const ChartShortNearLiquidation: StoryObj = {
  render: () => frame(<Chart {...chartProps(open(newLedger(), SIDE.short, 2000n, 20, (midAt(50) * 10_000n) / 10_300n, 50))} />),
};

export const ChartLiquidated: StoryObj = {
  render: () => {
    const l = open(newLedger(), SIDE.long, 3000n, 20, midAt(30), 30);
    return frame(<Chart {...chartProps(close(l, (midAt(30) * 94n) / 100n, 80, FILL.liquidated).ledger)} />);
  },
};

/* ——— Fill history ——— */

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

function book(seat: number, ledger: Ledger): Book {
  return {
    address: key(10 + seat),
    duel: key(20),
    player: key(30 + seat),
    seat,
    cash: ledger.cash,
    side: ledger.side,
    margin: ledger.margin,
    notional: ledger.notional,
    leverage: ledger.leverage,
    entry: ledger.entry,
    trades: ledger.trades,
    liquidations: ledger.liquidations,
    fills: ledger.fills,
    fillCount: ledger.fills.length,
  };
}

function history(): { books: [Book, Book]; duel: Duel } {
  const mid = usdToMid(142.5);
  let a = open(newLedger(), SIDE.long, 2000n, 5, pct(mid, 9950), 20);
  a = close(a, pct(mid, 10_030), 85).ledger;
  a = close(open(a, SIDE.short, 3000n, 10, pct(mid, 10_040), 120), pct(mid, 9980), 300, FILL.final).ledger;
  let b = close(open(newLedger(), SIDE.long, 5000n, 20, pct(mid, 10_000), 40), (pct(mid, 10_000) * 94n) / 100n, 100, FILL.liquidated).ledger;
  b = open(b, SIDE.short, 3000n, 5, pct(mid, 10_020), 200);
  b = close(b, pct(mid, 10_010), 300, FILL.final).ledger;
  const finalPrice = pct(mid, 9980);
  return {
    books: [book(0, a), book(1, b)],
    duel: {
      address: key(20),
      matchId: 14_400_000_000_000n,
      tesoroMatch: key(21),
      players: [key(30), key(31)],
      asset: ASSETS[0],
      status: STATUS.over,
      finalized: true,
      winner: equity(a, finalPrice) === equity(b, finalPrice) ? DRAW : equity(a, finalPrice) > equity(b, finalPrice) ? 0 : 1,
      startDeadline: 0,
      startsAt: ORIGIN / 1000,
      endsAt: ORIGIN / 1000 + 300,
      trades: [a.trades, b.trades],
      lead: LEAD.seat0,
      lastTick: ORIGIN / 1000 + 300,
      finalPrice,
      finalEquity: [equity(a, finalPrice), equity(b, finalPrice)],
    },
  };
}

/** Both Players' fills once the Match is over: wins, closes, a liquidation and the final mark. */
export const FillHistoryEnded: StoryObj = {
  render: () => {
    const { books, duel } = history();
    return <FillHistory books={books} duel={duel} mySeat={0} />;
  },
};

export const FillHistoryNoTrades: StoryObj = {
  render: () => {
    const { duel } = history();
    return <FillHistory books={[book(0, newLedger()), book(1, newLedger())]} duel={{ ...duel, winner: DRAW }} mySeat={null} />;
  },
};
