import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GameSelect, type LandingGame } from "@/components/landing/GameSelect";
import { art } from "@/lib/art";
import { inLanding, landingParameters } from "./support";

const games: LandingGame[] = [
  {
    id: "block-puzzle",
    name: "Block Puzzle",
    note: "Play anytime, 90 s",
    body: "Play when you like. You and your opponent get the same pieces; the higher score wins.",
    facts: [["Pace", "Play anytime"], ["Pieces", "Same for both Players"], ["Length", "90 s"], ["Moves", "Private"]],
    art: art.blockPuzzleHero,
    loop: [784, 862],
    href: "/play/block-puzzle",
  },
  {
    id: "holdem",
    name: "Heads-up Hold’em",
    note: "Real-time",
    body: "Heads-up against one opponent, live. Nobody sees the deck.",
    facts: [["Pace", "Real-time"], ["Table", "Two Players"], ["Deck", "Hidden"]],
    art: art.holdemHero,
    loop: [1124, 752],
    href: "/play/holdem",
  },
];

const meta = {
  title: "Components/landing/GameSelect",
  component: GameSelect,
  decorators: [inLanding, (Story) => <div className="lp-wrap" style={{ padding: "24px 0" }}><Story /></div>],
  parameters: landingParameters,
  args: { games, footnote: "Hidden moves, fair results, settled on Solana. Powered by MagicBlock." },
  argTypes: { games: { control: "object" } },
} satisfies Meta<typeof GameSelect>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A shelf of banners over one stage. Picking a game stops the auto-advance.  */
export const TwoGames: Story = {};
export const OneGame: Story = { args: { games: games.slice(0, 1) } };
export const Light: Story = { parameters: { theme: "light" } };
