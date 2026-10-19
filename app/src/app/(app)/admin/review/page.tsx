import type { Metadata } from "next";
import { ReviewPage } from "@/components/admin/ReviewPage";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Review · ${BRAND.name}`, robots: { index: false, follow: false } };

/** Admin-only. The page holds no data: the flags come from /api/admin/review, which checks the signing wallet. */
export default function Page() {
  return <ReviewPage />;
}
