import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { DuelView } from "@/games/trading-duel/useDuelMatch";
import type { HoldemView } from "@/games/holdem/useHoldemMatch";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";
import type { Frame } from "./support/flow-store";
import { FlowPlayer, type Flow } from "./support/flow";
import { burstView } from "./support/burst";
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
      what: `First: any unfinished ${bp ? "Block Burst" : game === "holdem" ? "Hold'em" : "Trading Duel"} Match of yours? Then the page offers Continue instead of a second entry. Otherwise it lists open Queue Matches at this entry, oldest first, and re-reads each one fresh: same Game and entry, an even id (odd ids are Challenges), no Backer seat, more than 60 s before its refund deadline${game === "trading-duel" ? ", and the same asset (bits 1–2 of the Match id)" : ""}.`,
      calls: ["unfinishedMatches", "listQueueMatchIds (getProgramAccounts on tesoro_core)", "fetchMatch × up to 6 per round"],
    },
  ];
  if (via === "joined") {
    steps.push(
      {
        label: "Joining a Match",
        status: "Joining a Match…",
        layers: ["wallet", "solana"],
        what: `One transaction on Solana takes the second seat. ${holdingNote} A send that times out is settled on chain first (\"Confirming your entry on Solana…\"); a definite failure tries the next candidate, three at most.`,
        calls: [o.backing ? "tesoro_core.join_match_backed" : "tesoro_core.join_match"],
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
        what: `Nobody was waiting at this entry, so you open a Match with a fresh even id (${game === "trading-duel" ? "ms × 8 + asset × 2" : "ms × 2"}). ${holdingNote} It waits in the Queue for the next Player.`,
        calls: [o.backing ? "tesoro_core.open_match_backed" : "tesoro_core.open_match"],
      },
      {
        label: "Entered the Queue",
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
  what: "/play/match/<id> renders MatchRoute. It reads the MatchState on tesoro_core and picks the Match view from the Game's program id (Block Burst, Hold'em or Trading Duel). Until that read answers the page shows the Match stage blank with “Loading the Match…”, so the layout holds.",
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

/* Block Burst */


const bv = (kind: Parameters<typeof burstView>[0], m: ChainMatch, over: Partial<NonNullable<ScreenData["burst"]>> = {}): ScreenData => ({ burst: { ...burstView(kind, m), ...over } });

/** The Match from "found a table" to the result: the same for the opener and the joiner. */
function blockBurstLive(m: ChainMatch, end: ChainMatch): (Step & { match?: ChainMatch })[] {
  return [
    {
      label: "Waiting for a table",
      screen: bv("table", m),
      layers: ["solana"],
      what: "The Match is Active but no table has been chosen yet: the operator writes the Assignment (assign_match) on Solana, which binds this Match to one persistent table at its current epoch. Until it exists the page says so and gives the refund time: an unassigned Match has no 5-minute refund, only tesoro_core's own deadline.",
      calls: ["fetchMatch every 2.5 s", "readAssignment (Assignment PDA)"],
      ms: 3200,
    },
    {
      label: "Check in",
      screen: bv("checkIn", m),
      remount: true,
      layers: ["tee"],
      what: "The table begins the Match (begin_match) and seats both Players (seat_players): each Board becomes readable by its Player only. Your page checks you in the moment the seat is open. A Player who has not checked in after 60 s of rollup time loses the Match.",
      calls: ["begin_match (anyone, keeper first)", "seat_players (anyone)", "check_in(binding)"],
      ms: 3200,
    },
    {
      label: "You are in",
      screen: bv("checkedIn", m),
      remount: true,
      layers: ["tee"],
      what: "You are checked in; the page counts the check-in window from the table's assigned slot, not from your clock.",
      calls: ["watch the table (websocket + 1 s read)"],
      ms: 3200,
    },
    {
      label: "Dealing the pieces",
      screen: bv("seeding", m),
      remount: true,
      layers: ["tee", "vrf"],
      what: "Both are in. One VRF request (request_seed, anyone) draws the Seed inside the rollup into a Vault nobody can read. The request is retried every 20 s, at most 3 times.",
      calls: ["request_seed", "seed_callback (oracle)", "start → start_slot = now + 10 s"],
      ms: 3200,
    },
    {
      label: "Get ready",
      screen: bv("getReady", m),
      remount: true,
      layers: ["tee"],
      what: "The Seed is in and the one shared clock is set: the run starts at the table's start_slot, 10 s from now. The count is the table's slot minus start_slot at 100 slots a second, never the page's clock.",
      calls: ["currentSlot every 2 s, run forward in between"],
      ms: 3600,
    },
    {
      label: "Playing",
      screen: bv("playing", m),
      remount: true,
      layers: ["tee"],
      what: "begin copies the Seed into your own Board. Every placement is sent in batches of up to 8 every half second (play), with your on-chain move count as the nonce. The opponent strip shows their last public score.",
      calls: ["begin(binding)", "play(binding, expected_count, moves) ≤ 8 moves, every 0.5 s"],
      ms: 4800,
    },
    {
      label: "Last 10 seconds",
      screen: bv("last10", m),
      remount: true,
      layers: ["tee"],
      what: "From 80 s both scores are hidden: your moves now go as play_hidden, which touches nothing public, and the opponent strip shows ?.",
      calls: ["play_hidden(binding, expected_count, moves)"],
      ms: 3600,
    },
    {
      label: "Paying out",
      screen: bv("closing", m),
      remount: true,
      layers: ["tee", "solana"],
      what: "After 93 s (90 s plus 3 s grace) anyone may close the table: it writes the result and both run logs, commit_table sends the public table to Solana, and finalize settles the Match through tesoro_core. The keeper does each step first; your page does it after a few seconds of silence.",
      calls: ["close", "commit_table", "finalize → tesoro_core.settle_match"],
      ms: 3600,
    },
    {
      label: "Result",
      match: end,
      screen: { burst: { stage: "settled", match: end, seat: end.seat, reason: 1 } },
      remount: true,
      layers: ["solana"],
      what: "The Match is settled. The result screen shows both scores, the payout and the receipts.",
      ms: 6000,
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
        {
          label: "Waiting for an opponent",
          screen: { burst: { stage: "waiting", match: open, seat: 0 } },
          remount: true,
          layers: ["server", "solana"],
          what: "You sit first: the Match starts when someone joins. While you wait the page tells the Queue you are here every 15 s (a presence lease); a Match whose opener has been gone for 30 s is skipped by the Queue and by the Play now count. Challenges ignore the lease. Leaving after you are paired loses the Match.",
          calls: ["POST /api/queue/presence every 15 s", "fetchMatch every 2.5 s"],
          ms: 4200,
        },
        ...blockBurstLive({ ...active, seat: 0 }, won),
      ],
    },
  );
}

function blockPuzzleJoins(o: { backing?: boolean } = {}): Frame[] {
  const active = chainMatch("block-puzzle", "active", o.backing ? { backing: "player" } : {});
  const result = { ...chainMatch("block-puzzle", o.backing ? "won" : "lost", o.backing ? { backing: "player" } : {}), id: active.id };
  return frames({ url: queueUrl("block-puzzle", o.backing), match: active, steps: queueSteps("block-puzzle", "joined", o) }, { steps: blockBurstLive(active, result) });
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
          what: "A friend sent you their Challenge link; opening it is the confirmation. Under the one status line: SOL for fees and the Tesoro Account (as for the Queue), then the Challenge is re-read (it must exist, be a Challenge, not be yours and still be open), then join_match takes the second seat.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)", "fetchMatch", "tesoro_core.join_match"],
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
    { steps: blockBurstLive(active, won) },
  );
}

