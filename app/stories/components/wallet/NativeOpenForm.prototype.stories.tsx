/* PROTOTYPE ONLY: takes on the SOL Open a Position form. Switch with ?variant=now|A|B|C|D or the pink bar. */
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { NativeOpenForm } from "@/app/(app)/wallet/NativePositions";
import { NOF_VARIANTS } from "@/app/(app)/wallet/NativeOpenForm.prototype";
import Wallet from "@/app/(app)/wallet/page";
import { withScreen } from "../../screens/support/screen";
import { withSigner } from "../../screens/support/signer";
import { NATIVE_MARKET, nativeSnapshot } from "./support";

const meta = {
  title: "Prototype/NativeOpenForm",
  decorators: [withSigner, withScreen],
  parameters: { layout: "fullscreen", data: { snapshot: nativeSnapshot() } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The sheet's own frame (480px max, surface fill) so each take is judged at its real width. */
function SheetFrame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
      {title && <span className="mono meta">{title}</span>}
      <div className="cut cut-frame" style={{ background: "var(--surface)", maxWidth: 480, padding: "24px 24px 26px", display: "grid", gap: 16 }}>
        <h2 style={{ fontSize: 20, fontWeight: 900 }}>Open a Position</h2>
        {children}
      </div>
    </div>
  );
}

/** One take at a time; the pink bar (or ← →) switches. Amount pre-filled with 5 SOL. */
export const Live: Story = {
  render: () => (
    <div style={{ padding: 24 }}>
      <SheetFrame><NativeOpenForm market={NATIVE_MARKET} loading={false} defaultAmount="5" /></SheetFrame>
    </div>
  ),
};

/** Same, empty: what a Player sees the moment the sheet opens. */
export const Empty: Story = {
  render: () => (
    <div style={{ padding: 24 }}>
      <SheetFrame><NativeOpenForm market={NATIVE_MARKET} loading={false} /></SheetFrame>
    </div>
  ),
};

/** More simSOL than the balance: the error state. */
export const TooMuch: Story = {
  render: () => (
    <div style={{ padding: 24 }}>
      <SheetFrame><NativeOpenForm market={NATIVE_MARKET} loading={false} defaultAmount="20" /></SheetFrame>
    </div>
  ),
};

/** Every take side by side with 5 SOL entered. */
export const Gallery: Story = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 440px), 1fr))", gap: 24, padding: 24, alignItems: "start" }}>
      {NOF_VARIANTS.map((v) => (
        <SheetFrame key={v.key} title={`${v.key} · ${v.name}`}>
          <NativeOpenForm market={NATIVE_MARKET} loading={false} defaultAmount="5" variant={v.key} />
        </SheetFrame>
      ))}
    </div>
  ),
};

/** The real Wallet with the sheet open on SOL: the take in context. */
export const InWallet: Story = {
  parameters: { shell: "app", nextjs: { navigation: { pathname: "/wallet" } } },
  render: () => <Wallet />,
  play: async ({ canvasElement }) => {
    const open = await waitFor(() => within(canvasElement).getAllByRole("button", { name: /Open a Position/ })[0], { timeout: 10_000 });
    await userEvent.click(open);
    const tab = await waitFor(() => within(document.body).getAllByRole("tab", { name: /^SOL/ })[0], { timeout: 10_000 });
    await userEvent.click(tab);
  },
};
