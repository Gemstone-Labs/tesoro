import type { Metadata } from "next";
import { FriendLinkCard } from "@/components/friends/FriendLinkCard";
import { BRAND } from "@/lib/brand";
import { friendsStore } from "@/server/friends/env";
import { isLinkCode } from "@/server/friends/rules";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Add a friend · ${BRAND.name}`, robots: { index: false } };

/** A Player's add-me link: their calling card and Add friend. Unknown and reset codes look the same. */
export default async function FriendLinkPage({ params }: PageProps<"/friend/[code]">) {
  const { code } = await params;
  let owner: string | null = null;
  try {
    if (isLinkCode(code)) owner = await friendsStore().linkOwner(code);
  } catch (e) {
    console.error("friend-link", e);
  }
  return <FriendLinkCard code={code} owner={owner} />;
}
