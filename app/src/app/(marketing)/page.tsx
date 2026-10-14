import type { Metadata } from "next";
import { WaitlistPage } from "@/components/waitlist/WaitlistPage";
import { WAITLIST_DESCRIPTION as DESCRIPTION } from "@/lib/waitlist-copy";


export const metadata: Metadata = {
  title: "Tesoro · Join the waitlist",
  description: DESCRIPTION,
  openGraph: { title: "Tesoro · Join the waitlist", description: DESCRIPTION, siteName: "Tesoro", type: "website", images: "/opengraph-image.png" },
  twitter: { card: "summary_large_image", title: "Tesoro · Join the waitlist", description: DESCRIPTION, images: "/twitter-image.png" },
  alternates: { canonical: "/" },
};

/** The count is read at most once a minute. */
export const revalidate = 60;

export default function Waitlist() {
  return <WaitlistPage />;
}
