import { useAccount } from "@/lib/account";
import { ratesOf, type TreasuryRates } from "./fees";

/** The Yield Fee and Instant Redeem Fee in force: the Treasury's, or the launch rates until it is read. */
export function useTreasuryRates(): TreasuryRates {
  return ratesOf(useAccount().snapshot?.market?.treasury);
}
