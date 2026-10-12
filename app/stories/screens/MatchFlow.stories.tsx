import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
import type { Frame } from "./support/flow-store";
import { FlowPlayer, type Flow } from "./support/flow";
import { chainMatch, duelLive, duelSettled, holdemLive, holdemOver } from "./support/matches";
import type { ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Match flow",
  component: FlowPlayer,
  decorators: [withSigner],
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/play/queue" } } },
  args: { autoplay: true, speed: 1 },
  argTypes: {
    flow: { table: { disable: true } },
    autoplay: { control: "boolean", description: "Step through on a timer" },
    speed: { control: { type: "select" }, options: [0.5, 1, 2, 4], description: "Autoplay speed" },
  },
} satisfies Meta<typeof FlowPlayer>;
export default meta;
type Story = StoryObj<typeof meta>;

type Step = Omit<Frame, "url" | "show" | "match">;

const BACKING = "8aEXqsYXm4XYC3Bvcb4ctS2FEw7ELaV6ztJvAC9pzhiX";
const queueUrl = (game: GameId, backing = false) => `/play/queue?entry=1000&game=${game}${game === "trading-duel" ? "&asset=sol" : ""}${backing ? `&backing=${BACKING}` : ""}`;
const matchUrl = (m: ChainMatch) => `/play/match/${m.id}`;

/** The Queue page, from the Enter button to the redirect into the Match. */
function queueSteps(game: GameId, via: "joined" | "opened", o: { backing?: boolean } = {}): Step[] {
  const bp = game === "block-puzzle";
  const holdingNote = o.backing ? "The entry is paid from the Backer's accepted Offer; your own Gemas are not touched." : "The entry is reserved from your Holdings, own-sourced Gemas first, then won Gemas.";
  const steps: Step[] = [
    o.backing
      ? {
          label: "Using your Backing",
          layers: ["server", "solana"],
          what: "The Enter button on an accepted Backing opens the Queue page with ?backing=<Offer>. Opening the page is the confirmation. Before anything else: SOL for fees (demo faucet when the wallet is low), the Tesoro Account if this wallet has none, and the Offer is re-read to check it is accepted, unused and for this Game and entry.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)", "read Offer (requireBacking)"],
        }
      : {
          label: "Checking your SOL and Account",
          layers: ["server", "solana"],
          what: "The Lobby's Enter button opens /play/queue. Opening the page is the confirmation: it runs once per visit. ensureReady tops up SOL for fees from the demo faucet when the wallet is under the minimum, and creates the Tesoro Account if this wallet has none.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)"],
        },
    {
      label: "Looking for an opponent",
      status: "Looking for an opponent…",
      layers: ["solana"],
      what: `First: any unfinished ${bp ? "Block Puzzle" : game === "holdem" ? "Hold'em" : "Trading Duel"} Match of yours? Then the page offers Continue instead of a second entry. Otherwise it lists open Queue Matches at this entry, oldest first, and re-reads each one fresh: same Game and entry, an even id (odd ids are Challenges), no Backer seat, more than 60 s before its refund deadline${game === "trading-duel" ? ", and the same asset (bits 1–2 of the Match id)" : ""}.`,
      calls: ["unfinishedMatches", "listQueueMatchIds (getProgramAccounts on tesoro_core)", "fetchMatch × up to 6 per round"],
    },
  ];
  if (via === "joined") {
    steps.push(
      {
        label: "Joining a Match",
        status: "Joining a Match…",
        layers: ["wallet", "solana"],
        what: `One transaction on Solana takes the second seat. ${holdingNote}${bp ? " For Block Puzzle the same transaction creates your hidden Board (join_session)." : ""} A send that times out is settled on chain first (\"Confirming your entry on Solana…\"); a definite failure tries the next candidate, three at most.`,
        calls: [o.backing ? "tesoro_core.join_match_backed" : "tesoro_core.join_match", ...(bp ? ["block_puzzle.join_session"] : [])],
      },
      {
        label: "Opponent found",
        entered: "joined",
        layers: ["app"],
        what: "The join landed. The page says so and replaces the URL with the Match page; the Queue page is not kept in history.",
        calls: ["router.replace(/play/match/<id>)"],
        ms: 2200,
      },
    );
  } else {
    steps.push(
      {
        label: "Opening a Match",
        status: "Opening a Match…",
        layers: ["wallet", "solana"],
        what: `Nobody was waiting at this entry, so you open a Match with a fresh even id (${game === "trading-duel" ? "ms × 8 + asset × 2" : "ms × 2"}). ${holdingNote}${bp ? " For Block Puzzle the same transaction opens the Session, your Board and the SeedVault (open_session), so you can play before anyone joins." : " It waits in the Queue for the next Player."}`,
        calls: [o.backing ? "tesoro_core.open_match_backed" : "tesoro_core.open_match", ...(bp ? ["block_puzzle.open_session"] : [])],
      },
      {
        label: bp ? "Match opened" : "Entered the Queue",
        entered: "opened",
        layers: ["app"],
        what: "The open landed. The page says so and replaces the URL with the Match page.",
        calls: ["router.replace(/play/match/<id>)"],
        ms: 2200,
      },
    );
  }
  return steps;
}

