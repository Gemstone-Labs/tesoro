import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { Suspense } from "react";
import { userEvent, within } from "storybook/test";
import { AccountView } from "@/components/account/AccountView";
import type { ChainRequest } from "@/lib/chain/backing";
import { DEMO_NEW_ACCOUNT, DEMO_NO_ACCOUNT, demoSnapshot } from "@/lib/chain/fixture";
import { DEMO_ME } from "../support/data";
import { demoKey } from "./support/screen";

/** Another Player's Account key (off the curve, so it is read as an Account and not sent on as a wallet). */
const OTHER = demoKey(51);

const page = (key: string, query: Record<string, string> = {}) => ({
  render: () => (
    <Suspense>
      <AccountView address={key} />
    </Suspense>
  ),
  parameters: { nextjs: { navigation: { pathname: `/account/${key}`, query } } },
});

const meta = {
  title: "Screens/Account",
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const press = (name: string): Story["play"] => async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement).findByRole("button", { name }));
};

/** `/account/<key>` for the signed-in Account: Edit profile and the running total of your own play. */
export const Own: Story = page(DEMO_ME);

/** Another Player, as anyone sees it: Challenge and Make an Offer. */
export const OtherPlayer: Story = page(OTHER);
export const OtherPlayerSignedOut: Story = { ...page(OTHER), parameters: { ...page(OTHER).parameters, auth: "signed-out" } };

/** The same Player as a phone shows it. */
export const OtherPlayerPhone: Story = { ...page(OTHER), globals: { viewport: { value: "phone360", isRotated: false } } };

/** Another Player's Account with no finished Match: what it will show once they play. */
export const NewAccount: Story = page(DEMO_NEW_ACCOUNT);

const asOwner = (hasGemas: boolean, key = DEMO_NEW_ACCOUNT) => ({
  snapshot: (a: string) => {
    const s = demoSnapshot(a);
    return { ...s, accountKey: new PublicKey(key), matches: [], funded: [], positions: hasGemas ? s.positions : [], holdings: hasGemas ? s.holdings : [], ownTotal: hasGemas ? s.ownTotal : 0n, wonTotal: 0n };
  },
});

/** Your own new Account, with Gemas to play: the empty page offers Play now. */
export const NewAccountOwn: Story = {
  ...page(DEMO_NEW_ACCOUNT),
  parameters: { ...page(DEMO_NEW_ACCOUNT).parameters, data: asOwner(true) },
};

/** Your own new Account with no Gemas: the empty page sends you to Get Gemas first. */
export const NewAccountOwnNoGemas: Story = {
  ...page(DEMO_NEW_ACCOUNT),
  parameters: { ...page(DEMO_NEW_ACCOUNT).parameters, data: asOwner(false) },
};

const NOT_CREATED = demoKey(58);

/** Your own page before the Account exists on chain (no Match, no Position yet): it still shows the owner's empty state. */
export const OwnAccountNotCreatedYet: Story = {
  ...page(NOT_CREATED),
  parameters: {
    ...page(NOT_CREATED).parameters,
    data: { ...asOwner(false, NOT_CREATED), playerAccount: () => ({ exists: false, played: [], requests: [] }) },
  },
};

/** An address that has never been used on Tesoro. */
export const NoAccount: Story = page(DEMO_NO_ACCOUNT);

const ASKING = demoKey(52);
const asking = (key: string): ChainRequest[] => {
  const r = (n: number, game: ChainRequest["game"], entry: number, hours: number): ChainRequest => ({
    address: new PublicKey(demoKey(n)),
    nonce: BigInt(n),
    player: key,
    game,
    entry,
    expiresAt: Math.floor(Date.now() / 1000) + hours * 3600,
    status: "open",
    live: true,
    record: { matches: 21, wins: 13 },
    pnl: [],
  });
  return [r(961, "holdem", 1000, 18), r(962, "block-puzzle", 1000, 5)];
};

/** A Player who is asking to be backed: the "Asking to be backed" strip with Make an Offer, and the Backing fact in the header. */
export const AskingToBeBacked: Story = {
  ...page(ASKING),
  parameters: {
    ...page(ASKING).parameters,
    data: {
      playerAccount: (a: string) => ({ exists: true, played: [], requests: asking(a) }),
    },
  },
};

/** The Challenge sheet opened on another Player: Game, entry and the note that you send the link yourself. */
export const ChallengeSheetOpen: Story = { ...page(demoKey(53)), play: press("Challenge") };

/** The Challenge sheet with Trading Duel picked: the asset picker (SOL, ETH, HYPE) appears. */
export const ChallengeSheetTradingDuel: Story = {
  ...page(demoKey(54)),
  play: async (ctx) => {
    await press("Challenge")!(ctx);
    await userEvent.click(await within(ctx.canvasElement.ownerDocument.body).findByRole("radio", { name: "Trading Duel" }));
  },
};

/** The Account could not be read: the message and Try again. */
export const LoadFailed: Story = {
  ...page(demoKey(55)),
  parameters: {
    ...page(demoKey(55)).parameters,
    data: {
      playerAccount: () => {
        throw new Error("The read timed out.");
      },
    },
  },
};

/** The Match history filtered to a Game this Player has not played: "No finished Trading Duel Matches yet." */
export const NoMatchesOfThisGame: Story = page(demoKey(56), { game: "trading-duel" });

/** The Match history filtered to results nobody has: "No Matches with these results" and Show all results. */
export const NoMatchesWithTheseResults: Story = page(demoKey(57), { result: "none" });

/** Edit profile opened from your own Account page. */
export const EditProfileOpen: Story = { ...page(DEMO_ME), play: press("Edit profile") };
