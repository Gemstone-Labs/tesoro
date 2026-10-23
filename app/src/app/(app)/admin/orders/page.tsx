import type { Metadata } from "next";
import { OrdersPage } from "@/components/admin/OrdersPage";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Orders · ${BRAND.name}`, robots: { index: false, follow: false } };

/** Admin-only. The page holds no data: the orders come from /api/admin/orders, which checks the signing wallet. */
export default function Page() {
  return <OrdersPage />;
}