const routing: Step = {
  label: "Reading the Match",
  layers: ["solana"],
  what: "/play/match/<id> renders MatchRoute. It reads the MatchState on tesoro_core and picks the Match view from the Game's program id (Block Puzzle, Hold'em or Trading Duel). Until that read answers the page shows the Match stage blank with “Loading the Match…”, so the layout holds.",
  calls: ["tesoro_core.account.matchState.fetchNullable", "gameOf(program id)"],
  ms: 2000,
};

/** Frames for one Game: the entry steps on the Queue page, then the Match page reading the Match it was given. */
function frames(entry: { url: string; match: ChainMatch; steps: Step[] }, match: { steps: (Step & { match?: ChainMatch })[] }): Frame[] {
  const m = entry.match;
  return [
    ...entry.steps.map((s): Frame => ({ ...s, show: "enter", url: entry.url, match: m })),
    { ...routing, show: "match", url: matchUrl(m), match: m },
    ...match.steps.map((s): Frame => ({ ...s, show: "match", url: matchUrl(s.match ?? m), match: s.match ?? m, routed: true })),
  ];
}

/* Block Puzzle */

const run = (stage: NonNullable<ScreenData["run"]>["stage"], step?: string): ScreenData => ({ run: { stage, step } });

function blockPuzzlePrep(opener: boolean): Step[] {
  return [
    {
      label: "Creating your session",
      screen: run("needs-prep", "Creating your session"),
      layers: ["wallet", "solana", "er"],
      what: opener
        ? "MatchView reads the Match and probes your Board: it is still owned by block_puzzle on Solana, so prepareRun starts. delegate_opener hands your Board and the SeedVault to the Delegation Program, assigned to MagicBlock's private Ephemeral Rollup (TEE validator). Then it waits until both accounts show the delegation owner."
        : "MatchView reads the Match and probes your Board: still on Solana. The opener's Board is usually delegated already (if not, either Player does it). delegate_joiner hands your Board to the Delegation Program, assigned to MagicBlock's private Ephemeral Rollup (TEE validator).",
      calls: [opener ? "block_puzzle.delegate_opener (Board 0 + SeedVault)" : "block_puzzle.delegate_joiner (Board 1)", "poll owner == Delegation Program"],
      ms: 3600,
    },
    {
      label: "Securing your session",
      screen: run("needs-prep", "Securing your session"),
      layers: ["tee"],
      what: "Your Board is now in the TEE rollup. The app signs in to the TEE (auth token from your wallet), reads your own Board, and init_permission makes it readable by you only: nobody, including the opponent, can see your pieces or score until the end.",
      calls: ["TEE auth token", "fetchOwnBoard (TEE)", "block_puzzle.init_permission (TEE)"],
      ms: 3200,
    },
    {
      label: "Dealing your pieces",
      screen: run("needs-prep", "Dealing your pieces"),
      layers: ["tee", "vrf"],
      what: "The Seed that deals both Players' pieces is drawn inside the rollup by MagicBlock VRF and stays hidden. init_vault_permission locks the SeedVault, request_seed asks for randomness, and check_seed is polled until it is drawn.",
      calls: ["block_puzzle.init_vault_permission (TEE)", "block_puzzle.request_seed → VRF callback", "block_puzzle.check_seed (poll)"],
      ms: 3600,
    },
    {
      label: "Ready to start",
      screen: run("ready"),
      layers: ["tee"],
      what: "probeRun reports ready only when Start will work (the Seed is drawn). The run clock does not start until you press Start run.",
      calls: ["probeRun"],
      ms: 2600,
    },
    {
      label: "Playing (Start run pressed)",
      screen: run("ready"),
      click: "Start run",
      layers: ["wallet", "tee"],
      what: "begin_run stamps the start in the TEE and reveals the Seed to you only. Every placement is checked locally and sent to the rollup in batches (play, at most 40 moves per transaction) while you play; finish closes the run. The pieces here are made up and nothing is sent.",
      calls: ["block_puzzle.begin_run (TEE)", "block_puzzle.play × n (TEE)", "block_puzzle.finish (TEE)"],
      ms: 7000,
    },
  ];
}

