import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import "@/components/waitlist/waitlist.css";
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

/** Joined: spot #7 draws the Amethyst Owl. "Share your gem on X" opens the real post composer. */
export const Joined: Story = {
  beforeEach: () => setNextJoin(7),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await expect(await c.findByText("You drew the Amethyst Owl.")).toBeInTheDocument();
    const share = c.getByRole("link", { name: "Share your gem on X" });
    await expect(share.getAttribute("href")).toContain(encodeURIComponent("/spot/7"));
  },
};

/** The first spot draws the Ruby Jaguar. */
export const JoinedFirst: Story = {
  name: "Joined (spot #1)",
  beforeEach: () => setNextJoin(1),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await c.findByText("You drew the Ruby Jaguar.");
  },
};

/** A six-digit spot on a phone. */
export const JoinedPhone: Story = {
  name: "Joined (phone)",
  globals: { viewport: { value: "phone390", isRotated: false } },
  beforeEach: () => setNextJoin(128450),
  play: async ({ canvasElement }) => {
    const c = await join(canvasElement);
    await c.findByText(/Spot #128450/);
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
