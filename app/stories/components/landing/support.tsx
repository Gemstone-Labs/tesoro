import type { Decorator } from "@storybook/nextjs-vite";

/** The landing page's own wrapper (its tokens and type live on `.lp`). The toolbar Theme switch flips light and dark. */
export const inLanding: Decorator = (Story) => (
  <div className="lp">
    <Story />
  </div>
);

export const landingParameters = { layout: "fullscreen", themed: true, nextjs: { navigation: { pathname: "/welcome" } } } as const;
