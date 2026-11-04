import { notFound } from "next/navigation";
import { RAILCAR_SHOWN } from "@/lib/games";
import { RailcarRoute } from "./RailcarRoute";

/** Railcar: one screen from Boarding to the Result. Shown only where NEXT_PUBLIC_SHOW_RAILCAR=1 until it launches. */
export default function RailcarPage() {
  if (!RAILCAR_SHOWN) notFound();
  return <RailcarRoute />;
}