function blockPuzzleOpens(): Frame[] {
  const open = chainMatch("block-puzzle", "open");
  const active = { ...chainMatch("block-puzzle", "active"), id: open.id };
  const won = { ...chainMatch("block-puzzle", "won"), id: open.id };
  return frames(
    { url: queueUrl("block-puzzle"), match: open, steps: queueSteps("block-puzzle", "opened") },
    {
      steps: [
        ...blockPuzzlePrep(true),
        {
          label: "Waiting for an opponent",
          screen: run("finished"),
          remount: true,
          layers: ["solana"],
          what: "Your run is closed and stays hidden. The Match sits in the Queue until another Player joins; the page re-reads it every 3 s. Nobody joining before the refund deadline (1 h) makes it refundable.",
          calls: ["fetchMatch every 3 s"],
        },
        {
          label: "Opponent joined, playing their run",
          match: active,
          screen: run("finished"),
          remount: true,
          layers: ["solana", "tee"],
          what: "Someone joined from the Queue (join_match + join_session) and is playing their own hidden Board. Every 6 s trySettle tries to finish: it can only settle once both runs are done (or the joiner's time ran out).",
          calls: ["trySettle every 6 s → waiting for the opponent"],
          ms: 3600,
        },
        {
          label: "Settling",
          match: active,
          screen: run("finished"),
          layers: ["tee", "solana"],
          what: "Both runs are done. seal and commit_boards in the TEE commit both Boards back to Solana (undelegating them); settle on block_puzzle compares the scores and CPIs into tesoro_core, which pays the Pot minus fees to the winner. Whichever Player's page gets there first sends it.",
          calls: ["block_puzzle.seal + commit_boards (TEE → Solana)", "block_puzzle.settle → tesoro_core.settle_match"],
        },
        {
          label: "Won",
          match: won,
          screen: run("committed"),
          remount: true,
          layers: ["solana"],
          what: "The Match is settled. The result screen shows both scores, your payout in won Gemas and the receipts.",
          ms: 6000,
        },
      ],
    },
  );
}

