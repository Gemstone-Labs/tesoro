import { toast } from "@/components/ui/Toast";
import { withdrawDeposit } from "@/lib/deposit/vault-actions";

type Withdraw = Parameters<typeof withdrawDeposit>;

/** Withdraws one deposit and confirms it with a toast. A failure throws and shows nowhere here: the caller shows it inline. */
export async function withdrawAndConfirm(label: string, ...args: Withdraw): Promise<void> {
  await withdrawDeposit(...args);
  toast(`${label} withdrawn. Your SOL is back in your wallet.`);
}
