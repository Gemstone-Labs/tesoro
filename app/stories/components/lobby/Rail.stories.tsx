import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Row, Thumb } from "@/components/ui";
import { Rail } from "@/components/lobby/Rail";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/Rail",
  component: Rail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
  args: {
    id: "demo",
    title: "A rail",
    viewAll: "/lobby",
    cols: 3,
    children: [1, 2, 3].map((i) => <Row key={i} thumb={<Thumb>{i}</Thumb>} title={`Item ${i}`} meta="A line of detail" />),
  },
  argTypes: { cols: { control: "inline-radio", options: [2, 3] }, children: { control: false }, aside: { control: false }, lead: { control: false } },
} satisfies Meta<typeof Rail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A titled Lobby section: header, optional See all link, a calm grid. */
export const ThreeColumns: Story = {};
export const TwoColumns: Story = { args: { cols: 2 } };
export const NoLink: Story = { args: { viewAll: undefined } };
export const WithAside: Story = { args: { aside: <span className="meta">Filtered by cards</span> } };
