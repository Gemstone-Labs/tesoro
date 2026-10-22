import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Keypair } from "@solana/web3.js";
import { EntryPlan } from "@/components/match/EntryPlan";
import { previewEntry } from "@/lib/chain/entry";
import { storesFromSnapshot } from "@/lib/chain/entry-snapshot";
import { fixtureHolding } from "@/lib/chain/fixture";
import type { StagedEntry as Staged } from "@/lib/chain/ticket";

const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const accountKey = new Keypair().publicKey;

const lines = [
  fixtureHolding(1, { amount: 220n, dueAt: now + 3 * DAY }),
  fixtureHolding(2, { amount: 150n, dueAt: now + 14 * DAY }),
  fixtureHolding(3, { amount: 900n, dueAt: now + 150 * DAY }),
  fixtureHolding(4, { amount: 400n, isOwn: false, dueAt: now + 40 * DAY }),
];
const stores = (holdings: typeof lines) => storesFromSnapshot({ accountKey, stores: null, reservedTotal: 0n, ticketNeed: 0n, holdings });

/** Many tiny lines: more than one transaction can draw, so the entry is put together in steps first. */
const manyTiny = Array.from({ length: 40 }, (_, i) => fixtureHolding(10 + i, { amount: 12n + BigInt(i % 5), dueAt: now + (1 + i) * DAY }));

const staged = (done: bigint, target: bigint): Staged => ({ staged: done, target, progress: Number((done * 1000n) / target) / 1000, complete: done >= target, cancelling: false, expired: false, stepsLeft: done >= target ? 0 : 2, expiresIn: 3000 });

const meta = {
  title: "Components/match/EntryPlan",
  component: EntryPlan,
  args: { nowSec: now },
  decorators: [
    (Story) => (
      <div className="enter" style={{ maxWidth: 560, margin: "32px auto" }}>
        <div className="enter-foot">
          <Story />
        </div>
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof EntryPlan>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The program's draw for a 500 Gema entry: own Gemas first, the soonest-repaying Gemas first. */
export const Direct: Story = { args: { preview: previewEntry(stores(lines), 500n), staged: null } };
/** An entry of 480 Gemas drawn from 40 small lines: prepared in steps, 18 of 480 ready so far. */
export const StagedEntry: Story = { args: { preview: previewEntry(stores(manyTiny), 480n), staged: staged(190n, 480n) } };
export const StagedAlmostDone: Story = { args: { preview: previewEntry(stores(manyTiny), 480n), staged: staged(470n, 480n) } };
export const StagedComplete: Story = { args: { preview: previewEntry(stores(manyTiny), 480n), staged: staged(480n, 480n) } };
