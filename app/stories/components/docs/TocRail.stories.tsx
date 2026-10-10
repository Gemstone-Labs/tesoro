import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TocRail } from "@/components/docs/TocRail";
import { H2, H3 } from "@/components/docs/prose";

const meta = {
  title: "Components/docs/TocRail",
  component: TocRail,
  parameters: { themed: true, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="docs" style={{ minHeight: 0 }}>
        <div className="docs-grid">
          <main id="docs-main" className="docs-main">
            <div className="docs-prose">
              <H2 id="one">First section</H2>
              <p>Text.</p>
              <H3 id="one-a">A part of it</H3>
              <p>Text.</p>
              <H2 id="two">Second section</H2>
              <p>Text.</p>
            </div>
          </main>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof TocRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** "On this page", built from the headings next to it. */
export const Default: Story = {};