function blockPuzzleJoins(o: { backing?: boolean } = {}): Frame[] {
  const active = chainMatch("block-puzzle", "active", o.backing ? { backing: "player" } : {});
  const result = { ...chainMatch("block-puzzle", o.backing ? "won" : "lost", o.backing ? { backing: "player" } : {}), id: active.id };
  return frames(
    { url: queueUrl("block-puzzle", o.backing), match: active, steps: queueSteps("block-puzzle", "joined", o) },
    {
      steps: [
        ...blockPuzzlePrep(false),
        {
          label: "Waiting for their score",
          screen: run("finished"),
          remount: true,
          layers: ["solana", "tee"],
          what: "Your run is closed. The opener may have finished long ago, or may still be playing. trySettle runs every 6 s; when the opener's time is up, Claim the Match appears.",
          calls: ["trySettle every 6 s", "canClaimTimeout"],
        },
        {
          label: "Settling",
          screen: run("finished"),
          layers: ["tee", "solana"],
          what: "Both runs are done: seal and commit_boards commit both Boards back to Solana, then settle pays the Pot through tesoro_core.",
          calls: ["block_puzzle.seal + commit_boards (TEE → Solana)", "block_puzzle.settle → tesoro_core.settle_match"],
        },
        {
          label: o.backing ? "Won (Backed)" : "Lost",
          match: result,
          screen: run("committed"),
          remount: true,
          layers: ["solana"],
          what: o.backing ? "Settled. The payout is split with your Backer by the Offer's share; the split is shown under the result." : "Settled. The opponent scored higher; your entry went into their payout.",
          ms: 6000,
        },
      ],
    },
  );
}

function blockPuzzleChallengeJoin(): Frame[] {
  const active = { ...chainMatch("block-puzzle", "active", { challenge: true }) };
  const won = { ...chainMatch("block-puzzle", "won", { challenge: true }), id: active.id };
  const url = `/play/challenge/${active.id}`;
  return frames(
    {
      url,
      match: active,
      steps: [
        {
          label: "Joining the Challenge",
          layers: ["server", "wallet", "solana"],
          what: "A friend sent you their Challenge link; opening it is the confirmation. Under the one status line: SOL for fees and the Tesoro Account (as for the Queue), then the Challenge is re-read (it must exist, be a Challenge with an odd id, not be yours and still be open), then join_match + join_session in one transaction take the second seat.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)", "fetchMatch", "tesoro_core.join_match", "block_puzzle.join_session"],
          ms: 4200,
        },
        {
          label: "Joined",
          entered: "joined",
          layers: ["app"],
          what: "The join landed; the page goes straight to the Match.",
          calls: ["router.replace(/play/match/<id>)"],
          ms: 1600,
        },
      ],
    },
    {
      steps: [
        ...blockPuzzlePrep(false),
        {
          label: "Won",
          match: won,
          screen: run("committed"),
          remount: true,
          layers: ["solana"],
          what: "After both runs: seal, commit_boards and settle, exactly as in the Queue.",
          ms: 6000,
        },
      ],
    },
  );
}

/* Hold'em */

const hv = (m: ChainMatch, v: Partial<HoldemView>): ScreenData => ({ holdem: { match: m, seat: m.seat, ...v } });

