import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "simple" as "simple" | "advanced",
  setMode: vi.fn(),
  push: vi.fn(),
  onChange: null as null | ((on: boolean) => void),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/auth/context", () => ({ useAuth: () => ({ gate: (_: string, f: () => void) => f() }) }));
vi.mock("@/lib/deposit/use-view-mode", () => ({ useViewMode: () => ({ mode: state.mode, setMode: state.setMode, resolved: true }) }));
vi.mock("./use-deposit-flow", () => ({
  useDepositFlow: () => ({ step: "packs", picked: null, reset: () => {}, quotes: [], highlight: null, canPay: true, feePct: 0 }),
}));
vi.mock("./DepositPanel", () => ({
  PacksView: () => <div data-body="packs" />,
  AckView: () => null, DoneView: () => null, ErrorView: () => null, WorkingView: () => null,
}));
vi.mock("@/app/(app)/wallet/ProDepositBody", () => ({ ProDepositBody: () => <div data-body="pro" /> }));
vi.mock("./ProViewSwitch", () => ({
  ProViewSwitch: ({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) => {
    state.onChange = onChange;
    return <button data-switch={on ? "on" : "off"} />;
  },
}));
vi.mock("@/components/ui", () => ({
  Sheet: ({ open, title, actions, children }: { open: boolean; title: string; actions?: React.ReactNode; children: React.ReactNode }) =>
    open ? <section data-title={title}>{actions}{children}</section> : null,
}));
const { DepositSheet } = await import("./DepositSheet");

const render = () => renderToStaticMarkup(<DepositSheet open onClose={() => {}} intent={null} />);

describe("the one Buy Gemas sheet", () => {
  beforeEach(() => {
    state.mode = "simple";
    state.setMode.mockClear();
    state.push.mockClear();
  });

  it("opens on the packs when Pro view is off", () => {
    const html = render();
    expect(html).toContain('data-body="packs"');
    expect(html).not.toContain('data-body="pro"');
    expect(html).toContain('data-switch="off"');
  });

  it("opens on the SOL / ETH / HYPE forms when Pro view is saved as on", () => {
    state.mode = "advanced";
    const html = render();
    expect(html).toContain('data-body="pro"');
    expect(html).not.toContain('data-body="packs"');
    expect(html).toContain('data-switch="on"');
    expect(html).toContain('data-title="Buy Gemas"');
  });

  it("saves the mode when the switch is toggled and never navigates", () => {
    render();
    state.onChange?.(true);
    expect(state.setMode).toHaveBeenCalledWith("advanced");
    state.onChange?.(false);
    expect(state.setMode).toHaveBeenLastCalledWith("simple");
    expect(state.push).not.toHaveBeenCalled();
  });
});
