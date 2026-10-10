import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Welcome from "@/app/(marketing)/welcome/page";

const meta = {
  title: "Motion/Landing page",
  component: Welcome,
  parameters: { layout: "fullscreen", shell: "marketing" },
} satisfies Meta<typeof Welcome>;
export default meta;

/**
 * The whole landing page with its scroll effects (LandingMotion.tsx: gsap and Lenis): reveals, count-ups, pins, scrubs and the
 * progress line under the nav. Scroll the canvas. Under Reduced motion (toolbar) it is static.
 */
export const Scroll: StoryObj<typeof meta> = {};