function holdemTable(m: ChainMatch, seat: "joiner" | "opener"): (Step & { match?: ChainMatch })[] {
  const late = seat === "opener" ? " The opener waits 12 s for the joiner to do it, then steps in." : "";
  return [
    {
      label: "Setting up the Match",
      screen: hv(m, { stage: "setup", note: "Setting up the Match" }),
      layers: ["wallet", "solana"],
      what: `The tesoro_core Match is Active (both seats taken). The table does not exist yet: the joiner creates it on Solana with both Players' wallets.${late}`,
      calls: ["holdem.create_match (Turbo speed)"],
    },
    {
      label: "Creating your session",
      screen: hv(m, { stage: "setup", note: "Creating your session" }),
      layers: ["wallet", "solana", "er"],
      what: "delegate_match hands the table to the Delegation Program, assigned to MagicBlock's private Ephemeral Rollup (TEE validator). From here every hand is played in the rollup: fast, free, and nothing about the cards is public.",
      calls: ["holdem.delegate_match"],
      ms: 3600,
    },
    {
      label: "Starting the Match",
      screen: hv(m, { stage: "setup", note: "Starting the Match" }),
      layers: ["tee", "vrf"],
      what: "init_permissions runs in the TEE: the deck and each Player's hole cards become readable only by the program and that Player, and the Match starts (equal Chips, blinds posted). Then the first hand is shuffled: each Player's page sends a fresh secret, the second one also asks MagicBlock VRF, and deal shuffles once both secrets and the VRF output are in.",
      calls: ["holdem.init_permissions (TEE)", "holdem.contribute_entropy × 2 (+ request_vrf) (TEE)", "holdem.deal (TEE)"],
    },
    {
      label: "Your turn before the flop",
      screen: hv(m, holdemLive("preflop")),
      layers: ["wallet", "tee"],
      what: "The table is read from the rollup; your hole cards are read with your TEE token. Each Fold / Check / Call / Raise is one act transaction to the rollup. Nothing goes to Solana during play.",
      calls: ["readTable (TEE)", "holdem.act (TEE)"],
      ms: 4200,
    },
    {
      label: "The flop",
      screen: hv(m, holdemLive("flop")),
      layers: ["tee"],
      what: "Community cards are revealed by the program in the rollup as betting rounds close.",
      calls: ["holdem.act (TEE)"],
    },
    {
      label: "Facing a bet",
      screen: hv(m, holdemLive("facing-bet")),
      layers: ["tee"],
      what: "The opponent raised. Each turn has a clock; a Player who runs out of time can be timed out by the other (claim_timeout).",
      calls: ["holdem.act (TEE)", "holdem.claim_timeout (TEE, on a stalled turn)"],
      ms: 4200,
    },
    {
      label: "Saving the result",
      screen: hv(m, holdemOver()),
      layers: ["tee", "solana"],
      what: "One Player has all the chips. close_match wipes the hidden accounts (hole cards, deck) and commits the table back to Solana, undelegating it. The winner does it at once; the other Player's page steps in after 15 s.",
      calls: ["holdem.close_match (TEE → commit + undelegate)"],
    },
    {
      label: "Paying out the Pot",
      screen: hv(m, { ...holdemOver(), note: "Paying out the Pot" }),
      layers: ["wallet", "solana"],
      what: "The table is back on Solana. finalize reads the winner and settles the tesoro_core Match: Pot minus fees to the winner's Holdings as won Gemas.",
      calls: ["holdem.finalize → tesoro_core.settle_match"],
    },
  ];
}

function holdemJoins(): Frame[] {
  const active = { ...chainMatch("holdem", "active"), id: chainMatch("holdem", "open").id };
  const won = { ...chainMatch("holdem", "won"), id: active.id };
  return frames(
    { url: queueUrl("holdem"), match: active, steps: queueSteps("holdem", "joined") },
    {
      steps: [
        ...holdemTable(active, "joiner"),
        { label: "Won", match: won, screen: hv(won, { stage: "settled" }), layers: ["solana"], what: "Settled. The result screen shows the payout and the receipts from both layers.", ms: 6000 },
      ],
    },
  );
}

function holdemChallenge(): Frame[] {
  const open = chainMatch("holdem", "open", { challenge: true });
  const active = { ...chainMatch("holdem", "active", { challenge: true }), id: open.id };
  return frames(
    {
      url: "/play/challenge?entry=1000&game=holdem",
      match: open,
      steps: [
        {
          label: "Checking your SOL and Account",
          layers: ["server", "solana"],
          what: "New Challenge from the Game page. Opening the page is the confirmation. SOL for fees and the Tesoro Account first.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)"],
        },
        {
          label: "Opening the Challenge",
          layers: ["wallet", "solana"],
          what: "open_match with an odd id: the Queue never picks it, only the link joins it. The page keeps showing the first line while this lands (createChallenge reports no steps).",
          calls: ["tesoro_core.open_match (odd id)"],
        },
        {
          label: "Challenge opened",
          entered: "opened",
          layers: ["app"],
          what: "No status line here: the page goes straight to the Match.",
          calls: ["router.replace(/play/match/<id>)"],
          ms: 1200,
        },
      ],
    },
    {
      steps: [
        {
          label: "Waiting, with the link to send",
          screen: hv(open, { stage: "waiting" }),
          layers: ["solana"],
          what: "The Match page shows the Challenge link to copy and send. It re-reads the Match until someone opens the link and joins; the refund deadline is 1 h.",
          calls: ["fetchMatch (poll)"],
          ms: 4200,
        },
        { ...holdemTable(active, "opener")[0], label: "Friend joined: setting up the Match", match: active },
        ...holdemTable(active, "opener")
          .slice(1, 4)
          .map((s) => ({ ...s, match: active })),
      ],
    },
  );
}