function blockPuzzleNobodyJoins(): Frame[] {
  const open = chainMatch("block-puzzle", "open");
  const refunded = { ...chainMatch("block-puzzle", "refunded"), id: open.id };
  return frames(
    { url: queueUrl("block-puzzle"), match: open, steps: queueSteps("block-puzzle", "opened") },
    {
      steps: [
        {
          label: "Waiting for an opponent",
          screen: { burst: { stage: "waiting", match: open, seat: 0 } },
          remount: true,
          layers: ["solana"],
          what: "Nobody has joined. Cancel and refund is on the page the whole time: it returns the entry to your Holdings.",
          calls: ["fetchMatch every 2.5 s"],
          ms: 3600,
        },
        {
          label: "Cancel and refund pressed",
          screen: { burst: { stage: "waiting", match: open, seat: 0 } },
          click: "Cancel and refund",
          layers: ["wallet", "solana"],
          what: "refund_match on tesoro_core closes the open Match and returns your held entry; the Match page reads it as refunded.",
          calls: ["tesoro_core.refund_match"],
          ms: 2400,
        },
        {
          label: "Refunded",
          match: refunded,
          screen: { burst: { stage: "settled", match: refunded, seat: 0, reason: null } },
          remount: true,
          layers: ["solana"],
          what: "The Match is refunded. The result screen says so and shows no scores.",
          ms: 6000,
        },
      ],
    },
  );
}

