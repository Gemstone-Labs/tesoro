import type { Metadata } from "next";
import { FriendsPage } from "@/components/friends/FriendsPage";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Friends · ${BRAND.name}` };

/** The signed-in Player's private Friends list. */
export default function Page() {
  return <FriendsPage />;
}
