import Link from "next/link";
import { ArrowRight, BookOpenCheck, Code2 } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { IconTile } from "./visual";

const PROGRAMS = [
  ["tesoro_core", "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"],
  ["block_puzzle", "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"],
  ["holdem", "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"],
  ["trading_duel", "CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj"],
  ["vanguard", "TS3iowavNFV2pMUrHcbmGNC9SW2Vv54i52DqjKebYKH"],
  ["sim_lst", "WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F"],
] as const;

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/** The index's "start here" cards: play, read the program ids. */
export function StartCards() {
  return (
    <div className="dx-start">
      <section className="dx-start-card">
        <header>
          <IconTile icon={BookOpenCheck} tone="sapphire" size="sm" />
          <h2>Play</h2>
        </header>
        <p>Open the app, get Gemas from your Wallet and play your first Match in a few minutes.</p>
        <Link href="/lobby" className="btn neutral cut cut-btn">
          Launch app <ArrowRight aria-hidden />
        </Link>
      </section>

      <section className="dx-start-card">
        <header>
          <IconTile icon={Code2} tone="violet" size="sm" />
          <h2>Developers</h2>
        </header>
        <p>Solana program IDs. Each links to the explorer on the Programs page.</p>
        <ul className="dx-ids">
          {PROGRAMS.map(([name, id]) => (
            <li key={name}>
              <span>{name}</span>
              <code>{short(id)}</code>
              <CopyButton value={id} label={`Copy ${name} program ID`} />
            </li>
          ))}
        </ul>
        <Link href="/docs/developers/programs" className="dx-start-more">
          All programs and contracts <ArrowRight aria-hidden />
        </Link>
      </section>
    </div>
  );
}
