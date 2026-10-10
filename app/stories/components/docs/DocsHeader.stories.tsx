import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { DocsHeader } from "@/components/docs/DocsHeader";

const meta = {
  title: "Components/docs/DocsHeader",
  component: DocsHeader,
  parameters: { layout: "fullscreen", themed: true },
  decorators: [(Story) => <div className="docs" style={{ minHeight: 0 }}><Story /></div>],
} satisfies Meta<typeof DocsHeader>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Search, the theme switch and the phone menu. Use the Theme switch in the toolbar for light. */
export const Default: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
