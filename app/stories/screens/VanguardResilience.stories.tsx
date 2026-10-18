import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { VanguardMatchView } from "@/games/vanguard/VanguardMatchView";
import { VanguardSpectateView } from "@/games/vanguard/VanguardSpectate";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../components/support/spectated";
import { chainMatch } from "./support/matches";
import { withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";
import * as vg from "./support/vanguard";
import * as rs from "./support/vanguard-resilience";

const meta = {
  title: "Screens/Vanguard resilience",
  decorators: [withSigner, withScreen, withSpectated],
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const route = (m: ChainMatch) => ({ nextjs: { navigation: { pathname: `/play/match/${m.id}` } } });
function vanguard(view: ScreenData["vanguard"], m: ChainMatch = chainMatch("vanguard", "active"), extra: Partial<Story> = {}): Story {
  return { render: () => <VanguardMatchView matchId={m.id.toString()} />, parameters: { ...route(m), spectated: m, screen: { vanguard: { ...view, match: m, seat: m.seat } } }, ...extra };
}

/** Taps your pieces until one shows a marked square, then taps that square. */
async function moveSomething(canvasElement: HTMLElement) {
  const c = within(canvasElement);
  const pieces = await waitFor(() => {
    const found = c.getAllByRole("button", { name: /^US [0-9BF]/ }).filter((b) => !b.hasAttribute("disabled"));
    if (!found.length) throw new Error("no piece yet");
    return found;
  }, { timeout: 10_000 });
  for (const piece of pieces) {
    await userEvent.click(piece);
    const marks = c.queryAllByRole("button", { name: /Move to/ });
    if (marks.length) return userEvent.click(marks[0]);
  }
}
const phone360 = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone360", isRotated: false } } });

/** Five moves happened while this client was away: they play one after the other, in order. */
export const CatchingUp = vanguard(rs.catchingUp());
export const CatchingUpPhone = phone360(CatchingUp);
/** More than 16 records behind: the board jumps to the current position, nothing is replayed. */
export const FarBehind = vanguard(rs.farBehind());
/** The Battle cannot be read for now: the board says it may be behind. */
export const Reconnecting = vanguard(rs.reconnecting());
export const ReconnectingPhone = phone360(Reconnecting);
/** The rollup refuses a move that was late or sent on an old board: the piece goes back, with a short line. */
export const RefusedMove = vanguard({ ...vg.yourTurn(), refuse: "Too late: your turn already ran out." }, undefined, { play: ({ canvasElement }) => moveSomething(canvasElement) });
/** Their declared move waits for the next slot. The board does not change and nothing about the result is shown. */
export const TheirMoveInProgress = vanguard(rs.theirMoveInProgress());
export const TheirAttackInProgress = vanguard(rs.theirMoveInProgress(true));
export const TheirAttackInProgressPhone = phone360(TheirAttackInProgress);
/** You sent a move the hidden rules refuse: when it is applied it costs you the turn. Plays out by itself after you tap a piece and a marked square. */
export const LostTurn = vanguard(rs.lostTurn(), undefined, { play: ({ canvasElement }) => moveSomething(canvasElement) });
/** The Match should have settled by now: Delayed, with the refund deadline from the shared status code. */
const delayedMatch = (): ChainMatch => ({ ...chainMatch("vanguard", "active"), deadline: Math.floor(Date.now() / 1000) + 80_000 });
export const Delayed = vanguard(vg.yourTurn(), delayedMatch());
export const DelayedPhone = phone360(Delayed);
export const DelayedRefundOpen = vanguard(vg.yourTurn(), { ...chainMatch("vanguard", "active"), deadline: Math.floor(Date.now() / 1000) - 60 });

/** Someone watching: the public Battle only, every piece face down. */
export const Spectator: Story = { render: () => <VanguardSpectateView battle={rs.spectated()} />, parameters: { layout: "padded" } };
export const SpectatorPhone = phone360(Spectator);
export const SpectatorFinished: Story = { render: () => <VanguardSpectateView battle={rs.finished()} />, parameters: { layout: "padded" } };
export const SpectatorUnreadable: Story = { render: () => <VanguardSpectateView battle={null} hidden />, parameters: { layout: "padded" } };
