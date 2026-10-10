import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Lab, Sample, ScrollBox, type Spec } from "./lab";

const F = "src/components/shell/shell.css";

const specs: Spec[] = [
  {
    name: "drawer-in",
    file: F,
    line: 117,
    note: "The menu drawer sliding in from the left below 1024px. The real one is in Motion / Sheet and drawers.",
    dur: 300,
    ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    iter: 1,
    stage: (s) => <Sample style={s}>Menu</Sample>,
  },
  {
    name: "menu-in",
    file: F,
    line: 161,
    note: "The Account menu dropping from the avatar.",
    dur: 180,
    ease: "ease-out",
    iter: 1,
    stage: (s) => (
      <div className="cut cut-card acct-menu" style={{ ...s, position: "static", transformOrigin: "top right" }}>
        <span className="acct-mail">demo@tesoro.gg</span>
        <button type="button" role="menuitem">Account</button>
        <button type="button" role="menuitem">Sign out</button>
      </div>
    ),
  },
  {
    name: "page-in",
    file: F,
    line: 169,
    note: "Every page arrives with a short rise. The real one, on the whole app, is in Motion / Page in.",
    dur: 450,
    ease: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    iter: 1,
    fill: "backwards",
    stage: (s) => <Sample style={s}>Page</Sample>,
  },
  {
    name: "topbar-lift",
    file: F,
    line: 157,
    note: "The top bar gains a frosted ground as the page scrolls under it (first 64px). Scroll the box.",
    dur: 0,
    ease: "linear",
    iter: 1,
    scroll: true,
    stage: () => (
      <ScrollBox rows={8}>
        <div
          className="sbm-sticky"
          style={{ animation: "topbar-lift linear both", animationTimeline: "scroll(nearest)", animationRange: "0 64px" }}
        >
          Top bar
        </div>
      </ScrollBox>
    ),
  },
];

const meta = {
  title: "Motion/Shell keyframes",
  parameters: { layout: "padded" },
} satisfies Meta;
export default meta;

export const Keyframes: StoryObj = {
  render: () => <Lab specs={specs} intro="The animations in shell.css: drawer, Account menu, page arrival and the top bar." />,
};
