export type DocPage = {
  href: string;
  title: string;
  /** One line shown under the title and in search results. */
  summary: string;
  /** Extra words search should match. */
  keywords?: string;
};

export type DocGroup = { id: "players" | "developers"; label: string; pages: DocPage[] };

/** The Docs tree: drives the sidebar, previous/next links and search. Player pages first, then Developers. */
export const DOC_GROUPS: DocGroup[] = [
  {
    id: "players",
    label: "Playing on Tesoro",
    pages: [
      { href: "/docs", title: "Overview", summary: "What Tesoro is, in one page, and where to go next.", keywords: "start intro welcome" },
      { href: "/docs/how-it-works", title: "How Tesoro works", summary: "From a Position to an Advance, a Match and Redeem.", keywords: "flow steps yield advance" },
      { href: "/docs/accounts", title: "Accounts and sign-in", summary: "Sign in with email or a wallet, and set up your profile.", keywords: "login privy phantom metamask profile avatar name sol eth" },
      { href: "/docs/positions", title: "Positions and Advances", summary: "Lock a staking token, take an Advance, get your Position back.", keywords: "principal horizon debt unlock estimate stake lock" },
      { href: "/docs/gemas", title: "Gemas", summary: "The play unit, what backs it, and how Redeem works.", keywords: "source redeem pending value $0.01" },
      { href: "/docs/matches", title: "Games and Matches", summary: "Block Puzzle, Hold'em and Trading Duel, entries, Queue, Challenge.", keywords: "queue challenge pot entry draw refund chips" },
      { href: "/docs/backing", title: "Backing", summary: "Fund a Player's entry and share what they win.", keywords: "backer request offer split surplus" },
      { href: "/docs/leaderboard", title: "Leaderboard", summary: "Weekly seasons, points for wins, and the Leaderboard Pool.", keywords: "season points pool top 10 prize ranking" },
      { href: "/docs/fees", title: "Fees", summary: "Every fee Tesoro takes, in one table, with a worked Match.", keywords: "platform studio leaderboard fee percent cost" },
      { href: "/docs/chains", title: "Chains", summary: "Solana, Ethereum and HyperEVM: where Positions live.", keywords: "solana ethereum hoodi hyperevm hype eth sol cross-chain" },
      { href: "/docs/fairness", title: "Fairness and privacy", summary: "How hidden information stays hidden and results stay honest.", keywords: "random hidden private verify cheat" },
      { href: "/docs/risks", title: "Risks and limits", summary: "What can go wrong, what is simulated, and what is not reviewed.", keywords: "risk simulated testnet audit legal warning" },
    ],
  },
  {
    id: "developers",
    label: "Developers",
    pages: [
      { href: "/docs/developers", title: "Architecture", summary: "The pieces, the trust boundaries and how they fit together.", keywords: "overview design stack keeper" },
      { href: "/docs/developers/programs", title: "Programs and addresses", summary: "Every deployed program and contract, with explorer links.", keywords: "program id address explorer deploy pda" },
      { href: "/docs/developers/settlement", title: "How settlement works", summary: "How a Game program settles a Pot through tesoro_core.", keywords: "settle_match cpi authority register_game fees pot lines" },
      { href: "/docs/developers/rollups", title: "Private Ephemeral Rollups", summary: "Hidden state with MagicBlock: delegation, permissions, randomness.", keywords: "magicblock per tee tdx vrf delegate permission seed deck" },
      { href: "/docs/developers/cross-chain", title: "Cross-chain with LayerZero V2", summary: "How EVM Positions reach the Solana ledger and back.", keywords: "layerzero oapp bridge hoodi hyperevm message dvn" },
      { href: "/docs/developers/simulated-yield", title: "Simulated yield", summary: "The per-Position yield model behind '1 month = 10 min'.", keywords: "sim_lst simsol simeth apy speedup 4380 mint" },
      { href: "/docs/developers/security", title: "Security", summary: "Review results, the key incident, trust assumptions.", keywords: "audit findings key compromise rotation admin upgrade authority" },
      { href: "/docs/developers/run", title: "Run it locally", summary: "Clone, build, test, and point at devnet.", keywords: "install pnpm anchor foundry env keeper verify" },
    ],
  },
];

export const ALL_PAGES: DocPage[] = DOC_GROUPS.flatMap((g) => g.pages);

export function pageIndex(href: string): number {
  return ALL_PAGES.findIndex((p) => p.href === href);
}

export function neighbours(href: string): { prev: DocPage | null; next: DocPage | null } {
  const i = pageIndex(href);
  return { prev: i > 0 ? ALL_PAGES[i - 1] : null, next: i >= 0 && i < ALL_PAGES.length - 1 ? ALL_PAGES[i + 1] : null };
}

export function groupOf(href: string): DocGroup | undefined {
  return DOC_GROUPS.find((g) => g.pages.some((p) => p.href === href));
}
