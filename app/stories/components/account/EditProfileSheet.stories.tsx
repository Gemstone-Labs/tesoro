import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EditProfileSheet } from "@/components/account/EditProfileSheet";
import { setEditProfileOpen } from "@/lib/identity/edit-profile";

const meta = {
  title: "Components/account/EditProfileSheet",
  component: EditProfileSheet,
  parameters: { auth: "signed-in" },
  render: function Render() {
    useEffect(() => {
      setEditProfileOpen(true);
      return () => setEditProfileOpen(false);
    }, []);
    return <EditProfileSheet />;
  },
} satisfies Meta<typeof EditProfileSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Name and picture. Name-service names (.sol, .eth) cannot be looked up in Storybook. */
export const Open: Story = {};
