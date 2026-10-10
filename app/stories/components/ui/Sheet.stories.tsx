import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Button, Sheet } from "@/components/ui";

const meta = {
  title: "Components/ui/Sheet",
  component: Sheet,
  args: { open: true, title: "Sheet title", onClose: () => {}, children: null },
  argTypes: { onClose: { control: false }, children: { control: false } },
  render: function Render(args) {
    const [open, setOpen] = useState(args.open);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open sheet</Button>
        <Sheet {...args} open={open} onClose={() => setOpen(false)}>
          <p className="meta">Bottom sheet on phones, centred on wide screens.</p>
          <Button variant="money" block onClick={() => setOpen(false)}>Confirm</Button>
        </Sheet>
      </>
    );
  },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Native dialog: focus trap, Esc and a click on the backdrop close it. */
export const Open: Story = {};
export const Closed: Story = { args: { open: false } };
