import type { Decorator, Preview } from "@storybook/nextjs-vite";
import { useLayoutEffect } from "react";
import "../src/app/globals.css";
import "../src/components/ui/ui.css";
import "../src/components/ui/page.css";
import "../src/components/shell/shell.css";
import "../src/components/lobby/lobby.css";
import "../src/components/landing/landing.css";
import "../src/components/landing/games.css";
import "../src/components/landing/money.css";
import "../src/components/docs/docs.css";
import "../src/components/docs/docs-visual.css";
import "./preview.css";
import { GemaDefs } from "../src/components/ui/gema";
import { AuthContext } from "../src/lib/auth/context";
import { authFor } from "../stories/support/auth";
import { setStoryData, type AuthMode, type StoryData } from "../stories/support/data";
import { FONT_CLASSES } from "../stories/support/fonts";
import { blockNetwork } from "../stories/support/network";
import { ShellFor, type Shell } from "../stories/support/shells";

blockNetwork();

let reducedMotion = false;
if (typeof window !== "undefined") {
  const realMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = (q: string) => {
    const mq = realMatchMedia(q);
    if (!reducedMotion || !q.includes("prefers-reduced-motion")) return mq;
    const matches = q.includes("reduce");
    return Object.assign(Object.create(mq), { matches, media: q, addEventListener: () => {}, removeEventListener: () => {} });
  };
}

/** The `<html>` attributes the app sets itself: font variables, the landing/docs theme, and the reduced-motion stand-in. */
function DocumentSettings({ theme, reduced }: { theme: "dark" | "light" | null; reduced: boolean }) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add(...FONT_CLASSES);
    html.classList.toggle("sb-reduced-motion", reduced);
    if (!theme) {
      delete html.dataset.theme;
      return;
    }
    html.dataset.theme = theme;
    try {
      localStorage.setItem("tesoro-landing-theme", theme);
    } catch {}
  }, [theme, reduced]);
  return null;
}

const withTesoro: Decorator = (Story, ctx) => {
  const auth = (ctx.parameters.auth ?? ctx.globals.auth ?? "signed-in") as AuthMode;
  const data = (ctx.parameters.data ?? {}) as StoryData;
  const shell = (ctx.parameters.shell ?? "none") as Shell;
  const themed = shell === "marketing" || shell === "docs" || ctx.parameters.themed === true;
  const theme = (ctx.parameters.theme ?? ctx.globals.theme ?? "dark") as "dark" | "light";
  reducedMotion = ctx.globals.motion === "reduced";
  const guide = (ctx.parameters.guide ?? ctx.globals.guide) === "on";
  setStoryData({ data, auth, guide });
  if (guide) {
    try {
      localStorage.removeItem("tesoro-guide-dismissed");
    } catch {}
  }

  return (
    <AuthContext.Provider value={authFor(auth)}>
      <GemaDefs />
      <DocumentSettings theme={themed ? theme : null} reduced={reducedMotion} />
      <ShellFor shell={shell}>
        <Story />
      </ShellFor>
    </AuthContext.Provider>
  );
};

const preview: Preview = {
  decorators: [withTesoro],
  parameters: {
    layout: "padded",
    nextjs: { appDirectory: true, navigation: { pathname: "/lobby" } },
    backgrounds: { disable: true },
    controls: { expanded: true, matchers: { color: /(background|color)$/i } },
    viewport: {
      options: {
        desktop1920: { name: "Desktop 1920", styles: { width: "1920px", height: "1080px" } },
        desktop1440: { name: "Desktop 1440", styles: { width: "1440px", height: "900px" } },
        tablet1024: { name: "Tablet 1024", styles: { width: "1024px", height: "768px" } },
        phone390: { name: "Phone 390", styles: { width: "390px", height: "844px" } },
      },
    },
    options: {
      storySort: { order: ["Introduction", "Foundations", "Brand", "Assets", "Motion", "Components", "Games", "Screens"] },
    },
  },
  globalTypes: {
    auth: {
      description: "Who is signed in (app screens)",
      toolbar: { title: "Auth", icon: "user", dynamicTitle: true, items: [
        { value: "signed-in", title: "Signed in (demo Account)" },
        { value: "signed-out", title: "Signed out" },
        { value: "loading", title: "Signing in…" },
      ] },
    },
    theme: {
      description: "Landing and docs theme (the app shell is always dark)",
      toolbar: { title: "Theme", icon: "mirror", dynamicTitle: true, items: [
        { value: "dark", title: "Dark" },
        { value: "light", title: "Light" },
      ] },
    },
    guide: {
      description: "The Guide character's tips on app screens",
      toolbar: { title: "Guide", icon: "comment", dynamicTitle: true, items: [
        { value: "off", title: "Guide tips off" },
        { value: "on", title: "Guide tips on" },
      ] },
    },
    motion: {
      description: "Reduced motion",
      toolbar: { title: "Motion", icon: "lightning", dynamicTitle: true, items: [
        { value: "full", title: "Full motion" },
        { value: "reduced", title: "Reduced motion" },
      ] },
    },
  },
  initialGlobals: { auth: "signed-in", theme: "dark", motion: "full", guide: "off" },
};

export default preview;
