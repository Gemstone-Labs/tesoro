import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { userEvent, within } from "storybook/test";
import Backing from "@/app/(app)/backing/page";
import type { BackingBoard, ChainOffer, ChainRequest } from "@/lib/chain/backing";
import type { GameId } from "@/lib/mock";
import { DEMO_ME } from "../support/data";
import { demoKey, withScreen } from "./support/screen";

const meta = {
  title: "Screens/Backing",
  component: Backing,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/backing" } } },
} satisfies Meta<typeof Backing>;
export default meta;
type Story = StoryObj<typeof meta>;

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const pk = (n: number) => new PublicKey(demoKey(n));

const at = (n: number) => demoKey(600 + n);

function request(n: number, game: GameId, entry: number, o: Partial<ChainRequest> = {}): ChainRequest {
  return {
    address: pk(n),
    nonce: BigInt(n),
    player: DEMO_ME,
    game,
    entry,
    expiresAt: now() + 18 * HOUR,
    status: "open",
    live: true,
    record: { matches: 21, wins: 13 },
    pnl: [],
    ...o,
  };
}

function offer(n: number, game: GameId, entry: number, o: Partial<ChainOffer> = {}): ChainOffer {
  return {
    address: pk(n),
    nonce: BigInt(n),
    backer: DEMO_ME,
    game,
    entry,
    shareBps: 5000,
    directedTo: null,
    status: "open",
    expiresAt: now() + 20 * HOUR,
    useBy: now() + 20 * HOUR,
    player: null,
    request: null,
    lines: [{ source: pk(n + 50), isOwn: true, amount: BigInt(entry) }],
    matchId: null,
    ...o,
  };
}

/**
 * The demo board (other Players' open Requests at demo-601..607, Players demo-701..707) plus your own
 * Requests and the Offers. Built when the story renders.
 */
const board =
  (mine: ChainRequest[], offers: ChainOffer[] = [], withOthers = true) =>
  (demo: BackingBoard): BackingBoard => ({ requests: [...(withOthers ? demo.requests : []), ...mine], offers, fetchedAt: Date.now() });

/** Your own live Request: Hold'em for 1,000. */
const MY_REQUEST = request(931, "holdem", 1000);

const tab = (name: string): Story["play"] => async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("tab", { name }));
};
const press = (name: string): Story["play"] => async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name }));
};

/** Players asking to be backed, with their record. */
export const Board: Story = {};

export const BoardSignedOut: Story = { parameters: { auth: "signed-out" } };

export const EmptyBoard: Story = { parameters: { data: { board: board([], [], false) } } };

/** `/backing#<request>` opens the Offer drawer for that Request. */
export const OfferDrawer: Story = { parameters: { screen: { hash: demoKey(601) } } };

export const Loading: Story = { parameters: { screen: { board: "loading" } } };

export const LoadFailed: Story = { parameters: { screen: { board: "error" } } };

/** You posted a Request and nobody has answered yet: it sits under the board with Cancel. */
export const YourRequestOpen: Story = {
  parameters: { data: { board: board([MY_REQUEST]) } },
};

const offersForYou = () =>
  board(
    [MY_REQUEST],
    [
      offer(941, "holdem", 1000, { backer: demoKey(703), directedTo: MY_REQUEST.address.toBase58(), shareBps: 6000, expiresAt: now() + 22 * HOUR }),
      offer(942, "holdem", 1000, { backer: demoKey(705), directedTo: MY_REQUEST.address.toBase58(), shareBps: 4000, expiresAt: now() + 3 * HOUR }),
    ],
  );

/** Two Backers answered your Request with Offers: each shows the split you keep, and you accept one. */
export const OffersForYourRequest: Story = { parameters: { data: { board: offersForYou() } } };

export const OffersForYourRequestPhone: Story = {
  ...OffersForYourRequest,
  globals: { viewport: { value: "phone360", isRotated: false } },
};

/** An accepted Backing waits for you to enter: Queue or Challenge. A Trading Duel Backing asks which asset first. */
export const BackedReadyToPlay: Story = {
  parameters: {
    data: {
      board: board(
        [
          { ...MY_REQUEST, status: "accepted", live: false },
          request(932, "trading-duel", 500, { status: "accepted", live: false }),
        ],
        [
          offer(943, "holdem", 1000, { backer: demoKey(703), directedTo: MY_REQUEST.address.toBase58(), status: "accepted", shareBps: 6000, player: DEMO_ME, request: MY_REQUEST.address.toBase58(), useBy: now() + 50 * 60 }),
          offer(944, "trading-duel", 500, { backer: demoKey(706), status: "accepted", shareBps: 3000, player: DEMO_ME, request: pk(932).toBase58(), useBy: now() + 5 * HOUR }),
        ],
      ),
    },
  },
};

/** You already made an Offer on a Request: its card says Offer sent instead of Make an Offer. */
export const OfferSentOnARequest: Story = {
  parameters: {
    data: { board: board([], [offer(945, "block-puzzle", 1000, { directedTo: at(1), shareBps: 5500 })]) },
  },
};

/**
 * Offers you funded, one in each state: waiting on a Player, an old public Offer (cancel only),
 * accepted and waiting for the Player to start, used in a Match, and expired (release the Gemas).
 */
export const MyBackings: Story = {
  parameters: {
    data: {
      board: board([], [
        offer(951, "block-puzzle", 1000, { directedTo: at(1), shareBps: 5500 }),
        offer(952, "holdem", 1000, { shareBps: 5000 }),
        offer(953, "trading-duel", 500, { status: "accepted", shareBps: 6000, player: demoKey(705), request: at(5), useBy: now() + 40 * 60 }),
        offer(954, "block-puzzle", 2500, { status: "consumed", shareBps: 4500, player: demoKey(703), request: at(3), matchId: BigInt(Date.now() - 25 * 60_000) << 1n }),
        offer(955, "holdem", 500, { directedTo: at(2), shareBps: 5000, expiresAt: now() - HOUR }),
      ]),
    },
  },
  play: tab("My Backings"),
};

export const MyBackingsEmpty: Story = { play: tab("My Backings") };

export const PostARequest: Story = { play: press("Post a Request") };

/** On a Break: the header and every Request say so instead of offering actions. */
export const OnABreak: Story = { parameters: { screen: { away: "break" } } };

/** A shared link to a Request that was cancelled or taken. */
export const RequestNoLongerOpen: Story = {
  parameters: {
    data: { board: board([request(933, "block-puzzle", 500, { player: demoKey(733), status: "cancelled", live: false })]) },
    screen: { hash: demoKey(933) },
  },
};
