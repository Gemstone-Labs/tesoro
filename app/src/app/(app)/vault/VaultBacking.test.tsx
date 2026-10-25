import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultBacking } from "./VaultBacking";

const state = vi.hoisted(() => ({
  me: "me" as string | null,
  requests: [] as { player: string; status: string; live: boolean; expiresAt: number }[],
}));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ snapshot: state.me ? { accountKey: { toBase58: () => state.me } } : null }) }));
vi.mock("@/lib/chain/useBackingBoard", () => ({ useBackingBoard: () => ({ board: { requests: state.requests } }) }));
vi.mock("@/lib/chain/useNowSecs", () => ({ useNowSecs: () => 100 }));

const request = (over = {}) => ({ player: "me", status: "open", live: true, expiresAt: 200, ...over });
beforeEach(() => { state.me = "me"; state.requests = []; });
describe("Vault Backing shortcut", () => {
  it("counts only the Player's open, unexpired Requests", () => {
    state.requests = [request(), request(), request({ player: "other" }), request({ status: "accepted" }), request({ status: "cancelled" }), request({ expiresAt: 100 }), request({ live: false })];
    const html = renderToStaticMarkup(<VaultBacking />);
    expect(html).toContain("Backing · 2 open");
    expect(html).toContain('href="/backing"');
  });
  it("hides when there are no own open Requests, including a just-expired read", () => {
    state.requests = [request({ player: "other" }), request({ expiresAt: 99 })];
    expect(renderToStaticMarkup(<VaultBacking />)).toBe("");
  });
  it("hides while the signed-in Account is unresolved", () => {
    state.me = null;
    state.requests = [request()];
    expect(renderToStaticMarkup(<VaultBacking />)).toBe("");
  });
});