function blockPuzzleOpponentNeverShows(): Frame[] {
  const active = chainMatch("block-puzzle", "active");
  const won = { ...chainMatch("block-puzzle", "won"), id: active.id };
  return frames(
    { url: queueUrl("block-puzzle"), match: active, steps: queueSteps("block-puzzle", "joined") },
    {
      steps: [
        { label: "Check in", screen: bv("checkedIn", active), remount: true, layers: ["tee"], what: "You are checked in. Your opponent is not: they have 60 s of rollup time from the table's assigned slot.", calls: ["check_in(binding)"], ms: 3200 },
        { label: "They never came", screen: bv("opponentGone", active), remount: true, layers: ["tee"], what: "The check-in window ended with one Player missing. close (anyone) writes the Match as a normal win for the Player who was there; neither there is a refund.", calls: ["close", "commit_table", "finalize"], ms: 3600 },
        { label: "You win", match: won, screen: { burst: { stage: "settled", match: won, seat: won.seat, reason: 2 } }, remount: true, layers: ["solana"], what: "The result says why: your opponent didn’t show up.", ms: 6000 },
      ],
    },
  );
}

function blockPuzzleContinue(): Frame[] {
  const active = chainMatch("block-puzzle", "active");
  return frames(
    {
      url: queueUrl("block-puzzle"),
      match: active,
      steps: [
        ...queueSteps("block-puzzle", "joined").slice(0, 2),
        {
          label: "Unfinished Match found",
          entered: "existing",
          layers: ["solana"],
          what: "unfinishedMatches found a Block Burst Match of yours that is still open or active, so nothing new is entered. The page offers Continue and Lobby instead.",
          calls: ["unfinishedMatches"],
          ms: 4200,
        },
      ],
    },
    { steps: [{ label: "Continue pressed: back in your Match", screen: bv("playing", active), layers: ["tee"], what: "Continue opens the Match page, which picks up where the table is: it reads your own Board, rebuilds the run from the Seed and the move log, and resumes on the table's clock.", ms: 4200 }] },
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

function holdemJoins(o: { lost?: boolean; backing?: boolean } = {}): Frame[] {
  const b = o.backing ? { backing: "player" as const } : {};
  const active = { ...chainMatch("holdem", "active", b), id: chainMatch("holdem", "open").id };
  const won = { ...chainMatch("holdem", o.lost ? "lost" : "won", b), id: active.id };
  return frames(
    { url: queueUrl("holdem", o.backing), match: active, steps: queueSteps("holdem", "joined", o) },
    {
      steps: [
        ...holdemTable(active, "joiner"),
        { label: o.lost ? "Lost" : o.backing ? "Won (Backed)" : "Won", match: won, screen: hv(won, { stage: "settled" }), layers: ["solana"], what: "Settled. The result screen shows the payout and the receipts from both layers.", ms: 6000 },
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
          status: "Checking your SOL and Account…",
          layers: ["server", "solana"],
          what: "New Challenge from the Game page. Opening the page is the confirmation. SOL for fees and the Tesoro Account first.",
          calls: ["ensureSol → POST /api/demo (fund)", "tesoro_core.create_account (first time only)"],
        },
        {
          label: "Opening the Challenge",
          status: "Opening your Challenge…",
          layers: ["wallet", "solana"],
          what: "open_match with an odd id: the Queue never picks it, only the link joins it. The status line reads Opening your Challenge… while this lands.",
          calls: ["tesoro_core.open_match (odd id)"],
        },
        {
          label: "Challenge opened",
          entered: "opened",
          layers: ["app"],
          what: "The page goes straight to the Match.",
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

function duelJoins(o: { lost?: boolean } = {}): Frame[] {
  const active = { ...chainMatch("trading-duel", "active"), id: chainMatch("trading-duel", "open").id };
  const won = { ...chainMatch("trading-duel", o.lost ? "lost" : "won"), id: active.id };
  return frames(
    { url: queueUrl("trading-duel"), match: active, steps: queueSteps("trading-duel", "joined") },
    {
      steps: [
        ...duelSetup(active, "joiner"),
        ...duelLiveSteps(active),
        { label: o.lost ? "Lost" : "Won", match: won, screen: dv(won, duelSettled(!o.lost)), layers: ["solana"], what: "Settled. Both scores and the final price.", ms: 6000 },
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
          what: "Unlike Block Burst there is nothing to play alone: the Match waits in the SOL Queue until the next Player trading SOL joins. The page re-reads it every few seconds.",
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

/** Nobody waiting: you open the Match and sit in the Queue until someone joins, then check in, get the Seed and play together. */
export const BlockPuzzleQueueOpens: Story = { args: { flow: flow("Block Burst · Queue · opens", { kind: "queue", entry: 1000, game: "block-puzzle" }, blockPuzzleOpens) } };
/** A Match was waiting: you join it, the operator gives it a table, you check in and play at the same time as your opponent. */
export const BlockPuzzleQueueJoins: Story = { args: { flow: flow("Block Burst · Queue · joins", { kind: "queue", entry: 1000, game: "block-puzzle" }, () => blockPuzzleJoins()) } };
/** The entry is paid by a Backer's accepted Offer. */
export const BlockPuzzleBackedQueue: Story = {
  args: { flow: flow("Block Burst · Backed Queue", { kind: "queue", entry: 1000, game: "block-puzzle", backing: BACKING }, () => blockPuzzleJoins({ backing: true })) },
};
/** Opening a friend's Challenge link. */
export const BlockPuzzleChallengeLink: Story = {
  args: { flow: flow("Block Burst · Challenge link", { kind: "challenge-join", id: "3581887481019" }, blockPuzzleChallengeJoin) },
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


/** Nobody joins: Cancel and refund returns the entry. */
export const BlockPuzzleNobodyJoins: Story = { args: { flow: flow("Block Burst · nobody joins · refund", { kind: "queue", entry: 1000, game: "block-puzzle" }, blockPuzzleNobodyJoins) } };
/** The opponent never checks in: you win. */
export const BlockPuzzleOpponentNeverShows: Story = {
  args: { flow: flow("Block Burst · opponent never shows", { kind: "queue", entry: 1000, game: "block-puzzle" }, blockPuzzleOpponentNeverShows) },
};
/** You already have a Match to play: the Queue page offers Continue instead of a second entry. */
export const BlockPuzzleContinueExistingMatch: Story = { args: { flow: flow("Block Burst · existing Match · Continue", { kind: "queue", entry: 1000, game: "block-puzzle" }, blockPuzzleContinue) } };
/** Hold'em: the opponent wins the Match. */
export const HoldemQueueLost: Story = { args: { flow: flow("Hold'em · Queue · lost", { kind: "queue", entry: 1000, game: "holdem" }, () => holdemJoins({ lost: true })) } };
/** Hold'em entry paid by a Backer's accepted Offer. */
export const HoldemBackedQueue: Story = {
  args: { flow: flow("Hold'em · Backed Queue", { kind: "queue", entry: 1000, game: "holdem", backing: BACKING }, () => holdemJoins({ backing: true })) },
};
/** Trading Duel: the opponent comes out ahead. */
export const TradingDuelQueueLost: Story = { args: { flow: flow("Trading Duel · Queue · lost", { kind: "queue", entry: 1000, game: "trading-duel", asset: 0 }, () => duelJoins({ lost: true })) } };
