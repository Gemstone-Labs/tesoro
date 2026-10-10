export type Receipt = { label: string; sig: string; layer?: "base" | "tee" };

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

/** Plain names for the steps a Match records; anything unlisted (Hold'em actions) shows as given. */
const PLAIN: Record<string, string> = {
  create_match: "Match created",
  delegate_match: "Session created",
  open_holding: "Entry set aside",
  init_permissions: "Hidden cards locked",
  contribute_entropy: "Deck shuffled",
  "contribute_entropy+request_vrf": "Deck shuffled",
  request_vrf: "Deck shuffled",
  deal: "Cards dealt",
  tick: "Price updated",
  close: "Trade closed",
  end_match: "Time up",
  close_match: "Match closed",
  "close_match commit": "Result saved",
  finalize: "Pot paid out",
  settle: "Pot paid out",
  begin_run: "Run started",
  refund: "Entries refunded",
  claim_timeout: "Timeout claimed",
};

export const plainStep = (label: string) => PLAIN[label] ?? label.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A Match's on-chain receipts, collapsed: public ones link to the explorer, private ones only show their id. */
export function Receipts({ items, className }: { items: Receipt[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <details className={["stack", className].filter(Boolean).join(" ")}>
      <summary className="label" style={{ cursor: "pointer" }}>Receipts ({items.length})</summary>
      {items.map((s) =>
        s.layer === "tee" ? (
          <span key={s.sig} className="meta mono" title={`${s.sig} · private step, not on the public explorer`}>
            {plainStep(s.label)} · private
          </span>
        ) : (
          <a key={s.sig} className="meta mono" href={explorer(s.sig)} target="_blank" rel="noreferrer">
            {plainStep(s.label)} · {s.sig.slice(0, 10)}…
          </a>
        ),
      )}
    </details>
  );
}
