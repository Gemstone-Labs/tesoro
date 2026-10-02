"use client";

import { PublicKey } from "@solana/web3.js";
import { AccountLink } from "@/components/account/AccountLink";
import { Label } from "@/components/ui";
import { tesoroAccountPda } from "../holdem/chain";
import { shortKey } from "@/lib/chain/history";
import { DRAW, FILL, RULES, SIDE, type Book, type Duel } from "./chain";
import { chips, kindName, signedChips, sideName, tPlus, usdMid } from "./fmt";
import "./trading.css";

interface Props {
  /** Both Books, as committed to the base layer: public once the Match is over. */
  books: [Book, Book];
  duel: Duel;
  /** Seat of the viewer, when a Player: that table is labelled "You". */
  mySeat?: 0 | 1 | null;
}

/** Both Players' full fill histories after the Match: every order, its price, size and PnL. */
export function FillHistory({ books, duel, mySeat = null }: Props) {
  return (
    <section className="td td-fh" aria-label="Fill histories">
      <p className="meta">
        Final price {usdMid(duel.finalPrice, duel.asset)} · {duel.asset.symbol}/USD · positions were hidden until the Match ended.
      </p>
      <div className="td-fh-grid">
        {books.map((b, i) => (
          <Table key={b.seat} book={b} duel={duel} seat={i as 0 | 1} you={mySeat === i} />
        ))}
      </div>
    </section>
  );
}

function Table({ book, duel, seat, you }: { book: Book; duel: Duel; seat: 0 | 1; you: boolean }) {
  const account = tesoroAccountPda(new PublicKey(book.player)).toBase58();
  const eq = duel.finalEquity[seat];
  const won = duel.winner === seat;
  const verdict = duel.winner === DRAW ? "Draw" : won ? "Won" : "Lost";
  const truncated = book.fillCount > book.fills.length;
  return (
    <div className="cut cut-card td-card">
      <div className="spread">
        <Label>{you ? "You" : `Seat ${seat + 1}`}</Label>
        <span className="mono meta">{you ? shortKey(account) : <AccountLink account={account} newTab />}</span>
      </div>
      <p className="mono td-big">
        {chips(eq)} <span className="meta">Chips · {verdict}</span>
      </p>
      <p className="meta">
        {book.trades} {book.trades === 1 ? "trade" : "trades"}
        {book.liquidations > 0 ? ` · ${book.liquidations} liquidated` : ""}
      </p>
      {book.fills.length === 0 ? (
        <p className="meta td-empty">Did not trade.</p>
      ) : (
        <div className="td-fh-scroll">
          <table className="td-fh-t">
            <thead>
              <tr>
                <th>Time</th>
                <th>Order</th>
                <th className="r">Price</th>
                <th className="r">Notional</th>
                <th className="r">PnL</th>
              </tr>
            </thead>
            <tbody>
              {book.fills.map((f, i) => (
                <tr key={i}>
                  <td className="mono">{tPlus(f.t)}</td>
                  <td>
                    <span className={f.side === SIDE.long ? "td-dir up" : "td-dir down"} aria-hidden="true">{f.side === SIDE.long ? "▲ " : "▼ "}</span>
                    {f.kind === FILL.open ? `${sideName(f.side)} ${f.margin > 0n ? `${f.notional / f.margin}x` : ""}` : `${kindName(f.kind)} ${sideName(f.side).toLowerCase()}`}
                  </td>
                  <td className="r mono">{usdMid(f.price, duel.asset)}</td>
                  <td className="r mono">{chips(f.notional)}</td>
                  <td className="r mono">{f.kind === FILL.open ? "" : signedChips(f.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <p className="note">Showing the last {RULES.fillLog} of {book.fillCount} fills.</p>}
    </div>
  );
}
