import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WaitlistPage } from "@/components/waitlist/WaitlistPage";
import { gemFor, parseSpotSlug } from "@/lib/waitlist-spot";

type Props = { params: Promise<{ spot: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const spot = parseSpotSlug((await params).spot)?.spot;
  if (!spot) return {};
  const title = `#${spot} on the Tesoro waitlist · ${gemFor(spot).name}`;
  const description = "Play casual games now with yield you haven't earned yet. Join the waitlist and open your pack.";
  return {
    title,
    description,
    openGraph: { title, description, siteName: "Tesoro", type: "website" },
    twitter: { card: "summary_large_image", title, description },
    alternates: { canonical: "/" },
    robots: { index: false },
  };
}

export const revalidate = 60;

/** A shared waitlist spot: the waitlist page, credited to the spot that shared it. */
export default async function SpotPage({ params }: Props) {
  const spot = parseSpotSlug((await params).spot)?.spot;
  if (!spot) notFound();
  return <WaitlistPage invite={gemFor(spot)} />;
}
