import type { Decorator } from "@storybook/nextjs-vite";

/** The docs wrapper the prose CSS expects, without the docs header and sidebar. */
export const inProse: Decorator = (Story) => (
  <div className="docs" style={{ minHeight: 0 }}>
    <div className="docs-main" style={{ maxWidth: 760, margin: "0 auto" }}>
      <div className="docs-prose">
        <Story />
      </div>
    </div>
  </div>
);
