import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { shape } from "@/test-utils/shape";
import { DepositCards, DepositsSkeleton } from "./DepositCards";

// eslint-disable-next-line @next/next/no-img-element
vi.mock("next/image", () => ({ default: (p: { className?: string }) => <img className={p.className} alt="" /> }));

const deposit = { id: "a", label: "Deposit 1", sol: 5, worthUsd: 504, gemasGiven: 50400, state: "ready" as const, backAtMs: null, openedAtMs: 0 };

/** The section the Vault renders around its deposit cards, minus the cards' own contents. */
function realSection() {
  return renderToStaticMarkup(
    <section className="cut cut-card vt-deposits" aria-label="Your deposits">
      <header className="vt-deposits-head">
        <h2 className="display">Deposits</h2>
        <p className="vt-total"><b>$504</b> in your Vault</p>
      </header>
      <DepositCards deposits={[deposit]} busyId={null} canWithdraw onWithdraw={() => {}} />
    </section>,
  );
}

describe("Deposits loading skeleton", () => {
  it("has the loaded section's header and a ready deposit card's parts, in the same order and classes", () => {
    expect(shape(renderToStaticMarkup(<DepositsSkeleton />))).toEqual(shape(realSection()));
  });

  it("is a busy region read out as one status, with no thin generic bars", () => {
    const html = renderToStaticMarkup(<DepositsSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading your Vault…");
    expect(html).not.toContain("skel-line");
  });
});
