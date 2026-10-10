import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Suspense } from "react";
import { AccountView } from "@/components/account/AccountView";
import { DEMO_NEW_ACCOUNT, DEMO_NO_ACCOUNT, demoSnapshot } from "@/lib/chain/fixture";
import { DEMO_ME } from "../support/data";

const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const page = (key: string) => ({
  render: () => (
    <Suspense>
      <AccountView address={key} />
    </Suspense>
  ),
  parameters: { nextjs: { navigation: { pathname: `/account/${key}` } } },
});

const meta = {
  title: "Screens/Account",
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** `/account/<key>` for the signed-in Account: Edit profile and the running total of your own play. */
export const Own: Story = page(DEMO_ME);

/** Another Player, as anyone sees it: Challenge and Make an Offer. */
export const OtherPlayer: Story = page(OTHER);
export const OtherPlayerSignedOut: Story = { ...page(OTHER), parameters: { ...page(OTHER).parameters, auth: "signed-out" } };

/** An Account with no finished Match. */
export const NewAccount: Story = page(DEMO_NEW_ACCOUNT);
export const NewAccountOwn: Story = {
  ...page(DEMO_NEW_ACCOUNT),
  parameters: { ...page(DEMO_NEW_ACCOUNT).parameters, data: { snapshot: (a: string) => ({ ...demoSnapshotEmpty(a) }) } },
};

/** An address that has never been used on Tesoro. */
export const NoAccount: Story = page(DEMO_NO_ACCOUNT);

const demoSnapshotEmpty = (a: string) => ({ ...demoSnapshot(a), matches: [], funded: [], positions: [], holdings: [], ownTotal: 0n, wonTotal: 0n });
