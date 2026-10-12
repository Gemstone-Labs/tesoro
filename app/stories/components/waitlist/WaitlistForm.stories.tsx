import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import "@/components/waitlist/waitlist.css";
import "@/components/waitlist/pack.css";
import { WaitlistForm } from "@/components/waitlist/WaitlistForm";
import { setNextJoin } from "../../../.storybook/mocks/src/app/(marketing)/waitlist-action";

/** The waitlist form with the signup mocked: no Supabase, a half-second wait, then the scripted spot. */
const meta = {
  title: "Components/waitlist/Waitlist form",
  component: WaitlistForm,
  parameters: { layout: "fullscreen", themed: true },
  decorators: [
    (Story) => (
      <div className="lp" style={{ minHeight: "100vh", padding: 40, background: "var(--bg)" }}>
        <div style={{ width: "min(480px, 100%)" }}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof WaitlistForm>;
export default meta;
type Story = StoryObj<typeof meta>;

const join = async (canvasElement: HTMLElement, email = "ana@example.com") => {
  const c = within(canvasElement);
  await userEvent.type(c.getByLabelText("Email"), email);
  await userEvent.click(c.getByRole("button", { name: "Join the waitlist" }));
  return c;
};

/** Empty: type any email and join to try it by hand (the mock hands out spot #7). */
export const Empty: Story = { beforeEach: () => setNextJoin(7) };

/** Focused on a phone, an email typed: the ring follows the cut corners. */
export const FocusedPhone: Story = {
  name: "Focused (phone)",
  globals: { viewport: { value: "phone360", isRotated: false } },
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByLabelText("Email"), "ana@example.com");
  },
};

/** Joined: the pack for spot #7 (the Amethyst Owl) comes up over the page. Rip it; Share opens the real post composer. */
export const Joined: Story = {
  beforeEach: () => setNextJoin(7),
  play: async ({ canvasElement }) => {
    await join(canvasElement);
    await expect(await within(document.body).findByRole("button", { name: "Open it for me" })).toBeInTheDocument();
  },
};

/** Behind the pack once it is closed: the spot, Try it now and See your card. */
export const JoinedClosed: Story = {
  name: "Joined (pack closed unopened)",
  beforeEach: () => setNextJoin(7),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await userEvent.click(await within(document.body).findByRole("button", { name: "Close" }));
    await expect(await c.findByRole("button", { name: "Open your pack" })).toBeInTheDocument();
    await expect(within(document.body).queryByText(/Amethyst Owl/)).toBeNull();
  },
};

/** Opened, then closed: now the page names the gem, and See your card brings the card back. */
export const JoinedOpened: Story = {
  name: "Joined (pack opened, closed)",
  beforeEach: () => setNextJoin(7),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    const page = within(document.body);
    await expect(page.queryByText(/Amethyst Owl/)).toBeNull();
    await userEvent.click(await page.findByRole("button", { name: "Open it for me" }));
    await page.findByRole("heading", { name: /You pulled the Amethyst Owl/ }, { timeout: 5000 });
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await expect(await c.findByText("You pulled the Amethyst Owl.")).toBeInTheDocument();
    await expect(c.getByRole("button", { name: "See your card" })).toBeInTheDocument();
  },
};

/** A six-digit spot on a phone. */
export const JoinedPhone: Story = {
  name: "Joined (phone)",
  globals: { viewport: { value: "phone390", isRotated: false } },
  beforeEach: () => setNextJoin(128450),
  play: async ({ canvasElement }) => {
    await join(canvasElement);
    await within(document.body).findByText("Spot #128450");
  },
};

/** Storage returned no spot: the plain share, no gem. */
export const JoinedNoSpot: Story = {
  name: "Joined (no spot)",
  beforeEach: () => setNextJoin(null),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await expect(await c.findByRole("link", { name: "Share on X" })).toBeInTheDocument();
  },
};

/** Saving failed. */
export const Failed: Story = {
  beforeEach: () => setNextJoin("error"),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await c.findByText(/couldn't save that/);
  },
};