/* Trading Duel */

const dv = (m: ChainMatch, v: Partial<DuelView>): ScreenData => ({ duel: { match: m, seat: m.seat, ...v } });

function duelSetup(m: ChainMatch, seat: "joiner" | "opener"): (Step & { match?: ChainMatch })[] {
  const late = seat === "opener" ? " The opener waits 12 s for the joiner to do it, then steps in." : "";
  return [
    {
      label: "Setting up the Match",
      screen: dv(m, { stage: "setup", note: "Setting up the Match" }),
      layers: ["wallet", "solana"],
      what: `Both seats are taken. The joiner creates the Duel account on Solana with both Players' wallets and the asset from the Match id.${late}`,
      calls: ["trading_duel.create_match"],
    },
    {
      label: "Creating your session",
      screen: dv(m, { stage: "setup", note: "Creating your session" }),
      layers: ["wallet", "solana", "er"],
      what: "delegate_match hands the Duel to the Delegation Program, assigned to MagicBlock's private Ephemeral Rollup (TEE validator), where the oracle price feed lives.",
      calls: ["trading_duel.delegate_match"],
      ms: 3600,
    },
    {
      label: "Starting the Match",
      screen: dv(m, { stage: "setup", note: "Starting the Match" }),
      layers: ["tee"],
      what: "init_permissions runs in the TEE: each Player's Book (their picks) becomes readable only by that Player, and the Duel starts at the live price: a 30 s head start, then 12 columns of 10 s. If nobody starts it before its start deadline, it is cancelled and both entries refunded.",
      calls: ["trading_duel.init_permissions (TEE)"],
    },
    {
      label: "The grid opens",
      screen: dv(m, duelLive("headstart")),
      layers: ["tee", "oracle"],
      what: "The grid screen opens on the live price (Pyth Lazer through MagicBlock's oracle in the rollup; synthetic here) with the head start running.",
      calls: ["readDuel (TEE)", "price feed"],
      ms: 3000,
    },
  ];
}

function duelLiveSteps(m: ChainMatch): (Step & { match?: ChainMatch })[] {
  return [
    {
      label: "Head start",
      screen: dv(m, duelLive("headstart")),
      layers: ["wallet", "tee", "oracle"],
      what: "The Match starts at the live price: its rows are fixed around that price. For 30 s the line is not in the grid yet. Tapping a box is set_pick in the rollup (signed for you), and the pick shows at once; it is taken back with a plain message if the rollup refuses it. Your picks live in your own Book, readable only by you. Both apps (and the keeper) send tick about once a second from here to the end.",
      calls: ["trading_duel.set_pick (TEE)", "trading_duel.tick (TEE)", "price feed"],
      ms: 4200,
    },
    {
      label: "Mid game",
      screen: dv(m, duelLive("mid")),
      layers: ["tee", "oracle"],
      what: "tick records the live price into the column the line is in and, ten seconds before a column starts, locks it: both Players' picks for it are revealed to both. A hit scores 100 points when the line passes through the box. Spectators and Backers see revealed picks only.",
      calls: ["trading_duel.tick (TEE)"],
      ms: 4800,
    },
    {
      label: "Saving the result",
      screen: dv(m, { ...duelSettled(true), stage: "closing", note: "Saving the result" }),
      layers: ["tee", "oracle", "solana"],
      what: "The 12 columns are over. end_match takes a price published within 4 s after the close (else the last price recorded), scores every column and decides the winner (equal points is a draw), then close_match opens the Books and commits the Duel back to Solana.",
      calls: ["trading_duel.end_match (TEE)", "trading_duel.close_match (TEE → commit + undelegate)"],
    },
    {
      label: "Paying out the Pot",
      screen: dv(m, { ...duelSettled(true), stage: "closing", note: "Paying out the Pot" }),
      layers: ["wallet", "solana"],
      what: "The winner (seat 0 for a draw) finalizes at once; the other Player's page waits a grace period first so the loser of a race pays no fee.",
      calls: ["trading_duel.finalize → tesoro_core.settle_match"],
    },
  ];
}

