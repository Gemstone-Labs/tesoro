import { Suspense } from "react";
import { Opening } from "./Opening";

/** Opening an ETH or HYPE Position: the cross-chain tracker, after "Open a Position" on the Wallet. */
export default function OpeningPage() {
  return (
    <Suspense>
      <Opening />
    </Suspense>
  );
}
