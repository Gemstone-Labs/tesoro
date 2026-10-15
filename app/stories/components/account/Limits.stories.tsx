import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { LimitsView, type LimitsViewProps } from "@/components/account/Limits";
import { entryLimitView, type EntryLimitData } from "@/lib/chain/entry-limit";
import { extendLimitView, type ExtendLimitData } from "@/lib/chain/extend-limit";
import "@/app/(app)/wallet/advance-sheet.css";

const NOW = 1_800_000_000;
const DAY = 86_400;
const noop = () => {};

const entry = (l: Partial<EntryLimitData>) => entryLimitView({ gemas: 0, pendingGemas: 0, pendingAt: 0, windowStart: 0, windowUsed: 0, ...l }, NOW);
const extend = (l: Partial<ExtendLimitData>) => extendLimitView({ months: 3, pendingMonths: 0, pendingAt: 0, windowStart: 0, windowMonths: 0, lastExtendAt: 0, ...l }, NOW, 0);

const meta = {
  title: "Components/account/Limits",
  component: LimitsView,
  render: (args) => (
    <div style={{ maxWidth: 420 }}>
      <LimitsView {...args} />
    </div>
  ),
  args: { entry: entry({}), extend: extend({}), busy: null, error: null, onSetEntry: noop, onSetExtend: noop, onRetry: noop } satisfies LimitsViewProps,
  argTypes: { entry: { control: false }, extend: { control: false }, onSetEntry: { control: false }, onSetExtend: { control: false }, onRetry: { control: false } },
} satisfies Meta<typeof LimitsView>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Nothing set: no Entry Limit, the default Extend Limit. */
export const NothingSet: Story = {};
/** An Entry Limit with part of the 7 days used. */
export const EntryLimitInForce: Story = { args: { entry: entry({ gemas: 2_500, windowStart: NOW - 2 * DAY, windowUsed: 1_500 }) } };
/** The limit is used up: entries are refused until the period resets. */
export const EntryLimitReached: Story = { args: { entry: entry({ gemas: 1_000, windowStart: NOW - DAY, windowUsed: 1_000 }) } };
/** A raise waits 24 hours before it applies. */
export const EntryRaisePending: Story = { args: { entry: entry({ gemas: 500, pendingGemas: 2_500, pendingAt: NOW + 20 * 3_600 }) } };
/** Removing the limit also waits 24 hours. */
export const EntryRemovalPending: Story = { args: { entry: entry({ gemas: 1_000, pendingGemas: 0, pendingAt: NOW + 3 * 3_600 }) } };
export const ExtendLimitUsed: Story = { args: { extend: extend({ windowStart: NOW - 5 * DAY, windowMonths: 2, lastExtendAt: NOW - 5 * DAY }), entry: entry({ gemas: 1_000 }) } };
export const ExtendRaisePending: Story = { args: { extend: extend({ months: 1, pendingMonths: 6, pendingAt: NOW + 8 * 3_600 }) } };
export const Loading: Story = { args: { entry: null, extend: null } };
export const Saving: Story = { args: { entry: entry({ gemas: 1_000 }), busy: "entry" } };
export const SaveFailed: Story = { args: { error: "That didn’t go through. Try again." } };