function duelJoins(): Frame[] {
  const active = { ...chainMatch("trading-duel", "active"), id: chainMatch("trading-duel", "open").id };
  const won = { ...chainMatch("trading-duel", "won"), id: active.id };
  return frames(
    { url: queueUrl("trading-duel"), match: active, steps: queueSteps("trading-duel", "joined") },
    {
      steps: [
        ...duelSetup(active, "joiner"),
        ...duelLiveSteps(active),
        { label: "Won", match: won, screen: dv(won, duelSettled(true)), layers: ["solana"], what: "Settled. Both scores and the final price.", ms: 6000 },
      ],
    },
  );
}

function duelOpens(): Frame[] {
  const open = chainMatch("trading-duel", "open");
  const active = { ...chainMatch("trading-duel", "active"), id: open.id };
  return frames(
    { url: queueUrl("trading-duel"), match: open, steps: queueSteps("trading-duel", "opened") },
    {
      steps: [
        {
          label: "Waiting for an opponent",
          screen: dv(open, { stage: "waiting" }),
          layers: ["solana"],
          what: "Unlike Block Puzzle there is nothing to play alone: the Match waits in the SOL Queue until the next Player trading SOL joins. The page re-reads it every few seconds.",
          calls: ["fetchMatch (poll)"],
          ms: 4200,
        },
        ...duelSetup(active, "opener").map((s, i) => (i === 0 ? { ...s, label: "Opponent joined: setting up", match: active } : { ...s, match: active })),
        { ...duelLiveSteps(active)[0], match: active },
      ],
    },
  );
}

const flow = (title: string, enter: Flow["enter"], build: () => Frame[]): Flow => ({ title, enter, frames: build });

/** Nobody waiting: you open the Match, play your run straight away, then someone joins and the Match settles. */
export const BlockPuzzleQueueOpens: Story = { args: { flow: flow("Block Puzzle · Queue · opens", { kind: "queue", entry: 1000, game: "block-puzzle" }, blockPuzzleOpens) } };
/** A Match was waiting: you join it, set up your own hidden Board and play. */
export const BlockPuzzleQueueJoins: Story = { args: { flow: flow("Block Puzzle · Queue · joins", { kind: "queue", entry: 1000, game: "block-puzzle" }, () => blockPuzzleJoins()) } };
/** The entry is paid by a Backer's accepted Offer. */
export const BlockPuzzleBackedQueue: Story = {
  args: { flow: flow("Block Puzzle · Backed Queue", { kind: "queue", entry: 1000, game: "block-puzzle", backing: BACKING }, () => blockPuzzleJoins({ backing: true })) },
};
/** Opening a friend's Challenge link. */
export const BlockPuzzleChallengeLink: Story = {
  args: { flow: flow("Block Puzzle · Challenge link", { kind: "challenge-join", id: "3581887481019" }, blockPuzzleChallengeJoin) },
  parameters: { nextjs: { navigation: { pathname: "/play/challenge/3581887481019" } } },
};
export const HoldemQueueJoins: Story = { args: { flow: flow("Hold'em · Queue · joins", { kind: "queue", entry: 1000, game: "holdem" }, holdemJoins) } };
/** A new Challenge: waits with its link until a friend joins, then the opener's side of the table setup. */
export const HoldemChallenge: Story = {
  args: { flow: flow("Hold'em · new Challenge", { kind: "challenge-new", entry: 1000, game: "holdem" }, holdemChallenge) },
  parameters: { nextjs: { navigation: { pathname: "/play/challenge" } } },
};
export const TradingDuelQueueJoins: Story = { args: { flow: flow("Trading Duel · Queue · joins", { kind: "queue", entry: 1000, game: "trading-duel", asset: 0 }, duelJoins) } };
export const TradingDuelQueueOpens: Story = { args: { flow: flow("Trading Duel · Queue · opens", { kind: "queue", entry: 1000, game: "trading-duel", asset: 0 }, duelOpens) } };

