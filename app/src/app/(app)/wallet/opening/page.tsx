import { Suspense } from "react";
import { Opening } from "./Opening";

/** Opening an ETH Position: the cross-chain tracker, after "Open an ETH Position" on the Wallet. */
export default function OpeningPage() {
  return (
    <Suspense>
      <Opening />
    </Suspense>
  );
}
