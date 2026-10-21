export type Change = { date: string; iso: string; title: string; body: string; href?: string };

/** What changed recently, in Player words. Dated from the merges on main; newest first. */
export const CHANGES: Change[] = [
  { date: "21 Oct", iso: "2026-10-21", title: "Vanguard turns are 10 seconds", body: "You now get 10 seconds for each move, each step of a Two-Step Turn included.", href: "/docs/matches#vanguard" },
  { date: "19 Oct", iso: "2026-10-19", title: "Vanguard", body: "The fourth Game: blitz Stratego on a 10x10 desert board. Hidden ranks, 5 seconds a move, capture the enemy Supply Truck to win. Play now, Practice free or Challenge a friend.", href: "/docs/matches#vanguard" },
  { date: "19 Oct", iso: "2026-10-19", title: "Buckshot Hold'em", body: "Heads-up Hold'em has a new name. Same Game, same rules.", href: "/docs/matches#holdem" },
  { date: "19 Oct", iso: "2026-10-19", title: "Limits and Breaks", body: "Set an Entry Limit for any 7 days, take a Break from one day to six weeks, or exclude yourself for six months or more. Unlock and Redeem always work. Find them under Edit profile." },
  { date: "19 Oct", iso: "2026-10-19", title: "Email when your Match settles", body: "Add an email under Edit profile and we tell you how your Match went. Optional, and never public." },
  { date: "19 Oct", iso: "2026-10-19", title: "ETH and HYPE Locks earn by the clock", body: "Earned on Ethereum and HyperEVM Locks now grows with time, like SOL. Unlock and Redeem take two quick steps.", href: "/docs/chains" },
  { date: "18 Oct", iso: "2026-10-18", title: "Say who you are on the waitlist", body: "Tell us if you play games, stake crypto or make games. Your tag shows on your card and its share link.", href: "/" },
  { date: "17 Oct", iso: "2026-10-17", title: "Wallet by chain", body: "One card per chain, each with its own Redeem, its Locks and the Players you won Gemas from.", href: "/wallet" },
  { date: "16 Oct", iso: "2026-10-16", title: "Instant Redeem pays 75%", body: "Redeem Gemas before their yield lands and get 75% of their value now.", href: "/docs/gemas#instant-redeem" },
  { date: "16 Oct", iso: "2026-10-16", title: "Rematch and share your win", body: "After a Match, tap Rematch for a ready Challenge to the same Player, or share your win as a card on X.", href: "/docs/matches" },
  { date: "16 Oct", iso: "2026-10-16", title: "Delayed Matches say when they refund", body: "If a Match gets stuck, it shows Delayed and the time it refunds by.", href: "/docs/matches" },
  { date: "16 Oct", iso: "2026-10-16", title: "Terms and Privacy", body: "Our Terms of Service and Privacy Policy are now in the app.", href: "/terms" },
  { date: "14 Oct", iso: "2026-10-14", title: "Extend your Advance", body: "Lost your Gemas? Extend the Advance on a SOL Lock for more months and get more Gemas now, up to 12 months.", href: "/docs/positions#advance" },
  { date: "12 Oct", iso: "2026-10-12", title: "Trading Duel is a price grid", body: "Pick a box in each of 12 columns and score 100 points when the live price line passes through it. Two and a half minutes, SOL, ETH or HYPE, more points wins.", href: "/docs/matches#trading-duel" },
  { date: "10 Oct", iso: "2026-10-10", title: "Waitlist", body: "The home page is now a waitlist: leave an email to get your spot. How it works moved to /welcome.", href: "/welcome" },
  { date: "10 Oct", iso: "2026-10-10", title: "Leaderboard Pool and weekly Seasons", body: "Every Match adds 1% of its Pot to a pool. Each week the top 10 Players by points split it.", href: "/docs/leaderboard" },
  { date: "10 Oct", iso: "2026-10-10", title: "Profiles and wallet sign-in", body: "Sign in with Phantom or MetaMask, pick a name and a gemstone animal, or show your .sol or .eth name.", href: "/docs/accounts" },
  { date: "10 Oct", iso: "2026-10-10", title: "New logo, plainer words, and these Docs", body: "A facet T mark, copy with no plumbing in it, and a reading guide for players and developers.", href: "/docs/how-it-works" },
  { date: "3 Oct", iso: "2026-10-03", title: "Trading Duel", body: "The third Game: five minutes, the same live price, hidden positions, 1x to 20x on SOL, ETH or HYPE.", href: "/docs/matches#trading-duel" },
  { date: "3 Oct", iso: "2026-10-03", title: "One yield rule for every Lock", body: "Each Lock earns its own yield, so a 1 month Length repays in about 10 minutes.", href: "/docs/positions" },
  { date: "2 Oct", iso: "2026-10-02", title: "HyperEVM Locks are live", body: "Lock test HYPE on HyperEVM and play with it next to Solana and Ethereum Gemas.", href: "/docs/chains" },
  { date: "2 Oct", iso: "2026-10-02", title: "Account pages and Match spectating", body: "Open any Player's Account to see what they played, and watch any Match you are not in.", href: "/docs/accounts#public-page" },
];
