import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountView } from "@/components/account/AccountView";

export async function generateMetadata({ params }: PageProps<"/account/[key]">): Promise<Metadata> {
  const { key } = await params;
  return { title: `Account ${key.slice(0, 4)}…${key.slice(-4)} · Tesoro` };
}

/** A Player's Account as anyone may see it: Match history, Gemas won and lost, Backings. Public, read from Solana devnet. */
export default async function AccountPage({ params }: PageProps<"/account/[key]">) {
  const { key } = await params;
  return (
    <Suspense>
      <AccountView address={key} />
    </Suspense>
  );
}
