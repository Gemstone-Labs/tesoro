import type { Metadata } from "next";
import { WaitlistPage } from "@/components/waitlist/WaitlistPage";
import { WAITLIST_DESCRIPTION as DESCRIPTION } from "@/lib/waitlist-copy";
import { BRAND } from "@/lib/brand";


export const metadata: Metadata = {
  title: `${BRAND.name} · Join the waitlist`,
  description: DESCRIPTION,
  openGraph: { title: `${BRAND.name} · Join the waitlist`, description: DESCRIPTION, siteName: BRAND.name, type: "website", images: "/opengraph-image.png" },
  twitter: { card: "summary_large_image", title: `${BRAND.name} · Join the waitlist`, description: DESCRIPTION, images: "/twitter-image.png" },
  alternates: { canonical: "/" },
};

/** The count is read at most once a minute. */
export const revalidate = 60;

export default function Waitlist() {
  return <WaitlistPage />;
}
