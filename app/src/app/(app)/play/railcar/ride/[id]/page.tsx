import { notFound } from "next/navigation";
import { RAILCAR_SHOWN } from "@/lib/games";
import { RideRoute } from "./RideRoute";

/** A finished Railcar ride from the round history: its result, and everything it revealed to check it. */
export default async function RidePage({ params }: PageProps<"/play/railcar/ride/[id]">) {
  if (!RAILCAR_SHOWN) notFound();
  return <RideRoute id={(await params).id} />;
}
