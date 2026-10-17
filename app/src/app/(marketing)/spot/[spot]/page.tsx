import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WaitlistPage } from "@/components/waitlist/WaitlistPage";
import { gemFor, parseSpot } from "@/lib/waitlist-spot";
import { BRAND } from "@/lib/brand";

type Props = { params: Promise<{ spot: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const spot = parseSpot((await params).spot);
  if (!spot) return {};
  const title = `#${spot} on the ${BRAND.name} waitlist · ${gemFor(spot).name}`;
  const description = "Play casual games now with yield you haven't earned yet. Join the waitlist and draw your gem.";
  return {
    title,
    description,
    openGraph: { title, description, siteName: BRAND.name, type: "website" },
    twitter: { card: "summary_large_image", title, description },
    alternates: { canonical: "/" },
    robots: { index: false },
  };
}

export const revalidate = 60;

/** A shared waitlist spot: the waitlist page, credited to the spot that shared it. */
export default async function SpotPage({ params }: Props) {
  const spot = parseSpot((await params).spot);
  if (!spot) notFound();
  return <WaitlistPage invite={gemFor(spot)} />;
}
