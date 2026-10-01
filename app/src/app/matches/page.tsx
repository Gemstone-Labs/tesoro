import { Suspense } from "react";
import { AllMatches } from "./AllMatches";

/** Match history per Account: every finished Match, both games, paginated. */
export default function MatchesPage() {
  return (
    <Suspense>
      <AllMatches />
    </Suspense>
  );
}
