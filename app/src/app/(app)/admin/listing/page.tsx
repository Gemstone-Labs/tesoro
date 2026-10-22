import type { Metadata } from "next";
import { ListingPage } from "@/components/admin/ListingPage";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Listings · ${BRAND.name}`, robots: { index: false, follow: false } };

/** Admin-only. The page holds no data: applications come from /api/admin/listing, which checks the signing wallet. */
export default function Page() {
  return <ListingPage />;
}
