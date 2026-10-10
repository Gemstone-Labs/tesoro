import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AccountView } from "@/components/account/AccountView";
import { DEMO_NEW_ACCOUNT, DEMO_NO_ACCOUNT } from "@/lib/chain/fixture";
import { DEMO_ME } from "../../support/data";

const OTHER = "6Nw6KJv8QZ2xYhrfK9tQmGbq9uTq1Yq5h3m7V8aJp4Cn";

const meta = {
  title: "Components/account/AccountView",
  component: AccountView,
  args: { address: OTHER },
  argTypes: { address: { control: "text" } },
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/account/x" } } },
} satisfies Meta<typeof AccountView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Another Player, seen by a signed-in visitor: record, Gemas won and lost, Backings, history. */
export const Other: Story = {};

/** Your own Account page: adds Edit profile and no Challenge. */
export const Own: Story = { args: { address: DEMO_ME } };

export const SignedOutVisitor: Story = { parameters: { auth: "signed-out" } };

/** The Account exists but has played nothing. */
export const NewAccount: Story = { args: { address: DEMO_NEW_ACCOUNT } };
export const NewAccountOwn: Story = { args: { address: DEMO_NEW_ACCOUNT }, parameters: { data: { snapshot: undefined } } };

export const NoAccount: Story = { args: { address: DEMO_NO_ACCOUNT } };
export const NotAnAccountKey: Story = { args: { address: "not-a-key" } };
export const Loading: Story = {
  parameters: { data: { playerAccount: () => new Promise(() => {}) as never } },
};
