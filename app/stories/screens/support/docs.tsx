import type { ComponentType } from "react";
import type { StoryObj } from "@storybook/nextjs-vite";

const pages = import.meta.glob("/src/app/*/docs/**/page.tsx", { eager: true }) as unknown as Record<string, { default: ComponentType }>;

/** One story for the Docs page at `href` (e.g. "/docs/fees"), inside the docs layout with that page current. */
export function docStory(href: string): StoryObj {
  const file = `/src/app/(docs)${href}/page.tsx`;
  const Page = pages[file]?.default;
  if (!Page) throw new Error(`No docs page for ${href} in ${Object.keys(pages).length}`);
  return { render: () => <Page />, parameters: { nextjs: { navigation: { pathname: href } } } };
}
