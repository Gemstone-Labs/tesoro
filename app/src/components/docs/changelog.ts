export type Change = { date: string; iso: string; title: string; body: string; href?: string };

/** What changed recently, in Player words. Dated from the merges on main; newest first. */
export const CHANGES: Change[] = [
  { date: "19 Oct", iso: "2026-10-19", title: "Vanguard", body: "The fourth Game: blitz Stratego on a 10x10 desert board. Hidden ranks, 5 seconds a move, capture the enemy Supply Truck to win. Play now, Practice free or Challenge a friend.", href: "/docs/matches#vanguard" },
  { date: "12 Oct", iso: "2026-10-12", title: "Trading Duel is a price grid", body: "Pick a box in each of 12 columns and score 100 points when the live price line passes through it. Two and a half minutes, SOL, ETH or HYPE, more points wins.", href: "/docs/matches#trading-duel" },
  { date: "10 Oct", iso: "2026-10-10", title: "Waitlist", body: "The home page is now a waitlist: leave an email to get your spot. How it works moved to /welcome.", href: "/welcome" },
  { date: "10 Oct", iso: "2026-10-10", title: "Leaderboard Pool and weekly Seasons", body: "Every Match adds 1% of its Pot to a pool. Each week the top 10 Players by points split it.", href: "/docs/leaderboard" },
  { date: "10 Oct", iso: "2026-10-10", title: "Profiles and wallet sign-in", body: "Sign in with Phantom or MetaMask, pick a name and a gemstone animal, or show your .sol or .eth name.", href: "/docs/accounts" },
  { date: "10 Oct", iso: "2026-10-10", title: "New logo, plainer words, and these Docs", body: "A facet T mark, copy with no plumbing in it, and a reading guide for players and developers.", href: "/docs/how-it-works" },
  { date: "3 Oct", iso: "2026-10-03", title: "Trading Duel", body: "The third Game: five minutes, the same live price, hidden positions, 1x to 20x on SOL, ETH or HYPE.", href: "/docs/matches#trading-duel" },
  { date: "3 Oct", iso: "2026-10-03", title: "One yield rule for every Position", body: "Each Position earns its own yield, so a 1 month Horizon repays in about 10 minutes.", href: "/docs/positions" },
  { date: "2 Oct", iso: "2026-10-02", title: "HyperEVM Positions are live", body: "Lock simHYPE on HyperEVM and play with it next to Solana and Ethereum Gemas.", href: "/docs/chains" },
  { date: "2 Oct", iso: "2026-10-02", title: "Account pages and Match spectating", body: "Open any Player's Account to see what they played, and watch any Match you are not in.", href: "/docs/accounts#public-page" },
];
