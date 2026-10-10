import Link from "next/link";
import { ArrowRight, BookOpenCheck, Code2, Terminal } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { IconTile } from "./visual";

const PROGRAMS = [
  ["tesoro_core", "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"],
  ["block_puzzle", "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"],
  ["holdem", "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"],
  ["trading_duel", "CNETsX9Gc78iApRNiGyAtiERKiHeD1yhHS8MwrfBAYyj"],
  ["sim_lst", "WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F"],
] as const;

const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

/** The index's "start here" cards: play, read the program ids, run it locally. */
export function StartCards() {
  return (
    <div className="dx-start">
      <section className="dx-start-card">
        <header>
          <IconTile icon={BookOpenCheck} tone="sapphire" size="sm" />
          <h2>Play</h2>
        </header>
        <p>Open the app, grab test simSOL from the Wallet faucet and play your first Match in a few minutes. Test mode: nothing has value.</p>
        <Link href="/lobby" className="btn neutral cut cut-btn">
          Launch app <ArrowRight aria-hidden />
        </Link>
      </section>

      <section className="dx-start-card">
        <header>
          <IconTile icon={Code2} tone="violet" size="sm" />
          <h2>Developers</h2>
        </header>
        <p>Solana devnet program IDs. Each links to the explorer on the Programs page.</p>
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

      <section className="dx-start-card">
        <header>
          <IconTile icon={Terminal} tone="amber" size="sm" />
          <h2>Run it locally</h2>
        </header>
        <div className="dx-cmd">
          <span aria-hidden>$</span>
          <code>pnpm install</code>
          <CopyButton value="pnpm install" label="Copy install command" />
        </div>
        <div className="dx-cmd">
          <span aria-hidden>$</span>
          <code>NEXT_PUBLIC_DEV_WALLET=1 pnpm dev</code>
          <CopyButton value="NEXT_PUBLIC_DEV_WALLET=1 pnpm dev" label="Copy dev command" />
        </div>
        <Link href="/docs/developers/run" className="dx-start-more">
          Build, test and point at devnet <ArrowRight aria-hidden />
        </Link>
      </section>
    </div>
  );
}
