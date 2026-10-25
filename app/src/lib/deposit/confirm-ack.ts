/**
 * "I understand" on the acknowledgment: consent is recorded on the server first, and the deposit goes on only once
 * that worked. "Don't show this again" is remembered only after a recorded consent.
 */
export async function confirmThenPay(o: {
  confirm: () => Promise<void>;
  dontShowAgain: boolean;
  rememberDontShow: () => void;
  pay: () => void;
}): Promise<{ error: unknown } | null> {
  try {
    await o.confirm();
  } catch (error) {
    return { error };
  }
  if (o.dontShowAgain) o.rememberDontShow();
  o.pay();
  return null;
}
