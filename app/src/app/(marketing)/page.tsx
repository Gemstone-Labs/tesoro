import type { Metadata } from "next";
import { WaitlistPage } from "@/components/waitlist/WaitlistPage";

const DESCRIPTION = "Join the Tesoro waitlist for early access.";

export const metadata: Metadata = {
  title: "Tesoro · Join the waitlist",
  description: DESCRIPTION,
  openGraph: { title: "Tesoro · Join the waitlist", description: DESCRIPTION, siteName: "Tesoro", type: "website" },
  twitter: { card: "summary_large_image", title: "Tesoro · Join the waitlist", description: DESCRIPTION },
  alternates: { canonical: "/" },
};

/** The count is read at most once a minute. */
export const revalidate = 60;

export default function Waitlist() {
  return <WaitlistPage />;
}
